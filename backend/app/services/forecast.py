"""Fire-activity forecast for the months after the data ends.

Model (per area), all in log space  L = log(1 + fire cell-days):
    L[y, m] = baseline[m] + ENSO effect + bias
    baseline[m]  = mean of L for month m over the last 5 years (captures the recent decline)
    ENSO effect  = slope * ONI[y, m], one slope for the dry season (Jun-Nov), one for the rest
    bias         = median training residual (the baseline tends to overshoot)

ONI = NOAA Oceanic Nino Index (El Nino > +0.5, La Nina < -0.5), downloaded from NOAA CPC
and cached in backend/.cache/oni.txt. If it can't be downloaded the model runs without ENSO.

Every area is backtested 2013..last year (train only on earlier years, predict the
whole year). ENSO is kept for an area only if it lowers the backtest error there.
The 80% band comes from the spread of past forecast errors.
"""
from __future__ import annotations

import io
import threading
import time
import urllib.request

import numpy as np
import pandas as pd

from app.config import CACHE_DIR, HARMONIZED_CSV
from app.services.harmonized import harmonized, scope_regions

ONI_URL = "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt"
ONI_CACHE = CACHE_DIR / "oni.txt"
ONI_MAX_AGE_S = 7 * 24 * 3600
SEASONS = ["DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ", "JJA", "JAS", "ASO", "SON", "OND", "NDJ"]  # centred on Jan..Dec

N_BASE = 5                     # baseline = last 5 years
FIRST_TEST_YEAR = 2013         # backtest years: 2013 .. last data year
DRY = np.array([m in (6, 7, 8, 9, 10, 11) for m in range(1, 13)])
ABOVE_NORMAL = 1.5             # "above normal" = 1.5x the same-month median

_lock = threading.Lock()
_oni: tuple[float, pd.DataFrame] | None = None
_bt_cache: dict[tuple, dict] = {}


# ---------------------------------------------------------------- ONI
def refresh_oni(force: bool = False) -> None:
    fresh = ONI_CACHE.exists() and time.time() - ONI_CACHE.stat().st_mtime < ONI_MAX_AGE_S
    if fresh and not force:
        return
    try:
        req = urllib.request.Request(ONI_URL, headers={"User-Agent": "fire-calendar-hackathon/0.1"})
        with urllib.request.urlopen(req, timeout=20) as r:
            txt = r.read().decode("utf-8", "replace")
        if "ANOM" not in txt:
            raise ValueError("unexpected ONI format")
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        ONI_CACHE.write_text(txt, encoding="utf-8")
    except Exception as e:  # offline -> keep the old cache (if any)
        print(f"[forecast] ONI download failed: {e}")


def oni_table() -> pd.DataFrame | None:
    """year x month (1..12) table of ONI anomalies, or None if unavailable."""
    global _oni
    refresh_oni()
    if not ONI_CACHE.exists():
        return None
    mtime = ONI_CACHE.stat().st_mtime
    if _oni and _oni[0] == mtime:
        return _oni[1]
    o = pd.read_csv(io.StringIO(ONI_CACHE.read_text(encoding="utf-8")), sep=r"\s+")
    o["month"] = o["SEAS"].map({s: i + 1 for i, s in enumerate(SEASONS)})
    t = o.pivot_table(index="YR", columns="month", values="ANOM")
    t = t.reindex(columns=range(1, 13))
    _oni = (mtime, t)
    return t


def oni_info() -> dict:
    t = oni_table()
    if t is None:
        return {"available": False}
    s = t.stack().dropna()
    (y, m), v = s.index[-1], float(s.iloc[-1])
    state = "El Niño" if v >= 0.5 else "La Niña" if v <= -0.5 else "Neutral"
    return {"available": True, "latest_year": int(y), "latest_month": int(m), "latest_season": SEASONS[m - 1],
            "latest_value": round(v, 2), "state": state, "source": ONI_URL}


# ---------------------------------------------------------------- model
def _log_matrix(scope: str) -> pd.DataFrame:
    h = harmonized()
    d = h[h["region"].isin(scope_regions(scope))]
    g = d.groupby(["year", "month"])["harmonized_count"].sum().unstack("month")
    g = g.reindex(columns=range(1, 13)).fillna(0)
    return np.log1p(g)


