"""
STEP 1 (run on your computer) - Global FIRMS hotspots -> compact monthly summary
NASA Space Apps 2026, Challenge #8: Harmonization of MODIS and VIIRS Hot Spots

Reads FIRMS "Country Yearly Summary" zips directly (no unzipping):
    modis_YYYY_all_countries.zip        (MODIS C6.1, use 2003-2025)
    viirs-jpss1_YYYY_all_countries.zip  (VIIRS NOAA-20, 2018-2025)

What it does, file by file (low memory, streams in chunks):
  1. Clean: vegetation fires only (type 0), MODIS confidence >= 30,
     VIIRS confidence nominal/high, drop rows with missing values.
  2. Local solar date: UTC + longitude/15 h (so a night fire is not split across days).
  3. Snap to a 0.05 deg grid and keep each burning cell once per day ("fire cell-day").
     This removes most of the 375 m vs 1 km resolution gap.
  4. Sum fire cell-days per 1 deg cell x country x month, per sensor.

Output: global_monthly_counts.csv.gz  (small - upload this to Claude)
        columns: sensor, country, cx, cy, year, month, cell_days
        cx = floor(lon+180), cy = floor(lat+90)  -> 1 deg cell, lower-left corner

Usage:
    python step1_aggregate_global.py --zips "C:/path/to/zips" --out global_monthly_counts.csv.gz
Needs: Python 3.9+, pandas, numpy   (pip install pandas numpy)
"""
import argparse
import glob
import io
import os
import re
import time
import zipfile

import numpy as np
import pandas as pd

FINE = 0.05                       # dedup grid (deg)
NX, NY = int(360 / FINE), int(180 / FINE)
EPOCH = np.datetime64("2000-01-01")
USECOLS = {"latitude", "longitude", "acq_date", "acq_time", "confidence", "type"}
CHUNK = 1_000_000


def sensor_of(zip_name):
    n = os.path.basename(zip_name).lower()
    if n.startswith("modis"):
        return "MODIS"
    if "jpss1" in n or "noaa20" in n or "noaa-20" in n:
        return "VIIRS_NOAA20"
    if "jpss2" in n or "noaa21" in n:
        return "VIIRS_NOAA21"
    if "suomi" in n or "snpp" in n:
        return "VIIRS_SNPP"
    raise SystemExit(f"Cannot tell sensor from file name: {zip_name}")


def country_of(member):
    # e.g. "modis/2015/modis_2015_Indonesia.csv" -> "Indonesia"
    stem = os.path.splitext(os.path.basename(member))[0]
    m = re.match(r"^.*?_\d{4}_(.+)$", stem)
    return m.group(1).replace("_", " ") if m else "UNKNOWN"


