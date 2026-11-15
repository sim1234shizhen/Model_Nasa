"""
Step W1: world FIRMS archive -> Clean_dataset/world_monthly.csv

Builds a per-country monthly fire record for the whole world from the NASA FIRMS
"all countries" yearly archives, so the site can show any country, not just
Malaysia and Indonesia.

Why it streams
    The archive is ~4.6 GB of nested zips that expand to ~21 GB across 6,474 CSV
    files. Nothing is ever extracted to disk: each inner zip is opened from
    memory, each country-year CSV is read in chunks, aggregated, and dropped.
    Peak memory stays in the hundreds of MB and the only output is a small CSV.

What it keeps (same rules as Clean.py, so the two records mean the same thing)
    - vegetation fires only (FIRMS type 0)
    - MODIS confidence >= 30; VIIRS low confidence dropped
    - rows missing a position or a timestamp dropped

Two numbers per country / year / month / sensor:
    hotspots        raw detections, that is, satellite pixels
    fire_cell_days  a 0.05 deg cell that burned on a given day, counted once.
                    This is the comparable measure - it does not inflate when a
                    sensor sees the same fire with more, smaller pixels.

Dates are local, approximated from longitude (UTC offset = round(lon / 15)).
The regional pipeline uses real time zones; at world scale that is not worth a
dependency, and it only matters for fires within an hour of a month boundary.

IMPORTANT - this archive's VIIRS is JPSS-1 (NOAA-20), not S-NPP. The MODIS->VIIRS
calibration in calibration.py was fitted against S-NPP over 2012-2025 and does
NOT carry over. World figures are reported per sensor and left uncalibrated.

Usage:
    python world_build.py --zip "C:/path/Dataset (World).zip"
                          [--out Clean_dataset/world_monthly.csv]
                          [--years 2023,2024] [--max-files N]
"""
from __future__ import annotations

import argparse
import csv
import io
import os
import sys
import time
import zipfile
from collections import defaultdict

GRID = 0.05            # same cell size as calibration.py
MODIS_MIN_CONF = 30
VIIRS_KEEP = {"n", "h"}


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", required=True, help="the Dataset (World).zip archive")
    ap.add_argument("--out", default=os.path.join("Clean_dataset", "world_monthly.csv"))
    ap.add_argument("--years", default="", help="comma separated, e.g. 2023,2024 (default: all)")
    ap.add_argument("--max-files", type=int, default=0, help="stop after N country files (testing)")
    return ap.parse_args()


def country_of(path: str) -> str:
    """viirs-jpss1/2025/viirs-jpss1_2025_Papua_New_Guinea.csv -> Papua New Guinea"""
    base = path.rsplit("/", 1)[-1]
    if base.lower().endswith(".csv"):
        base = base[:-4]
    parts = base.split("_")
    # <sensor>_<year>_<Country With Underscores>
    for i, part in enumerate(parts):
        if part.isdigit() and len(part) == 4:
            return " ".join(parts[i + 1:]).strip() or "Unknown"
    return base.replace("_", " ")


def read_rows(handle):
    """Yield dict rows from a CSV file object, tolerating a stray BOM."""
    text = io.TextIOWrapper(handle, encoding="utf-8-sig", errors="replace", newline="")
    return csv.DictReader(text)


def aggregate_file(handle, sensor: str):
    """One country-year CSV -> {(year, month): [hotspots, {cell-day keys}, frp_sum]}"""
    out: dict[tuple[int, int], list] = defaultdict(lambda: [0, set(), 0.0])
    for row in read_rows(handle):
        date = row.get("acq_date") or ""
        lat = row.get("latitude") or ""
        lon = row.get("longitude") or ""
        if len(date) < 10 or not lat or not lon:
            continue
        if (row.get("type") or "0").strip() not in ("0", ""):
            continue                                        # volcanoes, gas flares, offshore
        conf = (row.get("confidence") or "").strip().lower()
        if sensor == "MODIS":
            try:
                if float(conf) < MODIS_MIN_CONF:
                    continue
            except ValueError:
                continue
        elif conf[:1] not in VIIRS_KEEP:
            continue

        try:
            la, lo = float(lat), float(lon)
            y, m, d = int(date[:4]), int(date[5:7]), int(date[8:10])
        except ValueError:
            continue

        # local date, approximated from longitude; a fire just before midnight UTC
        # in the east belongs to the next day locally
        hhmm = (row.get("acq_time") or "0000").zfill(4)
        try:
            hour = int(hhmm[:2])
        except ValueError:
            hour = 0
        shifted = hour + round(lo / 15.0)
        if shifted >= 24:
            d += 1
        elif shifted < 0:
            d -= 1
        if d > 28:                     # keep month assignment cheap and stable
            d = min(d, 31)
        elif d < 1:
            d = 1

        gx = int(lo // GRID) + 7200
        gy = int(la // GRID) + 3600
        bucket = out[(y, m)]
        bucket[0] += 1
        bucket[1].add((gy * 14400 + gx) * 32 + d)          # packed cell-day key
        try:
            bucket[2] += float(row.get("frp") or 0.0)
        except ValueError:
            pass
    return out


def main():
    args = parse_args()
    want_years = {int(y) for y in args.years.split(",") if y.strip()} if args.years else None

    if not os.path.exists(args.zip):
        raise SystemExit(f"archive not found: {args.zip}")
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)

    totals: dict[tuple, list] = defaultdict(lambda: [0, 0, 0.0])   # key -> hotspots, cell-days, frp
    seen_files = 0
    started = time.time()

    outer = zipfile.ZipFile(args.zip)
    inner_names = sorted(n for n in outer.namelist() if n.lower().endswith(".zip"))
    print(f"{len(inner_names)} yearly archives in {os.path.basename(args.zip)}")

    for inner_name in inner_names:
        sensor = "MODIS" if "modis" in inner_name.lower() else "VIIRS"
        label = inner_name.rsplit("/", 1)[-1]
        if want_years and not any(str(y) in label for y in want_years):
            continue
        t0 = time.time()
        inner = zipfile.ZipFile(io.BytesIO(outer.read(inner_name)))
        csvs = [i for i in inner.infolist() if i.filename.lower().endswith(".csv")]
        rows_before = sum(v[0] for v in totals.values())

        for info in csvs:
            country = country_of(info.filename)
            with inner.open(info) as handle:
                per_month = aggregate_file(handle, sensor)
            for (year, month), (hot, celldays, frp) in per_month.items():
                if want_years and year not in want_years:
                    continue
                acc = totals[(country, year, month, sensor)]
                acc[0] += hot
                acc[1] += len(celldays)
                acc[2] += frp
            seen_files += 1
            if args.max_files and seen_files >= args.max_files:
                break

        added = sum(v[0] for v in totals.values()) - rows_before
        print(f"  {label:<44} {len(csvs):>4} countries  {added:>11,} detections  {time.time() - t0:5.0f}s",
              flush=True)
        inner.close()
        if args.max_files and seen_files >= args.max_files:
            break

    rows = sorted(totals.items())
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["country", "year", "month", "sensor", "hotspots", "fire_cell_days", "frp_sum"])
        for (country, year, month, sensor), (hot, celldays, frp) in rows:
            writer.writerow([country, year, month, sensor, hot, celldays, round(frp, 1)])

    countries = len({k[0] for k in totals})
    detections = sum(v[0] for v in totals.values())
    print(f"\nSaved {len(rows):,} rows -> {args.out}")
    print(f"{countries:,} countries · {detections:,} detections kept · {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
