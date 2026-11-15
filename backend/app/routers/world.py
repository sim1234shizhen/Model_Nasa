"""Fire danger for the whole world, one degree at a time.

The regional model needs a fire history before it can forecast anything, which
is why it only covers places where FIRMS files exist. Fire *weather* does not
have that problem: GFWED covers every land cell on Earth, every month, back to
2003. This endpoint turns it into a simple, honest statement - how this month's
fire weather compares with the same month in every year on record.

One degree cells, 180 rows (south to north) by 360 columns (west to east).
A cell the source grid never touches (open ocean, ice) comes back as 0.
"""
from __future__ import annotations

import json
import os
from functools import lru_cache

import numpy as np
from fastapi import APIRouter, HTTPException, Query

from app.config import PROJECT_ROOT

router = APIRouter(prefix="/api/world", tags=["world"])

WORLD = os.path.join(PROJECT_ROOT, "data", "world")
N_LAT, N_LON = 180, 360


def _part(kind: str, year: int, month: int):
    path = os.path.join(WORLD, f"{kind}_{year}{month:02d}.npy")
    if not os.path.exists(path):
        return None
    return np.load(path, allow_pickle=False)


@lru_cache(maxsize=1)
def _available() -> list[tuple[int, int]]:
    index = os.path.join(WORLD, "index.json")
    if not os.path.exists(index):
        return []
    rows = json.load(open(index))
    return sorted((int(r["year"]), int(r["month"])) for r in rows)


BASELINE_END = 2025


@lru_cache(maxsize=64)
def _climatology(month: int) -> tuple[np.ndarray, np.ndarray]:
    """The baseline years of this calendar month, stacked. Cached: it never changes.

    2026 fire weather is served as a target but does not join the baseline, so a
    month is always compared with 2003-2025 rather than partly with itself.
    """
    years = [y for (y, m) in _available() if m == month and y <= BASELINE_END]
    stack = []
    for year in years:
        part = _part("FWI", year, month)
        if part is not None:
            stack.append(np.asarray(part, dtype="float32"))
    if not stack:
        raise HTTPException(404, f"No fire weather stored for month {month}")
    return np.stack(stack), np.array(years)


@router.get("/coverage")
def coverage():
    months = _available()
    if not months:
        return {"available": False, "months": 0, "note": "run pull_gfwed_world.py"}
    return {
        "available": True,
        "months": len(months),
        "first": f"{months[0][0]}-{months[0][1]:02d}",
        "last": f"{months[-1][0]}-{months[-1][1]:02d}",
        "grid": {"rows": N_LAT, "cols": N_LON, "degrees": 1},
        "variables": ["FWI", "DC"],
    }


@router.get("/danger")
def danger(
    year: int = Query(..., ge=2003, le=2030),
    month: int = Query(..., ge=1, le=12),
    variable: str = Query("FWI", pattern="^(FWI|DC)$"),
):
    """Percentile of this month's fire weather against the same month 2003-2025.

    0 = no data, 1..100 = rank among the years on record. 90 means this cell has
    been drier / more fire-prone than nine years in ten.
    """
    target = _part(variable, year, month)
    if target is None:
        raise HTTPException(404, f"No {variable} stored for {year}-{month:02d}")

    stack, years = _climatology(month)
    if variable != "FWI":
        # rebuild the stack for the other variable on demand (small cost)
        rebuilt = []
        for y in years:
            part = _part(variable, y, month)
            rebuilt.append(np.asarray(part, dtype="float32") if part is not None
                           else np.full((N_LAT, N_LON), np.nan, dtype="float32"))
        stack = np.stack(rebuilt)

    tgt = np.asarray(target, dtype="float32")
    valid = np.isfinite(tgt) & np.isfinite(stack).all(axis=0)
    below = np.sum(np.where(valid[None, :, :], stack < tgt[None, :, :], False), axis=0)
    total = int(valid.sum())
    rank = np.zeros((N_LAT, N_LON), dtype="uint8")
    with np.errstate(invalid="ignore", divide="ignore"):
        pct = np.round(100.0 * below / max(len(years), 1))
    rank[valid] = np.clip(pct[valid], 1, 100).astype("uint8")

    # Ship it as a compact base64 grid: 64.8 kB raw, ~86 kB encoded. Far smaller
    # than 15,000 JSON objects and it renders straight into a canvas.
    import base64
    return {
        "year": year,
        "month": month,
        "variable": variable,
        "rows": N_LAT,
        "cols": N_LON,
        "cells": total,
        "years_compared": [int(years.min()), int(years.max())],
        "encoding": "uint8-base64",
        "grid": base64.b64encode(rank.tobytes()).decode("ascii"),
    }
