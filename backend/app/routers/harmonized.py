"""Endpoints for the website: harmonized monthly series, calibration, hotspot map."""
import re
from datetime import date

from fastapi import APIRouter, HTTPException, Query, Response

from app.config import REGIONS
from app.services import forecast as fc
from app.services import harmonized as svc
from app.services import spatial_forecast as sp

router = APIRouter(prefix="/api", tags=["harmonized"])


def _guard(fn, *args):
    try:
        return fn(*args)
    except FileNotFoundError as e:
        missing = e.filename or (e.args[0] if e.args else "data file")
        raise HTTPException(503, f"{missing} not found - run Clean.py and calibration.py first")
    except KeyError as e:
        raise HTTPException(404, f"Unknown area '{e.args[0]}'")


@router.get("/regions")
def regions():
    return [{"region": r, "country": v["country"], "bbox": v["bbox"]} for r, v in REGIONS.items()]


@router.get("/harmonized")
def harmonized(scope: str = Query("All", description="All, World, any country, or a Malaysia/Indonesia region name")):
    """Monthly harmonized fire cell-days (VIIRS-equivalent) with anomaly vs same-month median."""
    return {"scope": scope, "series": _guard(svc.monthly_series, scope)}


@router.get("/harmonized/countries")
def harmonized_countries(year: int = Query(..., ge=2000, le=2030)):
    """Every country's monthly cell-days for `year` and `year - 1` (world dashboard breakdown)."""
    return {"year": year, "countries": _guard(svc.world_country_months, year)}


@router.get("/harmonized/areas")
def harmonized_areas():
    """Countries available in the worldwide record (besides 'World' itself)."""
    return {"world": svc.WORLD_SCOPE, "countries": _guard(svc.world_countries)}


@router.get("/calibration")
def calibration():
    df = _guard(svc.calibration)
    return df.astype(object).where(df.notna(), None).to_dict(orient="records")


@router.get("/calibration/points")
def calibration_points(region: str = Query(..., description="Region name")):
    """Overlap months (MODIS vs VIIRS) + fitted model for the scatter plot."""
    return _guard(svc.calibration_points, region)


@router.get("/hotspots/grid")
def hotspot_grid(
    scope: str = Query("All"),
    year: int = Query(..., ge=2000, le=2030),
    month: int = Query(..., ge=1, le=12),
    sensor: str = Query("auto", pattern="^(auto|MODIS|VIIRS)$"),
    cell: float = Query(0.1, ge=0.02, le=1.0, description="Grid cell size in degrees"),
):
    """Cleaned hotspots for one month, binned into grid cells for the map."""
    return _guard(svc.hotspot_grid, scope, year, month, sensor, cell)


def _date_key(s: str, name: str) -> int:
    try:
        return int(date.fromisoformat(s).strftime("%Y%m%d"))
    except ValueError:
        raise HTTPException(422, f"{name} must be a date like 2019-09-14")


def _range_args(start: str, end: str) -> tuple[int, int]:
    a, b = _date_key(start, "start"), _date_key(end, "end")
    if a > b:
        raise HTTPException(422, "start must be on or before end")
    return a, b


@router.get("/hotspots/dates")
def hotspot_dates():
    """First and last date with cleaned hotspots."""
    return _guard(svc.hotspot_dates)


@router.get("/hotspots/range")
def hotspot_range(
    scope: str = Query("All"),
    start: str = Query(..., description="First date, YYYY-MM-DD"),
    end: str = Query(..., description="Last date, YYYY-MM-DD (inclusive)"),
    sensor: str = Query("auto", pattern="^(auto|MODIS|VIIRS|both)$"),
):
    """Hotspots between two dates: totals, day-by-day counts, per-region breakdown and map points
    (strongest 15,000 by FRP; the CSV endpoint has all of them)."""
    a, b = _range_args(start, end)
    return _guard(svc.hotspot_range, scope, a, b, sensor)


@router.get("/hotspots/range.csv")
def hotspot_range_csv(
    scope: str = Query("All"),
    start: str = Query(...),
    end: str = Query(...),
    sensor: str = Query("auto", pattern="^(auto|MODIS|VIIRS|both)$"),
):
    """Every cleaned hotspot between two dates as a CSV download."""
    a, b = _range_args(start, end)
    body = _guard(svc.hotspot_range_csv, scope, a, b, sensor)
    name = f"fire_points_{re.sub(r'[^A-Za-z0-9]+', '_', scope)}_{start}_to_{end}.csv"
    return Response(body, media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.get("/forecast")
def forecast(
    scope: str = Query("All"),
    year: int = Query(2026, description="First or second year after the data ends"),
    enso: str = Query("observed", pattern=r"^(observed|-?\d+(\.\d+)?)$",
                      description="'observed' (NOAA ONI) or a scenario ONI value, e.g. 2, 1, 0, -1"),
):
    """Monthly fire-activity forecast with 80% range and chance of an above-normal month."""
    try:
        return _guard(fc.forecast, scope, year, enso)
    except ValueError as e:
        raise HTTPException(422, str(e))


@router.get("/forecast/map")
def forecast_map(
    scope: str = Query("All"),
    year: int = Query(2026),
    enso: str = Query("observed", pattern=r"^(observed|-?\d+(\.\d+)?)$"),
):
    """Where: chance of at least one fire day per 0.25-degree cell for each month, plus top areas.
    Cells are compact rows: [lat_south, lon_west, chance_pct, expected_fire_days_x10, area_index]."""
    try:
        return _guard(sp.forecast_map, scope, year, enso)
    except ValueError as e:
        raise HTTPException(422, str(e))


@router.get("/enso")
def enso():
    """Latest NOAA Oceanic Nino Index (El Nino / La Nina state)."""
    return fc.oni_info()


@router.get("/status")
def status():
    return {"hotspots_ready": svc.clean_ready()}
