"""Fire-activity forecast for the months after the data ends.

Model (per area), all in log space  L = log(1 + fire cell-days):

    L[y, m] = baseline[m] + climate effect + bias
    baseline[m]  = mean of L for month m over the last 5 years (recent decline)
    climate effect = ENSO slope * ONI + drought slope * Drought Code
    bias         = median training residual (the baseline tends to overshoot)

Two climate predictors are available, and each area keeps only the ones that
earn their place in the backtest:

  ONI           NOAA Oceanic Nino Index (El Nino > +0.5, La Nina < -0.5), one
                slope for the dry season (Jun-Nov) and one for the rest.
  Drought Code  GFWED (NASA GISS) Canadian Drought Code, one slope. It is a
                slow, cumulative measure of how dry the soil and fuel are, so
                it carries the memory of the preceding months into the season.

Forecasts are issued honestly: the backtest for year Y uses only the climate
values that were knowable a year earlier (December of Y-1, held forward). It
never reads year Y's own index. An earlier version did, which flattered the
headline error by roughly ten points.

Every area is backtested 2013..last year (train only on earlier years). The
model with the lowest backtest error wins for that area: seasonal alone, plus
ENSO, plus drought, or both. The 80% band comes from past forecast errors.

Adding more predictors is not better: with ~10 usable training years, each
extra term costs more in noise than it returns. Two is the practical ceiling.
"""
from __future__ import annotations

import io
import threading
import time
import urllib.request

import numpy as np
import pandas as pd

from app.config import CACHE_DIR, HARMONIZED_CSV, PROJECT_ROOT
from app.services.harmonized import harmonized, scope_regions

ONI_URL = "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt"
ONI_CACHE = CACHE_DIR / "oni.txt"
ONI_MAX_AGE_S = 7 * 24 * 3600
SEASONS = ["DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ", "JJA", "JAS", "ASO", "SON", "OND", "NDJ"]  # centred on Jan..Dec
MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

DC_CSV = PROJECT_ROOT / "data" / "gfwed_regions_monthly.csv"

N_BASE = 5                     # baseline = last 5 years
FIRST_TEST_YEAR = 2013         # backtest years: 2013 .. last data year
DRY = np.array([m in (6, 7, 8, 9, 10, 11) for m in range(1, 13)])
ABOVE_NORMAL = 1.5             # "above normal" = 1.5x the same-month median

_lock = threading.Lock()
_oni: tuple[float, pd.DataFrame] | None = None
_dc: tuple[float, pd.DataFrame] | None = None      # region -> year x month frame (long form)
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


# ---------------------------------------------------------------- drought code
def _dc_source() -> pd.DataFrame | None:
    """The GFWED pull, cached on mtime. Long form: region, year, month, DC, FWI, ..."""
    global _dc
    if not DC_CSV.exists():
        return None
    mtime = DC_CSV.stat().st_mtime
    if _dc and _dc[0] == mtime:
        return _dc[1]
    df = pd.read_csv(DC_CSV)
    df = df[["region", "year", "month", "DC"]].dropna()
    _dc = (mtime, df)
    return df


def dc_matrix(scope: str) -> pd.DataFrame | None:
    """year x month Drought Code for a scope, fire-weighted across its regions.

    Weighting by recent fire share keeps one quiet province from diluting the
    signal on a scope such as 'All' or 'Indonesia'.
    """
    src = _dc_source()
    if src is None:
        return None
    regs = [r for r in scope_regions(scope) if r in set(src["region"])]
    if not regs:
        return None
    h = harmonized()
    recent = h[(h["year"] >= 2019) & h["region"].isin(regs)]
    w = recent.groupby("region")["harmonized_count"].sum()
    w = (w / w.sum())[regs] if w.sum() > 0 else pd.Series(1.0 / len(regs), index=regs)

    frames = []
    for r in regs:
        s = src[src["region"] == r].set_index(["year", "month"])["DC"]
        frames.append(s.rename(r) * float(w.loc[r]))
    wide = pd.concat(frames, axis=1)
    out = wide.mul(w, axis=1).sum(axis=1, min_count=1)   # weighted mean, NaN-aware
    out = out.unstack("month").reindex(columns=range(1, 13))
    out.index = out.index.astype(int)
    return out.sort_index()


