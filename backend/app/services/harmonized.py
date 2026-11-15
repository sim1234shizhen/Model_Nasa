"""Read the outputs of Clean.py and calibration.py for the website.

Files are re-read automatically when they change on disk (e.g. after you
re-run calibration.py), so the server never needs a restart for new results.
"""
from __future__ import annotations

import threading
from pathlib import Path

import numpy as np
import pandas as pd

from app.config import CACHE_DIR, CALIBRATION_CSV, CLEAN_CSV, CLEAN_DIR, HARMONIZED_CSV, PROJECT_ROOT, REGIONS

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
    if is_world_scope(scope):
        g = _world_frame(scope)
    else:
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


# ---------- specific date range (Dashboard "Specific dates") ----------
VIIRS_FROM = 20120201          # VIIRS S-NPP data start (yyyymmdd)


_dkeys: dict[int, np.ndarray] = {}


def _date_keys(df: pd.DataFrame) -> np.ndarray:
    """yyyymmdd as int32, computed once per loaded table (keyed by the table object)."""
    key = _dkeys.get(id(df))
    if key is None or len(key) != len(df):
        key = (df["year"].astype("int32") * 10000 + df["month"].astype("int32") * 100
               + df["day"].astype("int32")).to_numpy()
        _dkeys.clear()
        _dkeys[id(df)] = key
    return key


def hotspot_dates() -> dict:
    k = _date_keys(clean_hotspots())
    lo, hi = int(k.min()), int(k.max())
    fmt = lambda v: f"{v // 10000:04d}-{v // 100 % 100:02d}-{v % 100:02d}"
    return {"first": fmt(lo), "last": fmt(hi), "viirs_from": fmt(VIIRS_FROM)}


def _range_rows(scope: str, start: int, end: int, sensor: str) -> tuple[pd.DataFrame, str]:
    """Hotspots between two yyyymmdd keys (inclusive) for an area and sensor."""
    if sensor == "auto":
        sensor = "VIIRS" if start >= VIIRS_FROM else "MODIS"
    df = clean_hotspots()
    k = _date_keys(df)
    m = (k >= start) & (k <= end) & df["region"].isin(scope_regions(scope)).to_numpy()
    if sensor != "both":
        m &= (df["sensor"] == sensor).to_numpy()
    sub = df.loc[m, ["year", "month", "day", "lat", "lon", "frp", "sensor", "region"]].copy()
    sub["date"] = pd.to_datetime(dict(year=sub["year"], month=sub["month"], day=sub["day"])).dt.strftime("%Y-%m-%d")
    return sub, sensor


def hotspot_range(scope: str, start: int, end: int, sensor: str, max_points: int = 15000) -> dict:
    sub, sensor = _range_rows(scope, start, end, sensor)
    n_days = (pd.Timestamp(str(end)) - pd.Timestamp(str(start))).days + 1
    base = {"scope": scope, "sensor": sensor, "days_in_range": n_days}
    if sub.empty:
        return {**base, "hotspots": 0, "fire_days": 0, "cell_days": 0, "frp_total": 0,
                "busiest_day": None, "daily": [], "regions": [], "points": [], "points_truncated": False}
    # fire cell-days on the 0.05° grid, same unit as the rest of the site
    cells = (np.floor(sub["lat"] / 0.05).astype(int).astype(str) + "_"
             + np.floor(sub["lon"] / 0.05).astype(int).astype(str) + "_" + sub["date"])
    daily = (sub.groupby("date").agg(hotspots=("frp", "size"), frp=("frp", "sum")).reset_index())
    daily["frp"] = daily["frp"].astype("float64").round(1)
    busiest = daily.loc[daily["hotspots"].idxmax()]
    reg = (sub.groupby("region", observed=True)
              .agg(hotspots=("frp", "size"), frp=("frp", "sum"), fire_days=("date", "nunique")).reset_index()
              .sort_values("hotspots", ascending=False))
    peak_day = sub.groupby(["region", "date"], observed=True).size().reset_index(name="n")
    peak_day = peak_day.loc[peak_day.groupby("region", observed=True)["n"].idxmax()].set_index("region")["date"]
    total = len(sub)
    regions = [{"region": str(r.region), "hotspots": int(r.hotspots), "share": round(r.hotspots / total * 100, 1),
                "frp": round(float(r.frp), 1), "fire_days": int(r.fire_days),
                "peak_date": str(peak_day.get(r.region, ""))} for r in reg.itertuples(index=False)]
    # map points: strongest fires first, capped so the page stays fast
    pts = sub.sort_values("frp", ascending=False)
    truncated = len(pts) > max_points
    pts = pts.head(max_points)
    points = [[round(float(a), 4), round(float(b), 4), round(float(c), 1), d, str(e)]
              for a, b, c, d, e in zip(pts["lat"], pts["lon"], pts["frp"], pts["date"], pts["region"])]
    return {**base, "hotspots": total, "fire_days": int(daily.shape[0]), "cell_days": int(cells.nunique()),
            "frp_total": round(float(sub["frp"].sum()), 1),
            "busiest_day": {"date": busiest["date"], "hotspots": int(busiest["hotspots"])},
            "daily": daily.to_dict(orient="records"), "regions": regions,
            "points": points, "points_truncated": truncated}


