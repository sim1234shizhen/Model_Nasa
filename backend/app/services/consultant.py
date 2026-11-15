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

import functools
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
from app.services import world_fires as WF
from app.services import world_outlook as WO
from app.services import world_spatial_forecast as WSF

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


_SCOPES = "All, Malaysia, Indonesia, or one region: " + ", ".join(REGIONS)


def safe_tool(fn):
    """Never let a tool kill the turn.

    create_agent lets an exception out of a tool propagate and abort the whole
    run, so the user gets a raw Python error instead of an answer. Returning the
    failure as data keeps the conversation going and lets the model say what it
    could not look up, or try another tool.
    """
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:                       # noqa: BLE001 - deliberate catch-all
            return {"error": f"{type(exc).__name__}: {exc}",
                    "tool": getattr(fn, "__name__", "tool")}
    return wrapper


@tool(parse_docstring=False)
@safe_tool
def list_regions() -> dict:
    """List the regions this project covers and the scope names the other tools accept."""
    return {"regions": [{"region": r, "country": v["country"]} for r, v in REGIONS.items()],
            "scopes_accepted": ["All", "Malaysia", "Indonesia", *REGIONS]}


@tool(parse_docstring=False)
@safe_tool
def get_enso() -> dict:
    """Latest NOAA El Nino index (ONI) and whether conditions are El Nino, La Nina or neutral."""
    info = F.oni_info()
    info["meaning"] = ("ONI >= +0.5 is El Nino (drier, more fire in the Jun-Nov dry season); "
                       "<= -0.5 is La Nina (wetter); in between is neutral.")
    return _clean(info)


@tool(parse_docstring=False)
@safe_tool
def get_forecast(scope: str = "All", year: Optional[int] = None, enso: str = "observed") -> dict:
    """Month-by-month fire forecast for an area: expected fire cell-days, the 80% range,
    how it compares with a typical year, and the chance of an above-normal month.
    Use this for "how bad will it be" questions.

    scope: one of {scopes}.
    year: forecast year; defaults to the first year after the data ends.
    enso: 'observed' (default) or a scenario ONI such as '2', '1', '0', '-1'.
    """
    last = int(H.harmonized()["year"].max())
    year = int(year or last + 1)
    if not (last < year <= last + 2):
        # Asking for a past year is a reasonable thing to do - say what is available
        # instead of failing, so the answer continues with the right tool.
        return {"error": f"There is no forecast for {year}.",
                "reason": f"The observed record ends in {last}, so the model only forecasts "
                          f"{last + 1} and {last + 2}.",
                "forecast_years": [last + 1, last + 2],
                "use_instead": f"For {year} and earlier, call get_history - those months "
                               "were observed, not forecast."}
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
@safe_tool
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
@safe_tool
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
@safe_tool
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


def _focus_targets() -> list[tuple[str, str, str, str]]:
    """Every name the map can be moved to: (match key, display name, kind, region)."""
    out: list[tuple[str, str, str, str]] = []
    regional = {v["country"] for v in REGIONS.values()}
    for country in sorted(regional):
        out.append((country.lower(), country, "country", ""))
    # Every other country is in the world record, and the page can frame it by
    # its stored centre and zoom even though it has no regional forecast.
    if WF.available():
        for row in WF.countries():
            if row["country"] not in regional:
                out.append((row["country"].lower(), row["country"], "country", ""))
    for region in REGIONS:
        out.append((region.lower(), region, "region", region))
    for region, areas in S.AREAS.items():
        for area in areas:
            out.append((area.lower(), area, "area", region))
            # "Kuching/Samarahan" should also answer to "Kuching" and "Samarahan"
            for part in area.split("/"):
                if part.lower() != area.lower():
                    out.append((part.strip().lower(), area, "area", region))
    return out


@tool(parse_docstring=False)
@safe_tool
def focus_map(place: str) -> dict:
    """Move the map on screen to a place, so the user can see where you mean.

    Call this whenever the user asks about somewhere specific - a country, a region
    such as Sarawak or Kalimantan, or an area such as Miri, Jambi or Kuching - and
    then answer as normal. It only moves the view; it returns no fire figures, so
    still call the other tools for numbers.

    place: the name the user used.
    """
    query = (place or "").strip().lower()
    if not query:
        return {"error": "no place given"}
    targets = _focus_targets()
    hit = next((t for t in targets if t[0] == query), None)
    if hit is None:
        partial = [t for t in targets if query in t[0] or t[0] in query]
        if len(partial) == 1:
            hit = partial[0]
        elif partial:
            return {"error": f"'{place}' matches more than one place",
                    "did_you_mean": sorted({t[1] for t in partial})[:6]}
    if hit is None:
        return {"error": f"'{place}' is not a place this map covers",
                "covered": sorted({t[1] for t in targets})[:12]}
    _key, name, kind, region = hit
    country = REGIONS.get(region, {}).get("country", name if kind == "country" else "")
    return {"focused": name, "kind": kind, "region": region, "country": country,
            "note": "The map on screen has moved to this place."}


