"""Raw fire detections, as JSON list or GeoJSON (for Leaflet / Mapbox)."""
from fastapi import APIRouter, Depends, Query

from app.config import MAX_LIMIT
from app.routers.deps import FireFilters
from app.schemas import FirePoint, FiresResponse

router = APIRouter(prefix="/api/fires", tags=["fires"])

_COLS = ["latitude", "longitude", "brightness", "frp", "acq_datetime",
         "satellite", "instrument", "confidence", "daynight"]


def _records(df):
    out = df[_COLS].copy()
    out["acq_datetime"] = out["acq_datetime"].dt.strftime("%Y-%m-%dT%H:%MZ")
    for c in ("satellite", "instrument", "confidence", "daynight"):
        out[c] = out[c].astype(str)
    out = out.astype(object).where(out.notna(), None)
    return out.to_dict(orient="records")


@router.get("", response_model=FiresResponse)
def get_fires(
    filters: FireFilters = Depends(),
    limit: int = Query(5000, ge=1, le=MAX_LIMIT),
    offset: int = Query(0, ge=0),
    sort: str = Query("latest", pattern="^(latest|oldest|frp)$"),
):
    df = filters.apply()
    if sort == "latest":
        df = df.iloc[::-1]
    elif sort == "frp":
        df = df.sort_values("frp", ascending=False)
    page = df.iloc[offset: offset + limit]
    return FiresResponse(dataset=filters.dataset, total_matched=len(df), returned=len(page),
                         fires=[FirePoint(**r) for r in _records(page)])


@router.get("/geojson")
def get_fires_geojson(
    filters: FireFilters = Depends(),
    limit: int = Query(5000, ge=1, le=MAX_LIMIT),
):
    df = filters.apply().iloc[::-1].iloc[:limit]
    features = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [r.pop("longitude"), r.pop("latitude")]},
            "properties": r,
        }
        for r in _records(df)
    ]
    return {"type": "FeatureCollection", "features": features}
