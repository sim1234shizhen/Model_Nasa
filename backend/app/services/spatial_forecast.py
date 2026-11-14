"""Where will fires be? Monthly fire-risk forecast per 0.25-degree grid cell (~28 km).

For each cell c and month m of the forecast year:
    w[c,m]   = recency-weighted average number of VIIRS fire days in the cell in month m
               (half-life 3 years, lightly smoothed with the neighbouring months)
    R[r,m]   = the region's forecast multiplier (El Nino effect + bias) from forecast.py
    lambda   = k * w * R          expected fire days (k = scale learned in the backtest)
    P(fire)  = chance of >= 1 fire day, from a calibration curve learned in the backtest

Backtest 2016..last year (train only on earlier years) measures how well the map
ranks the cells that actually burned (AUC, share of fire days caught by the top 10% of cells).

Area names are approximate: each cell gets the name of the nearest province / state /
division centre within its region (not official boundaries).
"""
from __future__ import annotations

import threading

import numpy as np
import pandas as pd

from app.config import CALIBRATION_CSV, CLEAN_CSV, HARMONIZED_CSV
from app.services import forecast as F
from app.services.harmonized import clean_hotspots, scope_regions

CELL = 0.25
HALF_LIFE = 3.0
SMOOTH = 0.5
FIRST_TEST_YEAR = 2016
VIIRS_START = 2012 * 12 + 2
MIN_P = 0.05                    # cells below this chance are not sent to the map

# approximate centres (lat, lon) used to name cells
AREAS = {
    "Sumatra": {
        "Aceh": (4.4, 96.9), "North Sumatra": (2.2, 99.3), "West Sumatra": (-0.8, 100.6),
        "Riau": (0.5, 101.8), "Riau Islands": (0.9, 104.4), "Jambi": (-1.6, 103.0),
        "South Sumatra": (-3.3, 104.2), "Bengkulu": (-3.6, 102.3), "Lampung": (-4.9, 105.0),
        "Bangka Belitung": (-2.3, 106.2),
    },
    "Kalimantan": {
        "West Kalimantan": (0.0, 110.6), "Central Kalimantan": (-1.6, 113.4),
        "South Kalimantan": (-2.9, 115.3), "East Kalimantan": (0.5, 116.4), "North Kalimantan": (3.0, 116.2),
    },
    "Peninsular Malaysia": {
        "Perlis/Kedah": (6.1, 100.6), "Penang": (5.35, 100.4), "Perak": (4.6, 101.0), "Kelantan": (5.3, 102.0),
        "Terengganu": (4.9, 103.0), "Pahang": (3.7, 102.6), "Selangor/KL": (3.3, 101.5),
        "Negeri Sembilan": (2.75, 102.15), "Melaka": (2.25, 102.3), "Johor": (1.95, 103.4),
    },
    "Sarawak": {
        "Kuching/Samarahan": (1.3, 110.5), "Sri Aman/Betong": (1.3, 111.5), "Sibu/Sarikei": (2.1, 111.8),
        "Mukah": (2.7, 112.4), "Kapit": (1.9, 113.6), "Bintulu": (3.1, 113.3), "Miri": (4.0, 114.3),
        "Limbang": (4.5, 115.1),
    },
    "Sabah": {
        "Sabah West Coast": (5.8, 116.2), "Kudat": (6.6, 116.9), "Sandakan": (5.6, 117.8),
        "Tawau": (4.6, 117.8), "Sabah Interior": (5.0, 116.2),
    },
}

_lock = threading.Lock()
_cube = None          # (key, dict)
_calib: dict = {}


def _key():
    return tuple(p.stat().st_mtime for p in (CLEAN_CSV, HARMONIZED_CSV, CALIBRATION_CSV))


def _name_cells(cells: pd.DataFrame) -> list[str]:
    names = []
    for r in cells.itertuples(index=False):
        cand = AREAS.get(r.region, {})
        if not cand:
            names.append(r.region)
            continue
        lat, lon = r.lat + CELL / 2, r.lon + CELL / 2
        best = min(cand.items(), key=lambda kv: (kv[1][0] - lat) ** 2 + (kv[1][1] - lon) ** 2)
        names.append(best[0])
    return names


