"""Does the new data actually make the forecast better? Honest out-of-sample test.

Design (deliberately pessimistic):
  * Outlook issued at the END OF MAY, predicting June-November of the same year.
  * Only information available then is used: Jan-May of the target year, persisted
    forward. No peeking at the year's actual ONI / DMI / rain / fire weather.
  * Train on earlier years only; the target year is never in the training set.
  * Baseline is the existing model: mean of the last 5 years, same month, log space.

Models, each adding predictors to the same baseline:
  A  seasonal only
  B  + ONI  (May value persisted)
  C  + rainfall (Mar-May mean ratio, NASA POWER)
  D  + drought code DC (May value, GFWED)
  E  + DMI   (May value, NOAA)
  F  + all four

Two scopes:
  per region            equal weight per region
  All regions pooled    fire-weighted, comparable to the README headline

Metric: median |expm1(residual)| * 100 = typical % error. Lower is better.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

ROOT = r"C:\Users\jinse\Documents\nasa\Model_Nasa"
N_BASE, FIRST = 5, 2013
MONTHS = list(range(6, 12))

H = pd.read_csv(fr"{ROOT}\Clean_dataset\harmonized_monthly.csv")
P = pd.read_csv(fr"{ROOT}\data\power_regions_monthly.csv")
D = pd.read_csv(fr"{ROOT}\data\dmi_monthly.csv")
G = pd.read_csv(fr"{ROOT}\data\gfwed_regions_monthly.csv") if True else None

oni_raw = pd.read_csv(fr"{ROOT}\backend\.cache\oni.txt", sep=r"\s+")
SEASONS = ["DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ", "JJA", "JAS", "ASO", "SON", "OND", "NDJ"]
oni_raw["month"] = oni_raw["SEAS"].map({s: i + 1 for i, s in enumerate(SEASONS)})
ONI = oni_raw.pivot_table(index="YR", columns="month", values="ANOM").reindex(columns=range(1, 13))
DMI = D.set_index(["year", "month"])["dmi"]

clim = P[P.year >= 2003].groupby(["region", "month"])["PRECTOTCORR"].transform("median")
P["ratio"] = P["PRECTOTCORR"] / clim.replace(0, np.nan)
P = P.set_index(["region", "year", "month"])
G = G.set_index(["region", "year", "month"]) if len(G) else None

REGIONS = sorted(H.region.unique())


def series_for(scope: str) -> pd.DataFrame:
    """log fire per year x month, for one region or the All aggregate."""
    d = H if scope == "All" else H[H.region == scope]
    g = (d.groupby(["year", "month"])["harmonized_count"].sum()
           .unstack("month").reindex(columns=range(1, 13)).fillna(0))
    return np.log1p(g)


def features_for(scope: str) -> pd.DataFrame:
    """Issue-time features per year. For 'All', predictors are fire-weighted."""
    if scope != "All":
        regs = [scope]
        w = {scope: 1.0}
    else:
        last = H[H.year.between(2019, 2025)].groupby("region")["harmonized_count"].sum()
        w = (last / last.sum()).to_dict()
        regs = REGIONS
    out = []
    for y in range(2003, 2026):
        acc = {"rain_mam": [], "dc_may": [], "fwi_may": []}
        for r in regs:
            rr = [P["ratio"].get((r, y, m), np.nan) for m in (3, 4, 5)]
            acc["rain_mam"].append((np.nanmean(rr), w[r]))
            if G is not None:
                acc["dc_may"].append((G["DC"].get((r, y, 5), np.nan), w[r]))
                acc["fwi_may"].append((G["FWI"].get((r, y, 5), np.nan), w[r]))
        row = {"year": y}
        for k, pairs in acc.items():
            vals = np.array([v for v, _ in pairs], float)
            ww = np.array([x for _, x in pairs], float)
            ok = np.isfinite(vals)
            row[k] = float(np.average(vals[ok], weights=ww[ok])) if ok.any() else np.nan
        row["oni_may"] = ONI.loc[y, 5] if y in ONI.index else np.nan
        row["dmi_may"] = DMI.get((y, 5), np.nan)
        out.append(row)
    return pd.DataFrame(out).set_index("year")


def ols(X, y):
    A = np.column_stack([np.ones(len(X)), X])
    beta, *_ = np.linalg.lstsq(A, y, rcond=None)
    return beta, A


def residuals(F: pd.DataFrame, S: pd.DataFrame, cols: list[str]) -> np.ndarray:
    out = []
    for y in range(FIRST, 2026):
        if y not in S.index:
            continue
        base = {m: float(S.loc[y - N_BASE:y - 1, m].mean()) for m in range(1, 13)}
        Xs, ys = [], []
        for t in range(2003, y):
            if t not in S.index or t - N_BASE < S.index.min() or t not in F.index:
                continue
            b = {m: float(S.loc[t - N_BASE:t - 1, m].mean()) for m in range(1, 13)}
            xv = [F.loc[t, c] for c in cols]
            if cols and any(pd.isna(v) for v in xv):
                continue
            for m in MONTHS:
                r = float(S.loc[t, m]) - b[m]
                if np.isfinite(r):
                    Xs.append(xv)
                    ys.append(r)
        xv_y = [F.loc[y, c] for c in cols] if y in F.index else []
        if not Xs or (cols and any(pd.isna(v) for v in xv_y)):
            out += [float(S.loc[y, m]) - base[m] for m in MONTHS]
            continue
        beta, A = ols(np.asarray(Xs, float), np.asarray(ys, float))
        bias = float(np.median(np.asarray(ys) - A @ beta))
        for m in MONTHS:
            pred = base[m] + bias + beta[0] + float(np.dot(beta[1:], np.array(xv_y, float)))
            out.append(float(S.loc[y, m]) - pred)
    return np.array(out)


def pct(res):
    res = np.asarray(res, float)
    res = res[np.isfinite(res)]
    return round(float(np.median(np.abs(np.expm1(res)))) * 100, 1) if len(res) else None


MODELS = {"A_seasonal": [], "B_ONI": ["oni_may"], "C_rain": ["rain_mam"],
          "D_DC": ["dc_may"], "E_DMI": ["dmi_may"],
          "F_all": ["oni_may", "rain_mam", "dc_may", "dmi_may"],
          "G_ONI+DC": ["oni_may", "dc_may"],
          "H_ONI+rain": ["oni_may", "rain_mam"],
          "I_3vars": ["oni_may", "dc_may", "rain_mam"]}

print(f"GFWED: {0 if G is None else len(G):,} region-months loaded")
print("Test: issue end of May, predict Jun-Nov, trained on earlier years only\n")

rows = []
for scope in REGIONS + ["All"]:
    F, S = features_for(scope), series_for(scope)
    r = {"region": scope}
    for name, cols in MODELS.items():
        if cols and any(F[c].isna().all() for c in cols):
            r[name] = None
            continue
        r[name] = pct(residuals(F, S, cols))
    rows.append(r)

R = pd.DataFrame(rows)
print("Typical error Jun-Nov (%), lower is better:")
print(R.to_string(index=False))

allrow = R[R.region == "All"].iloc[0]
a = allrow["A_seasonal"]
print("\nAll regions, change vs seasonal baseline:")
for name in MODELS:
    v = allrow.get(name)
    if v is None:
        print(f"  {name:11s}  (predictor not available)")
    elif name == "A_seasonal":
        print(f"  {name:11s} {v:5.1f}%   baseline")
    else:
        print(f"  {name:11s} {v:5.1f}%   {'+' if v > a else ''}{v - a:+.1f} pts")
