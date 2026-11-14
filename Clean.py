"""
FIRMS hotspot cleaning script - NASA Space Apps 2026, Challenge #8
Cleans MODIS (C6.1) + VIIRS S-NPP (C2) archive CSVs into one unified table.

Usage:
    python Clean.py --modis "modis_2000-2025_*.csv" --viirs "viirs-snpp_2012-2025_*.csv" --out clean_hotspots.csv
    (File names must end in _<Country>.csv, e.g. modis_2000-2025_Malaysia.csv.
     Use S-NPP only; do NOT pass the viirs-jpss1 (NOAA-20) files.)

Optional:
    --aqua-only           keep only MODIS Aqua (overpass time closest to VIIRS S-NPP)
    --min-modis-conf 30   MODIS confidence threshold (0-100)
"""
import argparse
import glob
import pandas as pd

# ---- Areas of interest, per country: list of (lon_min, lat_min, lon_max, lat_max). ----
# Country comes from the file name (e.g. modis_2000-2025_Malaysia.csv), so
# overlapping boxes (Sumatra vs Peninsular Malaysia, Kalimantan vs Sarawak)
# never mix countries. Boxes are approximate; first match wins (dict order).
REGIONS = {
    "Malaysia": {
        "Peninsular Malaysia": [(99.5, 1.2, 105.0, 6.8)],
        # 2nd box: Sarawak highlands east of 115.5 (Bario / Ba'kelalan)
        "Sarawak":             [(109.5, 0.8, 115.5, 5.1), (115.5, 0.8, 115.8, 4.0)],
        # starts at 115.0 so Klias peninsula / Beaufort peat (and Labuan) are kept;
        # Sarawak is checked first, so Lawas / Limbang stay Sarawak
        "Sabah":               [(115.0, 4.0, 119.5, 7.5)],
    },
    "Indonesia": {
        "Sumatra":    [(95.0, -6.0, 106.2, 6.0)],
        "Kalimantan": [(108.8, -4.3, 119.0, 4.5)],
    },
}

# Local time zone per region, used for the local 'date' (so a night fire isn't
# split across days). Sumatra = WIB (UTC+7). Kalimantan: West/Central = WIB (+7),
# South/East/North = WITA (+8); the border is roughly lon 114.5.
UTC_OFFSET_HOURS = {"Peninsular Malaysia": 8, "Sarawak": 8, "Sabah": 8, "Sumatra": 7}
KALIMANTAN_WITA_LON = 114.5

UNIFIED_COLS = ["date", "lat", "lon", "frp", "confidence_level", "daynight",
                "sensor", "satellite", "country", "region"]


def load(paths):
    files = sorted({f for p in paths for f in glob.glob(p)})
    if not files:
        raise SystemExit(f"No files matched: {paths}")
    parts = []
    for f in files:
        country = f.replace("\\", "/").split("/")[-1].rsplit(".", 1)[0].split("_")[-1]
        parts.append(pd.read_csv(f, low_memory=False).assign(country=country))
        print(f"  {f}  (country = {country})")
    df = pd.concat(parts, ignore_index=True)
    print(f"  loaded {len(df):,} rows from {len(files)} file(s)")
    return df


def common_clean(df, sensor):
    n0 = len(df)

    # 1. Drop rows missing essentials
    df = df.dropna(subset=["latitude", "longitude", "acq_date", "acq_time"])

    # 2. Remove exact duplicates (e.g. overlapping archive / country files)
    df = df.drop_duplicates(subset=["latitude", "longitude", "acq_date", "acq_time", "satellite"])

    # 3. Keep vegetation fires only (type 0). Drops volcanoes (1), static sources
    #    such as factories / gas flares (2), and offshore (3).
    #    NRT files have no 'type' column -> warn, since static sources stay in.
    if "type" in df.columns:
        df = df[df["type"] == 0]
    else:
        print(f"  WARNING [{sensor}]: no 'type' column (NRT file?) - static sources not removed")

    # 4. Build UTC timestamp (converted to local date later, once region is known)
    t = df["acq_time"].astype(int).astype(str).str.zfill(4)
    ts = pd.to_datetime(df["acq_date"] + " " + t, format="%Y-%m-%d %H%M", utc=True)
    df = df.assign(ts_utc=ts)

    print(f"  [{sensor}] {n0:,} -> {len(df):,} after missing/duplicate/type filters")
    return df


