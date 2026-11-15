"""Whole-world harmonized fire activity (outputs of step2_harmonize_global.py).

Files in GLOBAL_DIR (Clean_dataset/global):
    harmonized_country_monthly.csv  country, year, month, harmonized_count, median_same_month, anomaly_ratio, source
    harmonized_cells_1deg.csv.gz    cx, cy, year, month, h       (1-degree cells, cx = lon+180, cy = lat+90)
    cell_dominant_country.csv       cx, cy, country
    calibration_global.csv          per-country MODIS -> VIIRS NOAA-20 factor k + validation
    validation_summary.csv          global validation scores

Counts are fire cell-days on the VIIRS NOAA-20 scale: k x MODIS before April 2018, VIIRS after.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from app.config import GLOBAL_DIR
from app.services.harmonized import _load

VIIRS_START = 2018 * 12 + 4    # April 2018
WORLD = "World"


def _country_monthly() -> pd.DataFrame:
    return _load(GLOBAL_DIR / "harmonized_country_monthly.csv", pd.read_csv)


def _cells() -> pd.DataFrame:
    def read(p):
        d = pd.read_csv(p)
        for c in ("cx", "cy", "year", "month"):
            d[c] = d[c].astype("int16")
        d["h"] = d["h"].astype("float32")
        return d
    return _load(GLOBAL_DIR / "harmonized_cells_1deg.csv.gz", read)


def _dominant() -> pd.DataFrame:
    return _load(GLOBAL_DIR / "cell_dominant_country.csv", pd.read_csv)


def _calibration() -> pd.DataFrame:
    return _load(GLOBAL_DIR / "calibration_global.csv", pd.read_csv)


def _validation() -> dict:
    v = _load(GLOBAL_DIR / "validation_summary.csv", lambda p: pd.read_csv(p, index_col=0))
    return {k: (None if pd.isna(x) else round(float(x), 4)) for k, x in v["value"].items()}


def _clean(v):
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return None
    if isinstance(v, (np.floating, float)):
        return round(float(v), 3)
    if isinstance(v, np.integer):
        return int(v)
    return v


def countries() -> list[str]:
    """All country names, alphabetical. Map cells refer to this list by index."""
    return sorted(_country_monthly()["country"].unique())


def summary() -> dict:
    cm = _country_monthly()
    years = sorted(cm["year"].unique())
    names = countries()
    annual = cm.groupby(["country", "year"])["harmonized_count"].sum().unstack("year")
    total = annual.sum(axis=1)
    typical = annual.median(axis=1)
    season = cm.groupby(["country", "month"])["median_same_month"].first().unstack("month")
    peak = season.idxmax(axis=1)

    cal = _calibration().set_index("country")
    cells = _cells().groupby(["cx", "cy"])["h"].sum().reset_index().merge(_dominant(), on=["cx", "cy"])
    cells["lon"] = cells["cx"] - 180 + 0.5
    cells["lat"] = cells["cy"] - 90 + 0.5
    geo = cells.groupby("country").apply(
        lambda g: pd.Series({
            "lon": float(np.average(g["lon"], weights=g["h"])), "lat": float(np.average(g["lat"], weights=g["h"])),
            "bbox": [float(g["lon"].min() - 0.5), float(g["lat"].min() - 0.5),
                     float(g["lon"].max() + 0.5), float(g["lat"].max() + 0.5)],
        }), include_groups=False)

    rows = []
    for c in names:
        r = {"country": c, "total": round(float(total.get(c, 0)), 1),
             "typical_year": round(float(typical.get(c, 0)), 1),
             "peak_month": int(peak[c]) if c in peak.index and season.loc[c].max() > 0 else None}
        if c in cal.index:
            k = cal.loc[c]
            r.update({"k": _clean(k["k"]), "k_source": k["k_source"], "r2_loyo": _clean(k.get("r2_loyo")),
                      "r2_holdout": _clean(k.get("r2_holdout_2024_25")),
                      "holdout_err_pct": _clean(k.get("holdout_total_err_pct")), "corr": _clean(k.get("corr"))})
        if c in geo.index:
            r.update({"lon": round(geo.at[c, "lon"], 2), "lat": round(geo.at[c, "lat"], 2), "bbox": geo.at[c, "bbox"]})
        rows.append(r)

    world_annual = annual.sum(axis=0)
    return {
        "years": [int(years[0]), int(years[-1])],
        "viirs_start": {"year": 2018, "month": 4},
        "countries": rows,
        "world": {"total": round(float(total.sum()), 1), "typical_year": round(float(world_annual.median()), 1),
                  "countries_with_fire": int((total > 0).sum())},
        "validation": _validation(),
    }


def series(country: str) -> dict:
    cm = _country_monthly()
    if country == WORLD:
        d = cm.groupby(["year", "month"], as_index=False)["harmonized_count"].sum()
    else:
        d = cm[cm["country"] == country][["year", "month", "harmonized_count"]]
        if d.empty:
            raise KeyError(country)
    d = d.sort_values(["year", "month"]).rename(columns={"harmonized_count": "value"})
    med = d.groupby("month")["value"].transform("median")
    d["median"] = med.round(1)
    d["anomaly"] = (d["value"] / med.replace(0, np.nan)).round(3)
    d["source"] = np.where(d["year"] * 12 + d["month"] >= VIIRS_START, "VIIRS NOAA-20", "MODIS (scaled)")
    d["value"] = d["value"].round(1)
    d = d.astype(object).where(d.notna(), None)
    return {"country": country, "series": d.to_dict(orient="records")}


def ranking(year: int, month: int) -> dict:
    """All countries for one month (month 1-12) or a whole year (month 0), vs their typical level."""
    cm = _country_monthly()
    if month:
        d = cm[cm["month"] == month]
        cur = d[d["year"] == year].set_index("country")["harmonized_count"]
        typ = d.groupby("country")["harmonized_count"].median()
    else:
        a = cm.groupby(["country", "year"])["harmonized_count"].sum().unstack("year")
        if year not in a.columns:
            raise ValueError(f"no data for {year}")
        cur, typ = a[year], a.median(axis=1)
    if cur.empty:
        raise ValueError(f"no data for {year}-{month:02d}")
    world = float(cur.sum())
    out = pd.DataFrame({"value": cur, "typical": typ.reindex(cur.index)}).fillna(0)
    out = out[out["value"] > 0].sort_values("value", ascending=False)
    rows = [{"country": c, "value": round(float(r.value), 1), "typical": round(float(r.typical), 1),
             "ratio": round(float(r.value / r.typical), 2) if r.typical > 0 else None,
             "share_pct": round(float(r.value) / world * 100, 2) if world else 0}
            for c, r in out.iterrows()]
    w_typ = (cm[cm["month"] == month].groupby("year")["harmonized_count"].sum().median() if month
             else cm.groupby("year")["harmonized_count"].sum().median())
    return {"year": year, "month": month, "world": round(world, 1), "world_typical": round(float(w_typ), 1),
            "source": "VIIRS NOAA-20" if year * 12 + max(month, 1) >= VIIRS_START else "MODIS (scaled)",
            "countries": rows}


def world_map(year: int, month: int) -> dict:
    """1-degree cells for one month (1-12) or a whole year (0): [lon_west, lat_south, value, country_index]."""
    c = _cells()
    d = c[(c["year"] == year) & ((c["month"] == month) if month else True)]
    if month == 0:
        d = d.groupby(["cx", "cy"], as_index=False)["h"].sum()
    else:
        d = d[["cx", "cy", "h"]]
    names = countries()
    idx = {n: i for i, n in enumerate(names)}
    dom = _dominant().set_index(["cx", "cy"])["country"]
    ci = pd.Series(list(zip(d["cx"], d["cy"]))).map(dom).map(idx).fillna(-1).astype(int).to_numpy()
    cells = [[int(x) - 180, int(y) - 90, round(float(h), 1), int(k)]
             for x, y, h, k in zip(d["cx"], d["cy"], d["h"], ci)]
    return {"year": year, "month": month, "cell_deg": 1,
            "max": round(float(d["h"].max()), 1) if len(d) else 0, "cells": cells}