def clean_chunk(df, sensor, warn):
    df = df.dropna(subset=["latitude", "longitude", "acq_date", "acq_time", "confidence"])
    if "type" in df.columns:
        df = df[df["type"] == 0]
    elif not warn["type"]:
        print("    WARNING: no 'type' column - static heat sources NOT removed")
        warn["type"] = True
    if sensor == "MODIS":
        df = df[pd.to_numeric(df["confidence"], errors="coerce") >= 30]
    else:
        df = df[df["confidence"].astype(str).str.lower().str[0].isin(["n", "h"])]
    if df.empty:
        return None
    lon = df["longitude"].to_numpy(np.float64)
    lat = df["latitude"].to_numpy(np.float64)
    hhmm = df["acq_time"].astype(int).to_numpy()
    utc_min = (hhmm // 100) * 60 + hhmm % 100
    day = (pd.to_datetime(df["acq_date"]).to_numpy("datetime64[D]") - EPOCH).astype(np.int64)
    # local solar time: shift by lon/15 hours
    local_min = utc_min + np.round(lon / 15.0 * 60).astype(np.int64)
    day = day + np.floor_divide(local_min, 1440)
    gx = np.clip(np.floor((lon + 180) / FINE).astype(np.int64), 0, NX - 1)
    gy = np.clip(np.floor((lat + 90) / FINE).astype(np.int64), 0, NY - 1)
    return day * (NX * NY) + gy * NX + gx       # one int64 key per fire cell-day


def process_zip(path, sensor):
    """Return DataFrame of unique (key, country) for one yearly zip."""
    keys, ctry = [], []
    warn = {"type": False}
    with zipfile.ZipFile(path) as z:
        members = [m for m in z.namelist() if m.lower().endswith(".csv")]
        for mem in members:
            country = country_of(mem)
            with z.open(mem) as fh:
                header = pd.read_csv(io.TextIOWrapper(fh), nrows=0).columns
            cols = [c for c in header if c in USECOLS]
            with z.open(mem) as fh:
                for ch in pd.read_csv(io.TextIOWrapper(fh), usecols=cols, chunksize=CHUNK,
                                      dtype={"confidence": str}, low_memory=False):
                    k = clean_chunk(ch, sensor, warn)
                    if k is not None and len(k):
                        k = np.unique(k)
                        keys.append(k)
                        ctry.append(np.full(len(k), country, dtype=object))
    if not keys:
        return pd.DataFrame(columns=["key", "country"])
    df = pd.DataFrame({"key": np.concatenate(keys), "country": np.concatenate(ctry)})
    return df.drop_duplicates("key")          # border cells: keep first country


def summarise(df, sensor):
    key = df["key"].to_numpy(np.int64)
    day, rest = np.divmod(key, NX * NY)
    gy, gx = np.divmod(rest, NX)
    d = EPOCH + day.astype("timedelta64[D]")
    ym = d.astype("datetime64[M]").astype(int)          # months since 1970-01
    out = pd.DataFrame({
        "sensor": sensor, "country": df["country"].to_numpy(),
        "cx": gx // int(round(1 / FINE)), "cy": gy // int(round(1 / FINE)),
        "year": ym // 12 + 1970, "month": ym % 12 + 1,
    })
    return (out.groupby(["sensor", "country", "cx", "cy", "year", "month"])
               .size().rename("cell_days").reset_index())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zips", required=True, help="folder containing the FIRMS zip files")
    ap.add_argument("--out", default="global_monthly_counts.csv.gz")
    a = ap.parse_args()

    files = sorted(glob.glob(os.path.join(a.zips, "*.zip")))
    if not files:
        raise SystemExit(f"No .zip files in {a.zips}")
    parts, t0 = [], time.time()
    for i, f in enumerate(files, 1):
        sensor = sensor_of(f)
        t = time.time()
        u = process_zip(f, sensor)
        s = summarise(u, sensor) if len(u) else None
        if s is not None:
            # keep only full calendar years requested by the file name
            yr = int(re.search(r"_(\d{4})_", os.path.basename(f)).group(1))
            s = s[s["year"].between(yr - 1, yr + 1)]
            parts.append(s)
        print(f"[{i}/{len(files)}] {os.path.basename(f)}: {len(u):,} fire cell-days "
              f"({time.time() - t:.0f}s, total {(time.time() - t0) / 60:.1f} min)")

    res = pd.concat(parts, ignore_index=True)
    # a fire on 31 Dec local time may sit in the next year's file: merge duplicates
    res = res.groupby(["sensor", "country", "cx", "cy", "year", "month"], as_index=False)["cell_days"].sum()
    res.to_csv(a.out, index=False, compression="gzip")
    print(f"\nSaved {len(res):,} rows -> {a.out} ({os.path.getsize(a.out) / 1e6:.1f} MB)")
    print("\nFire cell-days per year and sensor (check for odd jumps):")
    print(res.pivot_table(index="year", columns="sensor", values="cell_days",
                          aggfunc="sum", fill_value=0).to_string())


if __name__ == "__main__":
    main()
