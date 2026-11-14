"""FastAPI entry point.

Run (from d:\\Nasa_Hackhadon\\backend):
    .venv\\Scripts\\python.exe -m uvicorn app.main:app --reload --port 8000

Website: http://127.0.0.1:8000/
Docs:    http://127.0.0.1:8000/docs
"""
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import CLEAN_DIR, CORS_ORIGINS, DATA_DIR, FRONTEND_DIR
from app.routers import datasets, fires, harmonized, predict, stats
from app.services import forecast as forecast_svc
from app.services import harmonized as harmonized_svc
from app.services import spatial_forecast as spatial_svc


def _warm_up():
    # Fetch El Nino index + load the 3.6M cleaned hotspots in the background.
    try:
        forecast_svc.refresh_oni()
    except Exception as e:
        print(f"[warm-up] ONI not refreshed: {e}")
    try:
        harmonized_svc.clean_hotspots()
        spatial_svc.calibration()  # backtest for the place-by-place forecast
    except Exception as e:
        print(f"[warm-up] hotspot data / spatial forecast not ready: {e}")


@asynccontextmanager
async def lifespan(_app):
    threading.Thread(target=_warm_up, daemon=True).start()
    yield


app = FastAPI(
    title="NASA Fire Hotspot API",
    description="FIRMS VIIRS/MODIS fire detections for Malaysia & Indonesia",
    version="0.2.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=CORS_ORIGINS != ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(datasets.router)
app.include_router(fires.router)
app.include_router(stats.router)
app.include_router(predict.router)
app.include_router(harmonized.router)


@app.get("/api/health", tags=["health"])
def health():
    return {"status": "ok", "data_dir": str(DATA_DIR), "data_dir_exists": DATA_DIR.exists(),
            "clean_dir": str(CLEAN_DIR), "clean_dir_exists": CLEAN_DIR.exists()}


# Website - mounted last so /api/* and /docs keep priority.
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
