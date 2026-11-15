"""Worldwide per-country fire history from the FIRMS all-countries archives.

Sits beside /api/world (fire weather) and the regional Malaysia/Indonesia
endpoints. Observed history and country-level seasonal estimates use
separate datasets and endpoints.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.services import world_fire_grid, world_fires, world_outlook
from app.services import world_spatial_forecast

router = APIRouter(prefix="/api/world/fires", tags=["world fires"])


def _guard():
    if not world_fires.available():
        raise HTTPException(503, "The world fire record has not been built yet - "
                                 "run world_build.py to create Clean_dataset/world_monthly.csv")


@router.get("")
def coverage() -> dict:
    """What the world record covers, and the caveats that come with it."""
    _guard()
    return world_fires.coverage()


@router.get("/countries")
def countries() -> dict:
    """Every country in the record with its all-time total, busiest first."""
    _guard()
    rows = world_fires.countries()
    return {"count": len(rows), "countries": rows}


@router.get("/country/{name}")
def country(name: str, sensor: str = Query("VIIRS", pattern="^(?i)(MODIS|VIIRS)$")) -> dict:
    """One country month by month, with its typical season and annual totals."""
    _guard()
    try:
        return world_fires.country(name, sensor)
    except KeyError:
        raise HTTPException(404, f"'{name}' is not a country in the world record")
    except ValueError:
        raise HTTPException(422, "sensor must be MODIS or VIIRS")


@router.get("/grid")
def grid(year: int = Query(..., ge=2000, le=2030), month: int = Query(..., ge=1, le=12)) -> dict:
    """Harmonized historical fire activity in 1-degree global cells."""
    try:
        return world_fire_grid.monthly_grid(year, month)
    except FileNotFoundError:
        raise HTTPException(503, "The global fire grid dataset is unavailable") from None


@router.get("/outlook-map")
def outlook_map() -> dict:
    """Typical monthly fire activity by country and map boundary name."""
    try:
        return world_outlook.map_outlook()
    except FileNotFoundError:
        raise HTTPException(503, "The global fire outlook data is unavailable") from None


@router.get("/outlook/{name}")
def outlook(name: str) -> dict:
    """Country-level monthly seasonal estimate after the observation record."""
    try:
        return world_outlook.outlook(name)
    except KeyError:
        raise HTTPException(404, f"No seasonal record for {name}") from None
    except FileNotFoundError:
        raise HTTPException(503, "The harmonized world monthly dataset is unavailable") from None


@router.get("/forecast-map")
def forecast_map(
    year: int = Query(2026, description="First or second year after the data ends"),
    enso: str = Query("observed", pattern=r"^(observed|-?\d+(\.\d+)?)$"),
) -> dict:
    """Model estimate for every country, month by month, joined to map boundary names."""
    try:
        return world_spatial_forecast.map_outlook(year, enso)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    except FileNotFoundError:
        raise HTTPException(503, "The global cell dataset is unavailable") from None


@router.get("/forecast/{name}")
def forecast(
    name: str,
    year: int = Query(2026, description="First or second year after the data ends"),
    enso: str = Query("observed", pattern=r"^(observed|-?\d+(\.\d+)?)$",
                      description="'observed' (NOAA ONI) or a scenario ONI value, e.g. 2, 1, 0, -1"),
) -> dict:
    """Cell-level fire forecast for one country on the global 1-degree grid.

    Cells are compact rows: [lat_south, lon_west, chance_pct, expected_fire_days_x10, area_index].
    """
    try:
        return world_spatial_forecast.forecast_map(name, year, enso)
    except KeyError:
        raise HTTPException(404, f"'{name}' is not a country in the global cell record") from None
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    except FileNotFoundError:
        raise HTTPException(503, "The global cell dataset is unavailable") from None


@router.get("/ranking")
def ranking(
    year: int = Query(..., description="Calendar year"),
    month: int | None = Query(None, ge=1, le=12, description="Omit for the whole year"),
    sensor: str = Query("VIIRS", pattern="^(?i)(MODIS|VIIRS)$"),
    limit: int = Query(20, ge=1, le=200),
) -> dict:
    """The countries that burned most in a year, or in one month of it."""
    _guard()
    try:
        return world_fires.ranking(year, month, sensor, limit)
    except ValueError:
        raise HTTPException(422, "sensor must be MODIS or VIIRS")
