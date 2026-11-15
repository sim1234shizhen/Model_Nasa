"""Per-country monthly fire history for the whole world.

Reads Clean_dataset/world_monthly.csv, built by world_build.py from the NASA
FIRMS "all countries" yearly archives. The file is small, so it is read once and
cached, and re-read automatically when it changes on disk.

This layer is deliberately coarser than the Malaysia/Indonesia record:

  - Counts are reported per sensor and are NOT calibrated onto a common scale.
    The world archive carries VIIRS JPSS-1 (NOAA-20), while the regional
    calibration was fitted against VIIRS S-NPP over a longer overlap, so those
    coefficients do not transfer. Comparing one country with another within the
    same sensor is sound; adding MODIS and VIIRS together is not.
  - There is no sub-national breakdown and no forecast. It answers "where and
    when does this country burn", not "where will it burn next".

Dates are local, approximated from longitude when the file was built.
"""
from __future__ import annotations

import csv
import threading
from pathlib import Path

from app.config import CLEAN_DIR

WORLD_CSV = CLEAN_DIR / "world_monthly.csv"
SENSORS = ("MODIS", "VIIRS")

_lock = threading.Lock()
_cache: tuple[float, dict] | None = None


def available() -> bool:
    return WORLD_CSV.exists()


def _load() -> dict:
    """{'rows': [...], 'countries': {...}, 'years': [...]} - cached on file mtime."""
    global _cache
    if not WORLD_CSV.exists():
        raise FileNotFoundError(
            f"{WORLD_CSV} not found - run world_build.py to build the world record")
    mtime = WORLD_CSV.stat().st_mtime
    if _cache and _cache[0] == mtime:
        return _cache[1]
    with _lock:
        if _cache and _cache[0] == mtime:
            return _cache[1]
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
        countries: dict[str, dict] = {}
        for row in rows:
            entry = countries.setdefault(row["country"], {s: 0 for s in SENSORS})
            entry[row["sensor"]] = entry.get(row["sensor"], 0) + row["fire_cell_days"]
        data = {
            "rows": rows,
            "countries": countries,
            "years": sorted({row["year"] for row in rows}),
        }
        _cache = (mtime, data)
        return data


def coverage() -> dict:
    data = _load()
    years = data["years"]
    per_sensor = {
        sensor: sorted({r["year"] for r in data["rows"] if r["sensor"] == sensor})
        for sensor in SENSORS
    }
    return {
        "countries": len(data["countries"]),
        "years": {"first": years[0], "last": years[-1]} if years else {},
        "sensor_years": {
            s: ({"first": v[0], "last": v[-1]} if v else {}) for s, v in per_sensor.items()
        },
        "rows": len(data["rows"]),
        "unit": "fire cell-days: one 0.05 degree cell burning on one day, counted once",
        "calibrated": False,
        "note": ("Counts are per sensor and not calibrated onto a common scale. The world "
                 "archive uses VIIRS JPSS-1, not the S-NPP the regional calibration was "
                 "fitted against, so MODIS and VIIRS totals must not be added together."),
    }


def countries() -> list[dict]:
    data = _load()
    out = []
    for name, totals in data["countries"].items():
        out.append({"country": name,
                    "fire_cell_days": {s: totals.get(s, 0) for s in SENSORS}})
    out.sort(key=lambda c: -c["fire_cell_days"]["VIIRS"] or -c["fire_cell_days"]["MODIS"])
    return out


def _match(name: str) -> str | None:
    data = _load()
    if name in data["countries"]:
        return name
    wanted = name.strip().lower()
    for candidate in data["countries"]:
        if candidate.lower() == wanted:
            return candidate
    hits = [c for c in data["countries"] if wanted in c.lower()]
    return hits[0] if len(hits) == 1 else None


def country(name: str, sensor: str = "VIIRS") -> dict:
    data = _load()
    resolved = _match(name)
    if resolved is None:
        raise KeyError(name)
    sensor = sensor.upper()
    if sensor not in SENSORS:
        raise ValueError(sensor)
    rows = [r for r in data["rows"] if r["country"] == resolved and r["sensor"] == sensor]
    rows.sort(key=lambda r: (r["year"], r["month"]))

    by_month: dict[int, list[int]] = {m: [] for m in range(1, 13)}
    for row in rows:
        by_month[row["month"]].append(row["fire_cell_days"])
    season = []
    for month in range(1, 13):
        values = sorted(by_month[month])
        median = values[len(values) // 2] if values else 0
        season.append({"month": month, "median_fire_cell_days": median})
    peak = max(season, key=lambda s: s["median_fire_cell_days"])["month"] if rows else None

    totals: dict[int, int] = {}
    for row in rows:
        totals[row["year"]] = totals.get(row["year"], 0) + row["fire_cell_days"]

    return {
        "country": resolved,
        "sensor": sensor,
        "unit": "fire cell-days",
        "months": [{"year": r["year"], "month": r["month"],
                    "hotspots": r["hotspots"], "fire_cell_days": r["fire_cell_days"],
                    "frp_sum": round(r["frp_sum"], 1)} for r in rows],
        "annual_totals": [{"year": y, "fire_cell_days": v} for y, v in sorted(totals.items())],
        "typical_season": season,
        "peak_month": peak,
        "calibrated": False,
    }


def ranking(year: int, month: int | None = None, sensor: str = "VIIRS", limit: int = 20) -> dict:
    data = _load()
    sensor = sensor.upper()
    if sensor not in SENSORS:
        raise ValueError(sensor)
    totals: dict[str, int] = {}
    for row in data["rows"]:
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
