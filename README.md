# BurningView: harmonized fire hotspots for Malaysia & Indonesia, and a world record

NASA Space Apps 2026, Challenge #8. Fire hotspots from NASA FIRMS (MODIS 2000–2025 and VIIRS S-NPP 2012–2025) are cleaned, calibrated onto one consistent scale, and shown on a website. The site includes a burning calendar, a hotspot map, history comparisons, haze-preparedness tips, and a forecast of *how much* and *where* fires are likely in 2026–2027.

The same site also carries a **worldwide record**: 233 countries × month × sensor from 2003 (VIIRS from 2018), plus GFWED fire-weather maps for every land cell. World counts are per sensor and uncalibrated; only Malaysia and Indonesia have forecasts.

## Project layout
```
├── Clean.py           step 1: raw FIRMS CSVs -> Clean_dataset/clean_hotspots.csv
├── calibration.py     step 2: -> Clean_dataset/harmonized_monthly.csv + calibration.csv
├── world_build.py     step W1: FIRMS all-countries archives -> Clean_dataset/world_monthly.csv
├── pull_gfwed_world.py GFWED fire weather -> data/world/{FWI,DC}_YYYYMM.npy (1 degree, global)
├── tools/             static exports for the GitHub Pages build (docs/data)
├── Global_Dataset/    country-month fire record for 233 countries, 2003-2025
├── backend/           FastAPI server: API, data loading and forecast models
│   └── app/
│       ├── main.py        starts the server and serves the website
│       ├── config.py      paths, datasets, region boxes
│       ├── routers/       web endpoints (/api/...)
│       └── services/      the logic: data loading, forecast.py, spatial_forecast.py,
│                           world_spatial_forecast.py (all-country cell forecast)
├── Frontend/          the website: index.html, app.js, styles.css
├── Clean_dataset/     cleaned / calibrated outputs used by the website
└── *.csv (repo root)  raw NASA FIRMS data (Git LFS). Locally these live in Model_Nasa/
```

## Run it
**1. Set up Python (once):**
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

**2. Rebuild `clean_hotspots.csv` (once).** It's 264 MB, too large for GitHub, so it isn't in the repo. Run this from the folder that holds the raw CSVs (the repo root in a clone, or `Model_Nasa/` locally):
```powershell
backend\.venv\Scripts\python.exe Clean.py --modis "modis_2000-2025_*.csv" --viirs "viirs-snpp_2012-2025_*.csv" --out Clean_dataset\clean_hotspots.csv
```
`harmonized_monthly.csv` and `calibration.csv` are already in the repo. To regenerate them:
```powershell
cd Clean_dataset
..\backend\.venv\Scripts\python.exe ..\calibration.py --inp clean_hotspots.csv
```

**3. Start the server:**
```powershell
cd backend
.\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000
```
- Website: http://127.0.0.1:8000/
- API docs: http://127.0.0.1:8000/docs

The first start converts `clean_hotspots.csv` into a faster format (about a minute). Later starts take seconds. If you re-run `calibration.py`, the site picks up the new results without a restart.

## Method
- **Cleaning (`Clean.py`):** keeps vegetation fires only (FIRMS type 0) and removes duplicates. Drops low-confidence detections (MODIS confidence < 30, VIIRS "low"). Assigns each hotspot to a region (Peninsular Malaysia, Sarawak, Sabah, Sumatra, Kalimantan) and uses local-time dates.
- **Harmonization (`calibration.py`):**
  - Hotspots are snapped to a 0.05° grid and counted as *fire cell-days*: a cell that burns on a given day counts once.
  - For each region, MODIS is calibrated to the VIIRS scale on the overlap months (Feb 2012–2025), using either a linear or a power-law fit.
  - The fit is validated by leaving out one year at a time, and the model with the lower error is kept.
- **Anomaly:** each month is compared with the median of the same calendar month across 2003–2025.

