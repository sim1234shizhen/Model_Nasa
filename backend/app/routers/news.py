from fastapi import APIRouter, HTTPException, Query

from app.services import news as news_svc

router = APIRouter(prefix="/api", tags=["news"])


@router.get("/news")
def news(
    topic: str = Query(..., description="air | mask | health | home | fire"),
    countries: str = Query("Malaysia,Indonesia", description="comma-separated: Malaysia, Indonesia"),
    limit: int = Query(3, ge=1, le=10),
):
    """Latest headlines for a haze-kit card or the Explorer news panel (cached ~2 h)."""
    if topic not in news_svc.TOPICS:
        raise HTTPException(404, f"unknown topic {topic!r}")
    wanted = {c.strip() for c in countries.split(",") if c.strip()}
    return news_svc.latest(topic, wanted, limit)
