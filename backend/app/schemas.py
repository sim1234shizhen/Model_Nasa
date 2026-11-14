"""Pydantic response models — these show up in the auto docs at /docs."""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel


class DatasetInfo(BaseModel):
    id: str
    country: str
    source: str
    years: str
    file: str
    available: bool
    loaded: bool


class FirePoint(BaseModel):
    latitude: float
    longitude: float
    brightness: Optional[float]
    frp: Optional[float]
    acq_datetime: str
    satellite: str
    instrument: str
    confidence: str
    daynight: str


class FiresResponse(BaseModel):
    dataset: str
    total_matched: int
    returned: int
    fires: list[FirePoint]


class SummaryResponse(BaseModel):
    dataset: str
    count: int
    date_min: Optional[str]
    date_max: Optional[str]
    frp_mean: Optional[float]
    frp_max: Optional[float]
    by_confidence: dict[str, int]
    by_daynight: dict[str, int]
    bbox: Optional[list[float]]


class TimeSeriesPoint(BaseModel):
    period: str
    count: int
    frp_sum: float
    frp_mean: Optional[float]


class TimeSeriesResponse(BaseModel):
    dataset: str
    freq: str
    series: list[TimeSeriesPoint]


class PredictRequest(BaseModel):
    latitude: float
    longitude: float
    date: str
    features: dict[str, Any] = {}


class PredictResponse(BaseModel):
    latitude: float
    longitude: float
    date: str
    fire_risk: float
    risk_level: str
    model: str
    details: dict[str, Any] = {}