### Forecast: how much (`backend/app/services/forecast.py`)
The forecast for a month is the average of the last 5 years for that month (in log space), plus a climate effect and a bias correction. The bias correction fixes the recent-years average running too high.

Two climate predictors are available, and every area keeps whichever combination wins its own backtest:

- **El Niño** — NOAA's ONI index, one slope for the dry season (Jun–Nov) and another for the rest of the year. Cached in `backend/.cache/oni.txt`, so the model still runs offline.
- **Drought code** — GFWED from NASA GISS (`data/gfwed_regions_monthly.csv`), a slow cumulative measure of fuel dryness that carries the preceding months into the season.

In practice drought code wins Sarawak, Kalimantan and Papua; El Niño wins Sumatra, Sabah, Java, Sulawesi and Maluku; Nusa Tenggara takes both.

The backtest is deliberately unkind, because the earlier version was not. A forecast is issued at the end of **May** and scored on **June–November**, using only January–May of the target year, held forward. It never reads the season it is predicting, and the target year is never in its own training set. The old model read the year's own ONI to make its backtest prediction, which flattered the error by roughly ten points; that leak is gone.

For all 10 regions together the typical monthly error is **42%**, against **50%** for the seasonal pattern alone. Adding every dataset at once reaches 39.8%, which is inside the noise — more inputs do not buy more accuracy, and per region stacking usually makes it worse.

Coverage is 10 regions across Malaysia and Indonesia, 2003–2025.

### Forecast: where (`backend/app/services/spatial_forecast.py`)
Expected fire days in a 0.25° cell are `k × (recency-weighted history of the cell for that month) × (its region's El Niño/bias multiplier)`. A curve learned in the backtest converts expected fire days into a chance of at least one fire day.

Tested on 2016–2025:
- Ranking skill AUC is 0.81, where 0.5 is guessing.
- The 10% of cells rated riskiest held 36% of all fire days.
- The Brier score is 0.158, against 0.223 for guessing the same chance everywhere.

Area names are approximate: each cell is named after the nearest province, state or division centre.

### Worldwide record (`world_build.py`, `pull_gfwed_world.py`)
The raw FIRMS "all countries" archive is streamed without unpacking: 6,474 country-year CSVs, about 21 GB expanded. `world_build.py` keeps vegetation fires only and the same confidence rules as `Clean.py`, then writes `Clean_dataset/world_monthly.csv` with hotspots, fire cell-days and FRP for every country × month × sensor. It covers 233 countries from 2003 (MODIS) and 2018 (VIIRS JPSS-1). Counts are per sensor and are **not** calibrated onto the S-NPP scale used by the regional model, so do not add MODIS and VIIRS together.

`pull_gfwed_world.py` downloads NASA GFWED fire weather for every month and coarsens it to a 1-degree global grid in `data/world/`. The site compares any month with the same calendar month in the 2003-2025 baseline to show where fire weather is unusually dry; 2026 months are shown as NASA publishes them. Like the world fire counts, this is observed data, not a forecast.

`world_fire_grid.py` serves the harmonized 1-degree global cell record, and `world_outlook.py` turns the country-month archive into a month-by-month seasonal estimate (the median of the last ten observations for that calendar month). The estimate is historical seasonality, not a forecast; it does not know the current year's weather.

### All-country cell forecast (`world_spatial_forecast.py`)
Every country now has the same cell-level model estimate the Explorer shows for
an East Kalimantan regency:

- cells are 1 degree (~110 km) from `Global_Dataset/harmonized_cells_1deg.csv.gz`;
- each cell's expected activity is its recency-weighted climatology (half-life
  3 years) multiplied by its country's seasonal + ENSO factor;
- the country factor is fitted on `harmonized_country_monthly.csv` and uses only
  the January-May ONI of the target year, so the backtest is honest;
- the scale and probability curve are fitted once on 2018-2025 with each test
  year held out (`/api/world/fires/forecast/{name}` also returns the skill).

