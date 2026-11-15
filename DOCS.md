# BurningView — Documentation

The headline results and the evidence behind them, then every dataset this project holds or has tested: what it covers, where it comes from, and whether anything reads it yet.

**Contents**

- Get started: [Key numbers](#key-numbers) · [Data catalogue](#data-catalogue)
- Reference: [Climate data](#climate-data) · [What the data is worth](#what-the-data-is-worth) · [Limits](#limits) · [World fire record](#world-fire-record) · [Files](#files)
- Rebuild: [Reproduce](#reproduce)
- About: [References](#references) · [Use of AI](#use-of-artificial-intelligence) · [Future work](#future-work)

---

## Key numbers

The results this documentation explains, and the check behind each one. They come from the project's own record, calibration and backtests; the rebuild steps are under [Reproduce](#reproduce).

| Measure | Value | What it means |
|---|---|---|
| Joined naively, 2011 → 2012 | **3.6×** | The sensor jump. MODIS and VIIRS are different cameras, not different amounts of fire. |
| After calibration, 2011 → 2012 | **+11.9%** | The same record on one scale. The median year-on-year change is about 58%, so the step is ordinary. |
| MODIS → VIIRS error | **±18.4%** | Median error per region-month, leave-one-year-out. By region the range is 10.5–29.8%. |
| Calibration fit | **R² 0.90–0.99** | Leave-one-year-out across the ten regions; median 0.96. |
| Forecast error, Jun–Nov | **42%** | Typical monthly error for the ten regions, issued at the end of May and scored on years the model never saw. |
| Risk-map ranking | **AUC 0.84** | The 10% of cells rated riskiest held 44% of fire days. Brier 0.14 against 0.21 for guessing. |
| Record built | **2.63 M** | Fire cell-days across 2,760 region-months (10 regions × 276 months), from about 6.8 M raw detections. |

### The jump that is not fire

February–December in both years, because VIIRS starts in February 2012. Joining the two sensors makes the record jump 3.6 times. Calibrating MODIS onto the VIIRS scale removes the camera change and leaves a step of +12%, smaller than the median year-on-year change in the record (the median absolute change between consecutive February–December totals, 2004–2025).

| Feb–Dec | Joined naively | On the VIIRS scale |
|---|---|---|
| 2011 | 38,715 MODIS cell-days | 124,471 calibrated cell-days |
| 2012 | 139,318 VIIRS cell-days | 139,318 observed cell-days |

**Where each number comes from**

- The seam and the calibration are on the website's calibration page (Data → Calibration).
- The forecast error and the per-region inputs are under [What the data is worth](#what-the-data-is-worth).
- The risk-map score is printed with the map on the Outlook page.

---

## Data catalogue

| Dataset | What it gives | Coverage | Grid | Status | Licence |
|---|---|---|---|---|---|
| [NASA FIRMS · MODIS C6.1](https://firms.modaps.eosdis.nasa.gov/) | Active fire detections, Terra and Aqua | 2003–2025 | 1 km | In use | Free, open |
| [NASA FIRMS · VIIRS S-NPP](https://firms.modaps.eosdis.nasa.gov/) | Active fire detections, afternoon overpass | Feb 2012–2025 | 375 m | In use | Free, open |
| NASA FIRMS · VIIRS NOAA-20 | Second VIIRS overpass, 1.4 M detections | 2018–2025 | 375 m | Pulled | Free, open |
| [NOAA CPC · ONI](https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt) | El Niño index, drives the forecast term | 1950–2026 | Monthly | In use | Free, open |
| [NASA POWER](https://power.larc.nasa.gov/) | Rain, temperature, humidity, wind, soil wetness | 1981–Sep 2026 | 0.5° | Pulled | Free, open |
| [NASA GISS · GFWED](https://data.giss.nasa.gov/impacts/gfwed/) | Fire weather: FWI, drought code and five more indices | Jan 2003–Apr 2026 | 0.5° × ⅔° | Pulled | Free, open |
| [NOAA / BoM · DMI](https://stateoftheocean.osmc.noaa.gov/sur/ind/dmi.php) | Indian Ocean Dipole, a second climate dial | Sep 1981–Sep 2026 | Monthly | Pulled | Free, open |
| [CHIRPS v2.0](https://www.chc.ucsb.edu/data/chirps) | Gauge-corrected satellite rainfall | 1981–present | 0.05° | Available | Public domain |
| ESA Fire_cci | Burned area, an independent check on the record | 2001–present | 250 m | Available | ESA CCI terms |
| [ASMC](https://asmc.asean.org/asmc-hotspot/) | Daily ASEAN hotspot coordinates | Daily | ~1 km | Available | Free, cite ASMC |

### What the status means

- **In use** — the dataset drives a chart or the forecast on this site.
- **Pulled** — the file is on disk but nothing reads it yet.
- **Available** — the download route was tested, but nothing has been collected.

Nothing in the catalogue changes the forecast on its own. A dataset entering the model is a separate step.

---

## Climate data

### The pull

Monthly weather for every fire region, so the model can see how dry a season actually was. Collected from the NASA POWER API, which needs no key and no registration.

| Points sampled | History | Variables | Pull time |
|---|---|---|---|
| **52** across the 10 regions | **551** months per point, 1981 to Sep 2026 | **6**: rain, temp, max temp, humidity, wind, soil | **6.3 s**, 28 requests in parallel |

### Does rainfall predict fire?

Share of the month-to-month variation in fire activity explained by the previous three months of rainfall, 2003–2025, against what the calendar month alone explains.

| Region | Rain explains | Calendar month alone | Rain adds |
|---|---|---|---|
| Peninsular Malaysia | 25.2% | 3.9% | Yes, strongly |
| Sumatra | 19.9% | 24.1% | Yes, as much as the season |
| Sabah | 19.9% | 21.1% | Yes, marginal |
| Kalimantan | 8.0% | 25.9% | Weak |
| Sarawak | 1.8% | 48.4% | No |

> **Sumatra, in plain numbers.** The driest tenth of three-month spells average **5,783** fire cell-days a month. The wettest tenth average **784**. A **7.4×** difference, measured on this project's own record.

### Caveats

- Sarawak is the exception: its fire follows the calendar, not how dry the preceding quarter was. Do not claim a rainfall effect there without showing it.
- POWER reports monthly rainfall as millimetres *per day*, not per month. January's 7.6 for Sumatra means about 236 mm for the month. Convert before use or everything is off by roughly 30×.

---

## What the data is worth

### How this was measured

Every dataset was tested the same way, and the test is deliberately unkind to the model. A forecast is issued at the end of May for June to November of the same year, using only what is knowable at that moment: January to May of the target year, carried forward. The model learns from earlier years only, and the year being predicted never appears in its training set.

| Issued | Learns from | Regions |
|---|---|---|
| **31 May**, forecasting Jun–Nov, the dry half | **2003–2024**, earlier years only, never the target | **10**, Malaysia and Indonesia, 2003–2025 |

Lower is better. The baseline is the seasonal pattern alone: the mean of the previous five years, same month, in log space.

### What each input bought

All ten regions together, weighted by how much fire each one actually carries.

| Inputs given to the model | Typical error | Change |
|---|---|---|
| Seasonal pattern only (the baseline) | 50.2% | — |
| + El Niño alone | **40.2%** | −10.0 pts |
| All four together | **39.8%** | −10.4 pts |
| + El Niño and rainfall | 41.6% | −8.6 pts |
| + El Niño and drought code | 42.5% | −7.7 pts |
| + Indian Ocean Dipole alone | 46.9% | −3.3 pts |
| + rainfall alone | 49.1% | −1.1 pts |
| + drought code alone | 53.5% | +3.3 pts, worse |

> **One or two inputs, not four.** Across all ten regions, stacking every dataset reaches 39.8% against El Niño's 40.2%: a tie inside the noise. Region by region the stack usually loses — Sumatra goes from 60.4% on El Niño alone to 76.1% with everything. With about ten usable training years, each extra input costs more in noise than it returns, so the site keeps the smallest set that wins.

### Best input for each region

The same test, run region by region. The winning input is not the same everywhere, which is why the model chooses per region instead of globally.

| Region | Best input | Typical error | Baseline | Gain |
|---|---|---|---|---|
| Java | El Niño + drought code | **39.2%** | 63.7% | −24.5 pts |
| Sulawesi | El Niño + rainfall | **42.6%** | 60.7% | −18.1 pts |
| Sarawak | Drought code | **34.8%** | 46.2% | −11.4 pts |
| Nusa Tenggara | El Niño | **35.6%** | 42.9% | −7.3 pts |
| Kalimantan | El Niño + drought code | **48.1%** | 55.1% | −7.0 pts |
| Sabah | Drought code | **36.0%** | 42.8% | −6.8 pts |
| Maluku | El Niño | **50.2%** | 54.5% | −4.3 pts |
| Sumatra | El Niño | **60.4%** | 63.0% | −2.6 pts |
| Papua | Rainfall | **57.0%** | 58.4% | −1.4 pts |
| Peninsular Malaysia | El Niño | 31.6% | 31.7% | −0.1 pts, no gain |

> **Sarawak was not undriven, it was mis-driven.** The old model rejected El Niño there and fell back to the calendar alone. Drought code cuts Sarawak's error by 11 points and Sabah's by 7. Both regions always had a driver; the site was looking at the wrong one.

### Read this before quoting any of it

- **The old 38.2% headline is gone.** It counted all twelve months and used the year's actual El Niño value, which is not known when the forecast is made. This section measures the dry half only, with no foreknowledge. The site's own backtest — the one that picks a model per region — now reports **42.0%** for all regions together.
- **Choosing the winning input per region is mild hindsight.** The pick is made after seeing the backtest, which flatters the result. The old `use_enso` flag worked the same way. It is disclosed here rather than hidden.
- **Forecasts work at two scales.** Malaysia and Indonesia have a regional forecast map. The World page gives every country a cell-level model estimate from the global 1° grid: the number of cells with at least a 50% chance of fire, the peak cell chance, and expected fire cell-days. The observed history below it is the satellite record. City searches use the country estimate because the data do not support city forecasts.

---

## Limits

What the record cannot tell you, in one place.

### Harmonization

- **Harmonized as cell-days, not hotspots.** MODIS and VIIRS are put on one scale at the level of monthly fire cell-days (0.05° cells, one count per cell per day), not individual detections. Fire intensity (FRP) is not harmonized.
- **One fit per region, all year.** The MODIS → VIIRS calibration is one model per region, fitted on the overlap period (Feb 2012–2025). It does not vary by season or land cover.
- **A region-month is uncertain.** Leave-one-year-out error is a median of 18.4% per region-month, from 10.5% (Kalimantan) to 29.8% (Java). It is a median, so individual months can be worse. Regions with few fires have less reliable calibration.
- **Before Feb 2012 is modelled, not observed.** Those months are MODIS counts converted to the VIIRS scale, so they carry the calibration error above. A converted value is an estimate, not a measurement.
- **The calibration is tied to one satellite.** The coefficients apply to VIIRS S-NPP. They do not transfer to a different VIIRS satellite or to the world record's NOAA-20 counts.
- **Ageing satellites.** Terra and Aqua are near the end of their lives and their orbits are drifting, which may lower recent MODIS detections and affect the fitted ratio.
- **S-NPP has ended.** VIIRS S-NPP data delivery ended in November 2026. Future updates need a re-calibration against VIIRS NOAA-20/NOAA-21.

### Data

- **Cell-days count hot pixels, not area or smoke.** Active-fire hotspots show where and when burning was detected. A fire cell-day says a 0.05° cell had at least one detection that day. It is not burned hectares, smoke or air quality at any location.
- **Satellites miss fires.** Fires under thick cloud or smoke, small or short-lived fires, and fires between overpasses are not seen. The record counts what was seen, not everything that burned.
- **Filtered detections.** Low-confidence detections and non-vegetation heat sources (FIRMS type ≠ 0: volcanoes, gas flares, offshore) are removed.
- **The record starts in 2003,** the first full year with both Terra and Aqua.

### Forecast

- **A statistical outlook, not a warning.** The outlook is a statistical model (seasonal pattern + El Niño index, with drought code in some regions). It is not a physical fire or weather model, and it is not an official alert.
- **The 80% range is optimistic.** Backtest error is about ±42% per month (2013–2025), and on held-out Jun–Nov months the 80% range contained the outcome 68% of the time. The range is more meaningful than the single number.
- **Accuracy is slightly flattered.** The model input for each region was chosen after seeing the backtest, which makes the reported accuracy slightly optimistic.
- **What the model cannot see.** It does not use rainfall forecasts, wind, fire policy or land-use change.
- **Coarser outside Malaysia and Indonesia.** Country-level estimates elsewhere use a 1° grid and are less reliable than the ten-region forecast.

### Guidance

- **Not medical advice.** The haze preparedness advice is general information. Follow official air-quality agencies for current conditions.

The world record reports country totals by sensor. The World page also shows historical fire activity on a separate 1° global grid; read those figures together with the [World fire record](#world-fire-record) notes.

---

## World fire record

Per-country monthly fire history for 233 countries, 2003 onwards. It exists so the site can answer questions about anywhere on Earth, not only Malaysia and Indonesia. It is a *record*, not a forecast.

### Where it comes from

| Source | Sensor | Years | Size |
|---|---|---|---|
| NASA FIRMS, all-countries yearly archives | MODIS C6.1 (Terra + Aqua) | 2003–2025 | 23 archives |
| NASA FIRMS, all-countries yearly archives | VIIRS JPSS-1 / NOAA-20, 375 m | 2018–2025 | 8 archives |
| Supplied as `Dataset (World).zip`: nested zips, 6,474 country-year CSVs | | | 4.6 GB zipped, 20.9 GB raw |

### How it was built

The archive is never extracted. `world_build.py` opens each yearly zip from memory, streams every country CSV through a chunked reader, aggregates, and discards the rows. Peak memory stays in the hundreds of megabytes and the only thing written to disk is one small CSV — which matters, because 20.9 GB of raw CSVs does not fit on the build machine.

The filters are deliberately identical to `Clean.py`, so a number here means the same thing as a number in the regional record:

- vegetation fires only — FIRMS `type 0`, dropping volcanoes, gas flares and offshore
- MODIS confidence 30 or above; VIIRS low-confidence detections dropped
- rows missing a position or a timestamp dropped
- dates are local, approximated from longitude (offset = `round(lon / 15)`)

### The two numbers

61,111 rows · 233 countries · 224,951,233 detections kept · built in 21 minutes

| Column | Means |
|---|---|
| `hotspots` | Raw detections, i.e. satellite pixels. Rises when a sensor sees the same fire with more, smaller pixels. |
| `fire_cell_days` | A 0.05° cell that burned on a given day, counted once. The comparable measure, and the one the site uses. |
| `frp_sum` | Total fire radiative power in megawatts, a rough proxy for intensity. |

### What it does not do

**Counts are per sensor and are not calibrated onto a common scale.** This is the important caveat. The regional record rescales MODIS onto VIIRS **S-NPP** using a fit validated over the 2012–2025 overlap. The world archive carries VIIRS **JPSS-1 (NOAA-20)** instead — a different satellite, with only a 2018–2025 overlap — so those coefficients do not transfer. Compare one country with another *within the same sensor*; never add MODIS and VIIRS together.

- **Country-level outlooks.** The World page uses flame pins for every country's model estimate: larger flames mean more grid cells with at least a 50% chance of fire. Malaysia and Indonesia also have the finer regional forecast.
- **No sub-national detail.** Country totals only — there are no province boundaries in this layer.
- **MODIS before 2018 is alone.** Any apparent jump at 2018 is VIIRS arriving, not fire increasing.
- **Country is taken from the filename** as NASA packaged it, not from a boundary test.

### API

| Endpoint | Returns |
|---|---|
| `GET /api/world/fires` | Coverage, row count and the caveats above |
| `GET /api/world/fires/countries` | Every country with its all-time total, busiest first |
| `GET /api/world/fires/country/{name}?sensor=` | One country month by month, with its typical season, peak month and annual totals |
| `GET /api/world/fires/ranking?year=&month=&sensor=&limit=` | The countries that burned most in a year, or in one month of it |

Separate from `/api/world`, which serves GFWED fire *weather* on a 1° grid. That answers "how dangerous are conditions"; this answers "where and when does this country actually burn".

### In the app

Any of the 233 countries can be searched and added to the place watchlist, next to the Malaysian and Indonesian areas. World rows are labelled **History only** and are deliberately drawn differently:

- their numbers stay neutral grey — the red/amber risk bands mean *forecast* risk, which these do not have
- the columns show the latest year's fire cell-days and the peak month, not cells at ≥50% and a maximum chance
- the fire outlook dial and the share bar hide themselves, because both describe a forecast
- the detail panel states that the counts are on a different scale from the regional figures

Ziro reads the same record through `get_world_country`, `get_world_ranking` and `get_world_outlook`, so it can answer about any country — and is told to say plainly that it has history and seasonal estimates there, but no forecast.

### Flags

Every country that names a place in the interface carries its national flag — watchlist rows, search results, the detail header and the overview list. `flags_build.py` resolves each FIRMS country name to an ISO 3166-1 alpha-2 code and saves that flag as SVG under `Frontend/assets/flags/`, with `index.json` as the name → code map the browser reads.

They are stored in the project rather than linked from a CDN, so the site works offline, nothing is requested from a third party while someone is using it, and a flag cannot vanish because another service changed.

| Step | Result |
|---|---|
| Names matched automatically | 218 of 233 |
| Hand-checked overrides | 15 — `Cote d Ivoire`, `Dem Rep Korea`, `Lao PDR`, `Swaziland`, `Macedonia Former Yugoslav Republic of` and others FIRMS spells its own way |
| Flags stored | 233 SVG files, 3.4 MB |

**One trap worth recording.** The matcher ignores words like "democratic" and "republic" to absorb spelling differences — which collapses *Democratic Republic of the Congo* and *Republic of Congo* onto the same name, handing DR Congo the wrong flag. It is the country with the most fire on Earth, so the error sat at the top of the ranking. Both are now pinned explicitly (`cd` and `cg`), and the script warns if any two countries ever resolve to one code again.

---

## Files

What is on disk, and what each file is for.

| File | Rows | Contents |
|---|---|---|
| `data/power_regions_monthly.csv` | 5,510 | 10 regions × 551 months, climate variables averaged over each region |
| `data/power_points_monthly.csv` | 28,652 | 52 points × 551 months, for the map layer |
| `Clean_dataset/harmonized_monthly.csv` | 2,760 | 10 regions × 276 months of harmonized fire cell-days |
| `Clean_dataset/calibration.csv` | 10 | MODIS to VIIRS fit per region, with held-out scores |
| `*.csv` (repo root) | ~6.8 M | Raw NASA FIRMS downloads, six files |
| `data/gfwed_regions_monthly.csv` | 2,800 | 10 regions × 280 months of fire weather: FWI, drought code, DMC, BUI, ISI, FFMC, DSR |
| `data/dmi_monthly.csv` | 541 | Monthly Indian Ocean Dipole index, 1981 to Sep 2026 |
| `backend/.cache/oni.txt` | ~900 | Cached NOAA ONI table |
| `Clean_dataset/world_monthly.csv` | 61,111 | 233 countries × month × sensor: hotspots, fire cell-days and FRP, from 225 M detections. See [World fire record](#world-fire-record). |
| `Frontend/assets/flags/*.svg` | 233 | National flag per country, 3.4 MB, served locally. `index.json` maps FIRMS country name → ISO code. |

The two climate files are not read by the API. They exist as data, ready to be joined.

---

## Reproduce

1. **Rebuild the fire record.**
   `python Clean.py --modis "modis_2000-2025_*.csv" --viirs "viirs-snpp_2012-2025_*.csv" --out Clean_dataset\clean_hotspots.csv`
2. **Recalibrate MODIS to VIIRS.**
   `python calibration.py --inp clean_hotspots.csv`
3. **Pull the climate data.**
   `python pull_power.py` — 28 parallel requests, no key, about six seconds.
4. **Re-run the rainfall check.**
   `python check_power_vs_fire.py` — reproduces the numbers in [Climate data](#climate-data).
5. **Pull the fire weather.**
   `python pull_gfwed.py` — 288 monthly files, ten at a time, about ten minutes. Resumable: re-run it and it continues where it stopped.
6. **Re-run the accuracy test.**
   `python eval_predictors.py` — reproduces every number in [What the data is worth](#what-the-data-is-worth).
7. **Build the world record.**
   `python world_build.py --zip "Dataset (World).zip"` — streams 6,474 country CSVs out of the nested archives without unpacking them, about 21 minutes for 225 million detections. Add `--years 2024,2025` to test on a slice first.
8. **Fetch the flags.**
   `python flags_build.py` — resolves every country in the world record to an ISO code and saves its flag under `Frontend/assets/flags`. A few seconds; re-run with `--force` to refresh them.

All scripts sit in the project root and use the backend virtual environment.

---

## References

### NASA data

- [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) – MODIS Collection 6.1 Active Fire product (MCD14ML), Terra and Aqua, 1 km.
- [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) – VIIRS S-NPP 375 m Active Fire product (VNP14IMGT).
- [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) – VIIRS NOAA-20 375 m Active Fire product (VJ114IMGT), used in the world fire record.
- [NASA GISS – Global Fire Weather Database (GFWED)](https://data.giss.nasa.gov/impacts/gfwed/): fire weather index and drought code.
- [NASA POWER](https://power.larc.nasa.gov/) – monthly meteorological data, used in the rainfall and predictor tests.
- [NASA GIBS](https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api) – Blue Marble imagery.

### Other data

- [NOAA Climate Prediction Center](https://www.cpc.ncep.noaa.gov/) – Oceanic Niño Index (ONI).
- [NOAA / BoM](https://stateoftheocean.osmc.noaa.gov/sur/ind/dmi.php) – Indian Ocean Dipole Mode Index (DMI), used in the predictor tests.
- [Natural Earth](https://www.naturalearthdata.com/) – country and state boundaries.
- [GeoNames](https://www.geonames.org/) – city names and positions for the place search (CC BY 4.0).
- [Flagpedia (flagcdn.com)](https://flagpedia.net/) – national flag images.
- News headlines – [Google News](https://news.google.com/) RSS search feed, plus links to [ASMC](https://asmc.asean.org/) and the Indonesia Ministry of Forestry.

### Map imagery

- Esri World Imagery, World Light Gray Canvas and World Boundaries and Places (Esri, Maxar, Earthstar Geographics).
- © OpenStreetMap contributors.
- AWS Terrain Tiles (Mapzen Terrarium).

### Software

- **Back end and data:** Python, FastAPI, Uvicorn, pandas, NumPy, PyArrow, Pydantic, LangChain.
- **Front end:** [Leaflet](https://leafletjs.com/) 1.9.4, [MapLibre GL JS](https://maplibre.org/) 5.24.1, [Chart.js](https://www.chartjs.org/) 4.4.1.
- **Fonts:** DM Sans, Instrument Sans and IBM Plex Mono, from Google Fonts. Icons and the Ziro mascot are hand-written SVG in this project.

### Acknowledgement

We acknowledge the use of data from NASA's Fire Information for Resource Management System (FIRMS), part of NASA's Earth Science Data and Information System (ESDIS).

---

## Use of artificial intelligence

- **Development.** Claude (Anthropic) was used to help write and debug data-cleaning, gridding and calibration scripts, to review the website, and to draft documentation text.
- **Ziro, the in-app assistant,** is a LangChain tool-calling agent running on Ollama Cloud (GLM model). It answers by calling tools that read the site's own data — the fire record, calibration, forecasts and world record — rather than from general knowledge, and it is told to keep model estimates separate from confirmed detections.
- **Human review.** All AI-assisted code and text were reviewed and tested by the team. The data, calibration results and validation numbers come from our own runs on NASA FIRMS data.

---

## Future work

- Re-calibrate against VIIRS NOAA-20/NOAA-21 so the calendar keeps updating after S-NPP.
- Season-specific calibration, and harmonization of fire intensity (FRP).
- User-drawn areas of interest, and peat-fire persistence indicators for haze risk.
