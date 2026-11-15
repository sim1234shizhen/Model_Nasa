"""Write the gridded-hotspot static JSON in one pass over clean_hotspots.

`export_static.py` asks the API for each scope x month x cell size separately,
which re-filters the 6.8M-row table thousands of times. This does the same
aggregation once per cell size and then sums the region groups, so the five
new Indonesian regions finish in minutes.

Output matches docs/data/grid/<Scope>/<year>-<month>.json exactly, including
the compact `k` + array form used by static-api.js.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from app.config import REGIONS  # noqa: E402
from app.services.harmonized import clean_hotspots, scope_regions  # noqa: E402

OUT = ROOT / "docs" / "data" / "grid"
CELLS = ("0.25", "0.1", "0.05")
KEYS = ["lat", "lon", "cell_days", "hotspots", "frp"]
SCOPES = ["All"] + sorted({v["country"] for v in REGIONS.values()}) + list(REGIONS)


def slug(name: str) -> str:
    return name.replace(" ", "_")


def save(rel: str, obj) -> None:
    path = OUT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(obj, fh, separators=(",", ":"), ensure_ascii=False)


def groups_for_cell(df: pd.DataFrame, cell: float) -> dict:
    gx = np.floor(df["lon"].to_numpy() / cell).astype("int32")
    gy = np.floor(df["lat"].to_numpy() / cell).astype("int32")
    work = df.assign(gx=gx, gy=gy)
    grouped = work.groupby(["year", "month", "sensor", "region", "gx", "gy"],
                            observed=True).agg(
        hotspots=("day", "size"), days=("day", "nunique"), frp=("frp", "sum"),
    ).reset_index()
    return {
        (int(year), int(month), str(sensor)): sub
        for (year, month, sensor), sub in grouped.groupby(
            ["year", "month", "sensor"], observed=True)
    }


def scope_table(month_groups: dict, scope: str):
    regions = scope_regions(scope)
    if len(regions) == 1:
        return month_groups.get(regions[0])
    parts = [month_groups[r] for r in regions if r in month_groups]
    if not parts:
        return None
    joined = pd.concat(parts, ignore_index=True)
    return joined.groupby(["gx", "gy"], observed=True).agg(
        hotspots=("hotspots", "sum"), days=("days", "sum"), frp=("frp", "sum"),
    ).reset_index()


def payload_for(table, cell: float) -> dict:
    if table is None or table.empty:
        return {"cell": cell, "hotspots": 0, "cell_days": 0, "cells": []}
    ordered = table.sort_values(["gx", "gy"], ignore_index=True)
    cells = [
        [round(float(row.gy) * cell, 4), round(float(row.gx) * cell, 4),
         int(row.days), int(row.hotspots), round(float(row.frp), 1)]
        for row in ordered.itertuples(index=False)
    ]
    return {"cell": cell, "hotspots": int(ordered["hotspots"].sum()),
            "cell_days": int(ordered["days"].sum()), "cells": cells}


def main() -> None:
    df = clean_hotspots()
    years = sorted({int(y) for y in df["year"].unique() if 2003 <= int(y) <= 2025})
    print(f"{len(df):,} rows, {len(years)} years ({years[0]}-{years[-1]})", flush=True)

    per_cell = {name: groups_for_cell(df, float(name)) for name in CELLS}
    print("aggregated by cell size", flush=True)

    for index, year in enumerate(years, 1):
        for month in range(1, 13):
            auto = "VIIRS" if (year, month) >= (2012, 2) else "MODIS"
            out = {scope: {"cells": {name: {} for name in CELLS}, "auto": auto}
                   for scope in SCOPES}
            for name in CELLS:
                groups = per_cell[name]
                for sensor in ("MODIS", "VIIRS"):
                    sub = groups.get((year, month, sensor))
                    month_groups = {}
                    if sub is not None:
                        for region in REGIONS:
                            rows = sub.loc[sub["region"] == region]
                            if not rows.empty:
                                month_groups[region] = rows
                    for scope in SCOPES:
                        table = scope_table(month_groups, scope)
                        out[scope]["cells"][name][sensor] = {
                            "sensor": sensor,
                            **payload_for(table, float(name)),
                            "k": KEYS,
                        }
            for scope in SCOPES:
                save(f"{slug(scope)}/{year}-{month:02d}.json", out[scope])
        if index % 10 == 0:
            print(f"  {index}/{len(years)} years", flush=True)


if __name__ == "__main__":
    main()
