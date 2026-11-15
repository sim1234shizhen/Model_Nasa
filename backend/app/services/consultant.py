"""AI environmental consultant — LangChain agent over this project's own data.

A tool-calling agent that answers haze / fire-risk questions using THIS project's
numbers. It never guesses a figure: every number it quotes comes back from one of
the tools below, which call the same services the website's charts use.

Stack
    LangChain  create_agent (tool-calling loop) + @tool
    Model      Ollama Cloud via ChatOllama, base_url https://ollama.com,
               API key sent as a Bearer header. Model from OLLAMA_MODEL
               (default glm-5.3-flash). Key from OLLAMA_API_KEY or backend/.env.

Cloud models do not support structured outputs, so grounding is done with tool
calls, not a response schema.

Streams Server-Sent Events so the panel can show lookups while it works:
    event: tool    {"name": ..., "args": {...}}      a lookup started
    event: delta   {"text": "..."}                   a piece of the answer
    event: done    {"ok": true}
    event: error   {"message": "..."}
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, AsyncIterator, Optional

import numpy as np
import pandas as pd
from langchain.agents import create_agent
from langchain_core.tools import tool
from langchain_ollama import ChatOllama

from app.config import REGIONS
from app.services import forecast as F
from app.services import harmonized as H
from app.services import spatial_forecast as S

BASE_URL = os.getenv("OLLAMA_BASE_URL", "https://ollama.com")
MODEL = os.getenv("OLLAMA_MODEL", "glm-5.3-flash")
RECURSION_LIMIT = 12          # create_agent counts each model + tool step
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
    return {"configured": bool(_api_key()), "model": MODEL, "base_url": BASE_URL,
            "framework": "langchain"}


# ---------------------------------------------------------------- data access
def _clean(o: Any) -> Any:
    """numpy/pandas -> plain JSON types."""
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.floating):
        return None if np.isnan(o) else round(float(o), 3)
    if isinstance(o, float):
        return None if pd.isna(o) else round(o, 3)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


def _next_year() -> int:
    return int(H.harmonized()["year"].max()) + 1


_SCOPES = "All, Malaysia, Indonesia, or one region: Peninsular Malaysia, Sarawak, Sabah, Sumatra, Kalimantan"


@tool(parse_docstring=False)
def list_regions() -> dict:
    """List the regions this project covers and the scope names the other tools accept."""
    return {"regions": [{"region": r, "country": v["country"]} for r, v in REGIONS.items()],
            "scopes_accepted": ["All", "Malaysia", "Indonesia", *REGIONS]}


@tool(parse_docstring=False)
def get_enso() -> dict:
    """Latest NOAA El Nino index (ONI) and whether conditions are El Nino, La Nina or neutral."""
    info = F.oni_info()
    info["meaning"] = ("ONI >= +0.5 is El Nino (drier, more fire in the Jun-Nov dry season); "
                       "<= -0.5 is La Nina (wetter); in between is neutral.")
    return _clean(info)


@tool(parse_docstring=False)
def get_forecast(scope: str = "All", year: Optional[int] = None, enso: str = "observed") -> dict:
    """Month-by-month fire forecast for an area: expected fire cell-days, the 80% range,
    how it compares with a typical year, and the chance of an above-normal month.
    Use this for "how bad will it be" questions.

    scope: one of {scopes}.
    year: forecast year; defaults to the first year after the data ends.
    enso: 'observed' (default) or a scenario ONI such as '2', '1', '0', '-1'.
    """
    year = int(year or _next_year())
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


@tool(parse_docstring=False)
def get_history(scope: str = "All", year: Optional[int] = None, month: Optional[int] = None) -> dict:
    """Observed fire history from the harmonized MODIS + VIIRS record, 2003 onwards.
    No year: annual totals and the worst years. Year only: that year month by month.
    Year and month: that month against the long-run median, with its rank.

    scope: one of {scopes}.  month: 1-12.
    """
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
        return _clean({"scope": scope, "year": year,
                       "total": round(sum(r["harmonized"] for r in yr), 1),
                       "months": [{"month": r["month"], "name": MONTHS[r["month"] - 1],
                                   "fire_cell_days": r["harmonized"], "ratio_to_median": r["anomaly"]}
                                  for r in yr]})
    tot: dict[int, float] = {}
    for r in rows:
        tot[r["year"]] = tot.get(r["year"], 0) + r["harmonized"]
    ranked = sorted(tot.items(), key=lambda kv: -kv[1])
    med = float(np.median(list(tot.values())))
    return _clean({"scope": scope, "unit": "fire cell-days per year", "median_year": round(med, 1),
                   "annual_totals": [{"year": y, "total": round(v, 1)} for y, v in sorted(tot.items())],
                   "worst_years": [{"year": y, "total": round(v, 1), "times_typical": round(v / med, 2)}
                                   for y, v in ranked[:5]]})


@tool(parse_docstring=False)
def get_risk_map(scope: str = "All", year: Optional[int] = None, month: Optional[int] = None) -> dict:
    """Which specific areas (provinces, states, divisions) are most at risk, with expected
    fire days per area. Use this for "where" questions. It also returns how well the area
    ranking itself was validated (AUC, concentration, Brier) - use this, not get_accuracy,
    when asked how good the map, the ranking or the "where" prediction is.

    scope: one of {scopes}.  month: 1-12, omit for all twelve months.
    """
    try:
        year = int(year or _next_year())
        fm = S.forecast_map(scope, year, "observed")
    except FileNotFoundError as e:
        return {"error": "The place-by-place risk map is unavailable on this server because "
                         f"the cleaned hotspot file has not been built ({e}). Answer from the "
                         "regional forecast and history instead, and say so."}
    except Exception as e:
        return {"error": f"risk map unavailable: {e}"}
    months = fm["months"] if not month else [m for m in fm["months"] if m["month"] == month]
    sk = fm["skill"]
    return _clean({
        "scope": fm["scope"], "year": fm["year"], "cell_size_deg": fm["cell_deg"],
        # spelled out, so the answer describes these correctly rather than paraphrasing a bare number
        "skill": {
            "backtest_years": sk["test_years"],
            "ranking_auc": sk["auc"],
            "ranking_auc_means": (f"Given one cell that burned and one that did not, the model ranks "
                                  f"the right one higher {sk['auc'] * 100:.0f}% of the time. 50% is guessing."),
            "concentration_means": (f"The 10% of cells it rated riskiest contained "
                                    f"{sk['top10_capture_pct']}% of all the fire days that actually happened."),
            "brier": sk["brier"],
            "brier_if_same_chance_everywhere": sk["base_rate_brier"],
            "brier_means": "Lower is better, so the model's probabilities beat a flat guess.",
        },
        "months": [{"month": m["month"], "name": MONTHS[m["month"] - 1],
                    "expected_fire_days_total": m["expected_fire_days"],
                    "top_areas": m["top_areas"][:6]} for m in months],
    })


@tool(parse_docstring=False)
def get_accuracy(region: Optional[str] = None) -> dict:
    """How accurate the HISTORICAL RECORD is: how well MODIS 2003-2011 was rescaled onto the
    VIIRS scale, per region, with its validated error. Use only when asked whether the past
    data or the MODIS/VIIRS harmonization can be trusted.

    This says nothing about forecast skill. For how good a forecast is use get_forecast, and
    for how good the area ranking is use get_risk_map."""
    c = H.calibration()
    if region:
        c = c[c["region"] == region]
    return _clean({
        "what_this_is": ("How well MODIS was rescaled onto the VIIRS scale, so 2003-2011 can be "
                         "compared with 2012 onward. Validated leave-one-year-out."),
        "per_region": c.to_dict(orient="records"),
    })


TOOLS = [list_regions, get_enso, get_forecast, get_history, get_risk_map, get_accuracy]
for _t in TOOLS:  # fill the {scopes} placeholder once, so each schema lists the real names
    _t.description = _t.description.replace("{scopes}", _SCOPES)


SYSTEM = """You are Ziro, BuriningView's AI adviser on \
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


