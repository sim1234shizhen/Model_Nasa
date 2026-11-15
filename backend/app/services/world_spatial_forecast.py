"""Cell-level fire forecast for every country on the 1-degree global grid.

The regional model in spatial_forecast.py answers "which 0.25-degree cells are
likely to burn" for Malaysia and Indonesia. This module answers the same
question everywhere, using the harmonized global cell record and the country
boundaries from cell_dominant_country.csv.

For a country c and month m:

    w[cell,m]  = recency-weighted mean harmonized activity in that cell and month
                 (half-life 3 years, lightly smoothed with neighbouring months)
    R[c,m]     = the country's seasonal + ENSO multiplier, fitted on the
                 country-month totals in harmonized_country_monthly.csv
    lambda     = k * w * R          expected fire cell-days
    P(activity)= chance of at least one active cell, from a calibration curve
                 learned over the global backtest

The scale k and the probability curve are fitted once on 2018-2025, holding
each test year out of its own training set. The country multiplier uses only
the January-May ONI of the target year, so the backtest never sees the season
it is predicting.

This is a coarser product than the regional forecast: 1-degree cells instead
of 0.25-degree, harmonized counts instead of verified fire days, and one
structural model for all countries instead of a per-region model choice.
"""
from __future__ import annotations

import csv
import gzip
import threading
from functools import lru_cache

import numpy as np

from app.config import PROJECT_ROOT
from app.services import forecast as F

CELLS_CSV = PROJECT_ROOT / "Global_Dataset" / "cell_dominant_country.csv"
GRID_GZ = PROJECT_ROOT / "Global_Dataset" / "harmonized_cells_1deg.csv.gz"
MONTHLY_CSV = PROJECT_ROOT / "Global_Dataset" / "harmonized_country_monthly.csv"

CELL = 1.0
HALF_LIFE = 3.0
SMOOTH = 0.5
FIRST_TEST_YEAR = 2018
MIN_P = 0.05
N_BASE = 5
ABOVE_NORMAL = 1.5
DRY = np.array([m in (6, 7, 8, 9, 10, 11) for m in range(1, 13)])
ISSUE_MONTH = 5

_lock = threading.Lock()
_cache = None


def available() -> bool:
    return CELLS_CSV.exists() and GRID_GZ.exists() and MONTHLY_CSV.exists()


def _files_key() -> tuple[int, int, int]:
    return (CELLS_CSV.stat().st_mtime_ns, GRID_GZ.stat().st_mtime_ns,
            MONTHLY_CSV.stat().st_mtime_ns)


def _load() -> dict:
    global _cache
    if not available():
        raise FileNotFoundError("The global cell dataset is unavailable")
    key = _files_key()
    if _cache and _cache[0] == key:
        return _cache[1]
    with _lock:
        if _cache and _cache[0] == key:
            return _cache[1]

        meta = {}
        with CELLS_CSV.open(encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh):
                meta[(int(row["cx"]), int(row["cy"]))] = row["country"]

        monthly = list(csv.DictReader(MONTHLY_CSV.open(encoding="utf-8", newline="")))
        keys = sorted(meta)
        cell_index = {cell: i for i, cell in enumerate(keys)}
        countries = sorted(set(meta.values()) | {row["country"] for row in monthly})
        country_index = {name: i for i, name in enumerate(countries)}
        cell_country = np.array([country_index[meta[cell]] for cell in keys], dtype=np.int32)

        years = sorted({int(row["year"]) for row in monthly})
        year_index = {year: i for i, year in enumerate(years)}
        n_year, n_country, n_cell = len(years), len(countries), len(keys)

        counts = np.zeros((n_country, n_year, 12), dtype=np.float32)
        for row in monthly:
            counts[country_index[row["country"]], year_index[int(row["year"])],
                   int(row["month"]) - 1] = float(row["harmonized_count"])

        activity = np.zeros((n_year, 12, n_cell), dtype=np.float32)
        with gzip.open(GRID_GZ, "rt", encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh):
                cell = (int(row["cx"]), int(row["cy"]))
                activity[year_index[int(row["year"])], int(row["month"]) - 1,
                         cell_index[cell]] = float(row["h"])

        cx = np.array([cell[0] for cell in keys], dtype=float)
        cy = np.array([cell[1] for cell in keys], dtype=float)
        data = {
            "years": years,
            "year_index": year_index,
            "countries": countries,
            "country_index": country_index,
            "cell_country": cell_country,
            "activity": activity,
            "log_counts": np.log1p(counts),
            "counts": np.expm1(np.log1p(counts)),
            "lon": cx - 180.0,
            "lat": cy - 90.0,
            "last": years[-1],
        }
        _cache = (key, data)
        return data


def countries() -> list[str]:
    return _load()["countries"]


