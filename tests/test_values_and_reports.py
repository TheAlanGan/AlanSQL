"""Value conversion for the UI, and performance-report formatting (no server needed)."""
import datetime
import decimal

import pytest

from dbcentral import perfreports
from dbcentral.drivers.base import to_json_value


@pytest.mark.parametrize("value, expected", [
    (None, None), (True, True), ("x", "x"), (42, 42), (1.5, 1.5),
    (2**60, str(2**60)),                                   # beyond JavaScript's safe integers
    (float("nan"), "nan"),
    (decimal.Decimal("12.50"), "12.50"),
    (datetime.datetime(2024, 1, 2, 3, 4, 5), "2024-01-02 03:04:05"),
    (datetime.date(2024, 1, 2), "2024-01-02"),
    (datetime.timedelta(hours=-1, minutes=-30), "-01:30:00"),
    (datetime.timedelta(hours=100, seconds=5), "100:00:05"),
])
def test_to_json_value(value, expected):
    assert to_json_value(value) == expected


def test_binary_values():
    assert to_json_value(b"\x01\x02") == {"$bin": "0102", "size": 2}
    assert to_json_value(b"\x01\x00", bit=True) == 256


@pytest.mark.parametrize("report, column, fmt", [
    ("statement_analysis", "total_latency", "time"),
    ("statement_analysis", "query", "sql"),
    ("memory_by_event", "current_alloc", "bytes"),
    ("io_file_bytes", "total", "bytes"),          # 'total' is bytes only in this report
    ("io_wait_bytes", "total", None),
    ("schema_auto_increment", "auto_increment_ratio", "ratio"),
    ("statements_errors", "error_pct", "pct"),
    ("user_statement_type", "statement", None),   # a statement type such as 'select', not SQL text
])
def test_report_column_formats(report, column, fmt):
    assert perfreports.column_format(report, column) == fmt


def test_report_values():
    assert perfreports._value(2_500_000_000_000, "time") == 2.5            # picoseconds -> seconds
    assert perfreports._value("1048576", "bytes") == 1048576
    assert perfreports._value(decimal.Decimal("0.25"), "ratio") == 0.25
    assert perfreports._value(b"abc", None) == "abc"
    assert isinstance(perfreports._value(2**60, None), float)


def test_every_report_is_well_formed():
    ids = [r[0] for r in perfreports.REPORTS]
    assert len(ids) == len(set(ids))
    for rid, cat, title, src, needs_ps, desc in perfreports.REPORTS:
        assert cat and title and desc and isinstance(needs_ps, bool)
        assert src.upper().startswith("SELECT") or src.replace("$", "").replace("_", "").isalnum()
