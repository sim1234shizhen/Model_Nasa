"""Pull GFWED fire-weather indices (NASA GISS) for the 5 fire regions - parallel + resumable.

Downloads the MONTHLY netCDF files (4.3 MB each), cuts each to the region box, keeps
the regional mean of seven FWI-System indices, then deletes the download.

    data/gfwed_regions_monthly.csv   region x year x month  (final)
    data/gfwed_parts.jsonl           one line per finished month (resume log)

The host serves about 180 KB/s, so this takes ~10-15 min. Re-running resumes.
"""
from __future__ import annotations

import concurrent.futures as cf
import json
import os
import threading
import tempfile
import time
from pathlib import Path

import netCDF4 as nc
import numpy as np
import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "data"
OUT.mkdir(exist_ok=True)
PARTS = OUT / "gfwed_parts.jsonl"
NC_LOCK = threading.Lock()      # netCDF4/HDF5 is not thread-safe; serialise the parsing

BASE = ("https://portal.nccs.nasa.gov/datashare/GlobalFWI/v2.0/fwiCalcs.MERRA2/"
        "Default/MERRA2.CORRECTED/{y}/FWI.MERRA2.CORRECTED.Monthly.Default.{y}{m:02d}.nc")
YEARS = range(2003, 2027)
VARS = ["FWI", "DC", "DMC", "BUI", "ISI", "FFMC", "DSR"]

# lon_min, lat_min, lon_max, lat_max  (same boxes as Clean.py)
REGIONS = {
    "Peninsular Malaysia": (99.5, 1.2, 105.0, 6.8),
    "Sarawak": (109.5, 0.8, 115.8, 5.1),
    "Sabah": (115.0, 4.0, 119.5, 7.5),
    "Sumatra": (95.0, -6.0, 106.2, 6.0),
    "Kalimantan": (108.8, -4.3, 119.0, 4.5),
    "Java": (105.0, -9.0, 115.0, -5.5),
    "Nusa Tenggara": (114.5, -11.0, 125.0, -8.2),
    "Sulawesi": (118.5, -6.5, 125.5, 1.8),
    "Maluku": (125.5, -8.5, 131.0, -1.0),
    "Papua": (130.5, -9.5, 141.0, 0.5),
}


def done_keys() -> set[tuple[int, int]]:
    if not PARTS.exists():
        return set()
    out = set()
    with PARTS.open(encoding="utf-8") as f:
        for line in f:
            try:
                d = json.loads(line)
                if d.get("ok"):
                    out.add((d["y"], d["m"]))
            except Exception:
                pass
    return out


def one(job):
    y, m = job
    url = BASE.format(y=y, m=m)
    last = None
    for attempt in range(3):
        try:
            r = requests.get(url, timeout=240)
            if r.status_code == 404:
                return {"y": y, "m": m, "ok": False, "why": "missing"}
            r.raise_for_status()
            fd, tmp = tempfile.mkstemp(suffix=".nc", dir=OUT)
            os.close(fd)
            try:
                with open(tmp, "wb") as f:
                    f.write(r.content)
                with NC_LOCK:                      # one netCDF read at a time
                    d = nc.Dataset(tmp)
                    lat = np.asarray(d.variables["lat"][:], dtype=float)
                    lon = np.asarray(d.variables["lon"][:], dtype=float)
                    out = {}
                    for region, (x0, y0, x1, y1) in REGIONS.items():
                        iy = np.where((lat >= y0) & (lat <= y1))[0]
                        ix = np.where((lon >= x0) & (lon <= x1))[0]
                        if not len(iy) or not len(ix):
                            continue
                        for v in VARS:
                            key = f"MERRA2.CORRECTED_{v}"
                            if key not in d.variables:
                                continue
                            a = np.ma.filled(np.ma.asarray(d.variables[key][:]).astype(float), np.nan)
                            sub = a.squeeze()[np.ix_(iy, ix)]
                            sub[sub < 0] = np.nan      # ocean / no-data
                            out[f"{region}|{v}"] = round(float(np.nanmean(sub)), 3)
                    d.close()
                return {"y": y, "m": m, "ok": True, "vals": out}
            finally:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
        except Exception as e:
            last = repr(e)
            time.sleep(2 * (attempt + 1))
    return {"y": y, "m": m, "ok": False, "why": last}


def main():
    jobs = [(y, m) for y in YEARS for m in range(1, 13)]
    have = done_keys()
    todo = [j for j in jobs if j not in have]
    print(f"{len(jobs)} months total, {len(have)} already done, {len(todo)} to go", flush=True)

    t0, done, fails = time.time(), 0, []
    with PARTS.open("a", encoding="utf-8") as part, cf.ThreadPoolExecutor(max_workers=10) as ex:
        for res in ex.map(one, todo):
            part.write(json.dumps(res) + "\n")
            if res["ok"]:
                done += 1
            elif res.get("why") != "missing":
                fails.append(f"{res['y']}-{res['m']:02d}: {res['why']}")
            n = len(have) + done + len(fails)
            if n % 12 == 0:
                part.flush()
                print(f"  {n}/{len(jobs)}  {time.time()-t0:.0f}s", flush=True)

    # aggregate
    rows = []
    with PARTS.open(encoding="utf-8") as f:
        for line in f:
            d = json.loads(line)
            if not d.get("ok"):
                continue
            for key, val in d["vals"].items():
                region, var = key.split("|")
                rows.append({"region": region, "year": d["y"], "month": d["m"], "var": var, "value": val})
    df = pd.DataFrame(rows).drop_duplicates(subset=["region", "year", "month", "var"], keep="last")
    wide = (df.pivot_table(index=["region", "year", "month"], columns="var", values="value")
              .reset_index().round(2).sort_values(["region", "year", "month"]))
    wide.to_csv(OUT / "gfwed_regions_monthly.csv", index=False)

    print(f"\n{len(wide):,} region-months -> {OUT/'gfwed_regions_monthly.csv'}")
    print(f"took {time.time()-t0:.0f}s | failures {len(fails)}")
    for f_ in fails[:8]:
        print("  FAIL", f_)
    if len(wide):
        print("\nlatest per region:")
        for r, g in wide.groupby("region"):
            last = g.iloc[-1]
            print(f"  {r:22s} {int(last.year)}-{int(last.month):02d}  "
                  f"FWI {last.get('FWI')}  DC {last.get('DC')}")


if __name__ == "__main__":
    main()