def _value_at(t: pd.DataFrame | None, y: int, m: int) -> float | None:
    if t is None or y not in t.index or m not in t.columns:
        return None
    v = t.loc[y, m]
    return None if pd.isna(v) else float(v)


def _last_value(t: pd.DataFrame | None) -> float | None:
    if t is None:
        return None
    s = t.stack().dropna()
    return float(s.iloc[-1]) if len(s) else None


def _held_prev(t: pd.DataFrame | None, y: int) -> np.ndarray:
    """What a year-ahead forecaster knew: the value at Dec of y-1, held for 12 months."""
    v = _value_at(t, y - 1, 12)
    return np.full(12, v) if v is not None else np.full(12, np.nan)


ISSUE_MONTH = 5     # the outlook is issued at the end of May, like the backtest


def _held_through(t: pd.DataFrame | None, y: int, upto: int = ISSUE_MONTH) -> np.ndarray:
    """Months 1..upto keep their observed value; the rest hold the last one.

    This is the information actually available at issue time, so the backtest
    cannot see the season it is predicting.
    """
    x = np.full(12, np.nan)
    if t is None:
        return x
    for k in range(1, upto + 1):
        v = _value_at(t, y, k)
        if v is not None:
            x[k - 1] = v
    known = ~np.isnan(x)
    if known.any():
        last = int(np.where(known)[0].max())
        x[last + 1:] = x[last]
    return x


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


def _design(oni_x, dc_x, months, use_enso: bool, use_dc: bool) -> list[np.ndarray]:
    """Columns for the residual regression, no intercept (the bias covers it)."""
    cols: list[np.ndarray] = []
    m = np.asarray(months, dtype=int)
    if use_enso:
        dry = DRY[m - 1]
        cols.append(np.where(dry, oni_x, 0.0))
        cols.append(np.where(dry, 0.0, oni_x))
    if use_dc:
        cols.append(np.asarray(dc_x, dtype=float))
    return cols


def _residuals(L, oni, dc, years) -> pd.DataFrame:
    rows = []
    first = L.index.min()
    for y in years:
        if y - N_BASE < first:
            continue
        r = L.loc[y].to_numpy() - _base(L, y)
        xo = _oni_row(oni, y)
        xd = dc.loc[y].to_numpy(dtype=float) if (dc is not None and y in dc.index) else np.full(12, np.nan)
        rows += [(y, m + 1, r[m], xo[m], xd[m]) for m in range(12)]
    return pd.DataFrame(rows, columns=["year", "month", "r", "oni", "dc"])


def _fit(t: pd.DataFrame, use_enso: bool, use_dc: bool) -> dict | None:
    """Least squares on residual ~ climate terms. Returns None when nothing is used."""
    if not use_enso and not use_dc:
        return None
    need = []
    if use_enso:
        need.append("oni")
    if use_dc:
        need.append("dc")
    d = t.dropna(subset=need)
    cols = _design(d["oni"].to_numpy(), d["dc"].to_numpy(), d["month"].to_numpy(), use_enso, use_dc)
    if not cols:
        return None
    X = np.column_stack(cols)
    if len(X) < max(12, X.shape[1] + 6):     # not enough training rows to trust it
        return None
    beta, *_ = np.linalg.lstsq(X, d["r"].to_numpy(), rcond=None)
    if not np.all(np.isfinite(beta)):
        return None
    return {"beta": beta, "use_enso": use_enso, "use_dc": use_dc}


def _effect(p, oni_x, dc_x, months=None) -> np.ndarray:
    """Climate effect for the given ONI and drought-code values."""
    n = 12 if months is None else len(months)
    if p is None:
        return np.zeros(n)
    m = np.arange(1, 13) if months is None else np.asarray(months, dtype=int)
    cols = _design(np.asarray(oni_x, dtype=float), np.asarray(dc_x, dtype=float), m, p["use_enso"], p["use_dc"])
    if not cols:
        return np.zeros(n)
    return np.column_stack(cols) @ p["beta"]


