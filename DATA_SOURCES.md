# Open data sources for the Malaysia / Indonesia fire forecast

Researched and endpoint-tested 15 November 2026. Every URL marked **VERIFIED** was
actually requested from this machine and returned 200 (or working data). Anything I
could not confirm is marked **UNTESTED** with the reason.

Legend for "What it fixes":
- **VALIDATION** — does not add data, fixes how the model is judged (your ONI leak)
- **DRIVER** — new predictor, should raise real forecast skill
- **RECORD** — better/cleaner fire counts, or more of them
- **CONTEXT** — static layer that explains where and why, helps the map not the total
- **CHECK** — independent data to validate against, not a predictor

---

## Tier 1 — Forecast indices (this is what actually fixes your bug)

You currently use *observed* ONI for the year you predict. These give you a **forecast**
index instead, so the backtest becomes honest and the model keeps its El Niño term.

### 1.1 IRI / CPC ENSO forecast (official, monthly)
- URL: https://iri.columbia.edu/ENSO — **VERIFIED** (200)
- Page: https://iri.columbia.edu/our-expertise/climate/forecasts/enso/current/
- Gives: Niño 3.4 SST anomaly forecast by 3-month season, ~9 months ahead, from ~20
  dynamical + statistical models, plus CPC's official probability table.
- Licence: free, cite IRI/CPC.
- **Fixes: VALIDATION.** This is the direct replacement for `_oni_row(oni, y)` in
  `forecast.py:155`. In a backtest, use the forecast that was issued at the time
  (IRI archives plume plots monthly), or use the model-ensemble mean as the predictor
  and hold 3-month seasons into months.

### 1.2 NOAA PSL seasonal forecasts — LIM and Model-Analog
- URL: https://psl.noaa.gov/forecasts/seasonal/ — **VERIFIED** (200)
- Download root: https://downloads.psl.noaa.gov/Projects/LIM/Realtime/Realtime/webData/
  (current forecast bundle `current_fcst.tar.gz`; the exact timeseries filenames under
  `.../TimeSeries/` I could not enumerate — directory listing did not expose files.
  **UNTESTED** for the individual filenames, but the page documents them.)
- Gives: Niño 3.4 and other tropical fields, **months 1–24 lead**, netCDF + ASCII.
  4 NMME models (CCSM4, CESM1, CM2.1, FLOR) + 9 CMIP6 + LIM.
- Licence: free, US Government work.
- **Fixes: VALIDATION.** Best option if you want a *continuous numeric* forecast ONI
  series rather than IRI's seasonal plume — it drops straight into your existing
  `slope * ONI` term.

### 1.3 NMME (North American Multi-Model Ensemble)
- https://www.ncei.noaa.gov/products/weather-climate-models/north-american-multi-model
- Also on the IRI Data Library: https://iridl.ldeo.columbia.edu/
- Gives: gridded SST/precip/temperature forecasts, 0.5–1°, out to 9–12 months.
- **Fixes: DRIVER + VALIDATION.** Overkill for ONI alone; useful if you also want
  forecast *rainfall* rather than forecast fire weather.

### 1.4 Indian Ocean Dipole (DMI) — the second-biggest driver for Indonesia
- BoM: https://www.bom.gov.au/climate/iod/ (page works; direct PNG assets 403 from here)
- NOAA State of the Ocean: https://stateoftheocean.osmc.noaa.gov/sur/ind/dmi.php — **VERIFIED** (200)
- Gives: monthly Dipole Mode Index, plus BoM's IOD outlook.
- Licence: free, cite BoM / NOAA.
- **Fixes: DRIVER.** The IOD is often a *better* predictor than ENSO for Sumatra and
  Kalimantan rainfall. Adding it is a genuine skill gain, not a cosmetic one. GFWED's own
  documentation lists DMI alongside ONI for exactly this reason.

---

## Tier 2 — Weather: rain, humidity, wind (the missing predictors)

Your model has one dial (ONI). These give you the actual mechanism: drought, then fire.

### 2.1 NASA POWER — easiest, no key, no registration
- https://power.larc.nasa.gov/api/temporal/monthly/point — **VERIFIED, returned data**
- Example that worked:
  `?parameters=PRECTOTCORR,T2M,RH2M&community=AG&longitude=101.8&latitude=0.5&start=2025&end=2025&format=JSON`
- Gives: monthly and daily precipitation, temperature, relative humidity, wind, soil
  moisture, from 1981 to near-present, at ~0.5° × 0.625°.
- Licence: free, NASA, cite the POWER project.
- **Fixes: DRIVER.** One GET request per region centre gets you 44 years of rainfall.
  This is the single highest value-per-hour addition to your model.

### 2.2 Open-Meteo archive — no key, higher resolution, daily
- https://archive-api.open-meteo.com/v1/archive — **VERIFIED, returned data**
- `?latitude=0.5&longitude=101.8&start_date=...&end_date=...&daily=precipitation_sum,temperature_2m_max,relative_humidity_2m_mean,wind_speed_10m_max`
- Gives: daily/hourly back to **1940**, ~5–25 km, plus a separate forecast API.
- Licence: free for non-commercial, CC-BY-4.0 attribution. 10,000 calls/day free tier.
- **Fixes: DRIVER.** Much finer than POWER, and it can hand you the *forecast* rain for
  next month from the same vendor — which is what you need for a real forward outlook.

