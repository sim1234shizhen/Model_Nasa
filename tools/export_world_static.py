"""Export the worldwide fire record and GFWED fire-danger grids as static JSON.

The GitHub Pages build has no FastAPI server, so every /api/world response the
site can ask for is written under docs/data/world:

    world/fires/coverage.json
    world/fires/countries.json
    world/fires/country/<Country>_<SENSOR>.json
    world/fires/ranking/<year>[_<month>]_<SENSOR>.json
    world/fires/grid/<year>-<month>.json
    world/fires/outlook/<Country>.json
    world/fires/outlook-map.json
    world/danger/<VARIABLE>_<year>-<month>.json
    world/coverage.json

Run after world_build.py and pull_gfwed_world.py:

    backend/.venv/Scripts/python.exe tools/export_world_static.py
"""
from __future__ import annotations

import base64
import csv
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORLD_CSV = ROOT / "Clean_dataset" / "world_monthly.csv"
WORLD_NPY = ROOT / "data" / "world"
OUT = ROOT / "docs" / "data" / "world"
SENSORS = ("MODIS", "VIIRS")
N_LAT, N_LON = 180, 360


def slug(name: str) -> str:
    return name.replace(" ", "_")


def save(rel: str, obj) -> None:
    path = OUT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(obj, fh, separators=(",", ":"), ensure_ascii=False)


def load_rows() -> list[dict]:
    rows = []
    with WORLD_CSV.open(encoding="utf-8", newline="") as fh:
        for raw in csv.DictReader(fh):
            try:
                rows.append({
                    "country": raw["country"],
                    "year": int(raw["year"]),
                    "month": int(raw["month"]),
                    "sensor": raw["sensor"],
                    "hotspots": int(raw["hotspots"]),
                    "fire_cell_days": int(raw["fire_cell_days"]),
                    "frp_sum": float(raw["frp_sum"] or 0.0),
                })
            except (KeyError, ValueError):
                continue
    return rows


def coverage(rows: list[dict], countries: dict) -> dict:
    years = sorted({row["year"] for row in rows})
    per_sensor = {
        sensor: sorted({r["year"] for r in rows if r["sensor"] == sensor})
        for sensor in SENSORS
    }
    return {
        "countries": len(countries),
        "years": {"first": years[0], "last": years[-1]} if years else {},
        "sensor_years": {
            s: ({"first": v[0], "last": v[-1]} if v else {}) for s, v in per_sensor.items()
        },
        "rows": len(rows),
        "unit": "fire cell-days: one 0.05 degree cell burning on one day, counted once",
        "calibrated": False,
        "note": ("Counts are per sensor and not calibrated onto a common scale. The world "
                 "archive uses VIIRS JPSS-1, not the S-NPP the regional calibration was "
                 "fitted against, so MODIS and VIIRS totals must not be added together."),
    }


