"""Versioned temporal evaluation contract (millisecond UTC, half-open windows)."""
from __future__ import annotations
import json
from pathlib import Path
from typing import Any

MAX_SAFE_INTEGER = 2**53 - 1
FIELDS = {'version', 'ticker', 'from_ms', 'train_end_ms', 'validation_end_ms',
          'test_end_ms', 'test_independence'}


def validate_manifest(value: Any, ticker: str) -> dict:
    if not isinstance(value, dict) or set(value) != FIELDS:
        raise ValueError('evaluation manifest must contain exactly the version 1 fields')
    if type(value['version']) is not int or value['version'] != 1:
        raise ValueError('unsupported evaluation manifest version')
    if not isinstance(ticker, str) or not ticker or value['ticker'] != ticker:
        raise ValueError('evaluation manifest ticker mismatch')
    bounds = [value[key] for key in ('from_ms', 'train_end_ms', 'validation_end_ms', 'test_end_ms')]
    if any(type(v) is not int or not 0 <= v <= MAX_SAFE_INTEGER for v in bounds):
        raise ValueError('evaluation bounds must be nonnegative safe integer milliseconds')
    if not bounds[0] < bounds[1] < bounds[2] <= bounds[3]:
        raise ValueError('required from < train_end < validation_end <= test_end')
    if value['test_independence'] not in ('unverified', 'prospective'):
        raise ValueError('invalid test_independence')
    return dict(value)


def load_evaluation_manifest(path: str | Path | dict, ticker: str) -> dict:
    value = path if isinstance(path, dict) else json.loads(Path(path).read_text())
    return validate_manifest(value, ticker)


def generate_manifest(ticker: str, from_ms: int, end_ms: int) -> dict:
    """70/30 by elapsed time; end_ms is exclusive, never an independent Test."""
    if type(from_ms) is not int or type(end_ms) is not int:
        raise ValueError('bounds must be integers')
    return validate_manifest(dict(version=1, ticker=ticker, from_ms=from_ms,
        train_end_ms=from_ms + (end_ms - from_ms) * 7 // 10,
        validation_end_ms=end_ms, test_end_ms=end_ms, test_independence='unverified'), ticker)