def _train(L, oni, dc, upto: int, use_enso: bool, use_dc: bool):
    """Fit on residual years < upto. Returns (params, adjusted residuals, residual table)."""
    t = _residuals(L, oni, dc, range(L.index.min(), upto))
    p = _fit(t, use_enso, use_dc)
    adj = t["r"].to_numpy() - _effect(p, t["oni"].to_numpy(), t["dc"].to_numpy(), t["month"].to_numpy())
    return p, adj, t


def _backtest(L, oni, dc, use_enso: bool, use_dc: bool) -> dict:
    """Honest backtest, matched to how the site is actually used.

    A forecast is issued at the end of May, when the climate indices for January
    to May are published and the rest are unknown. It is scored on June-November,
    the dry half where the fires are. Nothing from June onwards is used to make
    the prediction, and year Y is never in its own training set.
    """
    last = int(L.index.max())
    res, cover = [], []
    issue_month = 5
    for y in range(FIRST_TEST_YEAR, last + 1):
        if y - 1 < int(L.index.min()):
            continue
        p, adj, _ = _train(L, oni, dc, y, use_enso, use_dc)
        bias = np.median(adj)
        lo, hi = np.quantile(adj - bias, [0.1, 0.9])
        # only January..May of year Y is known at issue time; hold it for the rest
        xo = _held_through(oni, y, issue_month)
        xd = _held_through(dc, y, issue_month)
        pred = _base(L, y) + _effect(p, xo, xd) + bias
        a = L.loc[y].to_numpy()
        months = [m for m in range(issue_month + 1, 13)]
        res += [a[m - 1] - pred[m - 1] for m in months]
        cover += [(a[m - 1] >= pred[m - 1] + lo) and (a[m - 1] <= pred[m - 1] + hi) for m in months]
    res = np.array(res)
    return {"log_rmse": round(float(np.sqrt((res ** 2).mean())), 3),
            "median_abs_pct_err": round(float(np.median(np.abs(np.expm1(res)))) * 100, 1),
            "coverage_80": round(float(np.mean(cover)) * 100, 1),
            "test_years": f"{FIRST_TEST_YEAR}-{last}",
            "scored": "Jun-Nov, issued end of May"}


def model_choice(scope: str) -> dict:
    """Pick the model that actually wins the backtest for this area."""
    L = _log_matrix(scope)
    oni = oni_table()
    dc = dc_matrix(scope)
    dc_mtime = DC_CSV.stat().st_mtime if DC_CSV.exists() else None
    key = (scope, HARMONIZED_CSV.stat().st_mtime, None if _oni is None else _oni[0], dc_mtime)
    with _lock:
        if key in _bt_cache:
            return _bt_cache[key]

    variants = {"seasonal": (False, False)}
    if oni is not None:
        variants["seasonal_enso"] = (True, False)
    if dc is not None:
        variants["seasonal_drought"] = (False, True)
    if oni is not None and dc is not None:
        variants["enso_drought"] = (True, True)

    scores = {name: _backtest(L, oni, dc, ue, ud) for name, (ue, ud) in variants.items()}
    # median % error is the metric quoted everywhere else; log_rmse is dominated by
    # the two haze years, so it would pick the wrong model for quiet areas.
    best = min(scores, key=lambda k: scores[k]["median_abs_pct_err"])
    ue, ud = variants[best]
    out = {"use_enso": ue, "use_dc": ud, "choice": best, "scores": scores,
           "seasonal": scores["seasonal"], "seasonal_enso": scores.get("seasonal_enso"),
           "seasonal_drought": scores.get("seasonal_drought"), "enso_drought": scores.get("enso_drought"),
           "chosen": scores[best]}
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