It is deliberately coarser than the regional model: one structural model for all
countries, harmonized counts rather than verified fire days, so it should not be
compared numerically with the Malaysia/Indonesia forecast.

Rebuild both, then regenerate the static site data:

```powershell
backend\.venv\Scripts\python.exe world_build.py --zip "C:\path\Dataset (World).zip"
backend\.venv\Scripts\python.exe pull_gfwed_world.py
backend\.venv\Scripts\python.exe tools\export_world_static.py
```

The regional Malaysia/Indonesia forecast still uses the finer 0.25-degree grid
and the per-region model choice.

## API (website endpoints)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/regions` | The 10 regions with country and bounding box |
| GET | `/api/harmonized?scope=All\|Malaysia\|Indonesia\|<region>` | Monthly harmonized series with anomaly |
| GET | `/api/calibration` | Calibration table |
| GET | `/api/calibration/points?region=` | Overlap months for the calibration scatter plot |
| GET | `/api/hotspots/grid?scope=&year=&month=&sensor=auto\|VIIRS\|MODIS&cell=0.1` | Gridded hotspots for the map |
| GET | `/api/forecast?scope=&year=2026\|2027&enso=observed\|2\|1\|0\|-1` | Monthly forecast with 80% range and chance of an above-normal month |
| GET | `/api/forecast/map?scope=&year=&enso=` | Each cell's chance of ≥1 fire day per month, top areas, and an area × month grid |
| GET | `/api/enso` | Latest NOAA El Niño index (ONI) |
| GET | `/api/world/fires` | Coverage and caveats for the worldwide country record |
| GET | `/api/world/fires/countries` | Every country with its all-time total, busiest first |
| GET | `/api/world/fires/country/{name}?sensor=VIIRS\|MODIS` | One country month by month, with its typical season, peak month and annual totals |
| GET | `/api/world/fires/ranking?year=&month=&sensor=&limit=` | The countries that burned most in a year or month |
| GET | `/api/world/fires/grid?year=&month=` | Harmonized historical fire activity in 1-degree global cells |
| GET | `/api/world/fires/outlook/{name}` | Country-level monthly seasonal estimate, with its historical 80% range |
| GET | `/api/world/fires/forecast/{name}?year=2026\|2027&enso=observed\|2\|1\|0\|-1` | Cell-level forecast for any country, plus its monthly summary and skill |
| GET | `/api/world/fires/forecast-map?year=&enso=` | The same model estimate for every country, joined to map boundary names |
| GET | `/api/world/fires/outlook-map` | Seasonal estimates joined to map boundary names |
| GET | `/api/world/coverage` | Months and grid covered by the global GFWED fire-weather record |
| GET | `/api/world/danger?year=&month=&variable=FWI\|DC` | Percentile of that month's fire weather against the same month on record |

Other endpoints on the raw FIRMS files (not used by the website): `/api/datasets`, `/api/fires`, `/api/fires/geojson`, `/api/stats/summary`, `/api/stats/timeseries`, `/api/stats/grid`, `/api/predict` (placeholder). Filters include `dataset`, `start_date`, `end_date`, `bbox=min_lon,min_lat,max_lon,max_lat`, `min_frp`, `confidence`, `daynight`.

CORS is open (`*`) by default. To restrict it, set `CORS_ORIGINS` to your frontend's URL.

## Data sources
- NASA FIRMS active fire archive: MODIS C6.1 and VIIRS S-NPP 375 m (https://firms.modaps.eosdis.nasa.gov/)
- NASA FIRMS all-countries archive: MODIS and VIIRS JPSS-1, used for the worldwide record
- NASA GISS GFWED v2.0 monthly fire weather (https://portal.nccs.nasa.gov/datashare/GlobalFWI/)
- NOAA CPC Oceanic Niño Index (https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt)
- Basemap © Esri, © OpenStreetMap contributors
