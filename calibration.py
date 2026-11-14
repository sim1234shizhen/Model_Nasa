"""
Step 2: grid + calibrate MODIS -> VIIRS-equivalent, build monthly burning calendar.
NASA Space Apps 2026, Challenge #8 (MODIS & VIIRS hotspot harmonization)

Input : clean_hotspots.csv  (output of Clean.py)
Output: harmonized_monthly.csv  -> one row per region x year x month (feeds the web app)
        calibration.csv         -> fitted MODIS->VIIRS factor per region, with validation scores

Method
  1. Snap every hotspot to a common grid (GRID deg). Count "fire cell-days":
     a grid cell burning on a given day counts once, however many pixels hit it.
     This removes most of the resolution gap (one VIIRS fire = many 375 m pixels).
  2. Sum cell-days per region x month, separately for MODIS and VIIRS.
  3. On the overlap period (Feb 2012+), fit two candidate models per region:
       linear : VIIRS = k * MODIS        (least squares through the origin)
       power  : VIIRS = a * MODIS ** b   (least squares on log-log, months with fires)
     A single k is dominated by extreme haze months (2015, 2019) and under-predicts
     normal months by 30-45% in Sumatra / Kalimantan / Sabah; the power law fixes that.
     Both are validated leave-one-year-out (refit without year Y, predict year Y);
     the model with the lower median absolute % error is used for that region.
  4. Harmonized series = VIIRS where it exists (Feb 2012+), calibrated MODIS before.
  5. Anomaly = month value vs median of the same calendar month across all years.

Usage: python calibration.py --inp clean_hotspots.csv [--aqua-only] [--grid 0.05]
"""
import argparse
import numpy as np
import pandas as pd

FIRST_FULL_YEAR = 2003   # MODIS Aqua starts mid-2002; 2003 is the first full year
LAST_YEAR = 2025
VIIRS_START = (2012, 2)  # S-NPP archive starts 2012-01-20 -> Jan 2012 is a partial month
REGION_COUNTRY = {"Peninsular Malaysia": "Malaysia", "Sarawak": "Malaysia", "Sabah": "Malaysia",
                  "Sumatra": "Indonesia", "Kalimantan": "Indonesia"}


def cell_days(df, grid):
    g = df.assign(gx=np.floor(df["lon"] / grid).astype(int),
                  gy=np.floor(df["lat"] / grid).astype(int))
    g = g.drop_duplicates(["sensor", "region", "date", "gx", "gy"])
    g["year"], g["month"] = g["date"].dt.year, g["date"].dt.month
    return (g.groupby(["region", "sensor", "year", "month"]).size()
             .unstack("sensor", fill_value=0).reset_index())


def fit_linear(m, v):
    k = float((m * v).sum() / (m * m).sum()) if (m * m).sum() > 0 else np.nan
    return {"k": k}


def fit_power(m, v):
    ok = (m > 0) & (v > 0)
    if ok.sum() < 3:
        return {"a": np.nan, "b": np.nan}
    b, log_a = np.polyfit(np.log(m[ok]), np.log(v[ok]), 1)
    return {"a": float(np.exp(log_a)), "b": float(b)}


def predict(model, p, m):
    m = np.asarray(m, dtype=float)
    return p["k"] * m if model == "linear" else p["a"] * np.power(m, p["b"])


FITS = {"linear": fit_linear, "power": fit_power}


def r2(y, yhat):
    ss = ((y - y.mean()) ** 2).sum()
    return float(1 - ((y - yhat) ** 2).sum() / ss) if ss > 0 else np.nan