# ---------------------------------------------------------------- agent
_agent_cache: dict[str, Any] = {}


def _agent(key: str, system: str):
    """Build (and cache per system prompt) the LangChain tool-calling agent."""
    hit = _agent_cache.get(system)
    if hit:
        return hit
    llm = ChatOllama(
        model=MODEL,
        base_url=BASE_URL,
        temperature=0.3,
        reasoning=False,           # keep <think> out of the answer stream
        client_kwargs={"headers": {"Authorization": f"Bearer {key}"}},
    )
    agent = create_agent(model=llm, tools=TOOLS, system_prompt=system)
    if len(_agent_cache) > 8:
        _agent_cache.clear()
    _agent_cache[system] = agent
    return agent


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def run(messages: list[dict], context: dict | None = None) -> AsyncIterator[str]:
    """Run the agent and stream Server-Sent Events."""
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

    try:
        agent = _agent(key, system)
        sent_any = False
        async for ev in agent.astream_events(
            {"messages": messages},
            config={"recursion_limit": RECURSION_LIMIT},
            version="v2",
        ):
            kind = ev["event"]
            if kind == "on_tool_start":
                yield _sse("tool", {"name": ev["name"], "args": ev["data"].get("input") or {}})
            elif kind == "on_chat_model_stream":
                chunk = ev["data"].get("chunk")
                text = getattr(chunk, "text", "") if chunk is not None else ""
                if not isinstance(text, str):        # older cores expose text() as a method
                    text = text() if callable(text) else ""
                if text:
                    sent_any = True
                    yield _sse("delta", {"text": text})
        if not sent_any:
            yield _sse("error", {"message": "The model returned no answer. Try again."})
            return
        yield _sse("done", {"ok": True})
    except Exception as e:
        yield _sse("error", {"message": f"{type(e).__name__}: {e}"})
