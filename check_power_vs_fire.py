"""Does the new NASA POWER rain actually predict fire? Quick check on real data."""
import numpy as np, pandas as pd

ROOT = r"C:\Users\jinse\Documents\nasa\Model_Nasa"
P = pd.read_csv(fr"{ROOT}\data\power_regions_monthly.csv")
H = pd.read_csv(fr"{ROOT}\Clean_dataset\harmonized_monthly.csv")

print("POWER coverage:", P.year.min(), "-", P.year.max())
last = P.dropna(subset=["PRECTOTCORR"]).groupby("region").apply(
    lambda g: f"{int(g.year.max())}-{int(g[g.year == g.year.max()].month.max()):02d}", include_groups=False)
print("last month with rain data:\n", last.to_string(), "\n")

P["date"] = pd.to_datetime(dict(year=P.year, month=P.month, day=1))
H["date"] = pd.to_datetime(dict(year=H.year, month=H.month, day=1))

# rainfall anomaly vs same-month climatology over the MODIS+VIIRS era
clim = P[(P.year >= 2003)].groupby(["region", "month"])["PRECTOTCORR"].transform("median")
P["rain_anom"] = P["PRECTOTCORR"] - clim
P["rain_ratio"] = P["PRECTOTCORR"] / clim.replace(0, np.nan)

M = H.merge(P[["region", "date", "PRECTOTCORR", "rain_ratio", "rain_anom"]],
            on=["region", "date"], how="inner")
M = M.rename(columns={"month": "month", "year": "year"})
M = M[M["harmonized_count"].notna()]
M["lfire"] = np.log1p(M["harmonized_count"])

print(f"joined rows: {len(M):,}\n")

rows = []
for region, g in M.groupby("region"):
    g = g.sort_values("date").copy()
    # rainfall lags: drought before fire
    for lag in (0, 1, 2, 3):
        g[f"rain_l{lag}"] = g["rain_ratio"].shift(lag)
    d = g.dropna(subset=["rain_l1", "rain_l2", "rain_l3"])
    if len(d) < 60:
        continue
    # 3-month running rain ratio = cumulative dryness
    g["rain_3mo"] = g["rain_ratio"].rolling(3, min_periods=3).mean()
    dd = g.dropna(subset=["rain_3mo", "rain_l1"])

    def r2(x, y):
        m = np.isfinite(x) & np.isfinite(y)
        if m.sum() < 30:
            return np.nan
        return float(np.corrcoef(x[m], y[m])[0, 1] ** 2)

    rows.append({
        "region": region, "n": len(dd),
        "R2 rain 3mo": round(r2(dd["rain_3mo"], dd["lfire"]), 3),
        "R2 rain lag1": round(r2(dd["rain_l1"], dd["lfire"]), 3),
        "R2 climatology": round(r2(np.cos(2 * np.pi * (dd.month - 1) / 12), dd["lfire"]), 3),
    })

R = pd.DataFrame(rows)
print("Explained variance of log monthly fire (region x month, 2003-2025):")
print(R.to_string(index=False))

# one worked example, Sumatra: dry quarter then fire
s = M[M.region == "Sumatra"].copy()
s["rain_3mo"] = s["rain_ratio"].rolling(3, min_periods=3).mean()
q = s.dropna(subset=["rain_3mo"])
print(f"\nSumatra, driest {int(len(q)*0.1)} vs wettest {int(len(q)*0.1)} 3-month spells:")
lo = q.nsmallest(int(len(q) * .1), "rain_3mo")["harmonized_count"]
hi = q.nlargest(int(len(q) * .1), "rain_3mo")["harmonized_count"]
print(f"  drier than normal : median {lo.median():8.0f} fire cell-days/month")
print(f"  wetter than normal: median {hi.median():8.0f} fire cell-days/month")
print(f"  ratio {lo.median()/max(hi.median(),1):.1f}x")
