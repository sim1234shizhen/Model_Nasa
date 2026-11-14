"""Central configuration: where the data lives and which datasets exist."""
from pathlib import Path
import os

# d:\Nasa_Hackhadon\backend\app\config.py -> d:\Nasa_Hackhadon
PROJECT_ROOT = Path(__file__).resolve().parents[2]

# Raw FIRMS CSVs: Model_Nasa\ locally; in a fresh git clone they sit in the repo root.
# Override with env var DATA_DIR if the CSVs move.
_default_data = PROJECT_ROOT / "Model_Nasa"
if not _default_data.exists():
    _default_data = PROJECT_ROOT
DATA_DIR = Path(os.getenv("DATA_DIR", _default_data))

# Parquet cache makes the big Indonesia CSVs load in seconds after the first time.
CACHE_DIR = Path(os.getenv("CACHE_DIR", Path(__file__).resolve().parents[1] / ".cache"))

# Outputs of Clean.py / calibration.py (override with env var CLEAN_DIR)
CLEAN_DIR = Path(os.getenv("CLEAN_DIR", PROJECT_ROOT / "Clean_dataset"))
CLEAN_CSV = CLEAN_DIR / "clean_hotspots.csv"
HARMONIZED_CSV = CLEAN_DIR / "harmonized_monthly.csv"
CALIBRATION_CSV = CLEAN_DIR / "calibration.csv"

# The website (served by FastAPI at "/")
FRONTEND_DIR = Path(os.getenv("FRONTEND_DIR", PROJECT_ROOT / "Frontend"))

# Region boxes (same as Clean.py) -> used by the map to zoom to an area.
# (lon_min, lat_min, lon_max, lat_max)
REGIONS = {
    "Peninsular Malaysia": {"country": "Malaysia", "bbox": (99.5, 1.2, 105.0, 6.8)},
    "Sarawak":             {"country": "Malaysia", "bbox": (109.5, 0.8, 115.8, 5.1)},
    "Sabah":               {"country": "Malaysia", "bbox": (115.0, 4.0, 119.5, 7.5)},
    "Sumatra":             {"country": "Indonesia", "bbox": (95.0, -6.0, 106.2, 6.0)},
    "Kalimantan":          {"country": "Indonesia", "bbox": (108.8, -4.3, 119.0, 4.5)},
}

# Frontend origins allowed to call the API (comma separated). "*" = allow all (dev).
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",")]

# Hard cap on rows returned by a single /fires request.
MAX_LIMIT = 50_000

# dataset_id -> metadata. Add new files here.
DATASETS: dict[str, dict] = {
    "viirs-snpp-malaysia": {
        "file": "viirs-snpp_2012-2025_Malaysia.csv",
        "country": "Malaysia", "source": "VIIRS S-NPP", "years": "2012-2025",
    },
    "viirs-jpss1-malaysia": {
        "file": "viirs-jpss1_2018-2025_Malaysia.csv",
        "country": "Malaysia", "source": "VIIRS NOAA-20 (JPSS-1)", "years": "2018-2025",
    },
    "modis-malaysia": {
        "file": "modis_2000-2025_Malaysia.csv",
        "country": "Malaysia", "source": "MODIS", "years": "2000-2025",
    },
    "viirs-snpp-indonesia": {
        "file": "viirs-snpp_2012-2025_Indonesia.csv",
        "country": "Indonesia", "source": "VIIRS S-NPP", "years": "2012-2025",
    },
    "viirs-jpss1-indonesia": {
        "file": "viirs-jpss1_2018-2025_Indonesia.csv",
        "country": "Indonesia", "source": "VIIRS NOAA-20 (JPSS-1)", "years": "2018-2025",
    },
    "modis-indonesia": {
        "file": "modis_2000-2025_Indonesia.csv",
        "country": "Indonesia", "source": "MODIS", "years": "2000-2025",
    },
}