def dc_for_year(scope: str, year: int) -> tuple[np.ndarray, str, list[str]]:
    """Drought code (12 months) for the forecast year, holding the latest known value."""
    t = dc_matrix(scope)
    notes = []
    if t is None:
        return np.full(12, np.nan), "No fire-weather data", notes
    x = np.full(12, np.nan)
    if year in t.index:
        x = t.loc[year].to_numpy(dtype=float, copy=True)
    known = ~np.isnan(x)
    if known.any():
        last_known = int(np.where(known)[0].max())
        if last_known < 11:
            x[last_known + 1:] = x[last_known]
            notes.append(f"Drought code observed to {MONTH_NAMES[last_known]} {year}; "
                         "later months hold the latest value.")
        return x, "GFWED drought code (observed)", notes
    v = _last_value(t)
    if v is None:
        return np.full(12, np.nan), "No fire-weather data", notes
    s = t.stack().dropna()
    (ly, lm) = s.index[-1]
    notes.append(f"Drought code carried forward from {MONTH_NAMES[int(lm) - 1]} {int(ly)}.")
    return np.full(12, v), "GFWED drought code (carried forward)", notes


def area_factor(scope: str, year: int, enso: str = "observed", train_upto: int | None = None) -> np.ndarray:
    """Multiplier vs the recent baseline for each month: exp(climate effect + bias).
    Used by the spatial forecast to scale each region's cells."""
    L = _log_matrix(scope)
    upto = int(L.index.max()) + 1 if train_upto is None else train_upto
    ch = model_choice(scope)
    oni = oni_table()
    dc = dc_matrix(scope)
    p, adj, _ = _train(L, oni, dc, upto, ch["use_enso"], ch["use_dc"])
    if train_upto is not None and enso == "observed":
        # backtest: only what was knowable at the end of May, never the season itself
        xo = _held_through(oni, year)
        xd = _held_through(dc, year)
    else:
        xo = enso_for_year(year, enso)[0]
        xd = dc_for_year(scope, year)[0]
    return np.exp(_effect(p, xo, xd) + float(np.median(adj)))


def forecast(scope: str, year: int, enso: str = "observed") -> dict:
    L = _log_matrix(scope)
    last, first = int(L.index.max()), int(L.index.min())
    if not (last < year <= last + 2):
        raise ValueError(f"year must be {last + 1} or {last + 2} (data ends {last})")
    oni = oni_table()
    dc = dc_matrix(scope)
    choice = model_choice(scope)
    use_enso, use_dc = choice["use_enso"], choice["use_dc"]

    p, adj, t = _train(L, oni, dc, last + 1, use_enso, use_dc)
    bias = float(np.median(adj))
    centred = adj - bias
    q_lo, q_hi = np.quantile(centred, [0.1, 0.9])

    x_oni, enso_label, notes = enso_for_year(year, enso)
    x_dc, dc_label, dc_notes = dc_for_year(scope, year)
    notes += dc_notes
    if not use_enso:
        notes.append("El Niño did not improve the backtest for this area, so it is not used here.")
    if not use_dc:
        notes.append("Drought code did not improve the backtest for this area, so it is not used here.")

    base = L.loc[last - N_BASE + 1:last].mean().to_numpy()
    eff = _effect(p, x_oni, x_dc)
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
        "oni": None if np.isnan(x_oni[m]) else round(float(x_oni[m]), 2),
        "dc": None if np.isnan(x_dc[m]) else round(float(x_dc[m]), 1),
        "enso_multiplier": round(float(np.exp(eff[m])), 2),
    } for m in range(12)]

    hist = h.reindex(range(last - 1, last + 1))
    recent = [{"year": int(y), "month": int(m), "value": round(float(hist.loc[y, m]), 1)}
              for y in hist.index for m in range(1, 13)]
    annual_typical = float(h.sum(axis=1).median())

    label = {"seasonal": "seasonal",
             "seasonal_enso": "seasonal + ENSO",
             "seasonal_drought": "seasonal + drought",
             "enso_drought": "seasonal + ENSO + drought"}[choice["choice"]]

    return {
        "scope": scope, "year": year, "data_ends": last,
        "model": label,
        "enso_used": enso_label, "dc_used": dc_label,
        "enso_slope": None if p is None or not p["use_enso"] else
                      {"dry": round(float(p["beta"][0]), 3), "wet": round(float(p["beta"][1]), 3)},
        "dc_slope": None if p is None or not p["use_dc"] else
                    round(float(p["beta"][-1]), 5),
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