def clean_modis(df, min_conf=30, aqua_only=False):
    df = common_clean(df, "MODIS")
    conf = pd.to_numeric(df["confidence"], errors="coerce")
    # FIRMS guidance: <30 low, 30-79 nominal, >=80 high
    df = df.assign(confidence_level=pd.cut(conf, [-1, 29, 79, 100],
                                           labels=["low", "nominal", "high"]).astype(str))
    n = len(df)
    df = df[conf.loc[df.index] >= min_conf]
    if aqua_only:
        df = df[df["satellite"].astype(str).str.lower().str.startswith("a")]
    print(f"  [MODIS] {n:,} -> {len(df):,} after confidence>={min_conf}"
          + (" + Aqua-only" if aqua_only else ""))
    return df.assign(sensor="MODIS")


def clean_viirs(df):
    df = common_clean(df, "VIIRS")
    level = df["confidence"].astype(str).str.lower().str[0].map(
        {"l": "low", "n": "nominal", "h": "high"})
    n = len(df)
    df = df.assign(confidence_level=level)
    df = df[df["confidence_level"].isin(["nominal", "high"])]  # low = glint / noise prone
    print(f"  [VIIRS] {n:,} -> {len(df):,} after dropping low confidence")
    return df.assign(sensor="VIIRS")


def assign_region(df):
    df = df.assign(region=pd.NA)
    for country, boxes in REGIONS.items():
        in_country = df["country"].str.lower() == country.lower()
        for name, box_list in boxes.items():
            for x0, y0, x1, y1 in box_list:
                inside = df["longitude"].between(x0, x1) & df["latitude"].between(y0, y1)
                df.loc[in_country & inside & df["region"].isna(), "region"] = name
    n = len(df)
    df = df.dropna(subset=["region"])
    print(f"  {n:,} -> {len(df):,} inside regions of interest")
    return df


def add_local_date(df):
    offset = df["region"].map(UTC_OFFSET_HOURS)
    kal = df["region"] == "Kalimantan"
    offset[kal] = (df.loc[kal, "longitude"] >= KALIMANTAN_WITA_LON).map({True: 8, False: 7})
    local = df["ts_utc"] + pd.to_timedelta(offset.astype(int), unit="h")
    return df.assign(date=local.dt.date)


def to_unified(df):
    df = df.rename(columns={"latitude": "lat", "longitude": "lon"})
    return df[UNIFIED_COLS]


def sanity_report(df):
    df = df.assign(year=pd.to_datetime(df["date"]).dt.year)
    print("\nHotspots per year per sensor (check for odd jumps / partial years):")
    print(df.pivot_table(index="year", columns="sensor", values="lat",
                         aggfunc="count", fill_value=0).to_string())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--modis", nargs="+", required=True)
    ap.add_argument("--viirs", nargs="+", required=True)
    ap.add_argument("--out", default="clean_hotspots.csv")
    ap.add_argument("--min-modis-conf", type=int, default=30)
    ap.add_argument("--aqua-only", action="store_true")
    a = ap.parse_args()

    print("MODIS:")
    m = clean_modis(load(a.modis), a.min_modis_conf, a.aqua_only)
    print("VIIRS:")
    v = clean_viirs(load(a.viirs))

    out = to_unified(add_local_date(assign_region(pd.concat([m, v], ignore_index=True))))
    out = out.sort_values(["date", "sensor"])
    out.to_csv(a.out, index=False)
    print(f"\nSaved {len(out):,} clean hotspots -> {a.out}")
    sanity_report(out)


if __name__ == "__main__":
    main()