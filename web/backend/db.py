"""SQLite user database with PBKDF2-SHA256 password hashing and Fernet API-key encryption.

DB location: $AMD_DB_PATH  or  ~/.amd/users.db

Schema
------
users(id, username UNIQUE, password_hash, created_at)

Hash format  (colon-separated, all fields in the hash string):
    pbkdf2:sha256:<iterations>:<hex-salt>:<hex-digest>
"""

from __future__ import annotations

import hashlib
import os
import secrets
import sqlite3
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

# ── Config ────────────────────────────────────────────────────────────

DB_PATH = Path(os.getenv("AMD_DB_PATH", str(Path.home() / ".amd" / "users.db")))
_ITERATIONS = 260_000

# No credentials are hardcoded. On a fresh database a single admin user is
# bootstrapped from the AMD_ADMIN_USER / AMD_ADMIN_PASSWORD env vars (see init_db);
# create further users with add_user().

# ── API-key encryption ────────────────────────────────────────────────

_ENC_KEY_PATH = Path(
    os.getenv("AMD_ENCRYPTION_KEY_PATH", str(Path.home() / ".amd" / "encryption_key"))
)


def _load_encryption_key() -> bytes:
    """Load or generate a Fernet encryption key persisted on disk."""
    if _ENC_KEY_PATH.exists():
        return _ENC_KEY_PATH.read_bytes().strip()
    _ENC_KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
    key = Fernet.generate_key()
    _ENC_KEY_PATH.write_bytes(key)
    return key


_FERNET = Fernet(_load_encryption_key())
_ENC_PREFIX = "enc:"


def _encrypt_api_key(plaintext: str) -> str:
    """Encrypt an API key. Empty strings are stored as-is."""
    if not plaintext:
        return ""
    return _ENC_PREFIX + _FERNET.encrypt(plaintext.encode()).decode()


def _decrypt_api_key(stored: str) -> str:
    """Decrypt an API key. Handles both encrypted and legacy plaintext values."""
    if not stored:
        return ""
    if stored.startswith(_ENC_PREFIX):
        try:
            return _FERNET.decrypt(stored[len(_ENC_PREFIX) :].encode()).decode()
        except InvalidToken:
            return ""
    # Legacy plaintext — return as-is (will be re-encrypted on next save)
    return stored


# ── Hashing ───────────────────────────────────────────────────────────


def _hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), _ITERATIONS)
    return f"pbkdf2:sha256:{_ITERATIONS}:{salt}:{digest.hex()}"


def _verify_password(password: str, stored: str) -> bool:
    try:
        _, algo, iters_s, salt, expected_hex = stored.split(":")
        digest = hashlib.pbkdf2_hmac(algo, password.encode(), salt.encode(), int(iters_s))
        return secrets.compare_digest(digest.hex(), expected_hex)
    except Exception:
        return False


# ── DB helpers ────────────────────────────────────────────────────────


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    return sqlite3.connect(str(DB_PATH))