def med_abs_pct_err(y, yhat, min_modis, m):
    # relative error on months with a meaningful MODIS signal
    keep = (m >= min_modis) & (y > 0)
    return float(np.median(np.abs(yhat[keep] / y[keep] - 1)) * 100) if keep.any() else np.nan


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inp", default="clean_hotspots.csv")
    ap.add_argument("--grid", type=float, default=0.05)
    ap.add_argument("--aqua-only", action="store_true")
    ap.add_argument("--out", default="harmonized_monthly.csv")
    ap.add_argument("--calib-out", default="calibration.csv")
    a = ap.parse_args()

    df = pd.read_csv(a.inp, parse_dates=["date"],
                     usecols=["date", "lat", "lon", "sensor", "satellite", "region"])
    if a.aqua_only:
        df = df[(df["sensor"] == "VIIRS") | (df["satellite"] == "Aqua")]
    df = df[(df["date"].dt.year >= FIRST_FULL_YEAR) & (df["date"].dt.year <= LAST_YEAR)]

    monthly = cell_days(df, a.grid)
    for c in ("MODIS", "VIIRS"):
        if c not in monthly:
            monthly[c] = 0

    # Fill missing months (no fires) with 0 *before* fitting, so zero months are
    # part of the calibration / validation and the calendar has no gaps
    full = pd.MultiIndex.from_product([monthly["region"].unique(),
                                       range(FIRST_FULL_YEAR, LAST_YEAR + 1), range(1, 13)],
                                      names=["region", "year", "month"])
    monthly = (monthly.set_index(["region", "year", "month"])[["MODIS", "VIIRS"]]
               .reindex(full, fill_value=0).reset_index())
    has_viirs = (monthly["year"] * 100 + monthly["month"]) >= VIIRS_START[0] * 100 + VIIRS_START[1]

    # ---- calibration per region on the overlap period ----
    rows, out = [], []
    for region, r in monthly.groupby("region"):
        ov = r[has_viirs.loc[r.index]]
        m, v = ov["MODIS"].to_numpy(float), ov["VIIRS"].to_numpy(float)
        years = ov["year"].to_numpy()
        min_modis = max(5, np.percentile(m, 10))

        scores, params = {}, {}
        for name, fit in FITS.items():
            params[name] = fit(m, v)
            pred = np.empty_like(v)
            for y in np.unique(years):  # leave-one-year-out
                tr, te = years != y, years == y
                pred[te] = predict(name, fit(m[tr], v[tr]), m[te])
            scores[name] = {"r2_loyo": r2(v, pred), "mape_loyo": med_abs_pct_err(v, pred, min_modis, m)}
        model = min(scores, key=lambda k: scores[k]["mape_loyo"])
        p = params[model]

        rows.append({"region": region, "country": REGION_COUNTRY.get(region, ""), "model": model,
                     "k": round(params["linear"]["k"], 3),
                     "a": round(params["power"]["a"], 3), "b": round(params["power"]["b"], 3),
                     "r2_in_sample": round(r2(v, predict(model, p, m)), 3),
                     "r2_leave_one_year_out": round(scores[model]["r2_loyo"], 3),
                     "median_abs_pct_err_loyo": round(scores[model]["mape_loyo"], 1),
                     "linear_mape_loyo": round(scores["linear"]["mape_loyo"], 1),
                     "power_mape_loyo": round(scores["power"]["mape_loyo"], 1),
                     "corr": round(float(np.corrcoef(m, v)[0, 1]), 3),
                     "n_months": len(ov)})

        r = r.copy()
        r["modis_scaled"] = predict(model, p, r["MODIS"]).round(1)
        hv = has_viirs.loc[r.index]
        r["harmonized_count"] = np.where(hv, r["VIIRS"], r["modis_scaled"])
        r["source"] = np.where(hv, "VIIRS", f"MODIS ({model}-calibrated)")
        out.append(r)

    calib = pd.DataFrame(rows)
    res = pd.concat(out)
    res["country"] = res["region"].map(REGION_COUNTRY).fillna("")

    # ---- anomaly vs historical median of the same calendar month ----
    med = res.groupby(["region", "month"])["harmonized_count"].transform("median")
    res["median_same_month"] = med.round(1)
    res["anomaly_ratio"] = (res["harmonized_count"] / med.replace(0, np.nan)).round(2)

    cols = ["country", "region", "year", "month", "harmonized_count", "source", "MODIS", "VIIRS",
            "median_same_month", "anomaly_ratio"]
    res[cols].sort_values(["region", "year", "month"]).to_csv(a.out, index=False)
    calib.to_csv(a.calib_out, index=False)
    print("Calibration (MODIS fire cell-days -> VIIRS-equivalent, best model per region):")
    print(calib.to_string(index=False))
    print(f"\nSaved {a.out} and {a.calib_out}")


if __name__ == "__main__":
    main()