@tool(parse_docstring=False)
@safe_tool
def get_world_country(country: str, sensor: str = "VIIRS") -> dict:
    """Observed fire history for ANY country on Earth, from the worldwide FIRMS record.

    Use this whenever the user asks about a country outside Malaysia and Indonesia -
    Thailand, Brazil, Australia and so on. It gives the typical season, the peak
    month and yearly totals, so you can say when that country burns.

    There is a cell-level forecast for 2026-2027 through get_world_forecast, but these \
    observed counts are not calibrated onto the same scale as the regional figures, so do \
    not compare the two directly.

    sensor: VIIRS (2018 onwards, the default) or MODIS (2003 onwards).
    """
    data = WF.country(country, sensor)
    recent = data["annual_totals"][-6:]
    return _clean({
        "country": data["country"], "sensor": data["sensor"], "unit": data["unit"],
        "peak_month": data["peak_month"],
        "peak_month_name": MONTHS[data["peak_month"] - 1] if data["peak_month"] else None,
        "typical_season": [{"month": s["month"], "name": MONTHS[s["month"] - 1],
                            "median_fire_cell_days": s["median_fire_cell_days"]}
                           for s in data["typical_season"]],
        "recent_years": recent,
        "annual_totals": data["annual_totals"],
        "coverage": f"{data['months'][0]['year']}-{data['months'][-1]['year']}" if data["months"] else "",
        "limits": ("Observed history. A cell-level forecast for 2026-2027 is available through "
                   "get_world_forecast. Counts are uncalibrated and not comparable with the "
                   "Malaysia/Indonesia figures."),
    })


@tool(parse_docstring=False)
@safe_tool
def get_world_ranking(year: int, month: Optional[int] = None, limit: int = 10,
                      sensor: str = "auto") -> dict:
    """Which countries burned most in a given year, or in one month of it, worldwide.

    Use for "where does the most burning happen" questions. month: 1-12, omit for
    the whole year. sensor: auto (VIIRS from 2018, MODIS before), VIIRS or MODIS.
    Observed history, uncalibrated.
    """
    chosen = str(sensor).upper()
    if chosen == "AUTO":
        chosen = "VIIRS" if int(year) >= 2018 else "MODIS"
    data = WF.ranking(int(year), int(month) if month else None, chosen, int(limit))
    return _clean({
        "year": data["year"], "month": data["month"], "sensor": data["sensor"],
        "unit": data["unit"], "countries": data["countries"],
        "limits": f"Observed history, {data['sensor']} only, uncalibrated.",
    })


@tool(parse_docstring=False)
@safe_tool
def get_world_outlook(country: str) -> dict:
    """Country-level seasonal fire estimate for any country on Earth.

    Use when the user asks what a month is normally like, or what the coming
    month may bring, outside Malaysia and Indonesia. It returns an estimate for
    each calendar month built from the last ten observations, the historical
    middle 80% range, and the country's data cutoff. This is seasonality, not a
    forecast: it does not know this year's weather.
    """
    names = WO.countries()
    wanted = country.strip().lower()
    resolved = (country if country in names
                else next((n for n in names if n.lower() == wanted), None))
    if resolved is None:
        hits = [n for n in names if wanted in n.lower()]
        resolved = hits[0] if len(hits) == 1 else None
    if resolved is None:
        raise KeyError(country)
    data = WO.outlook(resolved)
    return _clean({
        "country": data["country"],
        "data_through": data["data_through"],
        "months": data["months"],
        "backtest": data["backtest"],
        "limits": ("Historical seasonality only - not a forecast, and it does not use "
                   "this year's weather. Country-level counts, not a place inside the country."),
    })


