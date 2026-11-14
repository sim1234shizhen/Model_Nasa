"""Endpoints for the website: harmonized monthly series, calibration, hotspot map."""
from fastapi import APIRouter, HTTPException, Query

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
def harmonized(scope: str = Query("All", description="All, Malaysia, Indonesia, or a region name")):
    """Monthly harmonized fire cell-days (VIIRS-equivalent) with anomaly vs same-month median."""
    return {"scope": scope, "series": _guard(svc.monthly_series, scope)}


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
