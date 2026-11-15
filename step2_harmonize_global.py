"""
STEP 2 - Calibrate MODIS -> VIIRS NOAA-20 per country, build harmonized global series.
NASA Space Apps 2026, Challenge #8

Inputs : MODIS and VIIRS monthly counts from step1 (columns: sensor,country,cx,cy,year,month,cell_days)
Outputs: calibration_global.csv     k per country + validation scores
         harmonized_country_monthly.csv   country x year x month (harmonized, anomaly vs median)
         harmonized_cells_1deg.csv.gz     1-deg cell x year x month harmonized counts

Model  : VIIRS = k * MODIS on monthly fire cell-days, least squares through the origin,
         fitted per country on the Apr 2018-2025 overlap. Countries with too few fires use the
         global k (fitted on all countries pooled).
Checks : (1) leave-one-year-out R2 per country, (2) temporal hold-out: fit 2018-2023, test 2024-2025.
Series : Jan 2003-Mar 2018 = k * MODIS (VIIRS-equivalent);  Apr 2018-2025 = VIIRS NOAA-20.
"""
import argparse
import numpy as np
import pandas as pd

Y0, Y1, OV0 = 2003, 2025, 2018
OV_START = 2018 * 12 + 3     # NOAA-20 standard data starts April 2018 (month index y*12+m-1)
MIN_OVERLAP = 300      # min fire cell-days per sensor in the overlap to get a country-specific k


def fit_k(m, v):
    m, v = np.asarray(m, float), np.asarray(v, float)
    den = (m * m).sum()
    return (m * v).sum() / den if den > 0 else np.nan


def r2(y, yhat):
    y, yhat = np.asarray(y, float), np.asarray(yhat, float)
    ss = ((y - y.mean()) ** 2).sum()
    return 1 - ((y - yhat) ** 2).sum() / ss if ss > 0 else np.nan


