"""Monthly 1-degree fire cells from the existing harmonized global dataset."""
from __future__ import annotations

import csv
import gzip
from array import array
from collections import defaultdict
from functools import lru_cache
from threading import Lock

from app.config import PROJECT_ROOT

GRID = PROJECT_ROOT / "Global_Dataset" / "harmonized_cells_1deg.csv.gz"
grid_lock = Lock()


@lru_cache(maxsize=1)
def _index(mtime_ns: int) -> dict[tuple[int, int], array]:
    # Packed arrays keep the entire monthly index small in memory.
    months = defaultdict(lambda: array("d"))
    with gzip.open(GRID, "rt", encoding="utf-8", newline="") as source:
        rows = csv.DictReader(source)
        for row in rows:
            year, month = int(row["year"]), int(row["month"])
            lon, lat = int(row["cx"]) - 180, int(row["cy"]) - 90
            months[year, month].extend((lon, lat, float(row["h"])))
    return dict(months)


def grid_months() -> list[tuple[int, int]]:
    return sorted(_load())


def monthly_grid(year: int, month: int) -> dict:
    values = iter(_load().get((year, month), ()))
    return {"year": year, "month": month, "cell": 1, "cells": [
        (int(lon), int(lat), count) for lon, lat, count in zip(values, values, values)
    ]}


def _load() -> dict[tuple[int, int], array]:
    with grid_lock:
        return _index(GRID.stat().st_mtime_ns)