def country_payload(rows: list[dict], name: str, sensor: str) -> dict:
    picked = [r for r in rows if r["country"] == name and r["sensor"] == sensor]
    picked.sort(key=lambda r: (r["year"], r["month"]))

    by_month: dict[int, list[int]] = {m: [] for m in range(1, 13)}
    for row in picked:
        by_month[row["month"]].append(row["fire_cell_days"])
    season = []
    for month in range(1, 13):
        values = sorted(by_month[month])
        median = values[len(values) // 2] if values else 0
        season.append({"month": month, "median_fire_cell_days": median})
    peak = max(season, key=lambda s: s["median_fire_cell_days"])["month"] if picked else None

    totals: dict[int, int] = {}
    for row in picked:
        totals[row["year"]] = totals.get(row["year"], 0) + row["fire_cell_days"]

    return {
        "country": name,
        "sensor": sensor,
        "unit": "fire cell-days",
        "months": [{"year": r["year"], "month": r["month"],
                    "hotspots": r["hotspots"], "fire_cell_days": r["fire_cell_days"],
                    "frp_sum": round(r["frp_sum"], 1)} for r in picked],
        "annual_totals": [{"year": y, "fire_cell_days": v} for y, v in sorted(totals.items())],
        "typical_season": season,
        "peak_month": peak,
        "calibrated": False,
    }


def ranking_payload(rows: list[dict], year: int, month: int | None, sensor: str, limit: int = 200) -> dict:
    totals: dict[str, int] = {}
    for row in rows:
        if row["year"] != year or row["sensor"] != sensor:
            continue
        if month and row["month"] != month:
            continue
        totals[row["country"]] = totals.get(row["country"], 0) + row["fire_cell_days"]
    ranked = sorted(totals.items(), key=lambda kv: -kv[1])[:limit]
    return {
        "year": year, "month": month, "sensor": sensor, "unit": "fire cell-days",
        "countries": [{"rank": i + 1, "country": c, "fire_cell_days": v}
                      for i, (c, v) in enumerate(ranked)],
        "calibrated": False,
    }


def export_fires(rows: list[dict]) -> None:
    countries: dict[str, dict] = {}
    for row in rows:
        entry = countries.setdefault(row["country"], {s: 0 for s in SENSORS})
        entry[row["sensor"]] = entry.get(row["sensor"], 0) + row["fire_cell_days"]

    save("fires/coverage.json", coverage(rows, countries))

    listed = [{"country": name,
               "fire_cell_days": {s: totals.get(s, 0) for s in SENSORS}}
              for name, totals in countries.items()]
    listed.sort(key=lambda c: -c["fire_cell_days"]["VIIRS"] or -c["fire_cell_days"]["MODIS"])
    save("fires/countries.json", {"count": len(listed), "countries": listed})

    for name in countries:
        for sensor in SENSORS:
            save(f"fires/country/{slug(name)}_{sensor}.json",
                 country_payload(rows, name, sensor))

    years = sorted({row["year"] for row in rows})
    for sensor in SENSORS:
        for year in years:
            save(f"fires/ranking/{year}_{sensor}.json",
                 ranking_payload(rows, year, None, sensor))
            for month in range(1, 13):
                save(f"fires/ranking/{year}_{month:02d}_{sensor}.json",
                     ranking_payload(rows, year, month, sensor))


def part(kind: str, year: int, month: int):
    import numpy as np
    path = WORLD_NPY / f"{kind}_{year}{month:02d}.npy"
    if not path.exists():
        return None
    return np.asarray(np.load(path, allow_pickle=False), dtype="float32")


def export_danger() -> None:
    import numpy as np

    index_path = WORLD_NPY / "index.json"
    if not index_path.exists():
        print("no data/world/index.json - run pull_gfwed_world.py first")
        return
    months = sorted((int(r["year"]), int(r["month"]))
                    for r in json.loads(index_path.read_text()))
    if not months:
        return

    years_by_month: dict[int, list[int]] = defaultdict(list)
    for year, month in months:
        years_by_month[month].append(year)

    baseline_end = 2025
    baseline_by_month = {
        month: [y for y in years if y <= baseline_end]
        for month, years in years_by_month.items()
    }
    stacks = {}
    for variable in ("FWI", "DC"):
        for month, years in baseline_by_month.items():
            parts = [part(variable, y, month) for y in years]
            stacks[(variable, month)] = np.stack(
                [p if p is not None else np.full((N_LAT, N_LON), np.nan, dtype="float32")
                 for p in parts])

    encoded = 0
    for year, month in months:
        years = baseline_by_month[month]
        for variable in ("FWI", "DC"):
            target = part(variable, year, month)
            if target is None:
                continue
            stack = stacks[(variable, month)]
            valid = np.isfinite(target) & np.isfinite(stack).all(axis=0)
            below = np.sum(np.where(valid[None, :, :], stack < target[None, :, :], False), axis=0)
            total = int(valid.sum())
            rank = np.zeros((N_LAT, N_LON), dtype="uint8")
            with np.errstate(invalid="ignore", divide="ignore"):
                pct = np.round(100.0 * below / max(len(years), 1))
            rank[valid] = np.clip(pct[valid], 1, 100).astype("uint8")
            save(f"danger/{variable}_{year}-{month:02d}.json", {
                "year": year,
                "month": month,
                "variable": variable,
                "rows": N_LAT,
                "cols": N_LON,
                "cells": total,
                "years_compared": [int(min(years)), int(max(years))],
                "encoding": "uint8-base64",
                "grid": base64.b64encode(rank.tobytes()).decode("ascii"),
            })
            encoded += 1

    save("coverage.json", {
        "available": True,
        "months": len(months),
        "first": f"{months[0][0]}-{months[0][1]:02d}",
        "last": f"{months[-1][0]}-{months[-1][1]:02d}",
        "grid": {"rows": N_LAT, "cols": N_LON, "degrees": 1},
        "variables": ["FWI", "DC"],
    })
    print(f"world danger: {encoded} grids over {len(months)} months")


def export_fire_grids() -> None:
    sys.path.insert(0, str(ROOT / "backend"))
    from app.services.world_fire_grid import grid_months, monthly_grid

    months = grid_months()
    for year, month in months:
        save(f"fires/grid/{year}-{month:02d}.json", monthly_grid(year, month))
    print(f"global fire grids: {len(months)} months")


def export_outlooks() -> None:
    sys.path.insert(0, str(ROOT / "backend"))
    from app.services.world_outlook import countries, map_outlook, outlook

    names = countries()
    for name in names:
        save(f"fires/outlook/{slug(name)}.json", outlook(name))
    save("fires/outlook-map.json", map_outlook())
    print(f"world seasonal outlooks: {len(names)} countries")


def export_forecasts() -> None:
    sys.path.insert(0, str(ROOT / "backend"))
    from app.services.world_spatial_forecast import _load, countries, forecast_map

    names = countries()
    last = _load()["last"]
    years = [last + 1, last + 2]
    ensos = ["observed", "-1", "0", "1", "2"]
    for name in names:
        bundle = {}
        for year in years:
            for enso in ensos:
                bundle[f"{year}_{enso}"] = forecast_map(name, year, enso)
        save(f"fires/forecast/{slug(name)}.json", bundle)
    print(f"world cell forecasts: {len(names)} country bundles over {len(years) * len(ensos)} variants")


def export_forecast_maps() -> None:
    sys.path.insert(0, str(ROOT / "backend"))
    from app.services.world_spatial_forecast import _load, map_outlook

    last = _load()["last"]
    years = [last + 1, last + 2]
    ensos = ["observed", "-1", "0", "1", "2"]
    for year in years:
        for enso in ensos:
            save(f"fires/forecast-map/{year}_{enso}.json", map_outlook(year, enso))
    print(f"world forecast map: {len(years) * len(ensos)} variants")


def main() -> None:
    if sys.argv[1:] == ["--outlook-only"]:
        export_outlooks()
        return
    if sys.argv[1:] == ["--grid-only"]:
        export_fire_grids()
        return
    if sys.argv[1:] == ["--forecast-only"]:
        export_forecasts()
        return
    if sys.argv[1:] == ["--forecast-map-only"]:
        export_forecast_maps()
        return
    if not WORLD_CSV.exists():
        raise SystemExit(f"{WORLD_CSV} not found - run world_build.py first")
    rows = load_rows()
    export_fires(rows)
    export_fire_grids()
    export_outlooks()
    export_forecasts()
    export_forecast_maps()
    print(f"world fires: {len({r['country'] for r in rows})} countries, {len(rows)} rows")
    export_danger()
    print(f"written under {OUT}")


if __name__ == "__main__":
    main()
