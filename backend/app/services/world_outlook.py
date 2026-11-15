"""Country-level seasonal estimates from the harmonized monthly archive."""
from __future__ import annotations

import csv
import json
import unicodedata
from collections import defaultdict
from functools import lru_cache
from statistics import mean, median, quantiles

from app.config import PROJECT_ROOT

DATA = PROJECT_ROOT / "Global_Dataset" / "harmonized_country_monthly.csv"
HISTORY_YEARS = 10
BACKTEST_YEARS = 5


@lru_cache(maxsize=1)
def _load(mtime_ns: int) -> dict:
    countries = defaultdict(list)
    with DATA.open(encoding="utf-8", newline="") as source:
        for row in csv.DictReader(source):
            countries[row["country"]].append((
                int(row["year"]), int(row["month"]), float(row["harmonized_count"]),
            ))
    return {name: sorted(rows) for name, rows in countries.items()}


def countries() -> list[str]:
    return sorted(_load(DATA.stat().st_mtime_ns))


def outlook(country: str) -> dict:
    rows = _load(DATA.stat().st_mtime_ns)[country]
    end_year, end_month, _ = rows[-1]
    by_month = defaultdict(list)
    for year, month, count in rows:
        by_month[month].append((year, count))

    months, errors = [], []
    for month in sorted(by_month):
        series = by_month[month]
        baseline = [count for _, count in series[-HISTORY_YEARS:]]
        low, *_, high = quantiles(baseline, n=10, method="inclusive") if len(baseline) > 1 else baseline * 2
        months.append({
            "month": month,
            "expected": round(median(baseline)),
            "historical_low": round(low),
            "historical_high": round(high),
            "observations": len(baseline),
        })
        for index, (year, actual) in enumerate(series):
            if index < HISTORY_YEARS or year <= end_year - BACKTEST_YEARS:
                continue
            earlier = [count for _, count in series[index - HISTORY_YEARS:index]]
            errors.append(abs(actual - median(earlier)))

    return {
        "country": country,
        "data_through": {"year": end_year, "month": end_month},
        "months": months,
        "backtest": {
            "samples": len(errors),
            "mean_absolute_error": round(mean(errors)) if errors else None,
        },
    }


def _name_key(name: str) -> str:
    return "".join(ch for ch in unicodedata.normalize("NFKD", name.casefold()) if ch.isascii() and ch.isalnum())


# The map abbreviates these names. Match islands and territories explicitly
# so they are never shaded using a different country's seasonal history.
BOUNDARY_NAMES = {
    "Åland": "Aland Islands",
    "Antigua and Barb.": "Antigua and Barbuda",
    "Bosnia and Herz.": "Bosnia and Herzegovina",
    "British Virgin Is.": "British Virgin Islands",
    "Cayman Is.": "Cayman Islands",
    "Central African Rep.": "Central African Republic",
    "Congo": "Republic of Congo",
    "Cook Is.": "Cook Islands",
    "Dem. Rep. Congo": "Democratic Republic of the Congo",
    "Dominican Rep.": "Dominican Republic",
    "Eq. Guinea": "Equatorial Guinea",
    "Falkland Is.": "Falkland Islands",
    "Fr. Polynesia": "French Polynesia",
    "Fr. S. Antarctic Lands": "French Southern and Antarctic Lands",
    "Gambia": "The Gambia",
    "Heard I. and McDonald Is.": "Heard I and McDonald Islands",
    "N. Mariana Is.": "Northern Mariana Islands",
    "S. Sudan": "South Sudan",
    "Solomon Is.": "Solomon Islands",
    "St-Martin": "Saint-Martin",
    "St. Kitts and Nevis": "Saint Kitts and Nevis",
    "St. Pierre and Miquelon": "Saint Pierre and Miquelon",
    "St. Vin. and Gren.": "Saint Vincent and the Grenadines",
    "Turks and Caicos Is.": "Turks and Caicos Islands",
    "U.S. Virgin Is.": "United States Virgin Islands",
    "Wallis and Futuna Is.": "Wallis and Futuna Islands",
}


def map_outlook() -> dict:
    return _map_outlook(DATA.stat().st_mtime_ns)


@lru_cache(maxsize=1)
def _map_outlook(mtime_ns: int) -> dict:
    assets = PROJECT_ROOT / "Frontend" / "assets"
    focus = json.loads((assets / "country-focus.json").read_text(encoding="utf-8"))
    features = json.loads((assets / "countries.geojson").read_text(encoding="utf-8"))["features"]
    records = _load(mtime_ns)
    aliases = {
        _name_key(alias): country
        for country in records
        for alias in [country, *focus.get(country, {}).get("aliases", [])]
    }
    shapes = defaultdict(list)
    for feature in features:
        name = feature["properties"]["name"]
        country = BOUNDARY_NAMES.get(name) or aliases.get(_name_key(name))
        if country in records:
            shapes[country].append(name)

    entries = []
    for name in sorted(records):
        season = outlook(name)["months"]
        peak = max(row["expected"] for row in season)
        entries.append({
            "country": name,
            "shapes": shapes[name],
            "center": focus.get(name, {}).get("center"),
            "months": {
                row["month"]: [row["expected"], round(row["expected"] / peak, 3) if peak else 0]
                for row in season
            },
        })
    return {"countries": entries}