def _base(L: pd.DataFrame, y: int) -> np.ndarray:
    return L.loc[y - N_BASE:y - 1].mean().to_numpy()


def _oni_row(oni, y) -> np.ndarray:
    if oni is None or y not in oni.index:
        return np.full(12, np.nan)
    return oni.loc[y].to_numpy(dtype=float, copy=True)  # copy: callers fill gaps in place


def _residuals(L, oni, years) -> pd.DataFrame:
    rows = []
    first = L.index.min()
    for y in years:
        if y - N_BASE < first:
            continue
        r = L.loc[y].to_numpy() - _base(L, y)
        x = _oni_row(oni, y)
        rows += [(y, m + 1, r[m], x[m]) for m in range(12)]
    return pd.DataFrame(rows, columns=["year", "month", "r", "oni"])


def _fit(t: pd.DataFrame, use_enso: bool):
    if not use_enso:
        return None
    t = t.dropna(subset=["oni"])
    dry = t["month"].isin(np.where(DRY)[0] + 1)
    if dry.sum() < 6 or (~dry).sum() < 6:
        return None
    return {"dry": np.polyfit(t.loc[dry, "oni"], t.loc[dry, "r"], 1)[0],
            "wet": np.polyfit(t.loc[~dry, "oni"], t.loc[~dry, "r"], 1)[0]}


def _effect(p, x: np.ndarray, months: np.ndarray | None = None) -> np.ndarray:
    """ENSO effect for ONI values x (months 1..12 by position, or given)."""
    if p is None:
        return np.zeros(len(x))
    m = np.arange(1, 13) if months is None else months
    dry = DRY[m - 1]
    return np.where(dry, p["dry"], p["wet"]) * np.nan_to_num(x)


def _train(L, oni, upto: int, use_enso: bool):
    """Fit on residual years < upto. Returns (params, adjusted residuals, residual table)."""
    t = _residuals(L, oni, range(L.index.min(), upto))
    p = _fit(t, use_enso)
    adj = t["r"].to_numpy() - _effect(p, t["oni"].to_numpy(), t["month"].to_numpy())
    return p, adj, t


def _backtest(L, oni, use_enso: bool) -> dict:
    last = int(L.index.max())
    res, cover = [], []
    for y in range(FIRST_TEST_YEAR, last + 1):
        p, adj, _ = _train(L, oni, y, use_enso)
        bias = np.median(adj)
        lo, hi = np.quantile(adj - bias, [0.1, 0.9])
        pred = _base(L, y) + _effect(p, _oni_row(oni, y)) + bias
        a = L.loc[y].to_numpy()
        res += list(a - pred)
        cover += list((a >= pred + lo) & (a <= pred + hi))
    res = np.array(res)
    return {"log_rmse": round(float(np.sqrt((res ** 2).mean())), 3),
            "median_abs_pct_err": round(float(np.median(np.abs(np.expm1(res)))) * 100, 1),
            "coverage_80": round(float(np.mean(cover)) * 100, 1),
            "test_years": f"{FIRST_TEST_YEAR}-{last}"}


def model_choice(scope: str) -> dict:
    L = _log_matrix(scope)
    oni = oni_table()
    key = (scope, HARMONIZED_CSV.stat().st_mtime, None if _oni is None else _oni[0])
    with _lock:
        if key in _bt_cache:
            return _bt_cache[key]
    base = _backtest(L, oni, False)
    enso = _backtest(L, oni, True) if oni is not None else None
    use_enso = bool(enso and enso["log_rmse"] < base["log_rmse"])
    out = {"use_enso": use_enso, "seasonal": base, "seasonal_enso": enso,
           "chosen": enso if use_enso else base}
    with _lock:
        _bt_cache[key] = out
    return out


def enso_for_year(year: int, enso: str) -> tuple[np.ndarray, str, list[str]]:
    """ONI values (12 months) for the forecast year: observed (gaps held) or a scenario."""
    oni = oni_table()
    notes = []
    if enso == "observed":
        x = _oni_row(oni, year)
        known = ~np.isnan(x)
        if known.any():
            last_known = int(np.where(known)[0].max())
            if last_known < 11:
                x[last_known + 1:] = x[last_known]
                notes.append(f"ONI observed to {SEASONS[last_known]} {year}; later months hold the latest value.")
            return x, "NOAA observed El Niño index", notes
        notes.append(f"No observed ONI for {year} yet, so neutral conditions (ONI 0) are assumed.")
        return np.zeros(12), "Neutral (no observation yet)", notes
    v = float(enso)
    return np.full(12, v), f"Scenario: ONI {v:+.1f} all year", notes


