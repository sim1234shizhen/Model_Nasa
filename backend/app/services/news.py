"""Latest fire & haze headlines, so the website's "News" links stay current.

Source: the public Google News RSS search feed (no API key). Each topic is a
fixed search query; results are cached in memory for CACHE_HOURS so the site
doesn't hit the feed on every page view. If a fetch fails, the last good result
is served, and if there has never been one the endpoint returns an empty list
(the website then keeps its built-in links).
"""
from __future__ import annotations

import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

FEED = "https://news.google.com/rss/search?"
CACHE_HOURS = 2
MAX_AGE_DAYS = 120          # ignore stories older than this
USER_AGENT = "Mozilla/5.0 (compatible; fire-haze-dashboard/0.1)"

# topic -> list of (country tag, query, feed locale).  Country tag "" = always used.
TOPICS: dict[str, list[tuple[str, str, str]]] = {
    "air": [
        ("Malaysia", '"Air Pollutant Index" OR "API reading" haze Malaysia', "MY:en"),
        ("Indonesia", "ISPU kualitas udara kabut asap", "ID:id"),
        ("", "haze PSI Singapore NEA", "SG:en"),
    ],
    "mask": [
        ("", "haze N95 mask", "SG:en"),
        ("Malaysia", "jerebu topeng N95", "MY:ms"),
    ],
    "health": [
        ("", "haze asthma OR respiratory OR clinic Malaysia OR Singapore OR Indonesia", "MY:en"),
        ("Indonesia", "ISPA kabut asap", "ID:id"),
        ("Malaysia", "jerebu kesihatan", "MY:ms"),
    ],
    "home": [
        ("", "haze air purifier indoor schools", "SG:en"),
        ("Malaysia", "haze schools closed Malaysia", "MY:en"),
    ],
    "fire": [   # Explorer sidebar "Fire & haze updates"
        ("Indonesia", "karhutla hotspot titik panas", "ID:id"),
        ("Malaysia", "haze hotspots Malaysia", "MY:en"),
        ("", "ASEAN haze ASMC hotspots", "SG:en"),
    ],
}

# A headline must mention one of these to count (drops off-topic search hits).
KEYWORDS = ("haze", "jerebu", "asap", "smoke", "ispa", "ispu", "psi", " api", "n95", "hotspot",
            "titik panas", "karhutla", "kebakaran", "udara", "air quality", "air purifier", "fire")

_cache: dict[str, tuple[float, list[dict]]] = {}
_lock = threading.Lock()


def _feed_url(query: str, locale: str) -> str:
    country, lang = locale.split(":")
    return FEED + urllib.parse.urlencode({
        "q": query + " when:120d", "hl": f"en-{country}" if lang == "en" else lang,
        "gl": country, "ceid": locale,
    })


def _fetch(query: str, locale: str) -> list[dict]:
    req = urllib.request.Request(_feed_url(query, locale), headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as r:
        root = ET.fromstring(r.read())
    out = []
    cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_AGE_DAYS)
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        source_el = item.find("source")
        source = (source_el.text or "").strip() if source_el is not None else ""
        try:
            when = parsedate_to_datetime(item.findtext("pubDate") or "")
        except (TypeError, ValueError):
            continue
        if not title or not link.startswith("https://") or when < cutoff:
            continue
        # Google News titles end in " - Source"; keep the headline only
        if source and title.endswith(" - " + source):
            title = title[: -len(" - " + source)]
        if not any(k in " " + title.lower() for k in KEYWORDS):
            continue
        out.append({"title": title, "source": source, "url": link,
                    "published": when.astimezone(timezone.utc).isoformat()})
    return out


def _cached(query: str, locale: str) -> list[dict]:
    key = locale + "|" + query
    now = time.time()
    with _lock:
        hit = _cache.get(key)
    if hit and now - hit[0] < CACHE_HOURS * 3600:
        return hit[1]
    try:
        items = _fetch(query, locale)
        with _lock:
            _cache[key] = (now, items)
        return items
    except Exception as e:          # network down, feed changed: keep the last good copy
        print(f"[news] {query!r}: {e}")
        return hit[1] if hit else []


def latest(topic: str, countries: set[str], limit: int = 3) -> dict:
    queries = [(q, loc) for tag, q, loc in TOPICS.get(topic, []) if not tag or tag in countries]
    # newest first within each search, then take one from each search in turn,
    # so one country or language can't fill every slot
    pools = [sorted(_cached(q, loc), key=lambda it: it["published"], reverse=True) for q, loc in queries]
    seen, items = set(), []
    while len(items) < limit and any(pools):
        for pool in pools:
            while pool:
                it = pool.pop(0)
                key = it["title"].lower()[:80]
                if key not in seen:
                    seen.add(key)
                    items.append(it)
                    break
            if len(items) >= limit:
                break
    items.sort(key=lambda it: it["published"], reverse=True)
    return {"topic": topic, "items": items,
            "checked": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "Google News RSS"}
