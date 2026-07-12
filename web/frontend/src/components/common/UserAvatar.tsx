"use client";

import { useEffect, useState } from "react";
import { User } from "lucide-react";
import { avatarUrl } from "@/lib/api";
import { getToken, getUsername } from "@/lib/auth";
import { useSessionStore } from "@/store/sessionStore";

/**
 * The signed-in user's avatar. Shows the uploaded image when present, otherwise
 * falls back to the username initial or a generic user icon. The wrapper's
 * background/rounding/text styles come from `className` so it matches whatever
 * spot it's dropped into (chat bubble, top bar, settings).
 */
export default function UserAvatar({
  size = 32,
  className = "",
  fallback = "icon",
}: {
  size?: number;
  className?: string;
  fallback?: "icon" | "initial";
}) {
  const version = useSessionStore((s) => s.avatarVersion);
  const [failed, setFailed] = useState(false);
  // A fresh upload bumps the version — retry the image instead of staying failed.
  useEffect(() => setFailed(false), [version]);

  const token = getToken();
  const username = getUsername();
  const showImg = !!token && !failed;

  return (
    <div
      style={{ width: size, height: size }}
      className={`overflow-hidden flex items-center justify-center flex-shrink-0 ${className}`}
    >
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl(version)}
          onError={() => setFailed(true)}
          alt=""
          className="w-full h-full object-cover"
        />
      ) : fallback === "initial" ? (
        <span>{username[0]?.toUpperCase() ?? "?"}</span>
      ) : (
        <User size={Math.round(size * 0.55)} />
      )}
    </div>
  );
}