def area_factor(scope: str, year: int, enso: str = "observed", train_upto: int | None = None) -> np.ndarray:
    """Multiplier vs the recent baseline for each month: exp(ENSO effect + bias).
    Used by the spatial forecast to scale each region's cells."""
    L = _log_matrix(scope)
    upto = int(L.index.max()) + 1 if train_upto is None else train_upto
    p, adj, _ = _train(L, oni_table(), upto, model_choice(scope)["use_enso"])
    if train_upto is not None and enso == "observed":
        x = np.nan_to_num(_oni_row(oni_table(), year))  # backtest: the year's actual ONI
    else:
        x = enso_for_year(year, enso)[0]
    return np.exp(_effect(p, x) + float(np.median(adj)))


def forecast(scope: str, year: int, enso: str = "observed") -> dict:
    L = _log_matrix(scope)
    last, first = int(L.index.max()), int(L.index.min())
    if not (last < year <= last + 2):
        raise ValueError(f"year must be {last + 1} or {last + 2} (data ends {last})")
    oni = oni_table()
    choice = model_choice(scope)
    use_enso = choice["use_enso"]

    p, adj, t = _train(L, oni, last + 1, use_enso)
    bias = float(np.median(adj))
    centred = adj - bias
    q_lo, q_hi = np.quantile(centred, [0.1, 0.9])

    # ONI used for the forecast year
    x, enso_label, notes = enso_for_year(year, enso)
    if not use_enso:
        notes.append("El Niño did not improve the backtest for this area, so it is not used here.")

    base = L.loc[last - N_BASE + 1:last].mean().to_numpy()
    eff = _effect(p, x)
    pred = base + eff + bias

    h = np.expm1(L)  # counts
    typical = h.median().to_numpy()  # same-month median, all years
    thr = np.log1p(ABOVE_NORMAL * typical)
    p_above = [(pred[m] + centred >= thr[m]).mean() for m in range(12)]

    # annual range: apply each past year's whole error pattern (keeps months correlated)
    by_year = t.assign(c=centred).pivot(index="year", columns="month", values="c").to_numpy()
    annual_samples = np.expm1(pred + by_year).sum(axis=1)

    months = [{
        "month": m + 1,
        "expected": round(float(np.expm1(pred[m])), 1),
        "low": round(float(max(0.0, np.expm1(pred[m] + q_lo))), 1),
        "high": round(float(np.expm1(pred[m] + q_hi)), 1),
        "typical": round(float(typical[m]), 1),
        "ratio_to_typical": round(float(np.expm1(pred[m]) / typical[m]), 2) if typical[m] > 0 else None,
        "p_above_normal": round(float(p_above[m]), 2),
        "oni": None if np.isnan(x[m]) else round(float(x[m]), 2),
        "enso_multiplier": round(float(np.exp(eff[m])), 2),
    } for m in range(12)]

    hist = h.reindex(range(last - 1, last + 1))
    recent = [{"year": int(y), "month": int(m), "value": round(float(hist.loc[y, m]), 1)}
              for y in hist.index for m in range(1, 13)]
    annual_typical = float(h.sum(axis=1).median())

    return {
        "scope": scope, "year": year, "data_ends": last,
        "model": "seasonal + ENSO" if use_enso else "seasonal",
        "enso_used": enso_label, "enso_slope": None if p is None else {k: round(float(v), 3) for k, v in p.items()},
        "months": months,
        "annual": {"expected": round(float(np.expm1(pred).sum()), 0),
                   "low": round(float(np.quantile(annual_samples, 0.1)), 0),
                   "high": round(float(np.quantile(annual_samples, 0.9)), 0),
                   "typical": round(annual_typical, 0)},
        "recent": recent,
        "backtest": choice,
        "above_normal_threshold": ABOVE_NORMAL,
        "notes": notes,
        "oni": oni_info(),
    }
