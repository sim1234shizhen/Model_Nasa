"""Export every API response the Fire Calendar page asks for into static JSON files,
so the site can be hosted on GitHub Pages without the Python server.

Usage (with the backend running on port 8000):
    python export_static.py http://127.0.0.1:8000 out_dir
"""
import json, re, sys, os, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor

BASE = sys.argv[1].rstrip("/") + "/api"
OUT = sys.argv[2]
CELLS = ["0.25", "0.1", "0.05"]
ENSO = ["observed", "2", "1", "0", "-1"]
slug = lambda s: s.replace(" ", "_")

def get(path, **q):
    url = BASE + path + ("?" + urllib.parse.urlencode(q) if q else "")
    try:
        with urllib.request.urlopen(url, timeout=300) as r:
            return json.load(r)
    except Exception as e:
        return None

def save(rel, obj):
    p = os.path.join(OUT, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)

regions = get("/regions"); save("regions.json", regions)
for name in ["calibration", "enso", "status"]:
    save(name + ".json", get("/" + name))
names = [r["region"] for r in regions]
scopes = ["All"] + sorted({r["country"] for r in regions}) + names
for r in names:
    save(f"calibration-points/{slug(r)}.json", get("/calibration/points", region=r))
years = set()
for s in scopes:
    d = get("/harmonized", scope=s); save(f"harmonized/{slug(s)}.json", d)
    years |= {x["year"] for x in d["series"]}
years = sorted(years); last = years[-1]
print("scopes", scopes, "years", years[0], last, flush=True)

def fc(args):
    s, y, e = args
    for path, folder in [("/forecast", "forecast"), ("/forecast/map", "forecast-map")]:
        d = get(path, scope=s, year=y, enso=e)
        if d is not None: save(f"{folder}/{slug(s)}_{y}_{e}.json", d)

def grid(args):
    s, y, m = args
    out = {"cells": {}, "auto": None}
    for c in CELLS:
        out["cells"][c] = {}
        for sensor in ["MODIS", "VIIRS"]:
            d = get("/hotspots/grid", scope=s, year=y, month=m, sensor=sensor, cell=c)
            if d is None: continue
            keys = [k for k in (d["cells"][0].keys() if d["cells"] else [])]
            d["k"] = keys; d["cells"] = [[row[k] for k in keys] for row in d["cells"]]
            out["cells"][c][sensor] = d
    a = get("/hotspots/grid", scope=s, year=y, month=m, sensor="auto", cell="0.25")
    out["auto"] = a["sensor"] if a else None
    save(f"grid/{slug(s)}/{y}-{m:02d}.json", out)

# ---- World page: /api/global/* (skipped if the global data is missing) ----
gslug = lambda s: re.sub(r"[^A-Za-z0-9]+", "_", s)   # same rule as gslug() in static-api.js
gsum = get("/global/summary")
if gsum:
    save("global/summary.json", gsum)
    for c in ["World"] + [x["country"] for x in gsum["countries"]]:
        d = get("/global/series", country=c)
        if d is not None: save(f"global/series/{gslug(c)}.json", d)
    y0, y1 = gsum["years"]
    def gper(args):
        y, m = args
        for path, folder in [("/global/ranking", "ranking"), ("/global/map", "map")]:
            d = get(path, year=y, month=m)
            if d is not None: save(f"global/{folder}/{y}-{m:02d}.json", d)
    with ThreadPoolExecutor(4) as ex:
        list(ex.map(gper, [(y, m) for y in range(y0, y1 + 1) for m in range(0, 13)]))
    print("global done", flush=True)

with ThreadPoolExecutor(3) as ex:
    list(ex.map(fc, [(s, y, e) for s in scopes for y in (last + 1, last + 2) for e in ENSO]))
    print("forecast done", flush=True)
    jobs = [(s, y, m) for s in scopes for y in years for m in range(1, 13)]
    for i, _ in enumerate(ex.map(grid, jobs)):
        if i % 200 == 0: print("grid", i, "/", len(jobs), flush=True)
print("done", flush=True)
