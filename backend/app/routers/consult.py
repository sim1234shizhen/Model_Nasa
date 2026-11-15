"""AI environmental consultant endpoint."""
from __future__ import annotations

import json

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

# The consultant needs LangChain. If those packages are missing, or the operating system
# blocks one of them, the rest of the site must still start, so the import is optional.
try:
    from app.services import consultant
    _UNAVAILABLE = None
except Exception as e:  # ImportError, or a blocked DLL on Windows
    consultant = None
    _UNAVAILABLE = f"{type(e).__name__}: {e}"

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
    if consultant is None:
        return {"configured": False, "available": False, "reason": _UNAVAILABLE}
    return consultant.configured()


@router.post("")
def consult(req: ConsultRequest) -> StreamingResponse:
    """Ask the consultant. Streams Server-Sent Events: tool, delta, done, error."""
    if consultant is None:
        def unavailable():
            yield "event: error\ndata: " + json.dumps({"message": "The consultant is not available on this server."}) + "\n\n"
        return StreamingResponse(unavailable(), media_type="text/event-stream")
    msgs = [{"role": m.role, "content": m.content} for m in req.messages[-12:]]
    return StreamingResponse(
        consultant.run(msgs, req.context),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