def init_db() -> None:
    """Create tables and seed default users (idempotent)."""
    with _conn() as con:
        con.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                username      TEXT    UNIQUE NOT NULL,
                password_hash TEXT    NOT NULL,
                created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS user_api_keys (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                username   TEXT    NOT NULL,
                service    TEXT    NOT NULL,
                api_key    TEXT    NOT NULL DEFAULT '',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(username, service)
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                session_id       TEXT PRIMARY KEY,
                work_dir         TEXT NOT NULL,
                nickname         TEXT NOT NULL DEFAULT '',
                username         TEXT NOT NULL DEFAULT '',
                run_status       TEXT NOT NULL DEFAULT 'standby',
                selected_molecule TEXT NOT NULL DEFAULT '',
                started_at       REAL,
                finished_at      REAL,
                status           TEXT NOT NULL DEFAULT 'active',
                created_at       TEXT NOT NULL DEFAULT '',
                updated_at       TEXT NOT NULL DEFAULT '',
                json_path        TEXT NOT NULL DEFAULT '',
                result_cards     TEXT NOT NULL DEFAULT '[]'
            )
        """)
        session_columns = {row[1] for row in con.execute("PRAGMA table_info(sessions)").fetchall()}
        # Additive migrations for existing session indexes. Inspecting the
        # schema first avoids masking unrelated SQLite errors as "already
        # exists" and makes each migration independently idempotent.
        if "result_cards" not in session_columns:
            con.execute("ALTER TABLE sessions ADD COLUMN result_cards TEXT NOT NULL DEFAULT '[]'")
        if "created_at" not in session_columns:
            con.execute("ALTER TABLE sessions ADD COLUMN created_at TEXT NOT NULL DEFAULT ''")
        # Older rows only had updated_at, which is the best available historical
        # fallback; once backfilled, later edits never change created_at.
        con.execute(
            "UPDATE sessions SET created_at = updated_at "
            "WHERE (created_at IS NULL OR created_at = '') AND updated_at != ''"
        )
        # Bootstrap a single admin from env vars on a fresh DB only (no hardcoded creds).
        admin_user = os.getenv("AMD_ADMIN_USER")
        admin_pass = os.getenv("AMD_ADMIN_PASSWORD")
        if admin_user and admin_pass:
            exists = con.execute("SELECT 1 FROM users WHERE username = ?", (admin_user,)).fetchone()
            if not exists:
                con.execute(
                    "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                    (admin_user, _hash_password(admin_pass)),
                )


# Precomputed hash of a random secret. Verifying against it on the unknown-user
# path spends the same PBKDF2 time as a real check, so login latency does not leak
# whether a username exists.
_DUMMY_HASH = _hash_password(secrets.token_hex(16))


def verify_user(username: str, password: str) -> bool:
    """Return True if the username/password pair is valid.

    On an unknown username, runs a dummy verification so response time does not
    reveal whether the account exists (timing-attack mitigation).
    """
    with _conn() as con:
        row = con.execute(
            "SELECT password_hash FROM users WHERE username = ?", (username,)
        ).fetchone()
    if row:
        return _verify_password(password, row[0])
    _verify_password(password, _DUMMY_HASH)
    return False


def get_api_keys(username: str) -> dict[str, str]:
    """Return all API keys for a user as {service: decrypted_key}."""
    with _conn() as con:
        rows = con.execute(
            "SELECT service, api_key FROM user_api_keys WHERE username = ?", (username,)
        ).fetchall()
    return {row[0]: _decrypt_api_key(row[1]) for row in rows}


def set_api_key(username: str, service: str, api_key: str) -> None:
    """Insert or update an API key for a user/service pair (encrypted at rest)."""
    encrypted = _encrypt_api_key(api_key)
    with _conn() as con:
        con.execute(
            """
            INSERT INTO user_api_keys (username, service, api_key, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(username, service) DO UPDATE SET
                api_key    = excluded.api_key,
                updated_at = CURRENT_TIMESTAMP
            """,
            (username, service, encrypted),
        )


def add_user(username: str, password: str) -> None:
    """Insert a new user (raises sqlite3.IntegrityError if username exists)."""
    with _conn() as con:
        con.execute(
            "INSERT INTO users (username, password_hash) VALUES (?, ?)",
            (username, _hash_password(password)),
        )


def change_password(username: str, new_password: str) -> bool:
    """Update password. Returns False if user not found."""
    with _conn() as con:
        cur = con.execute(
            "UPDATE users SET password_hash = ? WHERE username = ?",
            (_hash_password(new_password), username),
        )
    return cur.rowcount > 0


# ── Session index ────────────────────────────────────────────────────

_SESSION_COLS = (
    "session_id",
    "work_dir",
    "nickname",
    "username",
    "run_status",
    "selected_molecule",
    "started_at",
    "finished_at",
    "status",
    "created_at",
    "updated_at",
    "json_path",
    "result_cards",
)


def upsert_session(data: dict) -> None:
    """Insert or update a session in the index."""
    import json as _json

    rc = data.get("result_cards", [])
    rc_json = _json.dumps(rc) if isinstance(rc, list) else (rc if isinstance(rc, str) else "[]")
    with _conn() as con:
        con.execute(
            """
            INSERT INTO sessions (session_id, work_dir, nickname, username, run_status,
                                  selected_molecule, started_at, finished_at, status, created_at, updated_at, json_path,
                                  result_cards)
            VALUES (:session_id, :work_dir, :nickname, :username, :run_status,
                    :selected_molecule, :started_at, :finished_at, :status, :created_at, :updated_at, :json_path,
                    :result_cards)
            ON CONFLICT(session_id) DO UPDATE SET
                work_dir          = excluded.work_dir,
                nickname          = excluded.nickname,
                username          = excluded.username,
                run_status        = excluded.run_status,
                selected_molecule = excluded.selected_molecule,
                started_at        = excluded.started_at,
                finished_at       = excluded.finished_at,
                status            = excluded.status,
                created_at        = CASE
                    WHEN sessions.created_at = '' THEN excluded.created_at
                    ELSE sessions.created_at
                END,
                updated_at        = excluded.updated_at,
                json_path         = excluded.json_path,
                result_cards      = excluded.result_cards
            """,
            {
                "session_id": data.get("session_id", ""),
                "work_dir": data.get("work_dir", ""),
                "nickname": data.get("nickname", ""),
                "username": data.get("username", ""),
                "run_status": data.get("run_status", "standby"),
                "selected_molecule": data.get("selected_molecule", ""),
                "started_at": data.get("started_at"),
                "finished_at": data.get("finished_at"),
                "status": data.get("status", "active"),
                "created_at": data.get("created_at") or data.get("updated_at", ""),
                "updated_at": data.get("updated_at", ""),
                "json_path": data.get("json_path", ""),
                "result_cards": rc_json,
            },
        )


def update_session_index(session_id: str, updates: dict) -> None:
    """Update specific fields of a session in the index."""
    import json as _json

    if not updates:
        return
    allowed = set(_SESSION_COLS) - {"session_id"}
    fields = {k: v for k, v in updates.items() if k in allowed}
    if not fields:
        return
    # Serialize result_cards list to JSON string for SQLite TEXT column
    if "result_cards" in fields and isinstance(fields["result_cards"], list):
        fields["result_cards"] = _json.dumps(fields["result_cards"])
    set_clause = ", ".join(f"{k} = :{k}" for k in fields)
    fields["session_id"] = session_id
    with _conn() as con:
        con.execute(f"UPDATE sessions SET {set_clause} WHERE session_id = :session_id", fields)


def list_sessions_indexed(username: str = "") -> list[dict]:
    """Fast session listing from SQLite index."""
    import json as _json

    with _conn() as con:
        con.row_factory = sqlite3.Row
        if username:
            rows = con.execute(
                "SELECT * FROM sessions WHERE status != 'deleted' AND username = ? ORDER BY updated_at DESC",
                (username,),
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM sessions WHERE status != 'deleted' ORDER BY updated_at DESC"
            ).fetchall()
    results = []
    for row in rows:
        d = dict(row)
        # Deserialize result_cards from JSON string
        rc = d.get("result_cards", "[]")
        if isinstance(rc, str):
            try:
                d["result_cards"] = _json.loads(rc)
            except Exception:
                d["result_cards"] = []
        results.append(d)
    return results


def get_session_indexed(session_id: str) -> dict | None:
    """Fast single-session lookup from SQLite index."""
    with _conn() as con:
        con.row_factory = sqlite3.Row
        row = con.execute("SELECT * FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
    return dict(row) if row else None


def delete_session_indexed(session_id: str) -> None:
    """Mark a session as deleted in the index."""
    with _conn() as con:
        con.execute("UPDATE sessions SET status = 'deleted' WHERE session_id = ?", (session_id,))


def session_index_count() -> int:
    """Return the number of active sessions in the index."""
    with _conn() as con:
        row = con.execute("SELECT COUNT(*) FROM sessions WHERE status != 'deleted'").fetchone()
    return row[0] if row else 0