def cube() -> dict:
    """Fire days per (year, month, cell) from VIIRS, Feb 2012 .. last full year."""
    global _cube
    key = _key()
    if _cube and _cube[0] == key:
        return _cube[1]
    with _lock:
        if _cube and _cube[0] == key:
            return _cube[1]
        df = clean_hotspots()
        last = int(df.loc[df["sensor"] == "VIIRS", "year"].value_counts().loc[lambda s: s > 1000].index.max())
        v = df[(df["sensor"] == "VIIRS") & ((df["year"].astype(int) * 12 + df["month"]) >= VIIRS_START)
               & (df["year"] <= last)]
        gx = np.floor(v["lon"] / CELL).astype(int)
        gy = np.floor(v["lat"] / CELL).astype(int)
        v = v.assign(gx=gx, gy=gy)
        fd = v.groupby(["year", "month", "gx", "gy"], observed=True)["day"].nunique().rename("fd").reset_index()
        cells = (v.groupby(["gx", "gy"], observed=True)["region"]
                  .agg(lambda s: s.value_counts().index[0]).rename("region").reset_index())
        cells["region"] = cells["region"].astype(str)
        cells["lat"] = cells["gy"] * CELL
        cells["lon"] = cells["gx"] * CELL
        cells["area"] = _name_cells(cells)
        cells["cid"] = np.arange(len(cells))
        fd = fd.merge(cells[["gx", "gy", "cid"]], on=["gx", "gy"])
        years = list(range(2012, last + 1))
        yi = {y: i for i, y in enumerate(years)}
        A = np.zeros((len(years), 12, len(cells)))
        A[fd["year"].astype(int).map(yi), fd["month"].astype(int) - 1, fd["cid"]] = fd["fd"]
        A[0, 0, :] = np.nan  # Jan 2012: no VIIRS
        out = {"A": A, "years": years, "yi": yi, "cells": cells.drop(columns=["gx", "gy"]), "last": last}
        _cube = (key, out)
        return out


def _wmean(c: dict, upto: int) -> np.ndarray:
    """Recency-weighted mean fire days per month & cell, using years < upto. Shape (12, n_cells)."""
    ty = [y for y in c["years"] if y < upto]
    X = c["A"][[c["yi"][y] for y in ty]]
    w = (0.5 ** ((upto - 1 - np.array(ty)) / HALF_LIFE))[:, None, None] * ~np.isnan(X)
    m = np.nansum(np.nan_to_num(X) * w, 0) / np.maximum(w.sum(0), 1e-9)
    return (m + SMOOTH * (np.roll(m, 1, 0) + np.roll(m, -1, 0))) / (1 + 2 * SMOOTH)


def _region_factor(c: dict, year: int, enso: str, train_upto: int | None) -> np.ndarray:
    reg = c["cells"]["region"].to_numpy()
    R = np.ones((12, len(reg)))
    for r in np.unique(reg):
        R[:, reg == r] = F.area_factor(r, year, enso, train_upto)[:, None]
    return R


def _auc(score, y):
    pos = int(y.sum()); neg = len(y) - pos
    if not pos or not neg:
        return np.nan
    o = np.argsort(score, kind="mergesort"); r = np.empty(len(o)); r[o] = np.arange(1, len(o) + 1)
    return float((r[y].sum() - pos * (pos + 1) / 2) / (pos * neg))


