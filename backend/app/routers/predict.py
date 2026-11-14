from fastapi import APIRouter, HTTPException, Query

from app.config import DATASETS
from app.schemas import PredictRequest, PredictResponse
from app.services.model import predict_risk

router = APIRouter(prefix="/api/predict", tags=["predict"])


@router.post("", response_model=PredictResponse)
def predict(req: PredictRequest, dataset: str = Query("viirs-snpp-malaysia")):
    if dataset not in DATASETS:
        raise HTTPException(404, f"Unknown dataset '{dataset}'")
    try:
        result = predict_risk(req.latitude, req.longitude, req.date, req.features, dataset)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return PredictResponse(latitude=req.latitude, longitude=req.longitude, date=req.date, **result)