@tool(parse_docstring=False)
@safe_tool
def get_world_forecast(country: str, year: int = 2026, enso: str = "observed") -> dict:
    """Cell-level fire forecast for any country on Earth, for 2026 or 2027.

    Use when the user asks what the coming season may bring outside Malaysia and
    Indonesia. Returns, for each month, the number of 1-degree cells with at
    least a 50% chance of fire, the peak cell chance and expected fire
    cell-days, with the country's observed history as context. enso: "observed"
    (NOAA ONI) or a scenario -1, 0, 1 or 2.
    """
    names = WSF.countries()
    wanted = country.strip().lower()
    resolved = (country if country in names
                else next((n for n in names if n.lower() == wanted), None))
    if resolved is None:
        hits = [n for n in names if wanted in n.lower()]
        resolved = hits[0] if len(hits) == 1 else None
    if resolved is None:
        raise KeyError(country)
    data = WSF.forecast_map(resolved, int(year), str(enso))
    months = []
    for detail, summary in zip(data["months"], data["summary"]):
        area = detail["top_areas"][0]
        months.append({
            "month": detail["month"],
            "cells_at_50": area["high_risk_cells"],
            "peak_cell_pct": area["max_chance_pct"],
            "expected_fire_cell_days": area["expected_fire_days"],
            "typical_fire_cell_days": summary["typical"],
            "ratio_to_typical": summary["ratio_to_typical"],
            "p_above_normal": summary["p_above_normal"],
            "oni": summary["oni"],
            "enso_multiplier": summary["enso_multiplier"],
        })
    return _clean({
        "country": data["country"], "year": data["year"], "data_ends": data["data_ends"],
        "cell_deg": data["cell_deg"], "cells": data["cells"],
        "enso_used": data["enso_used"], "model": data["model"],
        "months": months, "skill": data["skill"],
        "limits": ("1-degree global cells, harmonized counts rather than verified daily "
                   "fire days. Not comparable with the 0.25-degree Malaysia/Indonesia forecast."),
    })


TOOLS = [list_regions, get_enso, get_forecast, get_history, get_risk_map, get_accuracy,
         focus_map, get_world_country, get_world_ranking, get_world_outlook, get_world_forecast]
for _t in TOOLS:  # fill the {scopes} placeholder once, so each schema lists the real names
    _t.description = _t.description.replace("{scopes}", _SCOPES)


SYSTEM = """You are Ziro, BurningView's AI adviser on vegetation fire and haze. You are \
part of a NASA Space Apps 2026 project built on NASA FIRMS MODIS and VIIRS hotspot \
detections.

You cover the whole world, at two different depths. Malaysia and Indonesia (Peninsular \
Malaysia, Sarawak, Sabah, Sumatra, Kalimantan, Java, Nusa Tenggara, Sulawesi, Maluku and \
Papua: ten regions in all) have a harmonized record for 2003-2025, a month-by-month \
forecast and a place-by-place risk map. Every other country has observed fire history from \
2003 through get_world_country and get_world_ranking, plus a cell-level model estimate for \
2026-2027 through get_world_forecast. So you can always say when and how much a country \
burns - never tell a user that a country is outside your data without calling \
get_world_country for it first. Observed records end in December 2025; the forecasts cover \
2026 and 2027.

HOW YOU WORK
- Call the tools for every number. Never state a figure from memory, and never estimate one \
yourself. If a tool fails, say plainly what you could not look up.
- When the user asks about a particular place, call focus_map for it first so the map on \
screen moves there while you answer, then look up the numbers as usual. Do not mention the \
tool or narrate the map moving - just answer the question.

WHICH PLACES YOU KNOW
- Malaysia and Indonesia have the full picture: observed history, a month-by-month forecast \
and a place-by-place risk map.
- Every other country has observed history through get_world_country and \
get_world_ranking, plus a cell-level model estimate for 2026-2027 through \
get_world_forecast. Use those for Thailand, Brazil, Australia, anywhere else - never answer \
about one country using another country's numbers, and never call get_forecast or \
get_risk_map for a place outside Malaysia and Indonesia. VIIRS starts in 2018; for earlier \
years ask for MODIS (the ranking tool does this automatically when you leave sensor=auto).
- Keep the three world views distinct: get_world_country is observed history, get_world_outlook \
is historical seasonality (not a forecast), and get_world_forecast is the model estimate \
(cells with at least a 50% chance, peak cell chance, expected fire cell-days). World counts \
are uncalibrated, and the global 1-degree forecast is not comparable with the 0.25-degree \
Malaysia/Indonesia forecast.
- If a tool returns an error, read it - it usually says which tool to use instead. Do not \
repeat the raw error to the user; say in your own words what you could not look up.
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
            elif kind == "on_tool_end" and ev["name"] == "focus_map":
                # the resolved place, so the page can move the map to it
                out = ev["data"].get("output")
                out = getattr(out, "content", out)
                if isinstance(out, str):
                    try:
                        out = json.loads(out)
                    except json.JSONDecodeError:
                        out = None
                if isinstance(out, dict) and out.get("focused"):
                    yield _sse("focus", {"name": out["focused"], "kind": out.get("kind"),
                                         "region": out.get("region", "")})
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