def calibration() -> dict:
    """Backtest -> scale k, P(fire) curve, and skill scores. Cached."""
    c = cube()
    key = (_key(), None if F._oni is None else F._oni[0])
    if key in _calib:
        return _calib[key]
    lams, acts, aucs, top10 = [], [], [], []
    for Y in range(FIRST_TEST_YEAR, c["last"] + 1):
        lam = _wmean(c, Y) * _region_factor(c, Y, "observed", Y)
        act = c["A"][c["yi"][Y]]
        lams.append(lam); acts.append(act)
    lam_all, act_all = np.stack(lams), np.stack(acts)
    k = float(act_all.sum() / lam_all.sum())
    lam_all *= k
    for lam, act in zip(lam_all, act_all):
        for m in range(12):
            y = act[m] > 0
            aucs.append(_auc(lam[m], y))
            n = max(1, int(0.1 * lam.shape[1]))
            top = np.argsort(-lam[m])[:n]
            top10.append(act[m, top].sum() / max(act[m].sum(), 1))
    # calibration curve: observed share of cells with >=1 fire day, by quantile bins of lambda
    x = np.log(lam_all.ravel() + 0.01)
    y = (act_all.ravel() > 0).astype(float)
    edges = np.unique(np.quantile(x, np.linspace(0, 1, 26)))
    idx = np.clip(np.searchsorted(edges, x, side="right") - 1, 0, len(edges) - 2)
    cx = np.array([x[idx == i].mean() for i in range(len(edges) - 1)])
    cy = np.maximum.accumulate(np.array([y[idx == i].mean() for i in range(len(edges) - 1)]))
    brier = float(np.mean((np.interp(x, cx, cy) - y) ** 2))
    out = {"k": k, "cx": cx, "cy": cy, "skill": {
        "test_years": f"{FIRST_TEST_YEAR}-{c['last']}",
        "auc": round(float(np.nanmean(aucs)), 3),
        "top10_capture_pct": round(float(np.mean(top10)) * 100, 1),
        "brier": round(brier, 3),
        "base_rate_brier": round(float(np.mean((y.mean() - y) ** 2)), 3),
    }}
    _calib[key] = out
    return out


def forecast_map(scope: str, year: int, enso: str = "observed") -> dict:
    c = cube()
    last = c["last"]
    if not (last < year <= last + 2):
        raise ValueError(f"year must be {last + 1} or {last + 2} (data ends {last})")
    cal = calibration()
    cells = c["cells"]
    keep = cells["region"].isin(scope_regions(scope)).to_numpy()

    lam = cal["k"] * _wmean(c, last + 1) * _region_factor(c, year, enso, None)
    P = np.interp(np.log(lam + 0.01), cal["cx"], cal["cy"])
    lam, P = lam[:, keep], P[:, keep]
    sc = cells[keep].reset_index(drop=True)
    areas = sorted(sc["area"].unique())
    a_idx = sc["area"].map({a: i for i, a in enumerate(areas)}).to_numpy()
    a_region = sc.groupby("area")["region"].first()

    months = []
    for m in range(12):
        sel = np.where(P[m] >= MIN_P)[0]
        # compact rows: lat, lon, chance %, expected fire days x10, area index
        rows = [[float(sc.at[i, "lat"]), float(sc.at[i, "lon"]), int(round(P[m, i] * 100)),
                 int(round(lam[m, i] * 10)), int(a_idx[i])] for i in sel]
        fd = pd.Series(lam[m]).groupby(a_idx).sum()
        hi = pd.Series(P[m] >= 0.5).groupby(a_idx).sum()
        pmax = pd.Series(P[m]).groupby(a_idx).max()
        tot = float(lam[m].sum())
        top = fd.sort_values(ascending=False).head(8)
        months.append({
            "month": m + 1, "expected_fire_days": round(tot, 1), "cells": rows,
            "top_areas": [{"area": areas[i], "region": a_region[areas[i]],
                           "expected_fire_days": round(float(v), 1),
                           "share_pct": round(float(v) / tot * 100, 1) if tot else 0,
                           "high_risk_cells": int(hi[i]), "max_chance_pct": int(round(pmax[i] * 100))}
                          for i, v in top.items()],
        })

    # area x month matrix (expected fire days), largest areas first
    mat = pd.DataFrame(lam.T).groupby(a_idx).sum()
    order = mat.sum(axis=1).sort_values(ascending=False).index
    matrix = [{"area": areas[i], "region": a_region[areas[i]],
               "values": [round(float(v), 1) for v in mat.loc[i]],
               "peak_month": int(np.argmax(mat.loc[i].to_numpy()) + 1),
               "total": round(float(mat.loc[i].sum()), 1)} for i in order]

    _x, enso_label, notes = F.enso_for_year(year, enso)
    return {
        "scope": scope, "year": year, "data_ends": last, "cell_deg": CELL, "enso_used": enso_label,
        "areas": areas, "months": months, "area_matrix": matrix,
        "skill": cal["skill"], "notes": notes,
    }
