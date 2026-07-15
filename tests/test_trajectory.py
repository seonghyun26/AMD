"""Tests for the NGL remote trajectory frame reader."""

from __future__ import annotations

import sys
from types import SimpleNamespace

import numpy as np
import pytest

from web.backend.routers import trajectory


class _FakeTrajectoryReader:
    def __init__(self, coordinates: np.ndarray, box_vectors: np.ndarray | None):
        self.coordinates = coordinates
        self.box_vectors = box_vectors
        self.seek_calls: list[int] = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def seek(self, frame_index: int):
        self.seek_calls.append(frame_index)

    def read(self, n_frames: int = 1):
        assert n_frames == 1
        return self.coordinates, np.array([0.0]), np.array([0]), self.box_vectors


def test_read_frame_uses_indexed_trajectory_without_topology(monkeypatch, tmp_path):
    coordinates = np.array([[[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]], dtype=np.float32)
    box_vectors = np.array([np.eye(3, dtype=np.float32) * 7.0])
    reader = _FakeTrajectoryReader(coordinates, box_vectors)
    fake_mdtraj = SimpleNamespace(open=lambda _path: reader)
    monkeypatch.setitem(sys.modules, "mdtraj", fake_mdtraj)

    coords, box = trajectory._read_frame(tmp_path / "trajectory.xtc", 17)

    assert reader.seek_calls == [17]
    np.testing.assert_array_equal(coords, coordinates.reshape(-1) * 10.0)
    np.testing.assert_array_equal(box, box_vectors.reshape(-1) * 10.0)
    assert coords.dtype == np.float32
    assert box.dtype == np.float32


def test_read_frame_rejects_missing_frame(monkeypatch, tmp_path):
    reader = _FakeTrajectoryReader(
        np.empty((0, 2, 3), dtype=np.float32),
        np.empty((0, 3, 3), dtype=np.float32),
    )
    monkeypatch.setitem(sys.modules, "mdtraj", SimpleNamespace(open=lambda _path: reader))

    with pytest.raises(IndexError, match="Frame 4 is unavailable"):
        trajectory._read_frame(tmp_path / "trajectory.xtc", 4)
