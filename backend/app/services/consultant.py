"""AI environmental consultant.

A tool-calling agent that answers haze / fire-risk questions using THIS project's
own numbers. It never guesses a figure: every number it quotes comes back from one
of the tools below, which call the same services the website's charts use.

Backend: Ollama Cloud (OpenAI-compatible, https://ollama.com/v1), model from
OLLAMA_MODEL (default glm-5.3-flash). The key is read from OLLAMA_API_KEY, or from
backend/.env. Cloud models do not support structured outputs, so grounding is done
with tool calls, not a response schema.

Streams Server-Sent Events so the panel can show tool activity while it works:
    event: tool    {"name": ..., "args": {...}}      a lookup started
    event: delta   {"text": "..."}                   a piece of the answer
    event: done    {"ok": true}
    event: error   {"message": "..."}
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterator

import numpy as np
import pandas as pd

from app.config import REGIONS
from app.services import forecast as F
from app.services import harmonized as H
from app.services import spatial_forecast as S

BASE_URL = os.getenv("OLLAMA_BASE_URL", "https://ollama.com/v1").rstrip("/")
MODEL = os.getenv("OLLAMA_MODEL", "glm-5.3-flash")
MAX_ROUNDS = 5
TIMEOUT = 120
MONTHS = ["January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December"]


def _api_key() -> str | None:
    """OLLAMA_API_KEY from the environment, or from backend/.env."""
    key = os.getenv("OLLAMA_API_KEY")
    if key:
        return key.strip()
    env = Path(__file__).resolve().parents[2] / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("OLLAMA_API_KEY") and "=" in line:
                return line.split("=", 1)[1].strip().strip("'\"")
    return None


def configured() -> dict:
    return {"configured": bool(_api_key()), "model": MODEL, "base_url": BASE_URL}


# ---------------------------------------------------------------- tools
def _clean(o: Any) -> Any:
    """numpy/pandas -> plain JSON types."""
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if np.isnan(o) else round(float(o), 3)
    if isinstance(o, float):
        return None if pd.isna(o) else round(o, 3)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    return o


def t_list_regions() -> dict:
    return {"regions": [{"region": r, "country": v["country"]} for r, v in REGIONS.items()],
            "scopes_accepted": ["All", "Malaysia", "Indonesia", *REGIONS]}


def t_get_enso() -> dict:
    info = F.oni_info()
    info["meaning"] = ("ONI >= +0.5 is El Nino (drier, more fire in the Jun-Nov dry season); "
                       "<= -0.5 is La Nina (wetter); in between is neutral.")
    return _clean(info)


def t_get_forecast(scope: str = "All", year: int | None = None, enso: str = "observed") -> dict:
    h = H.harmonized()
    last = int(h["year"].max())
    year = int(year or last + 1)
    f = F.forecast(scope, year, enso)
    bt = f["backtest"]["chosen"]
    return _clean({
        "scope": f["scope"], "year": f["year"], "data_ends": f["data_ends"],
        "model": f["model"], "enso_used": f["enso_used"],
        "unit": "fire cell-days (a 0.05 deg cell burning on a day counts once)",
        "months": [{"month": m["month"], "name": MONTHS[m["month"] - 1],
                    "expected": m["expected"], "low": m["low"], "high": m["high"],
                    "typical_for_that_month": m["typical"],
                    "ratio_to_typical": m["ratio_to_typical"],
                    "chance_above_normal": m["p_above_normal"],
                    "enso_multiplier": m["enso_multiplier"]} for m in f["months"]],
        "annual": f["annual"],
        "accuracy": {"backtest_years": bt["test_years"],
                     "typical_monthly_error_pct": bt["median_abs_pct_err"],
                     "note": ("Backtested with the verifying year's observed ONI, so real "
                              "forward skill is weaker than this figure suggests.")},
        "notes": f["notes"],
    })


def t_get_history(scope: str = "All", year: int | None = None, month: int | None = None) -> dict:
    rows = H.monthly_series(scope)
    if year and month:
        hit = next((r for r in rows if r["year"] == year and r["month"] == month), None)
        if not hit:
            return {"error": f"no data for {year}-{month:02d}"}
        same = sorted((r["harmonized"] for r in rows if r["month"] == month), reverse=True)
        return _clean({"scope": scope, "year": year, "month": month, "name": MONTHS[month - 1],
                       "fire_cell_days": hit["harmonized"],
                       "median_for_that_month": hit["median"],
                       "ratio_to_median": hit["anomaly"],
                       "rank": same.index(hit["harmonized"]) + 1, "of_years": len(same),
                       "data_source": hit["source"]})
    if year:
        yr = [r for r in rows if r["year"] == year]
        return _clean({"scope": scope, "year": year, "total": round(sum(r["harmonized"] for r in yr), 1),
                       "months": [{"month": r["month"], "name": MONTHS[r["month"] - 1],
                                   "fire_cell_days": r["harmonized"], "ratio_to_median": r["anomaly"]}
                                  for r in yr]})
    tot: dict[int, float] = {}
    for r in rows:
        tot[r["year"]] = tot.get(r["year"], 0) + r["harmonized"]
    ranked = sorted(tot.items(), key=lambda kv: -kv[1])
    med = float(np.median(list(tot.values())))
    return _clean({"scope": scope, "unit": "fire cell-days per year",
                   "median_year": round(med, 1),
                   "annual_totals": [{"year": y, "total": round(v, 1)} for y, v in sorted(tot.items())],
                   "worst_years": [{"year": y, "total": round(v, 1), "times_typical": round(v / med, 2)}
                                   for y, v in ranked[:5]]})


def t_get_risk_map(scope: str = "All", year: int | None = None, month: int | None = None) -> dict:
    try:
        h = H.harmonized()
        year = int(year or int(h["year"].max()) + 1)
        fm = S.forecast_map(scope, year, "observed")
    except FileNotFoundError as e:
        return {"error": "The place-by-place risk map is unavailable on this server "
                         f"because the cleaned hotspot file has not been built ({e}). "
                         "Answer from the regional forecast and history instead, and say so."}
    except Exception as e:
        return {"error": f"risk map unavailable: {e}"}
    months = fm["months"] if not month else [m for m in fm["months"] if m["month"] == month]
    return _clean({
        "scope": fm["scope"], "year": fm["year"], "cell_size_deg": fm["cell_deg"],
        "skill": fm["skill"],
        "months": [{"month": m["month"], "name": MONTHS[m["month"] - 1],
                    "expected_fire_days_total": m["expected_fire_days"],
                    "top_areas": m["top_areas"][:6]} for m in months],
    })


def t_get_accuracy(region: str | None = None) -> dict:
    c = H.calibration()
    if region:
        c = c[c["region"] == region]
    return _clean({
        "what_this_is": ("How well MODIS was rescaled onto the VIIRS scale, so 2003-2011 "
                         "can be compared with 2012 onward. Validated leave-one-year-out."),
        "per_region": c.to_dict(orient="records"),
    })


TOOLS: dict[str, Any] = {
    "list_regions": t_list_regions,
    "get_enso": t_get_enso,
    "get_forecast": t_get_forecast,
    "get_history": t_get_history,
    "get_risk_map": t_get_risk_map,
    "get_accuracy": t_get_accuracy,
}

_SCOPE = {"type": "string",
          "description": "All, Malaysia, Indonesia, or one region: Peninsular Malaysia, "
                         "Sarawak, Sabah, Sumatra, Kalimantan."}

TOOL_SPECS = [
    {"type": "function", "function": {
        "name": "list_regions", "description": "The regions this project covers.",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "get_enso",
        "description": "Latest NOAA El Nino index (ONI) and whether conditions are El Nino, La Nina or neutral.",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "get_forecast",
        "description": "Month-by-month fire forecast for a region: expected fire cell-days, "
                       "80% range, how it compares with a typical year, and the chance of an "
                       "above-normal month. Use for 'how bad will it be' questions.",
        "parameters": {"type": "object", "properties": {
            "scope": _SCOPE,
            "year": {"type": "integer", "description": "Forecast year. Defaults to the next year after the data."},
            "enso": {"type": "string", "description": "'observed' (default), or a scenario ONI like '2', '1', '0', '-1'."}}}}},
    {"type": "function", "function": {
        "name": "get_history",
        "description": "Observed fire history. No year: annual totals and the worst years. "
                       "Year only: that year month by month. Year and month: that month "
                       "against the long-run median, with its rank.",
        "parameters": {"type": "object", "properties": {
            "scope": _SCOPE,
            "year": {"type": "integer"},
            "month": {"type": "integer", "description": "1-12"}}}}},
    {"type": "function", "function": {
        "name": "get_risk_map",
        "description": "Which specific areas (provinces, states, divisions) are most at risk, "
                       "with expected fire days. Use for 'where' questions.",
        "parameters": {"type": "object", "properties": {
            "scope": _SCOPE, "year": {"type": "integer"},
            "month": {"type": "integer", "description": "1-12. Omit for all twelve months."}}}}},
    {"type": "function", "function": {
        "name": "get_accuracy",
        "description": "How the MODIS-to-VIIRS calibration was validated and its error per region. "
                       "Use when asked how reliable or trustworthy the data is.",
        "parameters": {"type": "object", "properties": {
            "region": {"type": "string"}}}}},
]

SYSTEM = """You are the Fire Calendar consultant: a practical environmental adviser on \
vegetation fire and haze in Malaysia and Indonesia (Peninsular Malaysia, Sarawak, Sabah, \
Sumatra, Kalimantan). You are part of a NASA Space Apps 2026 project built on NASA FIRMS \
MODIS and VIIRS hotspot detections harmonized into one consistent record, 2003-2025, plus \
a forecast for the years after.

