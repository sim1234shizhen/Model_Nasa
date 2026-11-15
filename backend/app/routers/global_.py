"""Whole-world endpoints for the World page (data from step2_harmonize_global.py)."""
from fastapi import APIRouter, HTTPException, Query

from app.services import global_data as g

router = APIRouter(prefix="/api/global", tags=["global"])


def _guard(fn, *args):
    try:
        return fn(*args)
    except FileNotFoundError as e:
        missing = e.filename or (e.args[0] if e.args else "data file")
        raise HTTPException(503, f"{missing} not found - run step2_harmonize_global.py with --outdir Clean_dataset/global")
    except KeyError as e:
        raise HTTPException(404, f"Unknown country '{e.args[0]}'")
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.get("/summary")
def summary():
    """Country list (totals, peak month, calibration, centre/bbox) + world validation scores."""
    return _guard(g.summary)


@router.get("/series")
def series(country: str = Query("World", description="'World' or a country name")):
    """Monthly harmonized fire cell-days 2003-2025 with anomaly vs same-month median."""
    return _guard(g.series, country)


@router.get("/ranking")
def ranking(year: int = Query(..., ge=2003, le=2025), month: int = Query(0, ge=0, le=12, description="0 = whole year")):
    """Every country's fire activity for one month or year, vs its typical level."""
    return _guard(g.ranking, year, month)


@router.get("/map")
def world_map(year: int = Query(..., ge=2003, le=2025), month: int = Query(0, ge=0, le=12, description="0 = whole year")):
    """1-degree cells: [lon_west, lat_south, fire_cell_days, country_index into /summary countries]."""
    return _guard(g.world_map, year, month)