def hotspot_range_csv(scope: str, start: int, end: int, sensor: str) -> str:
    sub, _ = _range_rows(scope, start, end, sensor)
    out = sub[["date", "lat", "lon", "frp", "sensor", "region"]].sort_values(["date", "region"])
    return out.to_csv(index=False, float_format="%.4f")


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


# ---------------------------------------------------------------------------
# Worldwide record. The dashboard can also show the whole world ("World") or any
# country in Global_Dataset/harmonized_country_monthly.csv (233 countries, MODIS
# scaled onto the VIIRS NOAA-20 level). Malaysia and Indonesia keep their
# region-calibrated record above; every other country comes from this file.
WORLD_SCOPE = "World"
GLOBAL_CSV = PROJECT_ROOT / "Global_Dataset" / "harmonized_country_monthly.csv"
WORLD_RAW_CSV = CLEAN_DIR / "world_monthly.csv"


def _global() -> pd.DataFrame:
    return _load(GLOBAL_CSV, pd.read_csv)


def _world_raw() -> pd.DataFrame:
    """Raw per-sensor fire cell-days, pivoted to one row per country-month."""
    def read(path: Path) -> pd.DataFrame:
        raw = pd.read_csv(path, usecols=["country", "year", "month", "sensor", "fire_cell_days"])
        wide = raw.pivot_table(index=["country", "year", "month"], columns="sensor",
                               values="fire_cell_days", aggfunc="sum").reset_index()
        for sensor in ("MODIS", "VIIRS"):
            if sensor not in wide:
                wide[sensor] = np.nan
        return wide[["country", "year", "month", "MODIS", "VIIRS"]]
    return _load(WORLD_RAW_CSV, read)


def world_countries() -> list[str]:
    return sorted(_global()["country"].unique())


def is_world_scope(scope: str) -> bool:
    """True for 'World' and for countries outside the Malaysia/Indonesia record."""
    if scope == WORLD_SCOPE:
        return True
    if not scope or scope == "All" or scope in REGIONS:
        return False
    if any(v["country"] == scope for v in REGIONS.values()):
        return False
    return scope in set(_global()["country"])


def _world_frame(scope: str) -> pd.DataFrame:
    g = _global()
    d = g if scope == WORLD_SCOPE else g[g["country"] == scope]
    if d.empty:
        raise KeyError(scope)
    out = (d.groupby(["year", "month"], as_index=False)
             .agg(harmonized=("harmonized_count", "sum"), source=("source", "first")))
    try:
        raw = _world_raw()
        raw = raw if scope == WORLD_SCOPE else raw[raw["country"] == scope]
        sums = (raw.groupby(["year", "month"], as_index=False)
                   .agg(modis=("MODIS", lambda s: s.sum(min_count=1)),
                        viirs=("VIIRS", lambda s: s.sum(min_count=1))))
        out = out.merge(sums, on=["year", "month"], how="left")
    except FileNotFoundError:
        out["modis"] = np.nan
        out["viirs"] = np.nan
    return out


def world_country_months(year: int) -> list[dict]:
    """Every country's harmonized cell-days for `year` and the year before."""
    g = _global()
    d = g[g["year"].isin([year - 1, year])]
    return [
        {"country": country, "months": [
            {"year": int(r.year), "month": int(r.month), "harmonized": round(float(r.harmonized_count), 1)}
            for r in rows.itertuples(index=False)]}
        for country, rows in d.groupby("country", sort=True)
    ]