HOW YOU WORK
- Call the tools for every number. Never state a figure from memory, and never estimate one \
yourself. If a tool fails, say plainly what you could not look up.
- Answer the question that was asked, then give the practical next step. People ask you \
things like "should I worry about haze in Kuching in October", "when should I not burn my \
field", "is this year worse than usual", "how do I protect my kids".
- Be concrete and short. Lead with the answer, not with caveats. Use the user's units and \
plain words - "about 2.4 times a normal September", not a table of raw counts.
- The unit in the data is "fire cell-days": one 0.05 degree grid cell burning on one day. \
It measures how widespread and persistent burning is, not area burned or emissions. Explain \
it in passing the first time you use it, then keep going.

BEING HONEST ABOUT UNCERTAINTY
- The forecast is a statistical model: recent seasonal behaviour, adjusted by the El Nino \
index. Typical monthly error is roughly plus or minus 40 percent, and that figure is \
flattering because the backtest knew the year's actual El Nino value. Say so when someone \
leans on a precise number.
- You forecast fire activity, not air quality. Smoke that reaches a city depends on wind, \
and you have no wind data. Never predict an API or PM2.5 reading.
- You are not an official warning service. For live air quality and burning bans point \
people to their national agency - Malaysia: DOE / APIMS; Indonesia: BMKG and KLHK; \
regionally the ASEAN Specialised Meteorological Centre.

