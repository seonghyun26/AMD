"""Tests for WandB tools and MDMonitor."""

import pytest

from md_agent.utils.parsers import count_hills, parse_colvar_file


class TestParseColvar:
    def test_basic_parsing(self, tmp_path):
        colvar = tmp_path / "COLVAR"
        colvar.write_text("#! FIELDS time d1 phi\n" "0.000 1.234 -2.345\n" "0.002 1.250 -2.300\n")
        rows = parse_colvar_file(str(colvar))
        assert len(rows) == 2
        assert rows[0]["time"] == pytest.approx(0.0)
        assert rows[0]["d1"] == pytest.approx(1.234)

    def test_from_line_bookmark(self, tmp_path):
        colvar = tmp_path / "COLVAR"
        colvar.write_text("#! FIELDS time d1\n" "0.000 1.0\n" "0.002 1.1\n" "0.004 1.2\n")
        rows = parse_colvar_file(str(colvar), from_line=2)
        assert len(rows) == 1
        assert rows[0]["d1"] == pytest.approx(1.2)

    def test_empty_file(self, tmp_path):
        colvar = tmp_path / "COLVAR"
        colvar.write_text("")
        rows = parse_colvar_file(str(colvar))
        assert rows == []

    def test_missing_file(self):
        rows = parse_colvar_file("/nonexistent/COLVAR")
        assert rows == []


class TestCountHills:
    def test_counts_data_lines(self, tmp_path):
        hills = tmp_path / "HILLS"
        hills.write_text(
            "#! FIELDS time d1 sigma_d1 height biasf\n"
            "0.000 1.0 0.35 1.2 10\n"
            "1.000 1.1 0.35 1.2 10\n"
            "2.000 1.2 0.35 1.2 10\n"
        )
        assert count_hills(str(hills)) == 3

    def test_missing_file(self):
        assert count_hills("/nonexistent/HILLS") == 0