def warm_up() -> None:
    calibration(_files_key())
    map_outlook(_load()["last"] + 1, "observed")


def _wmean(c: dict, upto: int) -> np.ndarray:
    years = np.asarray(c["years"])
    take = [i for i, year in enumerate(years) if year < upto]
    if not take:
        return np.zeros((12, c["activity"].shape[2]))
    stack = c["activity"][take]
    decay = 0.5 ** ((upto - 1 - years[take]) / HALF_LIFE)
    weights = decay[:, None, None]
    mean = (stack * weights).sum(axis=0) / np.maximum(weights.sum(), 1e-9)
    return (mean + SMOOTH * (np.roll(mean, 1, axis=0) + np.roll(mean, -1, axis=0))) / (1 + 2 * SMOOTH)


def _design(oni: np.ndarray) -> np.ndarray:
    oni = np.where(np.isfinite(oni), oni, 0.0)
    dry = DRY.astype(float)
    return np.column_stack((dry * oni, (1 - dry) * oni))


def _oni_rows(years: list[int]) -> np.ndarray:
    table = F.oni_table()
    out = np.zeros((len(years), 12))
    if table is None:
        return out
    for i, year in enumerate(years):
        if year in table.index:
            row = table.loc[year].to_numpy(dtype=float)
            out[i] = np.where(np.isfinite(row), row, 0.0)
    return out


def _held_oni(year: int) -> np.ndarray:
    table = F.oni_table()
    x = np.full(12, np.nan)
    if table is not None and year in table.index:
        x[:ISSUE_MONTH] = table.loc[year].to_numpy(dtype=float)[:ISSUE_MONTH]
        known = np.where(np.isfinite(x))[0]
        if len(known):
            x[known.max() + 1:] = x[known.max()]
    return np.where(np.isfinite(x), x, 0.0)


def _base_rows(log_counts: np.ndarray, year_index: dict, years: list[int]) -> list[tuple[int, np.ndarray]]:
    rows = []
    first = years[0]
    for year in years:
        i = year_index[year]
        if year - N_BASE < first:
            continue
        rows.append((i, log_counts[:, i - N_BASE:i, :].mean(axis=1)))
    return rows


@lru_cache(maxsize=32)
def _factors(key: tuple, upto: int) -> dict:
    c = _load()
    years = c["years"]
    log_counts = c["log_counts"]
    rows = _base_rows(log_counts, c["year_index"], years)
    rows = [(i, base) for i, base in rows if years[i] < upto]
    if not rows:
        zero = np.zeros((len(c["countries"]), 2))
        return {"beta": zero, "bias": np.zeros(len(c["countries"]))}

    oni = _oni_rows([years[i] for i, _ in rows])
    design = np.stack([_design(oni[ri]) for ri in range(len(rows))])
    residual = np.stack([log_counts[:, i] - base for i, base in rows], axis=1)

    pooled_x = np.tile(design.reshape(-1, 2), (len(c["countries"]), 1))
    pooled_y = np.concatenate([residual[ci].reshape(-1) for ci in range(len(c["countries"]))])
    pooled = np.linalg.lstsq(pooled_x, pooled_y, rcond=None)[0]

    n_country = len(c["countries"])
    beta = np.tile(pooled, (n_country, 1))
    bias = np.zeros(n_country)
    for ci in range(n_country):
        x = design.reshape(-1, 2)
        y = residual[ci].reshape(-1)
        if len(y) >= max(12, 2 + 6) and np.all(np.isfinite(y)):
            fit = np.linalg.lstsq(x, y, rcond=None)[0]
            if np.all(np.isfinite(fit)):
                beta[ci] = fit
        adjusted = residual[ci] - design @ beta[ci]
        bias[ci] = float(np.median(adjusted))
    return {"beta": beta, "bias": bias}


def _factor(c: dict, country: str, year: int, enso: str, upto: int) -> tuple[np.ndarray, str, list[str]]:
    ci = c["country_index"][country]
    fit = _factors(_files_key(), upto)
    oni, label, notes = F.enso_for_year(year, enso)
    effect = _design(oni) @ fit["beta"][ci]
    return np.exp(effect + fit["bias"][ci]), label, notes


def _auc(score: np.ndarray, target: np.ndarray) -> float:
    pos, neg = int(target.sum()), len(target) - int(target.sum())
    if not pos or not neg:
        return float("nan")
    order = np.argsort(score, kind="mergesort")
    rank = np.empty(len(order))
    rank[order] = np.arange(1, len(order) + 1)
    return float((rank[target].sum() - pos * (pos + 1) / 2) / (pos * neg))


