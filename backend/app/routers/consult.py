"""AI environmental consultant endpoint."""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.services import consultant

router = APIRouter(prefix="/api/consult", tags=["consultant"])


class Message(BaseModel):
    role: str = Field(description="user or assistant")
    content: str


class ConsultRequest(BaseModel):
    messages: list[Message] = Field(description="The conversation so far, oldest first.")
    context: dict | None = Field(default=None, description="What the user is looking at: page, area, year, month.")


@router.get("")
def status() -> dict:
    """Is the consultant configured? The panel calls this before showing itself."""
    return consultant.configured()


@router.post("")
def consult(req: ConsultRequest) -> StreamingResponse:
    """Ask the consultant. Streams Server-Sent Events: tool, delta, done, error."""
    msgs = [{"role": m.role, "content": m.content} for m in req.messages[-12:]]
    return StreamingResponse(
        consultant.run(msgs, req.context),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
