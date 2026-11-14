"""Read the outputs of Clean.py and calibration.py for the website.

Files are re-read automatically when they change on disk (e.g. after you
re-run calibration.py), so the server never needs a restart for new results.
"""
from __future__ import annotations

import threading
from pathlib import Path

import numpy as np
import pandas as pd

from app.config import CACHE_DIR, CALIBRATION_CSV, CLEAN_CSV, HARMONIZED_CSV, REGIONS

_cache: dict[Path, tuple[float, pd.DataFrame]] = {}
_lock = threading.Lock()


def _load(path: Path, reader) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(path)
    mtime = path.stat().st_mtime
    hit = _cache.get(path)
    if hit and hit[0] == mtime:
        return hit[1]
    with _lock:
        hit = _cache.get(path)
        if hit and hit[0] == mtime:
            return hit[1]
        df = reader(path)
        _cache[path] = (mtime, df)
        return df


def _read_clean(path: Path) -> pd.DataFrame:
    pq = CACHE_DIR / "clean_hotspots.parquet"
    if pq.exists() and pq.stat().st_mtime >= path.stat().st_mtime:
        try:
            return pd.read_parquet(pq)
        except Exception:
            pass
    df = pd.read_csv(path, usecols=["date", "lat", "lon", "frp", "sensor", "region"])
    d = pd.to_datetime(df.pop("date"))
    df["year"] = d.dt.year.astype("int16")
    df["month"] = d.dt.month.astype("int8")
    df["day"] = d.dt.day.astype("int8")
    for c in ("lat", "lon", "frp"):
        df[c] = df[c].astype("float32")
    for c in ("sensor", "region"):
        df[c] = df[c].astype("category")
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        df.to_parquet(pq, index=False)
    except Exception:
        pass
    return df


def harmonized() -> pd.DataFrame:
    return _load(HARMONIZED_CSV, pd.read_csv)


def calibration() -> pd.DataFrame:
    return _load(CALIBRATION_CSV, pd.read_csv)


def clean_hotspots() -> pd.DataFrame:
    return _load(CLEAN_CSV, _read_clean)


def clean_ready() -> bool:
    hit = _cache.get(CLEAN_CSV)
    return bool(hit) and CLEAN_CSV.exists() and hit[0] == CLEAN_CSV.stat().st_mtime


def scope_regions(scope: str) -> list[str]:
    """'All' | country name | region name -> list of region names."""
    if not scope or scope == "All":
        return list(REGIONS)
    if scope in REGIONS:
        return [scope]
    regs = [r for r, v in REGIONS.items() if v["country"] == scope]
    if not regs:
        raise KeyError(scope)
    return regs


def monthly_series(scope: str) -> list[dict]:
    h = harmonized()
    d = h[h["region"].isin(scope_regions(scope))]
    g = (d.groupby(["year", "month"], as_index=False)
          .agg(harmonized=("harmonized_count", "sum"), modis=("MODIS", "sum"),
               viirs=("VIIRS", "sum"), source=("source", "first")))
    med = g.groupby("month")["harmonized"].transform("median")
    g["median"] = med
    g["anomaly"] = g["harmonized"] / med.replace(0, np.nan)
    g = g.sort_values(["year", "month"])
    g["harmonized"] = g["harmonized"].round(1)
    g["median"] = g["median"].round(1)
    g["anomaly"] = g["anomaly"].round(3)
    g = g.astype(object).where(g.notna(), None)
    return g.to_dict(orient="records")


def calibration_points(region: str) -> dict:
    h = harmonized()
    d = h[(h["region"] == region) & (h["source"] == "VIIRS")]
    c = calibration()
    row = c[c["region"] == region]
    if row.empty:
        raise KeyError(region)
    row = row.iloc[0].astype(object).where(row.iloc[0].notna(), None).to_dict()
    pts = d[["year", "month", "MODIS", "VIIRS"]].rename(columns=str.lower).to_dict(orient="records")
    return {"calibration": row, "points": pts}


def hotspot_grid(scope: str, year: int, month: int, sensor: str, cell: float) -> dict:
    if sensor == "auto":
        sensor = "VIIRS" if (year, month) >= (2012, 2) else "MODIS"
    df = clean_hotspots()
    m = ((df["year"] == year) & (df["month"] == month)
         & df["region"].isin(scope_regions(scope)) & (df["sensor"] == sensor))
    sub = df.loc[m, ["lat", "lon", "day", "frp"]]
    if sub.empty:
        return {"sensor": sensor, "cell": cell, "hotspots": 0, "cell_days": 0, "cells": []}
    gx = np.floor(sub["lon"] / cell).astype(int)
    gy = np.floor(sub["lat"] / cell).astype(int)
    sub = sub.assign(gx=gx, gy=gy)
    g = sub.groupby(["gx", "gy"]).agg(hotspots=("day", "size"), days=("day", "nunique"),
                                      frp=("frp", "sum")).reset_index()
    cells = [
        {"lat": round(float(r.gy * cell), 4), "lon": round(float(r.gx * cell), 4),
         "cell_days": int(r.days), "hotspots": int(r.hotspots), "frp": round(float(r.frp), 1)}
        for r in g.itertuples(index=False)
    ]
    return {"sensor": sensor, "cell": cell, "hotspots": int(len(sub)),
            "cell_days": int(g["days"].sum()), "cells": cells}
