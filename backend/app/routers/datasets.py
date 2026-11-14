from fastapi import APIRouter

from app.config import DATA_DIR, DATASETS
from app.schemas import DatasetInfo
from app.services.data_loader import is_loaded

router = APIRouter(prefix="/api/datasets", tags=["datasets"])


@router.get("", response_model=list[DatasetInfo])
def list_datasets():
    return [
        DatasetInfo(id=k, file=v["file"], country=v["country"], source=v["source"],
                    years=v["years"], available=(DATA_DIR / v["file"]).exists(),
                    loaded=is_loaded(k))
        for k, v in DATASETS.items()
    ]
