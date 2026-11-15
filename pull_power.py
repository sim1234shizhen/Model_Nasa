"""Pull NASA POWER monthly climate for the 5 fire regions - parallel.

One request per point, all in flight at once. Outputs:
    data/power_points_monthly.csv    long: region, lat, lon, year, month, params
    data/power_regions_monthly.csv   region x year x month (mean of points)
"""
from __future__ import annotations
import concurrent.futures as cf
import json
import sys
import time
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "data"
OUT.mkdir(exist_ok=True)

PARAMS = ["PRECTOTCORR", "T2M", "T2M_MAX", "RH2M", "WS2M", "GWETROOT"]
START, END = 1981, 2026
URL = "https://power.larc.nasa.gov/api/temporal/monthly/point"

# Fire-relevant points per region (same place names as spatial_forecast.AREAS)
POINTS = {
    "Peninsular Malaysia": [("Perlis/Kedah", 6.1, 100.6), ("Penang", 5.35, 100.4),
                            ("Perak", 4.6, 101.0), ("Kelantan", 5.3, 102.0),
                            ("Pahang", 3.7, 102.6), ("Johor", 1.95, 103.4)],
    "Sarawak": [("Kuching", 1.3, 110.5), ("Sibu", 2.1, 111.8), ("Kapit", 1.9, 113.6),
                ("Bintulu", 3.1, 113.3), ("Miri", 4.0, 114.3)],
    "Sabah": [("West Coast", 5.8, 116.2), ("Kudat", 6.6, 116.9), ("Sandakan", 5.6, 117.8),
              ("Tawau", 4.6, 117.8), ("Interior", 5.0, 116.2)],
    "Sumatra": [("Aceh", 4.4, 96.9), ("North Sumatra", 2.2, 99.3), ("West Sumatra", -0.8, 100.6),
                ("Riau", 0.5, 101.8), ("Jambi", -1.6, 103.0), ("South Sumatra", -3.3, 104.2),
                ("Lampung", -4.9, 105.0)],
    "Kalimantan": [("West", 0.0, 110.6), ("Central", -1.6, 113.4), ("South", -2.9, 115.3),
                   ("East", 0.5, 116.4), ("North", 3.0, 116.2)],
    "Java": [("Jakarta", -6.2, 106.8), ("Bandung", -6.9, 107.6), ("Semarang", -7.0, 110.4),
             ("Surabaya", -7.25, 112.75), ("Yogyakarta", -7.8, 110.4)],
    "Nusa Tenggara": [("Bali", -8.65, 115.2), ("Lombok", -8.58, 116.1), ("Sumbawa", -8.5, 117.4),
                      ("Sumba", -9.65, 120.3), ("Flores", -8.6, 121.1), ("Timor", -10.2, 123.6)],
    "Sulawesi": [("Makassar", -5.15, 119.4), ("Palu", -0.9, 119.9), ("Manado", 1.5, 124.85),
                 ("Kendari", -4.0, 122.5), ("Gorontalo", 0.55, 123.05)],
    "Maluku": [("Ambon", -3.7, 128.2), ("Ternate", 0.8, 127.4), ("Tual", -5.6, 132.7)],
    "Papua": [("Jayapura", -2.5, 140.7), ("Merauke", -8.5, 140.4), ("Timika", -4.5, 136.9),
              ("Nabire", -3.35, 135.5), ("Manokwari", -0.86, 134.08)],
}


def fetch(job):
    region, place, lat, lon = job
    params = dict(parameters=",".join(PARAMS), community="AG", latitude=lat, longitude=lon,
                  start=START, end=END, format="JSON")
    last = None
    for attempt in range(4):
        try:
            r = requests.get(URL, params=params, timeout=120)
            r.raise_for_status()
            d = json.loads(r.text)
            p = d["properties"]["parameter"]
            rows = {}
            for key, series in p.items():
                for ym, val in series.items():
                    if len(ym) != 6 or int(ym[4:]) > 12:   # drop the annual "YYYY13" slot
                        continue
                    rows.setdefault(ym, {})[key] = val
            recs = [{"region": region, "place": place, "lat": lat, "lon": lon,
                     "year": int(ym[:4]), "month": int(ym[4:]),
                     **{k: (v if v > -900 else None) for k, v in vals.items()}}
                    for ym, vals in rows.items()]
            return region, place, recs, None
        except Exception as e:
            last = e
            time.sleep(1.5 * (attempt + 1))
    return region, place, [], repr(last)


def main():
    jobs = [(r, pl, la, lo) for r, pts in POINTS.items() for pl, la, lo in pts]
    print(f"{len(jobs)} points, {START}-{END}, params: {', '.join(PARAMS)}", flush=True)
    t0 = time.time()
    all_recs, fails = [], []
    with cf.ThreadPoolExecutor(max_workers=10) as ex:
        for i, (region, place, recs, err) in enumerate(ex.map(fetch, jobs), 1):
            if err:
                fails.append(f"{region}/{place}: {err}")
                print(f"  [{i:2d}/{len(jobs)}] FAIL {region}/{place}", flush=True)
            else:
                all_recs += recs
                print(f"  [{i:2d}/{len(jobs)}] ok   {region}/{place}  ({len(recs)} months)", flush=True)

    df = pd.DataFrame(all_recs).sort_values(["region", "place", "year", "month"])
    df.to_csv(OUT / "power_points_monthly.csv", index=False)

    agg = (df.groupby(["region", "year", "month"])[PARAMS].mean()
             .reset_index().round(2))
    agg.to_csv(OUT / "power_regions_monthly.csv", index=False)

    print(f"\n{len(df):,} point-months -> {OUT/'power_points_monthly.csv'}")
    print(f"{len(agg):,} region-months -> {OUT/'power_regions_monthly.csv'}")
    print(f"wall time {time.time()-t0:.1f}s, {len(fails)} failures")
    for f in fails:
        print("  FAILED:", f)

    print("\nLast full month per region:")
    for r, g in agg.groupby("region"):
        mx = g.year.max()
        tail = g[g.year == mx].tail(3)
        print(f"  {r:22s} data to {mx}-{int(tail.month.max()):02d}  "
              f"rain {tail.PRECTOTCORR.iloc[-1]} mm  RH {tail.RH2M.iloc[-1]}%")


if __name__ == "__main__":
    main()