@lru_cache(maxsize=4)
def calibration(key: tuple) -> dict:
    c = _load()
    last = c["last"]
    weights = _wmean(c, last + 1)
    test_years = [year for year in c["years"] if FIRST_TEST_YEAR <= year <= last]
    lams, acts, aucs, captures = [], [], [], []
    for year in test_years:
        fit = _factors(key, year)
        effect = _design(_held_oni(year)) @ fit["beta"].T + fit["bias"][None, :]
        factor = np.exp(effect)
        lam = weights * factor[:, c["cell_country"]]
        lams.append(lam)
        acts.append(c["activity"][c["year_index"][year]])
    lam_all = np.stack(lams)
    act_all = np.stack(acts)
    k = float(act_all.sum() / max(lam_all.sum(), 1e-9))
    lam_all *= k
    for lam, act in zip(lam_all, act_all):
        for month in range(12):
            target = act[month] > 0
            aucs.append(_auc(lam[month], target))
            n_top = max(1, int(0.1 * lam.shape[1]))
            top = np.argsort(-lam[month])[:n_top]
            captures.append(act[month, top].sum() / max(act[month].sum(), 1))

    x = np.log(lam_all.ravel() + 0.01)
    y = (act_all.ravel() > 0).astype(float)
    edges = np.unique(np.quantile(x, np.linspace(0, 1, 26)))
    idx = np.clip(np.searchsorted(edges, x, side="right") - 1, 0, len(edges) - 2)
    cx = np.array([x[idx == i].mean() for i in range(len(edges) - 1)])
    cy = np.maximum.accumulate(np.array([y[idx == i].mean() for i in range(len(edges) - 1)]))
    brier = float(np.mean((np.interp(x, cx, cy) - y) ** 2))
    return {
        "k": k,
        "cx": cx,
        "cy": cy,
        "skill": {
            "test_years": f"{test_years[0]}-{test_years[-1]}",
            "auc": round(float(np.nanmean(aucs)), 3),
            "top10_capture_pct": round(float(np.mean(captures)) * 100, 1),
            "brier": round(brier, 3),
            "base_rate_brier": round(float(np.mean((y.mean() - y) ** 2)), 3),
        },
    }


def _summary(c: dict, country: str, year: int, enso: str) -> dict:
    ci = c["country_index"][country]
    last = c["last"]
    log_counts = c["log_counts"][ci]
    years = c["years"]
    fit = _factors(_files_key(), last + 1)
    oni, label, notes = F.enso_for_year(year, enso)
    effect = _design(oni) @ fit["beta"][ci]
    base = log_counts[c["year_index"][last] - N_BASE + 1:c["year_index"][last] + 1].mean(axis=0)
    pred = base + effect + fit["bias"][ci]

    rows = []
    for year_value in years:
        index = c["year_index"][year_value]
        if year_value - N_BASE < years[0]:
            continue
        rows.append((index, log_counts[index - N_BASE:index].mean(axis=0)))
    train_oni = _oni_rows([years[i] for i, _ in rows])
    train_design = np.stack([_design(train_oni[ri]) for ri in range(len(rows))])
    residual = np.stack([log_counts[i] - row_base for i, row_base in rows])
    adjusted = residual - train_design @ fit["beta"][ci]
    centred = adjusted - np.median(adjusted)
    low_q, high_q = np.quantile(centred, [0.1, 0.9])

    actual = c["counts"][ci]
    typical = np.median(actual, axis=0)
    expected = np.expm1(pred)
    months = []
    for month in range(12):
        past = actual[:, month]
        rank = int((past > expected[month]).sum()) + 1
        worst = int(np.argmax(past))
        months.append({
            "month": month + 1,
            "expected": round(float(expected[month]), 1),
            "low": round(float(max(0.0, np.expm1(pred[month] + low_q))), 1),
            "high": round(float(max(0.0, np.expm1(pred[month] + high_q))), 1),
            "typical": round(float(typical[month]), 1),
            "ratio_to_typical": round(float(expected[month] / typical[month]), 2) if typical[month] > 0 else None,
            "p_above_normal": round(float(np.mean(pred[month] + centred >= np.log1p(ABOVE_NORMAL * typical[month]))), 2),
            "oni": None if not np.isfinite(oni[month]) else round(float(oni[month]), 2),
            "enso_multiplier": round(float(np.exp(effect[month])), 2),
            "rank": rank,
            "years_compared": len(past),
            "first_year": int(years[0]),
            "worst_year": int(years[worst]),
            "worst_value": round(float(past[worst]), 1),
            "history": [round(float(value), 1) for value in past],
        })
    return {"months": months, "data_ends": last, "enso_used": label, "notes": notes,
            "model": "seasonal + ENSO"}


def map_outlook(year: int, enso: str = "observed") -> dict:
    return _map_outlook(_files_key(), year, enso)


