"""Shared query parameters / dependencies for the routers."""
from __future__ import annotations

from typing import Optional

import pandas as pd
from fastapi import HTTPException, Query

from app.config import DATA_DIR, DATASETS
from app.services.data_loader import filter_fires, get_dataset


def load_dataset_or_404(dataset: str) -> pd.DataFrame:
    if dataset not in DATASETS:
        raise HTTPException(404, f"Unknown dataset '{dataset}'. See GET /api/datasets")
    if not (DATA_DIR / DATASETS[dataset]["file"]).exists():
        raise HTTPException(404, f"Data file for '{dataset}' not found in {DATA_DIR}")
    return get_dataset(dataset)


def parse_bbox(bbox: Optional[str]) -> Optional[tuple[float, float, float, float]]:
    if not bbox:
        return None
    try:
        parts = tuple(float(x) for x in bbox.split(","))
        assert len(parts) == 4
        return parts  # type: ignore[return-value]
    except Exception:
        raise HTTPException(422, "bbox must be 'min_lon,min_lat,max_lon,max_lat'")


class FireFilters:
    """Common filters: inject with `filters: FireFilters = Depends()`."""

    def __init__(
        self,
        dataset: str = Query("viirs-snpp-malaysia", description="Dataset id from /api/datasets"),
        start_date: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive)"),
        end_date: Optional[str] = Query(None, description="YYYY-MM-DD (inclusive)"),
        bbox: Optional[str] = Query(None, description="min_lon,min_lat,max_lon,max_lat"),
        min_frp: Optional[float] = Query(None, ge=0, description="Minimum Fire Radiative Power (MW)"),
        confidence: Optional[list[str]] = Query(None, description="low / nominal / high (repeatable)"),
        daynight: Optional[str] = Query(None, pattern="^[DNdn]$", description="D or N"),
    ):
        self.dataset = dataset
        self.start_date = start_date
        self.end_date = end_date
        self.bbox = parse_bbox(bbox)
        self.min_frp = min_frp
        self.confidence = confidence
        self.daynight = daynight

    def apply(self) -> pd.DataFrame:
        df = load_dataset_or_404(self.dataset)
        try:
            return filter_fires(df, self.start_date, self.end_date, self.bbox,
                                self.min_frp, self.confidence, self.daynight)
        except ValueError as e:
            raise HTTPException(422, f"Invalid filter value: {e}")
