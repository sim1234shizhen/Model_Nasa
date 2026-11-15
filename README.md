# BuriningView: harmonized MODIS + VIIRS fire hotspots for Malaysia & Indonesia

NASA Space Apps 2026, Challenge #8. Fire hotspots from NASA FIRMS (MODIS 2000–2025 and VIIRS S-NPP 2012–2025) are cleaned, calibrated onto one consistent scale, and shown on a website. The site includes a burning calendar, a hotspot map, history comparisons, haze-preparedness tips, and a forecast of *how much* and *where* fires are likely in 2026–2027.

## Project layout
```
├── Clean.py           step 1: raw FIRMS CSVs -> Clean_dataset/clean_hotspots.csv
├── calibration.py     step 2: -> Clean_dataset/harmonized_monthly.csv + calibration.csv
├── backend/           FastAPI server: API, data loading and forecast models
│   └── app/
│       ├── main.py        starts the server and serves the website
│       ├── config.py      paths, datasets, region boxes
│       ├── routers/       web endpoints (/api/...)
│       └── services/      the logic: data loading, forecast.py, spatial_forecast.py
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
The forecast for a month is the average of the last 5 years for that month (in log space), plus an El Niño effect and a bias correction. The El Niño effect uses NOAA's ONI index, with one slope for the dry season (Jun–Nov) and another for the rest of the year. The bias correction fixes the recent-years average running too high.

Every area is backtested over 2013–2025: train only on earlier years, then predict the whole year. El Niño is kept for an area only if it lowers that area's backtest error; it does for every area except Sarawak. For all regions together, the typical monthly error is ±38% (±47% without El Niño). The ONI file is downloaded from NOAA CPC and cached in `backend/.cache/oni.txt`. If the server is offline, the model runs without El Niño.

### Forecast: where (`backend/app/services/spatial_forecast.py`)
Expected fire days in a 0.25° cell are `k × (recency-weighted history of the cell for that month) × (its region's El Niño/bias multiplier)`. A curve learned in the backtest converts expected fire days into a chance of at least one fire day.

Tested on 2016–2025:
- Ranking skill AUC is 0.81, where 0.5 is guessing.
- The 10% of cells rated riskiest held 36% of all fire days.
- The Brier score is 0.158, against 0.223 for guessing the same chance everywhere.

Area names are approximate: each cell is named after the nearest province, state or division centre.

## API (website endpoints)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/regions` | The 5 regions with country and bounding box |
| GET | `/api/harmonized?scope=All\|Malaysia\|Indonesia\|<region>` | Monthly harmonized series with anomaly |
| GET | `/api/calibration` | Calibration table |
| GET | `/api/calibration/points?region=` | Overlap months for the calibration scatter plot |
| GET | `/api/hotspots/grid?scope=&year=&month=&sensor=auto\|VIIRS\|MODIS&cell=0.1` | Gridded hotspots for the map |
| GET | `/api/forecast?scope=&year=2026\|2027&enso=observed\|2\|1\|0\|-1` | Monthly forecast with 80% range and chance of an above-normal month |
| GET | `/api/forecast/map?scope=&year=&enso=` | Each cell's chance of ≥1 fire day per month, top areas, and an area × month grid |
| GET | `/api/enso` | Latest NOAA El Niño index (ONI) |

Other endpoints on the raw FIRMS files (not used by the website): `/api/datasets`, `/api/fires`, `/api/fires/geojson`, `/api/stats/summary`, `/api/stats/timeseries`, `/api/stats/grid`, `/api/predict` (placeholder). Filters include `dataset`, `start_date`, `end_date`, `bbox=min_lon,min_lat,max_lon,max_lat`, `min_frp`, `confidence`, `daynight`.

CORS is open (`*`) by default. To restrict it, set `CORS_ORIGINS` to your frontend's URL.

## Data sources
- NASA FIRMS active fire archive: MODIS C6.1 and VIIRS S-NPP 375 m (https://firms.modaps.eosdis.nasa.gov/)
- NOAA CPC Oceanic Niño Index (https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt)
- Basemap © Esri, © OpenStreetMap contributors