ADVICE YOU CAN GIVE
Haze protection (N95 or KN95 rather than surgical masks, keeping windows shut, HEPA \
purifiers, limiting outdoor exertion, extra care for children, elderly people, pregnant \
women, and anyone with asthma or heart disease), planning around the fire season (travel, \
events, outdoor work, school activities), land management timing (avoid burning in the \
high-risk months you can see in the data, wet-season alternatives, the special danger of \
drained peat, which smoulders underground for weeks and is extremely hard to put out), and \
how to read the project's own charts.

Keep replies under about 200 words unless asked for detail. Markdown is fine: short \
paragraphs, bold for the key number, bullets only for genuine lists."""


# ---------------------------------------------------------------- Ollama
def _post(payload: dict, key: str):
    req = urllib.request.Request(
        f"{BASE_URL}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                 "Accept": "text/event-stream", "User-Agent": "fire-calendar-consultant/1.0"},
        method="POST")
    return urllib.request.urlopen(req, timeout=TIMEOUT)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _stream_round(messages: list[dict], key: str) -> Iterator[tuple[str, Any]]:
    """One model turn. Yields ('delta', text) as it arrives, then ('calls', [...]) or ('end', None)."""
    payload = {"model": MODEL, "messages": messages, "tools": TOOL_SPECS,
               "stream": True, "temperature": 0.3}
    calls: dict[int, dict] = {}
    with _post(payload, key) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            body = line[5:].strip()
            if body == "[DONE]":
                break
            try:
                chunk = json.loads(body)
            except json.JSONDecodeError:
                continue
            choices = chunk.get("choices") or [{}]
            delta = choices[0].get("delta") or {}
            if delta.get("content"):
                yield "delta", delta["content"]
            for tc in delta.get("tool_calls") or []:
                i = tc.get("index", 0)
                slot = calls.setdefault(i, {"id": "", "name": "", "args": ""})
                if tc.get("id"):
                    slot["id"] = tc["id"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    slot["name"] = fn["name"]
                if fn.get("arguments"):
                    slot["args"] += fn["arguments"]
    yield ("calls", [calls[i] for i in sorted(calls)]) if calls else ("end", None)


def run(messages: list[dict], context: dict | None = None) -> Iterator[str]:
    """Agent loop as a Server-Sent Event stream."""
    key = _api_key()
    if not key:
        yield _sse("error", {"message": "No Ollama API key. Put OLLAMA_API_KEY=... in "
                                        "Model_Nasa/backend/.env and restart the server."})
        return

    system = SYSTEM
    if context:
        bits = [f"{k}: {v}" for k, v in context.items() if v not in (None, "", "undefined")]
        if bits:
            system += ("\n\nThe user is currently looking at this part of the site - use it to "
                       "read vague questions like 'is this bad?' - " + "; ".join(bits))
    convo: list[dict] = [{"role": "system", "content": system}, *messages]

    try:
        for _ in range(MAX_ROUNDS):
            text, calls = "", None
            for kind, value in _stream_round(convo, key):
                if kind == "delta":
                    text += value
                    yield _sse("delta", {"text": value})
                elif kind == "calls":
                    calls = value
            if not calls:
                yield _sse("done", {"ok": True})
                return
            convo.append({"role": "assistant", "content": text or None,
                          "tool_calls": [{"id": c["id"] or f"call_{i}", "type": "function",
                                          "function": {"name": c["name"], "arguments": c["args"] or "{}"}}
                                         for i, c in enumerate(calls)]})
            for i, c in enumerate(calls):
                name = c["name"]
                try:
                    args = json.loads(c["args"] or "{}")
                except json.JSONDecodeError:
                    args = {}
                yield _sse("tool", {"name": name, "args": args})
                fn = TOOLS.get(name)
                try:
                    result = fn(**args) if fn else {"error": f"unknown tool {name}"}
                except Exception as e:
                    result = {"error": f"{type(e).__name__}: {e}"}
                convo.append({"role": "tool", "tool_call_id": c["id"] or f"call_{i}",
                              "name": name, "content": json.dumps(result, ensure_ascii=False)[:12000]})
        yield _sse("error", {"message": "Gave up after too many lookups."})
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        yield _sse("error", {"message": f"Ollama returned {e.code}. {detail}"})
    except Exception as e:
        yield _sse("error", {"message": f"{type(e).__name__}: {e}"})
