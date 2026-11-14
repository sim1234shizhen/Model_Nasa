"""Load FIRMS CSVs into a single normalized DataFrame schema.

VIIRS and MODIS use different column names / confidence formats, so everything
is normalized to:

    latitude, longitude, brightness, brightness_2, frp, scan, track,
    acq_datetime, acq_date, satellite, instrument, confidence (low|nominal|high),
    confidence_raw, daynight, type

Your own Python code (models, analysis) should call `get_dataset(id)` and get
this same clean DataFrame the API uses.
"""
from __future__ import annotations

import threading
from typing import Optional

import pandas as pd

from app.config import CACHE_DIR, DATA_DIR, DATASETS

_cache: dict[str, pd.DataFrame] = {}
_lock = threading.Lock()


def _modis_conf(v: pd.Series) -> pd.Series:
    # FIRMS convention: <30 low, 30-79 nominal, >=80 high
    n = pd.to_numeric(v, errors="coerce")
    out = pd.Series("nominal", index=v.index)
    out[n < 30] = "low"
    out[n >= 80] = "high"
    return out


def _normalize(df: pd.DataFrame) -> pd.DataFrame:
    df = df.rename(columns={
        "bright_ti4": "brightness", "bright_ti5": "brightness_2", "bright_t31": "brightness_2",
    })
    df["confidence_raw"] = df["confidence"].astype(str)
    if (df["instrument"] == "MODIS").any():
        df["confidence"] = _modis_conf(df["confidence"])
    else:
        df["confidence"] = df["confidence"].map({"l": "low", "n": "nominal", "h": "high"}).fillna("nominal")

    t = df["acq_time"].astype(str).str.zfill(4)
    df["acq_datetime"] = pd.to_datetime(df["acq_date"] + " " + t.str[:2] + ":" + t.str[2:], utc=True)
    df["acq_date"] = df["acq_datetime"].dt.normalize()

    keep = ["latitude", "longitude", "brightness", "brightness_2", "frp", "scan", "track",
            "acq_datetime", "acq_date", "satellite", "instrument", "confidence",
            "confidence_raw", "daynight", "type"]
    df = df[keep]
    for c in ("satellite", "instrument", "confidence", "daynight"):
        df[c] = df[c].astype("category")
    df["latitude"] = df["latitude"].astype("float32")
    df["longitude"] = df["longitude"].astype("float32")
    return df.sort_values("acq_datetime").reset_index(drop=True)


def _load(dataset_id: str) -> pd.DataFrame:
    meta = DATASETS[dataset_id]
    csv_path = DATA_DIR / meta["file"]
    pq_path = CACHE_DIR / f"{dataset_id}.parquet"

    if pq_path.exists() and pq_path.stat().st_mtime >= csv_path.stat().st_mtime:
        try:
            return pd.read_parquet(pq_path)
        except Exception:
            pass  # fall through and rebuild

    df = _normalize(pd.read_csv(csv_path, dtype={"acq_time": str, "confidence": str}))
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        df.to_parquet(pq_path, index=False)
    except Exception:
        pass  # pyarrow missing -> just skip caching
    return df


def get_dataset(dataset_id: str) -> pd.DataFrame:
    """Return the normalized DataFrame (loaded once, then kept in memory)."""
    if dataset_id not in DATASETS:
        raise KeyError(dataset_id)
    if dataset_id not in _cache:
        with _lock:
            if dataset_id not in _cache:
                _cache[dataset_id] = _load(dataset_id)
    return _cache[dataset_id]


def is_loaded(dataset_id: str) -> bool:
    return dataset_id in _cache


def filter_fires(
    df: pd.DataFrame,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    bbox: Optional[tuple[float, float, float, float]] = None,
    min_frp: Optional[float] = None,
    confidence: Optional[list[str]] = None,
    daynight: Optional[str] = None,
) -> pd.DataFrame:
    """Shared filtering used by every endpoint (and usable from your own code)."""
    mask = pd.Series(True, index=df.index)
    if start_date:
        mask &= df["acq_date"] >= pd.Timestamp(start_date, tz="UTC")
    if end_date:
        mask &= df["acq_date"] <= pd.Timestamp(end_date, tz="UTC")
    if bbox:
        min_lon, min_lat, max_lon, max_lat = bbox
        mask &= df["longitude"].between(min_lon, max_lon) & df["latitude"].between(min_lat, max_lat)
    if min_frp is not None:
        mask &= df["frp"] >= min_frp
    if confidence:
        mask &= df["confidence"].isin(confidence)
    if daynight:
        mask &= df["daynight"] == daynight.upper()
    return df[mask]
