"""Build the place-search index for the Explorer.

The search box used to know only the ten harmonized regions and the country
names in the world fire record, so most countries could be found but the map
would not move to them, and no city could be found at all. This script writes
the two files the page needs:

    Frontend/assets/cities.json         every city above 15,000 people
    Frontend/assets/country-focus.json  a centre and zoom for every country

Both are derived from open data and served from this project, so the site keeps
working offline and no request goes to a geocoder while someone is using it.

Sources (downloaded on first run):
    GeoNames cities15000, admin1CodesASCII and countryInfo
    Natural Earth admin-0 countries already in Frontend/assets/countries.geojson

Usage:
    python places_build.py
    python places_build.py --geonames data/geonames --refresh
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import unicodedata
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
GEONAMES_URLS = {
    "cities15000.zip": "https://download.geonames.org/export/dump/cities15000.zip",
    "admin1CodesASCII.txt": "https://download.geonames.org/export/dump/admin1CodesASCII.txt",
    "countryInfo.txt": "https://download.geonames.org/export/dump/countryInfo.txt",
}
UA = {"User-Agent": "burningview-places/1.0"}

# Natural Earth abbreviates names; GeoNames uses the official spelling. These
# are the ones the normalised match cannot resolve on its own, plus the two
# Congos, which both normalise to "congo".
GEO_ISO_OVERRIDES = {
    "Antigua and Barb.": "ag",
    "Bosnia and Herz.": "ba",
    "British Virgin Is.": "vg",
    "Cayman Is.": "ky",
    "Congo": "cg",
    "Cook Is.": "ck",
    "Côte d'Ivoire": "ci",
    "Dem. Rep. Congo": "cd",
    "Eq. Guinea": "gq",
    "Falkland Is.": "fk",
    "Fr. Polynesia": "pf",
    "Fr. S. Antarctic Lands": "tf",
    "Heard I. and McDonald Is.": "hm",
    "Macedonia": "mk",
    "N. Mariana Is.": "mp",
    "Palestine": "ps",
    "S. Sudan": "ss",
    "Solomon Is.": "sb",
    "St-Martin": "mf",
    "St. Kitts and Nevis": "kn",
    "St. Pierre and Miquelon": "pm",
    "St. Vin. and Gren.": "vc",
    "Turks and Caicos Is.": "tc",
    "U.S. Virgin Is.": "vi",
    "United States of America": "us",
    "Wallis and Futuna Is.": "wf",
}

# Countries in the fire record with no Natural Earth polygon. Their cities give
# a usable view; these two have no city above 15,000 people.
COUNTRY_FALLBACKS = {
    "Svalbard and Jan Mayen": ([15.0, 78.0], 4.5),
    "United States Minor Outlying Islands": ([166.0, 10.0], 3.5),
}

# FIRMS uses older or more formal names for some countries. Search should still
# find them by the name most people use, and by the acronyms.
COUNTRY_ALIASES = {
    "Brunei Darussalam": ["Brunei"],
    "Cabo Verde": ["Cape Verde"],
    "Cote d Ivoire": ["Ivory Coast"],
    "Czech Republic": ["Czechia"],
    "Dem Rep Korea": ["North Korea"],
    "Democratic Republic of the Congo": ["DR Congo", "Congo-Kinshasa"],
    "Federated States of Micronesia": ["Micronesia"],
    "Lao PDR": ["Laos"],
    "Macedonia Former Yugoslav Republic of": ["Macedonia", "North Macedonia"],
    "Myanmar": ["Burma"],
    "Republic of Congo": ["Congo-Brazzaville", "Republic of the Congo"],
    "Republic of Korea": ["South Korea"],
    "Russian Federation": ["Russia"],
    "Swaziland": ["Eswatini"],
    "Timor-Leste": ["East Timor"],
    "United Arab Emirates": ["UAE", "U.A.E."],
    "United Kingdom": ["UK", "U.K.", "Britain", "Great Britain"],
    "United States": ["USA", "US", "U.S.A.", "United States of America"],
    "Vietnam": ["Viet Nam"],
}

NOISE = re.compile(r"\b(the|of|republic|islands|island|rep|dem|democratic|federated|"
                   r"states|former|yugoslav)\b")


def normalise(name: str) -> str:
    text = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    text = text.lower().replace("&", " and ")
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    return " ".join(NOISE.sub(" ", text).split())


def fetch(url: str, path: str) -> None:
    print(f"downloading {url}")
    request = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(request, timeout=120) as response, open(path, "wb") as out:
        out.write(response.read())


def ensure_geonames(folder: str, refresh: bool) -> None:
    os.makedirs(folder, exist_ok=True)
    for name, url in GEONAMES_URLS.items():
        path = os.path.join(folder, name)
        if refresh or not os.path.exists(path):
            fetch(url, path)
    cities_zip = os.path.join(folder, "cities15000.zip")
    cities_txt = os.path.join(folder, "cities15000.txt")
    if refresh or not os.path.exists(cities_txt):
        with zipfile.ZipFile(cities_zip) as archive:
            archive.extract("cities15000.txt", folder)


def read_countries(path: str) -> dict[str, dict]:
    countries: dict[str, dict] = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("#"):
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 9:
                continue
            iso = parts[0].lower()
            try:
                area = float(parts[6]) if parts[6] else 0.0
            except ValueError:
                area = 0.0
            countries[iso] = {"name": parts[4], "area": area}
    return countries


def read_admin1(path: str) -> dict[str, str]:
    admin: dict[str, str] = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 2:
                admin[parts[0]] = parts[1]
    return admin


def read_firms(path: str) -> list[str]:
    import csv
    with open(path, encoding="utf-8", newline="") as handle:
        return sorted({row["country"] for row in csv.DictReader(handle)})


def iter_polygons(geometry: dict):
    if geometry["type"] == "Polygon":
        yield geometry["coordinates"]
    elif geometry["type"] == "MultiPolygon":
        yield from geometry["coordinates"]


def ring_stats(ring: list) -> tuple[float, float, float, float, float] | None:
    """Area and bounds of one ring, with longitude unwrapped across the date line."""
    if len(ring) < 3:
        return None
    points = []
    previous = None
    for lon, lat in ring:
        lon = ((float(lon) + 180.0) % 360.0) - 180.0
        if previous is not None:
            while lon - previous > 180.0:
                lon -= 360.0
            while lon - previous < -180.0:
                lon += 360.0
        points.append((lon, float(lat)))
        previous = lon
    area = 0.0
    for index, (x1, y1) in enumerate(points):
        x2, y2 = points[(index + 1) % len(points)]
        area += x1 * y2 - x2 * y1
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return abs(area) / 2.0, min(xs), max(xs), min(ys), max(ys)


def focus_for_geometry(geometry: dict) -> dict | None:
    polygons = []
    for polygon in iter_polygons(geometry):
        stats = ring_stats(polygon[0])
        if stats:
            polygons.append(stats)
    if not polygons:
        return None
    largest = max(polygons, key=lambda item: item[0])
    anchor_x = (largest[1] + largest[2]) / 2.0
    anchor_y = (largest[3] + largest[4]) / 2.0

    # Keep the main landmass and nearby islands, but leave out far-flung
    # territories so "France" opens on France, not half the Atlantic.
    chosen = []
    for item in polygons:
        if item is largest:
            chosen.append(item)
            continue
        area, west, east, south, north = item
        centre_x = (west + east) / 2.0
        centre_y = (south + north) / 2.0
        dx = abs(((centre_x - anchor_x + 180.0) % 360.0) - 180.0) * math.cos(math.radians(centre_y))
        dy = abs(centre_y - anchor_y)
        if area >= largest[0] * 0.05 and math.hypot(dx, dy) <= 40.0:
            chosen.append(item)
    if not chosen:
        chosen = [largest]

    west = east = None
    south = north = None
    weighted_x = weighted_y = total_area = 0.0
    for area, item_west, item_east, item_south, item_north in chosen:
        shift = round((anchor_x - (item_west + item_east) / 2.0) / 360.0) * 360.0
        item_west += shift
        item_east += shift
        west = item_west if west is None else min(west, item_west)
        east = item_east if east is None else max(east, item_east)
        south = item_south if south is None else min(south, item_south)
        north = item_north if north is None else max(north, item_north)
        weighted_x += (item_west + item_east) / 2.0 * area
        weighted_y += (item_south + item_north) / 2.0 * area
        total_area += area

    span = max(east - west, north - south)
    zoom = math.log2(900.0 / max(span, 0.15)) - 0.35
    zoom = max(0.8, min(9.5, zoom))
    lon = (weighted_x / total_area + 180.0) % 360.0 - 180.0 if total_area else (west + east) / 2.0
    lat = weighted_y / total_area if total_area else (south + north) / 2.0
    return {"center": [round(lon, 4), round(lat, 4)], "zoom": round(zoom, 2)}


def build(args: argparse.Namespace) -> int:
    assets = os.path.join(ROOT, args.assets)
    geonames = os.path.join(ROOT, args.geonames)
    ensure_geonames(geonames, args.refresh)

    countries_info = read_countries(os.path.join(geonames, "countryInfo.txt"))
    admin1 = read_admin1(os.path.join(geonames, "admin1CodesASCII.txt"))
    firms = read_firms(os.path.join(ROOT, "Clean_dataset", "world_monthly.csv"))
    with open(os.path.join(assets, "flags", "index.json"), encoding="utf-8") as handle:
        flags = json.load(handle)
    firms_by_iso = {code.lower(): name for name, code in flags.items()}
    countries_by_norm = {}
    for iso, row in countries_info.items():
        countries_by_norm.setdefault(normalise(row["name"]), iso)

    # ---- every city above 15,000 people -------------------------------------
    cities = []
    city_by_iso: dict[str, list[tuple[float, float]]] = {}
    with open(os.path.join(geonames, "cities15000.txt"), encoding="utf-8") as handle:
        for line in handle:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 19 or parts[6] != "P":
                continue
            try:
                lat, lon = float(parts[4]), float(parts[5])
                population = int(parts[14] or 0)
            except ValueError:
                continue
            if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
                continue
            iso = parts[8].lower()
            country = firms_by_iso.get(iso) or countries_info.get(iso, {}).get("name") or parts[8]
            region = admin1.get(f"{parts[8].upper()}.{parts[10]}", "")
            record = {
                "n": parts[1],
                "c": country,
                "la": round(lat, 4),
                "lo": round(lon, 4),
                "p": population,
            }
            if parts[2] and parts[2] != parts[1]:
                record["a"] = parts[2]
            if region:
                record["ad"] = region
            cities.append(record)
            city_by_iso.setdefault(iso, []).append((lat, lon))
    cities.sort(key=lambda row: (-row["p"], row["n"], row["la"], row["lo"]))

    # ---- a centre and zoom for every country in the fire record --------------
    with open(os.path.join(assets, "countries.geojson"), encoding="utf-8") as handle:
        world = json.load(handle)
    geo_by_iso: dict[str, dict] = {}
    for feature in world["features"]:
        name = feature["properties"]["name"]
        iso = GEO_ISO_OVERRIDES.get(name) or countries_by_norm.get(normalise(name))
        if iso and iso not in geo_by_iso:
            geo_by_iso[iso] = feature

    focus = {}
    missing = []
    for name in firms:
        iso = flags.get(name, "").lower()
        feature = geo_by_iso.get(iso) if iso else None
        target = focus_for_geometry(feature["geometry"]) if feature else None
        if target is None and iso in city_by_iso:
            points = city_by_iso[iso]
            lats = [p[0] for p in points]
            lons = [p[1] for p in points]
            span = max(max(lons) - min(lons), max(lats) - min(lats)) * 1.25
            zoom = max(0.8, min(9.5, math.log2(900.0 / max(span, 0.15)) - 0.35))
            target = {
                "center": [round((min(lons) + max(lons)) / 2.0, 4),
                           round((min(lats) + max(lats)) / 2.0, 4)],
                "zoom": round(zoom, 2),
            }
        if target is None and name in COUNTRY_FALLBACKS:
            center, zoom = COUNTRY_FALLBACKS[name]
            target = {"center": center, "zoom": zoom}
        if target is None:
            missing.append(name)
            continue
        aliases = set(COUNTRY_ALIASES.get(name, []))
        official = countries_info.get(iso, {}).get("name") if iso else None
        if official and normalise(official) != normalise(name):
            aliases.add(official)
        if aliases:
            target["aliases"] = sorted(aliases)
        focus[name] = target

    def write(folder: str) -> None:
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "cities.json"), "w", encoding="utf-8") as handle:
            json.dump(cities, handle, ensure_ascii=False, separators=(",", ":"))
        with open(os.path.join(folder, "country-focus.json"), "w", encoding="utf-8") as handle:
            json.dump(dict(sorted(focus.items())), handle, ensure_ascii=False, separators=(",", ":"))

    write(assets)
    # Keep the GitHub Pages copy in step when the docs folder is present.
    docs_assets = os.path.join(ROOT, "docs", "assets")
    if os.path.isdir(docs_assets) and os.path.abspath(docs_assets) != os.path.abspath(assets):
        write(docs_assets)
        print(f"also updated {docs_assets}")

    cities_path = os.path.join(assets, "cities.json")
    focus_path = os.path.join(assets, "country-focus.json")
    print(f"{len(cities):,} cities -> {cities_path} "
          f"({os.path.getsize(cities_path) / 1024 / 1024:.1f} MB)")
    print(f"{len(focus)} country views -> {focus_path} "
          f"({os.path.getsize(focus_path) / 1024:.0f} KB)")
    for name in missing:
        print(f"   no map view: {name}")
    return 1 if missing else 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", default=os.path.join("Frontend", "assets"))
    parser.add_argument("--geonames", default=os.path.join("data", "geonames"))
    parser.add_argument("--refresh", action="store_true", help="download the GeoNames files again")
    return build(parser.parse_args())


if __name__ == "__main__":
    sys.exit(main())
