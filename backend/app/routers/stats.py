"""Aggregations for dashboards / charts."""
from fastapi import APIRouter, Depends, Query

from app.routers.deps import FireFilters
from app.schemas import SummaryResponse, TimeSeriesPoint, TimeSeriesResponse

router = APIRouter(prefix="/api/stats", tags=["stats"])

_FREQ = {"day": ("D", "%Y-%m-%d"), "month": ("MS", "%Y-%m"), "year": ("YS", "%Y")}


def _f(x):
    return None if x != x else round(float(x), 3)  # NaN -> None


@router.get("/summary", response_model=SummaryResponse)
def summary(filters: FireFilters = Depends()):
    df = filters.apply()
    empty = df.empty
    return SummaryResponse(
        dataset=filters.dataset,
        count=len(df),
        date_min=None if empty else df["acq_date"].min().strftime("%Y-%m-%d"),
        date_max=None if empty else df["acq_date"].max().strftime("%Y-%m-%d"),
        frp_mean=None if empty else _f(df["frp"].mean()),
        frp_max=None if empty else _f(df["frp"].max()),
        by_confidence={str(k): int(v) for k, v in df["confidence"].value_counts().items() if v},
        by_daynight={str(k): int(v) for k, v in df["daynight"].value_counts().items() if v},
        bbox=None if empty else [float(df["longitude"].min()), float(df["latitude"].min()),
                                 float(df["longitude"].max()), float(df["latitude"].max())],
    )


@router.get("/timeseries", response_model=TimeSeriesResponse)
def timeseries(
    filters: FireFilters = Depends(),
    freq: str = Query("month", pattern="^(day|month|year)$"),
):
    df = filters.apply()
    rule, fmt = _FREQ[freq]
    g = df.set_index("acq_date")["frp"].resample(rule).agg(["count", "sum", "mean"])
    series = [
        TimeSeriesPoint(period=idx.strftime(fmt), count=int(r["count"]),
                        frp_sum=round(float(r["sum"]), 3), frp_mean=_f(r["mean"]))
        for idx, r in g.iterrows()
    ]
    return TimeSeriesResponse(dataset=filters.dataset, freq=freq, series=series)


@router.get("/grid")
def grid(
    filters: FireFilters = Depends(),
    cell_deg: float = Query(0.25, gt=0.01, le=5, description="Grid cell size in degrees"),
):
    """Fire counts binned into lat/lon cells — good for heatmaps without sending every point."""
    df = filters.apply()
    lat = (df["latitude"] // cell_deg) * cell_deg + cell_deg / 2
    lon = (df["longitude"] // cell_deg) * cell_deg + cell_deg / 2
    g = df.groupby([lat.rename("lat"), lon.rename("lon")], observed=True)["frp"].agg(["count", "sum"])
    cells = [
        {"lat": round(float(la), 4), "lon": round(float(lo), 4),
         "count": int(r["count"]), "frp_sum": round(float(r["sum"]), 2)}
        for (la, lo), r in g.iterrows()
    ]
    return {"dataset": filters.dataset, "cell_deg": cell_deg, "cells": cells}
