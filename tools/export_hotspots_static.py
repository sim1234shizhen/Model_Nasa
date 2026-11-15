"""Export every cleaned hotspot as compact per-month binary files for the static site.

The Dashboard's "Hotspot map" asks /api/hotspots/range and /api/hotspots/range.csv,
which on the local server filter Clean_dataset/clean_hotspots.csv. The static
build has no server, so docs/static-api.js answers those requests in the browser
from these files instead:

    docs/data/hotspots/index.json        first/last date, VIIRS start, region list, rows per month
    docs/data/hotspots/<YYYY>-<MM>.bin   16 bytes per detection, little-endian:
        float32 lat
        float32 lon
        float32 frp (MW)
        uint8  day of month
        uint8  region index (into index.json "regions")
        uint8  sensor (0 MODIS, 1 VIIRS)
        uint8  padding

Run after Clean.py:

    backend/.venv/Scripts/python.exe tools/export_hotspots_static.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.config import REGIONS  # noqa: E402
from app.services import harmonized as H  # noqa: E402

OUT = ROOT / "docs" / "data" / "hotspots"
ROW = np.dtype([("lat", "<f4"), ("lon", "<f4"), ("frp", "<f4"), ("day", "u1"),
                ("region", "u1"), ("sensor", "u1"), ("pad", "u1")])


def main() -> None:
    df = H.clean_hotspots()
    regions = list(REGIONS)
    region_idx = {r: i for i, r in enumerate(regions)}
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.bin"):
        old.unlink()

    months: dict[str, int] = {}
    for (year, month), g in df.groupby(["year", "month"], sort=True):
        g = g.sort_values(["day", "frp"], ascending=[True, False])
        rows = np.zeros(len(g), dtype=ROW)
        rows["lat"] = g["lat"].to_numpy(np.float32)
        rows["lon"] = g["lon"].to_numpy(np.float32)
        rows["frp"] = g["frp"].to_numpy(np.float32)
        rows["day"] = g["day"].to_numpy(np.uint8)
        rows["region"] = g["region"].astype(str).map(region_idx).to_numpy(np.uint8)
        rows["sensor"] = (g["sensor"].astype(str) == "VIIRS").to_numpy(np.uint8)
        key = f"{int(year):04d}-{int(month):02d}"
        (OUT / f"{key}.bin").write_bytes(rows.tobytes())
        months[key] = int(len(g))

    index = {**H.hotspot_dates(), "regions": regions,
             "countries": {r: v["country"] for r, v in REGIONS.items()},
             "row_bytes": ROW.itemsize, "months": months}
    (OUT / "index.json").write_text(json.dumps(index), encoding="utf-8")
    size = sum(p.stat().st_size for p in OUT.glob("*.bin"))
    print(f"{len(months)} month files, {sum(months.values()):,} detections, {size / 1e6:.1f} MB -> {OUT}")


if __name__ == "__main__":
    main()