### 2.3 CHIRPS v2.0 — the best rainfall product for this region
- https://www.chc.ucsb.edu/data/chirps
- Access routes that work:
  - NOAA ERDDAP: https://coastwatch.pfeg.noaa.gov/erddap/griddap/chirps20GlobalMonthlyP05.html
    — dataset live, variable name is `precip`, **but the mirror only goes to 2025-02-01**
    (confirmed by query). Fine for the backtest, useless for 2026.
  - ClimateSERV: https://climateserv.servirglobal.net/ — **VERIFIED** (200), point queries.
  - Google Earth Engine: `UCSB-CHG/CHIRPS/DAILY`, `UCSB-CHG/CHIRPS/PENTAD`.
- Direct HTTP at `data.chc.ucsb.edu/products/CHIRPS-2.0/...` returned 404 for every path
  I tried from this machine, including the netCDF directory ERDDAP itself cites.
  **Do not build on it**; use ERDDAP or GEE.
- Licence: public domain / CC0 (CHIRPS is USGS-funded).
- **Fixes: DRIVER.** 0.05° daily gauge-satellite blend, 1981–present. This is what the
  fire literature uses for Southeast Asia; better than POWER over Borneo.

### 2.4 ERA5 / ERA5-Land (Copernicus Climate Data Store)
- https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels-monthly-means
  — page **VERIFIED** (200)
- Free with a CDS account + `cdsapi` key. ERA5-Land is 0.1°, 1950–present.
- **Fixes: DRIVER.** The gold standard if you want to compute your own fire weather
  index. Slower to set up than POWER; same information.

### 2.5 GPM IMERG — 0.1° rain, 2000–present
- https://gpm.nasa.gov/data (Earthdata login)
- **Fixes: DRIVER.** Only real reason to prefer it over CHIRPS is latency and the
  30-minute product; skip unless you go sub-monthly.

---

## Tier 3 — Fire-specific data

### 3.1 NASA FIRMS — the archive sources you are not using
- API docs: https://firms.modaps.eosdis.nasa.gov/api/
- Confirmed available source IDs (scraped from the live API page):
  `MODIS_NRT`, `MODIS_SP`, `VIIRS_SNPP_NRT`, `VIIRS_SNPP_SP`,
  `VIIRS_NOAA20_NRT`, `VIIRS_NOAA20_SP`, `VIIRS_NOAA21_NRT`, `VIIRS_NOAA21_SP`
- `_SP` = standard processing (science quality archive), `_NRT` = near real time.
- Needs a free MAP_KEY: https://firms.modaps.eosdis.nasa.gov/api/map_key/
- **Fixes: RECORD.** Two concrete wins:
  1. Pull `*_SP` files for **2026** — your data stops at Dec 2025 and you are
     10 months stale.
  2. You already have `viirs-jpss1_2018-2025_*.csv` (1.39 M rows, NOAA-20) on disk and
     `Clean.py` explicitly tells you not to use them. NOAA-20 is a second VIIRS with a
     different overpass time; including it reduces dependence on one satellite's schedule
     and is the reference scale Fire Harmony harmonizes to.

### 3.2 GFWED — Global Fire Weather Database (NASA GISS)
- https://data.giss.nasa.gov/impacts/gfwed/ — **VERIFIED** (200)
- Data: https://portal.nccs.nasa.gov/datashare/GlobalFWI/ — **VERIFIED** (200)
- Gives: Canadian FWI System outputs (FFMC, DMC, DC, ISI, BUI, FWI) from MERRA-2,
  **1981–present**, 0.5° × 2/3°, daily and monthly netCDF. Eight variants differing in
  which rainfall estimate is used.
- Also mirrored as an IRI Data Library dataset:
  https://iridl.ldeo.columbia.edu/SOURCES/.GISS/.GlobalFWI/ — **VERIFIED** (200)
  (easier to subset than raw netCDF).
- Licence: free, NASA, cite Field et al. (2015).
- **Fixes: DRIVER.** This is pre-computed fire weather — you get drought code and fire
  danger for free without doing any meteorology yourself. Strongest single addition after
  rainfall. Notably, GFWED's own validation literature includes a dedicated
  **Indonesia and Malaysia** FWI calibration (de Groot et al. 2007), so the index is
  known to behave in your region.

### 3.3 ESA Fire_cci burned area
- https://catalogue.ceda.ac.uk/ (search "Fire_cci Burned Area")
- 0.25° and 250 m, 2001–2020 (v5.1 extends further).
- **Fixes: CHECK.** Independent measurement you did not derive from hotspots. Fire Harmony
  uses exactly this as its "burned area witness" for the 2012 satellite switch — copy
  that idea, it is the strongest validity argument in their whole write-up.

