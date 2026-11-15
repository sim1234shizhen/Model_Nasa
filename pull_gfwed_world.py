"""Pull GFWED fire weather for the whole world, one month at a time.

The regional puller (pull_gfwed.py) averages a box per region. This one keeps a
1-degree grid over the entire globe instead, so the site can show fire danger
anywhere - no fire history required, no per-country download.

Each monthly file is ~4 MB. It is downloaded, coarsened to 1 degree, stored as a
small .npy part, and deleted. Peak disk cost is one raw file.

Output
    data/world/FWI_YYYYMM.npy    float16, shape (180, 360), north to south
    data/world/DC_YYYYMM.npy     float16, shape (180, 360)
    data/world/index.json        the months that succeeded

Run:  ./backend/.venv/Scripts/python.exe pull_gfwed_world.py
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

import numpy as np

try:
    import netCDF4
except ImportError:  # pragma: no cover
    netCDF4 = None

BASE = ("https://portal.nccs.nasa.gov/datashare/GlobalFWI/v2.0/fwiCalcs.MERRA2/"
        "Default/MERRA2.CORRECTED/{y}/FWI.MERRA2.CORRECTED.Monthly.Default.{y}{m:02d}.nc")

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data", "world")
TMP = os.path.join(OUT, "_tmp.nc")
YEARS = range(2003, 2027)      # 2026 months appear as GFWED publishes them
N_LAT, N_LON = 180, 360          # 1 degree output grid


def bin_to_grid(values: np.ndarray, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """Average onto a 1 degree grid using each cell's real latitude/longitude.

    The source grid is neither regular nor 1 degree (it is a MERRA-2 lattice),
    so the cells are binned by their coordinate rather than reshaped.
    Row 0 is the southernmost degree, column 0 the westernmost.
    """
    values = np.squeeze(values).astype("float32")
    lat_i = np.clip(np.floor(np.asarray(lat, dtype=float) + 90).astype(int), 0, N_LAT - 1)
    lon_i = np.clip(np.floor(np.asarray(lon, dtype=float) + 180).astype(int), 0, N_LON - 1)
    row, col = np.meshgrid(lat_i, lon_i, indexing="ij")

    ok = np.isfinite(values)
    sums = np.zeros((N_LAT, N_LON), dtype="float64")
    counts = np.zeros((N_LAT, N_LON), dtype="float64")
    np.add.at(sums, (row[ok], col[ok]), values[ok])
    np.add.at(counts, (row[ok], col[ok]), 1.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.where(counts > 0, sums / np.maximum(counts, 1), np.nan)
    return out.astype("float32")


def month_index(month: int) -> int:
    return month - 1


def main() -> None:
    if netCDF4 is None:
        raise SystemExit("netCDF4 is required: pip install netCDF4")
    os.makedirs(OUT, exist_ok=True)

    index_path = os.path.join(OUT, "index.json")
    done = []
    if os.path.exists(index_path):
        done = json.load(open(index_path))
    have = {(row["year"], row["month"]) for row in done}

    todo = [(y, m) for y in YEARS for m in range(1, 13) if (y, m) not in have]
    print(f"{len(todo)} months to pull, {len(have)} already on disk", flush=True)

    failures = []
    started = time.time()
    for n, (year, month) in enumerate(todo, 1):
        url = BASE.format(y=year, m=month)
        try:
            urllib.request.urlretrieve(url, TMP)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                failures.append((year, month, "missing"))
                print(f"  {year}-{month:02d} missing", flush=True)
                continue
            failures.append((year, month, str(exc)))
            print(f"  {year}-{month:02d} HTTP {exc.code}", flush=True)
            continue
        except Exception as exc:                      # noqa: BLE001 - network
            failures.append((year, month, str(exc)))
            print(f"  {year}-{month:02d} {exc}", flush=True)
            continue

        try:
            ds = netCDF4.Dataset(TMP)
            try:
                lat = np.asarray(ds.variables["lat"][:], dtype=float)
                lon = np.asarray(ds.variables["lon"][:], dtype=float)
                names = list(ds.variables)
                fwi_key = next(k for k in names if k.endswith("_FWI"))
                dc_key = next(k for k in names if k.endswith("_DC"))
                fwi_src = np.ma.filled(np.ma.asarray(ds.variables[fwi_key][:]), np.nan)
                dc_src = np.ma.filled(np.ma.asarray(ds.variables[dc_key][:]), np.nan)
            finally:
                ds.close()
        finally:
            try:
                os.remove(TMP)
            except OSError:
                pass

        fwi = bin_to_grid(fwi_src, lat, lon)
        dc = bin_to_grid(dc_src, lat, lon)
        stem = f"{year}{month:02d}"
        np.save(os.path.join(OUT, f"FWI_{stem}.npy"), fwi.astype("float16"))
        np.save(os.path.join(OUT, f"DC_{stem}.npy"), dc.astype("float16"))

        done.append({"year": year, "month": month})
        json.dump(done, open(index_path, "w"))

        if n % 12 == 0 or n == len(todo):
            rate = (time.time() - started) / n
            print(f"  {n}/{len(todo)}  {year}-{month:02d}  "
                  f"{rate:.1f}s/month  ~{rate * (len(todo) - n) / 60:.0f} min left", flush=True)

    print(f"done: {len(done)} months, {len(failures)} failures", flush=True)
    if failures:
        print("failures:", failures[:12], flush=True)


if __name__ == "__main__":
    main()