def load(paths):
    d = pd.concat([pd.read_csv(p) for p in paths], ignore_index=True)
    d["sensor"] = np.where(d["sensor"].str.startswith("VIIRS"), "VIIRS", d["sensor"])
    return d[d["year"].between(Y0, Y1)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inputs", nargs="+", required=True)
    ap.add_argument("--outdir", default=".")
    a = ap.parse_args()
    d = load(a.inputs)

    # ---------- country x month totals per sensor ----------
    cm = (d.groupby(["country", "sensor", "year", "month"]).cell_days.sum()
            .unstack("sensor", fill_value=0).reset_index())
    for s in ("MODIS", "VIIRS"):
        if s not in cm:
            cm[s] = 0
    cm["ym"] = cm["year"] * 12 + cm["month"] - 1
    ov = cm[cm["ym"] >= OV_START]

    k_global = fit_k(ov["MODIS"], ov["VIIRS"])
    tr, te = ov[ov["year"] <= 2023], ov[ov["year"] >= 2024]

    rows = []
    for c, g in ov.groupby("country"):
        own = g["MODIS"].sum() >= MIN_OVERLAP and g["VIIRS"].sum() >= MIN_OVERLAP
        k = fit_k(g["MODIS"], g["VIIRS"]) if own else k_global
        row = {"country": c, "k": k, "k_source": "country" if own else "global",
               "modis_overlap": int(g["MODIS"].sum()), "viirs_overlap": int(g["VIIRS"].sum())}
        if own:
            preds = [t.assign(p=fit_k(g[g.year != y]["MODIS"], g[g.year != y]["VIIRS"]) * t["MODIS"])
                     for y, t in g.groupby("year")]
            p = pd.concat(preds)
            row["r2_loyo"] = r2(p["VIIRS"], p["p"])
            row["corr"] = np.corrcoef(g["MODIS"], g["VIIRS"])[0, 1]
            gtr, gte = g[g.year <= 2023], g[g.year >= 2024]
            kt = fit_k(gtr["MODIS"], gtr["VIIRS"])
            row["r2_holdout_2024_25"] = r2(gte["VIIRS"], kt * gte["MODIS"])
            row["holdout_total_err_pct"] = 100 * (kt * gte["MODIS"].sum() - gte["VIIRS"].sum()) / max(gte["VIIRS"].sum(), 1)
        rows.append(row)
    calib = pd.DataFrame(rows).sort_values("viirs_overlap", ascending=False)

    # global hold-out, using each country's k fitted on 2018-2023 only
    kt = {c: (fit_k(g["MODIS"], g["VIIRS"]) if g["MODIS"].sum() >= MIN_OVERLAP and g["VIIRS"].sum() >= MIN_OVERLAP
              else fit_k(tr["MODIS"], tr["VIIRS"])) for c, g in tr.groupby("country")}
    te = te.assign(p=te["country"].map(kt).fillna(fit_k(tr["MODIS"], tr["VIIRS"])) * te["MODIS"])
    gm = te.groupby(["year", "month"])[["VIIRS", "p"]].sum()
    summary = {
        "k_global": k_global,
        "countries_own_k": int((calib.k_source == "country").sum()),
        "share_fires_with_own_k": calib.loc[calib.k_source == "country", "viirs_overlap"].sum() / calib.viirs_overlap.sum(),
        "median_r2_loyo": calib["r2_loyo"].median(),
        "global_monthly_r2_holdout_2024_25": r2(gm["VIIRS"], gm["p"]),
        "global_total_err_pct_holdout_2024_25": 100 * (gm["p"].sum() - gm["VIIRS"].sum()) / gm["VIIRS"].sum(),
    }

    # ---------- harmonize at cell level ----------
    kmap = calib.set_index("country")["k"].to_dict()
    cell = (d.groupby(["country", "cx", "cy", "year", "month", "sensor"]).cell_days.sum()
              .unstack("sensor", fill_value=0).reset_index())
    for s in ("MODIS", "VIIRS"):
        if s not in cell:
            cell[s] = 0
    k = cell["country"].map(kmap).fillna(k_global)
    viirs_era = (cell["year"] * 12 + cell["month"] - 1) >= OV_START
    cell["h"] = np.where(viirs_era, cell["VIIRS"], k * cell["MODIS"])
    cell = cell[cell["h"] > 0]

    cells = cell.groupby(["cx", "cy", "year", "month"])["h"].sum().round(2).reset_index()
    cells.to_csv(f"{a.outdir}/harmonized_cells_1deg.csv.gz", index=False, compression="gzip")
    dom = (cell.groupby(["cx", "cy", "country"])["h"].sum().reset_index()
               .sort_values("h").drop_duplicates(["cx", "cy"], keep="last")[["cx", "cy", "country"]])
    dom.to_csv(f"{a.outdir}/cell_dominant_country.csv", index=False)

    ctry = cell.groupby(["country", "year", "month"])["h"].sum().reset_index()
    full = pd.MultiIndex.from_product([ctry.country.unique(), range(Y0, Y1 + 1), range(1, 13)],
                                      names=["country", "year", "month"])
    ctry = ctry.set_index(["country", "year", "month"]).reindex(full, fill_value=0).reset_index()
    med = ctry.groupby(["country", "month"])["h"].transform("median")
    ctry["median_same_month"] = med.round(1)
    ctry["anomaly_ratio"] = (ctry["h"] / med.replace(0, np.nan)).round(2)
    ctry["source"] = np.where(ctry["year"] * 12 + ctry["month"] - 1 >= OV_START, "VIIRS NOAA-20", "MODIS (scaled)")
    ctry.rename(columns={"h": "harmonized_count"}).round({"harmonized_count": 1}) \
        .to_csv(f"{a.outdir}/harmonized_country_monthly.csv", index=False)

    calib.round(3).to_csv(f"{a.outdir}/calibration_global.csv", index=False)
    pd.Series(summary).to_csv(f"{a.outdir}/validation_summary.csv", header=["value"])
    print("Validation summary:")
    for kk, vv in summary.items():
        print(f"  {kk}: {vv:.3f}" if isinstance(vv, float) else f"  {kk}: {vv}")
    print("\nTop 12 countries by fire activity:")
    print(calib.head(12)[["country", "k", "k_source", "r2_loyo", "r2_holdout_2024_25", "corr"]].round(3).to_string(index=False))


if __name__ == "__main__":
    main()