@lru_cache(maxsize=8)
def _map_outlook(key: tuple, year: int, enso: str) -> dict:
    from app.services import world_outlook

    c = _load()
    last = c["last"]
    if not (last < year <= last + 2):
        raise ValueError(f"year must be {last + 1} or {last + 2} (data ends {last})")
    cal = calibration(key)
    weights = _wmean(c, last + 1)
    fit = _factors(key, last + 1)
    oni, label, _notes = F.enso_for_year(year, enso)
    effect = _design(oni) @ fit["beta"].T + fit["bias"][None, :]
    factor = np.exp(effect)
    shapes = {entry["country"]: entry for entry in world_outlook.map_outlook().get("countries", [])}

    entries = []
    for name in c["countries"]:
        meta = shapes.get(name, {})
        ci = c["country_index"][name]
        mask = c["cell_country"] == ci
        if mask.any():
            lam = cal["k"] * weights[:, mask] * factor[:, ci][:, None]
            chance = np.interp(np.log(lam + 0.01), cal["cx"], cal["cy"])
            high = (chance >= 0.5).sum(axis=1)
            peak = np.rint(chance.max(axis=1) * 100)
            expected = np.rint(lam.sum(axis=1))
        else:
            high = peak = expected = np.zeros(12)
        top = max(float(high.max()), 1.0)
        entries.append({
            "country": name,
            "shapes": meta.get("shapes", []),
            "center": meta.get("center"),
            "months": {str(month + 1): [int(high[month]), round(float(high[month]) / top, 3)]
                       for month in range(12)},
            "peak": {str(month + 1): int(peak[month]) for month in range(12)},
            "expected": {str(month + 1): int(expected[month]) for month in range(12)},
        })
    return {"year": year, "enso_used": label, "cell_deg": CELL,
            "model": "seasonal + ENSO", "countries": entries}


def forecast_map(country: str, year: int, enso: str = "observed") -> dict:
    c = _load()
    if country not in c["country_index"]:
        raise KeyError(country)
    last = c["last"]
    if not (last < year <= last + 2):
        raise ValueError(f"year must be {last + 1} or {last + 2} (data ends {last})")

    cal = calibration(_files_key())
    ci = c["country_index"][country]
    mask = c["cell_country"] == ci
    weights = _wmean(c, last + 1)[:, mask]
    factor, label, notes = _factor(c, country, year, enso, last + 1)
    lam = cal["k"] * weights * factor[:, None]
    chance = np.interp(np.log(lam + 0.01), cal["cx"], cal["cy"])

    lat = c["lat"][mask]
    lon = c["lon"][mask]
    summary = _summary(c, country, year, enso)
    months = []
    for month in range(12):
        selected = np.where(chance[month] >= MIN_P)[0]
        rows = [[float(lat[i]), float(lon[i]), int(round(chance[month, i] * 100)),
                 int(round(lam[month, i] * 10)), 0] for i in selected]
        total = float(lam[month].sum())
        max_chance = int(round(chance[month].max() * 100)) if chance.shape[1] else 0
        detail = summary["months"][month]
        if detail["expected"] > 0:
            detail["low"] = round(detail["low"] * total / detail["expected"], 1)
            detail["high"] = round(detail["high"] * total / detail["expected"], 1)
        detail["expected"] = round(total, 1)
        detail["ratio_to_typical"] = round(total / detail["typical"], 2) if detail["typical"] > 0 else None
        detail["rank"] = int(sum(value > total for value in detail["history"])) + 1
        months.append({
            "month": month + 1,
            "expected_fire_days": round(total, 1),
            "cells": rows,
            "top_areas": [{
                "area": country,
                "region": country,
                "expected_fire_days": round(total, 1),
                "share_pct": 100.0,
                "high_risk_cells": int((chance[month] >= 0.5).sum()) if chance.shape[1] else 0,
                "max_chance_pct": max_chance,
            }],
        })

    totals = [month["expected_fire_days"] for month in months]
    for detail in summary["months"]:
        detail.pop("history", None)
    matrix = [{
        "area": country,
        "region": country,
        "values": totals,
        "peak_month": int(np.argmax(totals)) + 1,
        "total": round(sum(totals), 1),
    }]

    notes = list(notes)
    notes.append("Global cells are 1 degree (~110 km), not the regional 0.25-degree grid.")
    notes.append("Expected fire cell-days come from harmonized counts, not verified daily fire days.")
    return {
        "scope": country,
        "country": country,
        "year": year,
        "data_ends": last,
        "cell_deg": CELL,
        "enso_used": label,
        "cells": int(mask.sum()),
        "areas": [country],
        "months": months,
        "area_matrix": matrix,
        "summary": summary["months"],
        "model": summary["model"],
        "skill": cal["skill"],
        "notes": notes,
    }