### 3.4 MCD64A1 MODIS burned area
- https://www.earthdata.nasa.gov/data/catalog/lpcloud-mcd64a1-061
- 500 m monthly, 2000–present, Earthdata login.
- **Fixes: CHECK.** Same role as 3.3, longer and finer.

### 3.5 ASMC ASEAN hotspot service
- https://asmc.asean.org/asmc-hotspot/ — **VERIFIED** (200)
- Daily hotspot coordinate download for the ASEAN region, NOAA-20 based.
- **Fixes: CHECK.** Regional operational source — good for saying "our numbers agree with
  the agency that actually runs ASEAN haze monitoring", which is a stronger line in a
  Malaysian/Indonesian context than a global benchmark.

### 3.6 GIHS — global industrial heat sources
- https://zenodo.org/records/8308133 — **VERIFIED** (200)
- Ma & Wang et al., 2012–2021 (newer version covers more), CC BY 4.0.
- **Fixes: RECORD.** Removes gas flares, power plants, smelters from your hotspots.
  Your `Clean.py` already drops FIRMS `type != 0`, but NOAA-20/21 NRT has **no type
  label at all** — so the moment you add those satellites you need this mask or you will
  import industrial false positives.

---

## Tier 4 — Static context layers (explain where, not how much)

### 4.1 PEATMAP
- https://archive.researchdata.leeds.ac.uk/251/ (Xu et al. 2018), CC BY 4.0.
- **Fixes: CONTEXT.** Peat fires are the haze drivers. A peat flag per 0.25° cell tells
  your map why South Kalimantan's cells behave differently from upland cells.

### 4.2 CIFOR Global Wetlands Map
- https://data.cifor.org (persistentId doi:10.17528/CIFOR/DATA.00058) — **VERIFIED** (200)
- **Fixes: CONTEXT.** The Indonesia-specific peat/wetland layer; better than PEATMAP
  inside Indonesia. Directly relevant to your Kalimantan and Sumatra regions.

### 4.3 Global Forest Watch
- Peatlands: https://data.globalforestwatch.org/datasets/gfw::global-peatlands/about — **VERIFIED** (200)
- Data API: https://data-api.globalforestwatch.org/dataset/umd_tree_cover_loss/latest — **VERIFIED** (200)
- Also: oil palm concessions, wood fibre concessions, protected areas.
- Licence: CC BY 4.0 per layer.
- **Fixes: CONTEXT.** Concessions are one of the strongest *where* predictors in this
  region — land clearing is deliberate and happens in known places.

### 4.4 MCD12C1 land cover
- https://ladsweb.modaps.eosdis.nasa.gov/missions-and-measurements/products/MCD12C1/
- 0.05° yearly, 2001–present.
- **Fixes: CONTEXT.** Cheap static feature for the spatial model.

### 4.5 SEDAC GPW v4 population
- https://sedac.ciesin.columbia.edu/ (GPW v4.11), CC BY 4.0.
- **Fixes: CONTEXT.** Lets you rank cells by people exposed, not just fire days.

---

## What I would actually build, in order

| Order | Add | Effort | Expected effect |
|---|---|---|---|
| 1 | **Fix the ONI leak** (persistence, or IRI forecast) | ~30 min | Removes a false claim. Nothing else matters until this is done. |
| 2 | **Pull FIRMS `_SP` 2026 files** | ~1 hour | Data no longer 10 months stale; 2027 forecast becomes meaningful. |
| 3 | **NASA POWER rainfall per region** | ~2 hours | First real new predictor. Rainfall anomaly → fire with a lag. |
| 4 | **GFWED fire weather index** | ~half a day | Best new predictor for the money. Regional calibration already published. |
| 5 | **Enable NOAA-20 (jpss1) + GIHS mask** | ~half a day | Better record, one more satellite, fewer false positives. |
| 6 | **DMI / IOD index** | ~1 hour | Second climate dial; often beats ENSO here. |
| 7 | **ESA Fire CCI burned area cross-check** | ~1 day | Turns "our record is right" into a demonstrated fact. |
| 8 | **CIFOR wetlands + GFW concessions** | ~1 day | Makes the map explain itself. |

## What not to bother with

- **More MODIS history.** You already start in 2003; MODIS Aqua adds nothing before that.
- **GPM IMERG.** CHIRPS or POWER covers your need at lower effort.
- **NMME gridded fields.** IRI/PSL forecast ONI is all your architecture can consume.
- **A global rebuild.** Fire Harmony's 640 M hotspot record is not what makes it credible;
  its held-out validation is. You can match the credibility with 6.8 M rows and a
  clean test.

## Reference implementation notes

- Fire Harmony's own source list (for attribution parity) is at
  https://warren-530.github.io/fire-harmony/#/data — NASA FIRMS, MCD12C1, MERRA-2, GPM
  IMERG, GFWED, SEDAC GPW, ESA Fire_cci, PEATMAP, GIHS, Natural Earth, NOAA ONI + DMI.
  That is the same set arrived at independently; you can cite the same sources.
- Their strongest methodological idea, worth copying: use **burned area as an independent
  witness** to prove your harmonization did not create a fake trend.
