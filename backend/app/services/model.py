"""Plug your ML model in here.

Right now `predict_risk` is a simple placeholder using historical fire density
around the point in the same month. Replace the body with your trained model
(e.g. load a joblib/pickle once at module import and call model.predict).
The /api/predict endpoint will keep working unchanged.
"""
from __future__ import annotations

import pandas as pd

from app.services.data_loader import get_dataset

MODEL_NAME = "baseline-historical-density"

# Example of how you'd load a real model once:
# import joblib
# from pathlib import Path
# _model = joblib.load(Path(__file__).resolve().parents[2] / "models" / "fire_model.pkl")


def predict_risk(latitude: float, longitude: float, date: str, features: dict,
                 dataset_id: str = "viirs-snpp-malaysia") -> dict:
    df = get_dataset(dataset_id)
    month = pd.Timestamp(date).month
    radius = 0.25  # degrees (~28 km)

    nearby = df[
        df["latitude"].between(latitude - radius, latitude + radius)
        & df["longitude"].between(longitude - radius, longitude + radius)
    ]
    same_month = nearby[nearby["acq_date"].dt.month == month]
    years = max(df["acq_date"].dt.year.nunique(), 1)
    avg_per_year = len(same_month) / years

    # squash to 0..1
    risk = float(min(avg_per_year / 20.0, 1.0))
    level = "low" if risk < 0.33 else "medium" if risk < 0.66 else "high"
    return {
        "fire_risk": round(risk, 3),
        "risk_level": level,
        "model": MODEL_NAME,
        "details": {
            "historical_fires_nearby": int(len(nearby)),
            "historical_fires_same_month": int(len(same_month)),
            "avg_fires_same_month_per_year": round(avg_per_year, 2),
            "radius_deg": radius,
            "dataset": dataset_id,
        },
    }
