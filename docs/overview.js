import { regionBounds } from "./satellite-map.js";

const el = (id) => document.getElementById(id);
const number = new Intl.NumberFormat("en");
const dateLabel = ({ year, month }) => new Intl.DateTimeFormat("en", {
  month: "long", year: "numeric", timeZone: "UTC",
}).format(Date.UTC(year, month - 1, 1));
const storageKey = "fire-calendar:watchlist";
const threshold = 50;
const news = [
  {
    source: "Indonesia Ministry of Forestry", date: "14 Nov 2026", indonesia: true,
    title: "Indonesia reports fewer hotspots and ongoing peat-fire response",
    href: "https://www.kehutanan.go.id/pers/hotspot-nasional-turun-jadi-25-titik-negara-beri-penghormatan-bagi-pahlawan-karhutla",
  },
  {
    source: "ASMC", date: "12 Nov 2026",
    title: "Southern ASEAN moved to haze alert level 0",
    href: "https://asmc.asean.org/alert20261112-downgrade-to-alert-level-0-for-southern-asean-region",
  },
  {
    source: "ASMC", date: "11 Nov 2026",
    title: "October haze review covers Sumatra, Kalimantan, and Malaysia",
    href: "https://asmc.asean.org/review-of-regional-haze-situation-for-october-2026",
  },
];

let settings, forecastGrid, watchPeriod, watchRequest = 0, homeRequest = 0, initialized;
let catalog = new Map();
let saved = null;
let selected = "";
let selectedCity = null;
let searchAddsPlace = false;
let focusScope = "All";
let cities = [];
let citiesRequest = null;
let citiesLoading = false;
let countryFocus = new Map();
let countryAliasHay = new Map();
let countryFocusRequest = null;
let layer = "observed";
let forecastMonth;
const forecasts = new Map();

function forecastFor(getJSON, scope, { year, enso }) {
  const query = new URLSearchParams({ scope, year, enso }).toString();
  if (!forecasts.has(query)) {
    const result = getJSON("/forecast/map?" + query).catch((error) => {
      forecasts.delete(query);
      throw error;
    });
    forecasts.set(query, result);
  }
  return forecasts.get(query);
}

export function renderOverview({ observed, outlook, getJSON, scope, regions, openExplorer }) {
  setRegions(regions);
  const request = ++homeRequest;
  el("overview-detected-date").textContent = dateLabel(observed);
  el("overview-watch-date").textContent = dateLabel(outlook);
  el("overview-chip-obs").textContent = dateLabel(observed);
  el("overview-chip-fc").textContent = dateLabel(outlook);
  for (const id of ["detected", "repeat", "area-count", "watch-count"]) {
    const node = el("overview-" + id);
    delete node.dataset.count;  // cancel any count-up still running from the last render
    node.textContent = "–";
  }
  const observedStatus = el("overview-observed-status"), forecastStatus = el("overview-watch-status");
  const openMap = el("overview-open-map");
  openMap.disabled = true;
  observedStatus.textContent = "Loading satellite detections…";
  forecastStatus.textContent = "Loading the fire forecast…";
  el("overview-severity").hidden = true;
  el("overview-top-places").replaceChildren();
  const { year, month } = observed;
  getJSON("/hotspots/grid?" + new URLSearchParams({ scope, year, month, cell: "0.25" })).then((grid) => {
    if (request !== homeRequest) return;
    countUp(el("overview-detected"), grid.cells.length);
    countUp(el("overview-repeat"), grid.cells.filter(({ cell_days }) => cell_days >= 8).length);
    observedStatus.textContent = `${number.format(grid.hotspots)} ${grid.sensor} detections in ${number.format(grid.cells.length)} grid cells. Each cell is grouped by how many days it burned that month.`;
    renderSeverity(grid.cells);
    openMap.disabled = false;
    openMap.onclick = () => openExplorer(year, month);
  }).catch(() => {
    if (request === homeRequest) observedStatus.textContent = "Satellite detections are unavailable for this month.";
  });
  forecastFor(getJSON, scope, outlook).then((grid) => {
    if (request !== homeRequest) return;
    const places = [...catalogFor(grid, outlook.month).values()].filter((place) => place.high > 0).sort(byRisk);
    countUp(el("overview-area-count"), places.length);
    countUp(el("overview-watch-count"), places.reduce((sum, place) => sum + place.high, 0));
    forecastStatus.textContent = places.length
      ? `Top areas for ${dateLabel(outlook)}, by the number of grid cells with at least a 50% chance of a fire day.`
      : "No grid cells reach a 50% chance of a fire day for this area and month.";
    const top = places.slice(0, 5);
    const peak = Math.max(1, ...top.map((place) => place.high));
    el("overview-top-places").innerHTML = top.map((place, i) => {
      const cells = number.format(place.high) + (place.high === 1 ? " cell" : " cells");
      return `<li style="--i:${i}">
        <a href="#/explorer" data-nav="explorer" title="${escapeHTML(place.name)}: ${cells} at 50% or higher${place.max ? `, peak cell ${place.max}%` : ""}">
          <span class="ov-rank-n">${i + 1}</span>
          <span class="ov-rank-name"><b>${flagChip(countryOfRegion(place.region))?.outerHTML || ""}${escapeHTML(place.name)}</b><small>${escapeHTML(place.region || "")}</small></span>
          <span class="ov-rank-val">${cells}</span>
          <span class="ov-rank-track" aria-hidden="true"><i style="width:${(place.high / peak * 100).toFixed(1)}%"></i></span>
        </a></li>`;
    }).join("");
  }).catch(() => {
    if (request === homeRequest) forecastStatus.textContent = "The fire forecast is unavailable for this month.";
  });

  renderWorldRank(getJSON, observed.year, request);
}

/* The countries that burned most, straight from the world record. This is the
   one panel on the overview that is not about Malaysia and Indonesia, so the
   site shows its global reach rather than only claiming it. */
function renderWorldRank(getJSON, year, request) {
  const status = el("overview-world-status");
  const list = el("overview-world-rank");
  if (!status || !list) return;
  list.replaceChildren();
  status.textContent = "Loading the world record…";

  const ask = (y) => getJSON(`/world/fires/ranking?year=${y}&limit=6`);
  // the newest year can be partial, so fall back to the one before it
  ask(year)
    .then((data) => (data.countries?.length ? data : ask(year - 1)))
    .then((data) => {
      if (request !== homeRequest) return;
      const rows = data.countries || [];
      if (!rows.length) { status.textContent = "The world record is unavailable."; return; }
      const peak = rows[0].fire_cell_days || 1;
      status.textContent = `Countries with the most fire in ${data.year}, by cell-days observed by VIIRS.`;
      list.innerHTML = rows.map((row) => {
        const chip = flagChip(row.country);
        return `<li><a href="#/docs?section=world">
          <span class="ov-rank-n">${row.rank}</span>
          <span class="ov-rank-name"><b>${chip ? chip.outerHTML : ""}${escapeHTML(row.country)}</b></span>
          <span class="ov-rank-val">${number.format(row.fire_cell_days)}</span>
          <span class="ov-rank-track" aria-hidden="true"><i style="width:${(row.fire_cell_days / peak * 100).toFixed(1)}%"></i></span>
        </a></li>`;
      }).join("");
    })
    .catch(() => {
      if (request === homeRequest) status.textContent = "The world record is unavailable.";
    });
}

const escapeHTML = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Numbers tick up to their value once, so the tiles feel alive on arrival.
function countUp(node, value) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const token = (node.dataset.count = String(Math.random()));
  const final = () => { if (node.dataset.count === token) node.textContent = number.format(value); };
  if (reduce || value < 10 || document.hidden) { final(); return; }
  const start = performance.now(), ms = 700;
  node.textContent = "0";
  const step = (now) => {
    if (node.dataset.count !== token) return;
    const t = Math.min(1, (now - start) / ms);
    node.textContent = number.format(Math.round(value * (1 - Math.pow(1 - t, 3))));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  // Browsers pause animation frames in background tabs and some previews;
  // make sure the real number always lands, animated or not.
  setTimeout(final, ms + 150);
}

// Same three bands as the Explorer legend: light 1–2 days, moderate 3–7, heavy 8+.
const SEVERITY = [
  { key: "lv0", label: "Light", days: "1–2 days", test: (d) => d < 3 },
  { key: "lv1", label: "Moderate", days: "3–7 days", test: (d) => d >= 3 && d < 8 },
  { key: "lv2", label: "Heavy", days: "8+ days", test: (d) => d >= 8 },
];
const pct = (n, total) => (n && n / total < .005 ? "<1%" : Math.round(n / total * 100) + "%");
function renderSeverity(cells) {
  const total = cells.length;
  const box = el("overview-severity");
  if (!total) { box.hidden = true; return; }
  const counts = SEVERITY.map((band) => ({ ...band, n: cells.filter(({ cell_days }) => band.test(cell_days)).length }));
  el("overview-sev-bar").innerHTML = counts.filter((b) => b.n).map((b) =>
    `<span class="${b.key}" style="flex-grow:${b.n}" title="${b.label} (${b.days}): ${number.format(b.n)} cells, ${pct(b.n, total)}"></span>`).join("");
  el("overview-sev-legend").innerHTML = counts.map((b) =>
    `<li><i class="${b.key}" aria-hidden="true"></i><span>${b.label} <small>${b.days}</small></span><b>${number.format(b.n)}</b><small class="ov-pct">${pct(b.n, total)}</small></li>`).join("");
  box.hidden = false;
}

export function renderExplorerWatchlist(options) {
  settings = options;
  setRegions(options.regions);
  loadWorldCountries(options.getJSON).then(() => {
    const pending = (saved || []).filter((n) => worldCountries.has(n) && !worldDetail.has(n));
    if (pending.length) {
      Promise.all(pending.map(worldHistory)).then(() => { if (forecastGrid) renderList(); });
    }
    prefetchWorldForecasts();
  });
  if (!initialized) init();
  const { outlook, getJSON } = settings;
  const period = [outlook.year, outlook.enso].join("/");
  if (period !== watchPeriod) {
    worldForecastSummary.clear();
    worldForecastGrid = null;
  }
  if (period === watchPeriod && forecastGrid) {
    if (forecastMonth !== outlook.month) {
      forecastMonth = outlook.month;
      catalog = catalogFor(forecastGrid, forecastMonth);
    }
    renderSelection();
    return;
  }
  const request = ++watchRequest;
  forecastMonth = outlook.month;
  forecastGrid = null;
  el("explorer-watch-status").textContent = "Loading forecast areas…";
  el("watch-add-toggle").disabled = true;
  el("explorer-watchlist").replaceChildren();
  renderDetails();
  updateMap();
  forecastFor(getJSON, "All", outlook).then((grid) => {
    if (request !== watchRequest) return;
    watchPeriod = period;
    forecastGrid = grid;
    catalog = catalogFor(grid, forecastMonth);
    if (saved === null) {
      const stored = readSaved();
      if (stored) saved = stored;
      else seedWatchlist();
    }
    el("explorer-watch-status").textContent = "";
    renderSelection();
    if (el("place-search-dialog").open) renderPlaceResults();
  }).catch(() => {
    if (request !== watchRequest) return;
    el("explorer-watch-status").textContent = "The forecast and place list are unavailable for this month.";
    if (!selectedCity && !isWorld(selected)) {
      el("watch-place-description").textContent = "The forecast is unavailable for this month.";
    }
  });
}

function init() {
  initialized = true;
  initPlaceSearch();
  loadCountryFocus();
  loadCities();
  initWatchlistDivider();
  // The timeline is the only era control now: app.js passes layer with each render.
  el("explorer-watchlist").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if ("place" in button.dataset) { selectPlace(button.dataset.place); return; }
    saved = saved.filter((name) => name !== button.dataset.removePlace);
    storeSaved();
    if (selected === button.dataset.removePlace) selectPlace("");
    else renderList();
    focusRow(selected);
  });
}

function initWatchlistDivider() {
  const divider = el("watchlist-divider");
  const panel = el("watchlist-title").closest(".watchlist-panel");
  const sidebar = divider.parentElement;
  const docked = matchMedia("(min-width: 821px)");
  let desiredHeight, drag;

  function sync() {
    if (!sidebar.clientHeight) return;
    const headerHeight = panel.querySelector(".watch-panel-head").offsetHeight
      + panel.querySelector(".watch-column-head").offsetHeight;
    const min = headerHeight + 44;
    const max = Math.max(min, docked.matches
      ? sidebar.clientHeight - divider.offsetHeight - 100
      : Math.round(window.innerHeight * 0.6));

    if (desiredHeight != null) {
      const height = Math.max(min, Math.min(desiredHeight, max));
      sidebar.style.setProperty("--watchlist-height", `${height}px`);
      sidebar.dataset.watchlistResized = "";
    }
    const height = panel.offsetHeight;
    divider.setAttribute("aria-valuemin", String(Math.min(min, height)));
    divider.setAttribute("aria-valuemax", String(Math.max(max, height)));
    divider.setAttribute("aria-valuenow", String(height));
  }

  divider.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || drag) return;
    drag = { pointerId: event.pointerId, startY: event.clientY, height: panel.offsetHeight };
    divider.focus({ preventScroll: true });
    divider.setPointerCapture(event.pointerId);
    sidebar.classList.add("is-resizing-watchlist");
    event.preventDefault();
  });
  divider.addEventListener("pointermove", (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    desiredHeight = drag.height + event.clientY - drag.startY;
    sync();
  });
  divider.addEventListener("lostpointercapture", () => {
    drag = null;
    sidebar.classList.remove("is-resizing-watchlist");
  });
  divider.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "ArrowUp": desiredHeight = panel.offsetHeight - 16; break;
      case "ArrowDown": desiredHeight = panel.offsetHeight + 16; break;
      case "Home": desiredHeight = 0; break;
      case "End": desiredHeight = Infinity; break;
      default: return;
    }
    event.preventDefault();
    sync();
  });

  const observer = new ResizeObserver(sync);
  observer.observe(sidebar);
  observer.observe(panel);
  window.addEventListener("resize", sync);
}

const searchText = (value) => value.toLowerCase().normalize("NFD")
  .replace(/\p{Diacritic}/gu, "").replace(/[^a-z0-9]+/g, " ").trim();

/* Country centres and zooms, from places_build.py. Small enough to load with
   the Explorer and used by both the search box and the map. */
function rebuildCountryAliasHay() {
  countryAliasHay = new Map();
  for (const [name, info] of countryFocus) {
    const text = searchText((info.aliases || []).join(" "));
    if (text) countryAliasHay.set(name, text);
  }
}

function loadCountryFocus() {
  if (countryFocusRequest) return countryFocusRequest;
  countryFocusRequest = fetch("assets/country-focus.json")
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (data) countryFocus = new Map(Object.entries(data));
      rebuildCountryAliasHay();
      if (isWorld(focusScope) || selectedCity) updateMap();
      if (el("place-search-dialog").open) renderPlaceResults();
      return countryFocus;
    })
    .catch(() => countryFocus);
  return countryFocusRequest;
}

/* Every city above 15,000 people. It is fetched in the background when the
   Explorer starts, so the first search already has the full index. */
function loadCities() {
  if (citiesRequest) return citiesRequest;
  citiesLoading = true;
  citiesRequest = fetch("assets/cities.json")
    .then((response) => (response.ok ? response.json() : []))
    .then((rows) => {
      cities = rows.map((row) => {
        const ascii = row.a || row.n;
        return {
          ...row,
          ascii,
          key: searchText(row.n),
          context: searchText(`${row.n} ${ascii} ${row.ad || ""} ${row.c || ""}`),
        };
      });
      return cities;
    })
    .catch(() => { cities = []; return cities; })
    .finally(() => {
      citiesLoading = false;
      if (el("place-search-dialog").open) renderPlaceResults();
    });
  return citiesRequest;
}

function renderPlaceResults() {
  const query = searchText(el("place-search-input").value);
  const countries = [...new Set(settings.regions.map(({ country }) => country))];
  const entries = [
    ...countries.map((name) => ({ name, scope: name, subtitle: "Country", country: name, kind: "country" })),
    ...settings.regions.map(({ region, country }) =>
      ({ name: region, scope: region, subtitle: country, country, kind: "region" })),
    ...(forecastGrid ? [...catalog.values()].map(({ name, region }) =>
      ({ name, place: name, scope: region, subtitle: region, country: countryOfRegion(region), kind: "area" })) : []),
    // every other country on Earth, from the world record
    ...[...worldCountries.keys()]
      .filter((name) => !countries.includes(name))
      .map((name) => {
        const aliases = countryFocus.get(name)?.aliases || [];
        return { name, place: name, scope: name, country: name,
          kind: "country", add: true, aliases, aliasKeys: aliases.map(searchText) };
      }),
  ];
  const available = searchAddsPlace
    ? entries.filter(({ place }) => place && !saved?.includes(place))
    : entries;
  const kindOrder = { country: 0, region: 1, area: 2, city: 3 };
  const matches = [];
  const consider = (entry) => {
    const name = searchText(entry.name);
    const aliases = entry.aliases || [];
    const context = searchText(`${entry.name} ${entry.subtitle || ""} ${entry.country || ""} ${aliases.join(" ")}`);
    if (!context.includes(query)) return;
    const exactAlias = (entry.aliasKeys || []).includes(query);
    entry.rank = name === query || exactAlias ? 0 : name.startsWith(query) ? 1 : 2;
    matches.push(entry);
  };
  available.forEach(consider);

  if (!searchAddsPlace && query && cities.length) {
    let prefixes = 0, broad = 0;
    for (const city of cities) {
      const haystack = city.context + " " + (countryAliasHay.get(city.c) || "");
      if (!haystack.includes(query)) continue;
      // A country, region or forecast area with the same prefix should come
      // first, so city prefixes start at 2 rather than 1.
      const rank = city.key === query ? 0 : city.key.startsWith(query) ? 2 : 3;
      // cities.json is population-ordered. Once these caps are reached, later
      // matches are smaller and cannot reach the first page of results.
      if (rank === 2 && ++prefixes > 300) continue;
      if (rank === 3 && ++broad > 200) continue;
      matches.push({
        name: city.n,
        scope: city.c,
        subtitle: `${city.ad ? city.ad + ", " : ""}${city.c} · city`,
        country: city.c,
        city,
        rank,
        pop: city.p,
        kind: "city",
      });
    }
  }

  matches.sort((a, b) => a.rank - b.rank
    || (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9)
    || (b.pop || 0) - (a.pop || 0)
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // Long queries can match thousands of cities; the first screenful is enough.
  const shown = matches.slice(0, query ? 50 : 300);
  el("place-search-results").replaceChildren(...shown.map(({ name, place, scope, subtitle, country, city, add }) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const label = document.createElement("strong");
    const region = document.createElement("span");
    button.type = "button";
    label.textContent = name;
    region.textContent = subtitle || "";
    const chip = flagChip(country);
    if (chip) button.append(chip);
    button.append(label, region);
    button.addEventListener("click", () => {
      el("place-search-dialog").close();
      if (searchAddsPlace) {
        if (saved.includes(place)) return;
        saved.push(place);
        storeSaved();
        selectPlace(place || "", scope);
        focusRow(place);
      } else if (city) {
        selectPlace(city.n, city.c, city);
      } else {
        selectPlace(place || "", scope);
      }
    });
    item.append(button);
    if (add) {
      const isSaved = saved?.includes(name);
      const addButton = document.createElement("button");
      item.className = "place-search-row";
      addButton.type = "button";
      addButton.className = "place-search-add";
      addButton.textContent = isSaved ? "✓" : "+";
      addButton.disabled = isSaved;
      addButton.setAttribute("aria-label", isSaved ? `${name} is in the watchlist` : `Add ${name} to the watchlist`);
      addButton.addEventListener("click", () => {
        if (saved === null) saved = readSaved() || [];
        if (saved.includes(name)) return;
        saved.push(name);
        storeSaved();
        renderList();
        addButton.textContent = "✓";
        addButton.disabled = true;
        addButton.setAttribute("aria-label", `${name} is in the watchlist`);
      });
      item.append(addButton);
    }
    return item;
  }));
  const empty = el("place-search-empty");
  empty.hidden = shown.length !== 0;
  empty.textContent = shown.length ? ""
    : searchAddsPlace ? "No matching places to add."
    : citiesLoading ? "Loading cities…"
    : "No matching places.";
}

function initPlaceSearch() {
  const trigger = el("place-search-open");
  const dialog = el("place-search-dialog");
  const input = el("place-search-input");
  const results = el("place-search-results");
  trigger.disabled = false;
  function openSearch(addToWatchlist) {
    searchAddsPlace = addToWatchlist;
    input.value = "";
    if (!addToWatchlist) loadCities();
    renderPlaceResults();
    results.scrollTop = 0;
    dialog.showModal();
  }
  trigger.addEventListener("click", () => openSearch(false));
  el("watch-add-toggle").addEventListener("click", () => openSearch(true));
  input.addEventListener("input", renderPlaceResults);
  el("place-search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    results.querySelector("button")?.click();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      dialog.close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const controls = [input, ...results.querySelectorAll("button")];
    const index = controls.indexOf(event.target);
    if (index < 0 || controls.length === 1) return;
    event.preventDefault();
    const offset = event.key === "ArrowDown" ? 1 : -1;
    controls[(index + offset + controls.length) % controls.length].focus();
  });
}

function renderSelection() {
  if (selected && !selectedCity && !isWorld(selected) && catalog.get(selected)?.region !== focusScope) {
    selected = "";
  }
  renderList();
  renderDetails();
  updateMap();
  prefetchWorldForecasts();
}

function scopedRegions(scope) {
  return settings.regions.filter((region) => scope === "All" || region.region === scope || region.country === scope);
}

function cityBounds(city, hasRegionalGrid) {
  const localPad = city.p >= 1_000_000 ? 0.15 : city.p >= 200_000 ? 0.22 : 0.32;
  const pad = hasRegionalGrid ? localPad : 1.6;
  return [city.lo - pad, city.la - pad, city.lo + pad, city.la + pad];
}

function updateMap() {
  const city = selectedCity;
  const mode = (settings.layer ?? layer) === "forecast" ? "forecast" : "observed";
  const panel = el("explorer-map-panel");
  panel.dataset.mapMode = mode;
  const place = !city && forecastGrid ? catalog.get(selected) : null;
  const regions = scopedRegions(focusScope);
  const target = city ? null : countryFocus.get(focusScope) || null;
  panel.dataset.mapScope = focusScope;
  const bounds = city
    ? cityBounds(city, regions.length > 0)
    : place?.cells.length
      ? [
          Math.min(...place.cells.map(([, lon]) => lon)), Math.min(...place.cells.map(([lat]) => lat)),
          Math.max(...place.cells.map(([, lon]) => lon)) + forecastGrid.cell_deg,
          Math.max(...place.cells.map(([lat]) => lat)) + forecastGrid.cell_deg,
        ]
      : regions.find((region) => region.region === place?.region)?.bbox || target?.bounds || null;
  const focus = {
    selection: JSON.stringify([focusScope, place?.name, city?.n, city?.la, city?.lo]),
    bounds: bounds || (target ? null : regionBounds(regions)),
    center: !bounds && target?.center ? target.center : null,
    zoom: !bounds && target?.zoom ? target.zoom : null,
    city: city ? { name: city.n, lon: city.lo, lat: city.la } : null,
  };
  const plan = mode === "forecast"
    ? {
        grid: isWorld(focusScope) ? worldForecastGrid : forecastGrid,
        month: forecastMonth || settings.outlook.month,
        year: settings.outlook.year,
        enso: settings.outlook.enso,
      }
    : null;
  settings.updateTerrain(focus, plan);
}

/* Which country the site opens on. The browser's own time zone separates
   Malaysia from Indonesia without asking for a location permission; anything
   else falls back to Malaysia. */
/* National flags, drawn inline so the panel needs no image requests and works
   offline. Emoji flags are not an option: Windows ships no flag glyphs and
   renders them as letter pairs. Each is cropped from its left edge inside the
   round badge, which keeps Malaysia's canton - the recognisable part - visible. */
/* National flags for all 233 countries in the fire record, downloaded into
   Frontend/assets/flags by flags_build.py and served from this project - so the
   site works offline and nothing is fetched from a third party at run time.
   index.json maps a FIRMS country name to its ISO 3166-1 alpha-2 code. */
const FLAG_DIR = "assets/flags";
let flagCode = new Map();

fetch(`${FLAG_DIR}/index.json`)
  .then((r) => (r.ok ? r.json() : null))
  .then((map) => {
    if (!map) return;
    flagCode = new Map(Object.entries(map));
    // anything already on screen was drawn before the map arrived
    document.querySelectorAll("[data-flag-country]").forEach((host) => {
      const markup = flagMarkup(host.dataset.flagCountry);
      if (markup) host.innerHTML = markup;
    });
  })
  .catch(() => { /* flags are decoration; the site works without them */ });

/* <img> markup for a country, or "" when we have no flag for it. */
function flagMarkup(country) {
  const code = flagCode.get(country);
  return code ? `<img src="${FLAG_DIR}/${code}.svg" alt="" loading="lazy" decoding="async">` : "";
}

/* Country names and observed history, loaded separately from the seasonal estimates. */
let worldCountries = new Map();     // name -> { country, fire_cell_days }
let worldDetail = new Map();        // name -> full history, fetched on demand
let worldLoaded = false;

function loadWorldCountries(getJSON) {
  if (worldLoaded) return Promise.resolve();
  worldLoaded = true;
  return getJSON("/world/fires/countries")
    .then((data) => {
      worldCountries = new Map((data.countries || []).map((row) => [row.country, row]));
      if (el("place-search-dialog").open) renderPlaceResults();
    })
    .catch(() => { worldCountries = new Map(); });
}

const isWorld = (name) => !catalog.has(name) && worldCountries.has(name)
  && !settings.regions.some((region) => region.region === name || region.country === name);

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/* /api/world/fires/country/<name>, reshaped into what the UI needs. */
function worldHistory(name) {
  if (worldDetail.has(name)) return Promise.resolve(worldDetail.get(name));
  return settings.getJSON(`/world/fires/country/${encodeURIComponent(name)}`)
    .then((data) => {
      const years = data.annual_totals || [];
      const info = {
        country: data.country,
        sensor: data.sensor,
        peakMonth: data.peak_month,
        peakMonthName: data.peak_month ? MONTH_NAMES[data.peak_month - 1] : "",
        years,
        latest: years.at(-1) || null,
        busiest: years.length ? years.reduce((a, b) => (b.fire_cell_days > a.fire_cell_days ? b : a)) : null,
        coverage: years.length ? `${years[0].year}–${years.at(-1).year}` : "",
      };
      worldDetail.set(name, info);
      return info;
    })
    .catch(() => null);
}

/* region -> country, kept module-level so both the home page and the explorer can
   look a flag up; only the explorer is handed the region list on every render. */
let regionCountry = new Map();
function setRegions(regions) {
  if (regions?.length) regionCountry = new Map(regions.map(({ region, country }) => [region, country]));
}
const countryOfRegion = (region) => regionCountry.get(region) || "";

/* A scope is either "All", a country name, or a region name. */
function countryOfScope(scope) {
  if (!scope || scope === "All") return "";
  for (const country of regionCountry.values()) if (country === scope) return scope;
  return countryOfRegion(scope);
}

/* A small round flag for any list that names a place. */
function flagChip(country) {
  if (!country) return null;
  const chip = document.createElement("i");
  chip.className = "flag-chip";
  chip.setAttribute("aria-hidden", "true");
  chip.dataset.flagCountry = country;        // so it can fill in once index.json lands
  chip.innerHTML = flagMarkup(country);
  return chip;
}

function badgeFor(name, region) {
  const country = countryOfRegion(region);
  return flagMarkup(country)
    || settings.escape(name.trim().charAt(0).toUpperCase());
}

/* First visit: watch the busiest places across every region, and open on all of
   them. The site covers two countries, so seeding only the visitor's own would
   hide most of the map. */
function seedWatchlist() {
  saved = [...catalog.values()].sort(byRisk).slice(0, 5).map((place) => place.name);
}

function readSaved() {
  try {
    const names = JSON.parse(localStorage.getItem(storageKey));
    return Array.isArray(names) ? [...new Set(names.filter((name) => typeof name === "string"))] : null;
  } catch {
    return null;
  }
}

function storeSaved() {
  try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch { /* Browser storage may be disabled. */ }
}

function catalogFor(grid, month) {
  const regions = new Map(grid.area_matrix.map(({ area, region }) => [area, region]));
  const places = grid.areas.map((name) => ({ name, region: regions.get(name), cells: [], high: 0, max: 0 }));
  for (const row of grid.months[month - 1].cells) {
    const chance = row[2], place = places[row[4]];
    place.cells.push(row);
    if (chance >= threshold) place.high++;
    place.max = Math.max(place.max, chance);
  }
  return new Map(places.map((place) => [place.name, place]));
}

const byRisk = (a, b) => b.high - a.high || b.max - a.max;

/* Entry point for the consultant: it resolves a place server-side and asks the
   page to move the map there. Kept on window because consultant.js is a plain
   script, not a module. Returns false if the explorer is not up yet. */
window.fireCalendarFocus = function focusFromAssistant({ name, kind, region } = {}) {
  if (!initialized || !name) return false;
  if (kind === "area" && catalog.has(name)) selectPlace(name);
  else if (kind === "country" && worldCountries.has(name)
    && !settings.regions.some((item) => item.country === name)) selectPlace(name, name);
  else selectPlace("", kind === "area" ? region : name);
  return true;
};

function selectPlace(name, scope = catalog.get(name)?.region || (worldCountries.has(name) ? name : "All"), city = null) {
  selectedCity = city;
  selected = name;
  focusScope = scope;
  if (forecastGrid) renderList();
  renderDetails();
  updateMap();
}

/* Badge and number colours, read like a price change: green calm, amber watch,
   red elevated. Banded on the count of cells at >=50%, relative to the busiest
   place on the list. NOT on "Max." - the probability curve saturates at 88%, so
   most places report the same maximum and it cannot separate them. */
function riskLevel(high, peak) {
  if (!high) return "low";
  const share = peak ? high / peak : 0;
  return share >= 0.6 ? "high" : share >= 0.25 ? "mid" : "low";
}

/* Fire outlook dial. The reading is the average chance of at least one fire day
   across the place's mapped cells — the figure that actually separates places,
   since the per-cell maximum saturates at the top of the probability curve.
   Mapped cells are those the forecast returns at 5% or above, so the average is
   over cells with some chance, not over every square of land. */
const GAUGE_BANDS = [
  { under: 20, band: "low", label: "Low" },
  { under: 40, band: "moderate", label: "Moderate" },
  { under: 60, band: "elevated", label: "Elevated" },
  { under: 80, band: "high", label: "High" },
  { under: Infinity, band: "severe", label: "Severe" },
];

function setGauge(chances) {
  const gauge = el("watch-gauge");
  if (!gauge) return;
  const n = chances.length;
  const mean = n ? chances.reduce((sum, value) => sum + value, 0) / n : 0;
  const band = GAUGE_BANDS.find((entry) => mean < entry.under);
  gauge.dataset.band = n ? band.band : "low";
  el("watch-gauge-needle").style.transform = `rotate(${Math.min(100, Math.max(0, mean)) * 1.8}deg)`;
  el("watch-gauge-verdict").textContent = n ? band.label : "–";
  el("watch-gauge-caption").textContent = n
    ? `${Math.round(mean)}% average chance of a fire day · ${number.format(n)} mapped cells`
    : "No mapped cells for this place.";
}

function focusRow(name) {
  [...el("explorer-watchlist").querySelectorAll("[data-place]")].find((button) => button.dataset.place === name)?.focus();
}

function renderList() {
  const prior = document.activeElement?.dataset.place;
  const entries = (saved || []).map((name) => catalog.get(name)
    || (worldCountries.has(name) ? { name, world: true } : null)).filter(Boolean);
  const peak = Math.max(0, ...entries.map((entry) => entry.high ?? 0));
  el("explorer-watchlist").innerHTML = entries.map(({ name, region, high, max, world }) => {
    if (world) {
      const info = worldDetail.get(name);
      const latest = info?.latest;
      const peakMonth = info?.peakMonthName;
      const label = settings.escape(name);
      const data = (() => {
        const entry = worldForecastSummary.get(name);
        return entry && entry.year === settings.outlook.year && entry.enso === settings.outlook.enso
          ? entry.data : null;
      })();
      const month = forecastMonth || settings.outlook.month;
      const area = data?.months?.[month - 1]?.top_areas?.[0];
      const value = area ? number.format(area.high_risk_cells)
        : latest ? number.format(latest.fire_cell_days) : "–";
      const extreme = area ? (area.max_chance_pct ? `${area.max_chance_pct}%` : "–")
        : peakMonth ? peakMonth.slice(0, 3) : "–";
      const note = area ? `Country model · ${area.high_risk_cells} cells at 50% or higher` : "Country record";
      return `<li><button type="button" data-place="${label}" data-level="world"
          aria-label="${label}, ${note}" aria-pressed="${selected === name && !selectedCity}">
        <span class="watch-sym"><i class="watch-badge" aria-hidden="true" data-flag-country="${label}">${flagMarkup(name)}</i>
          <span><strong>${label}</strong><small>${note}</small></span></span>
        <span class="watch-num">${value}</span>
        <span class="watch-max">${extreme}</span>
        </button><button type="button" class="watch-remove" data-remove-place="${label}" aria-label="Remove ${label}">×</button></li>`;
    }
    const label = settings.escape(name);
    const summary = `${label}, ${number.format(high)} cells at 50% or higher${max ? ", maximum " + max + "%" : ""}`;
    const badge = badgeFor(name, region);
    return `<li><button type="button" data-place="${label}" data-level="${riskLevel(high, peak)}" aria-label="${summary}" aria-pressed="${selected === name && !selectedCity}">
      <span class="watch-sym"><i class="watch-badge" aria-hidden="true">${badge}</i>
        <span><strong>${label}</strong><small>${settings.escape(region || "")}</small></span></span>
      <span class="watch-num">${number.format(high)}</span><span class="watch-max">${max ? max + "%" : "–"}</span>
      </button><button type="button" class="watch-remove" data-remove-place="${label}" aria-label="Remove ${label}">×</button></li>`;
  }).join("");
  el("explorer-watch-status").textContent = entries.length
    ? "" : "No places saved yet — add one to start watching it.";
  if (prior !== undefined) focusRow(prior);
  el("watch-add-toggle").disabled = false;
}

/* ---------- key facts ----------
   Three bullets built from the region's own record and the current model
   output: the size of the month against its own history, where that sits in
   the ranking, and the odds. Every number comes from the API; nothing is
   written by hand. */
const factsCache = new Map();
let factsTicket = 0;

function factsFor(scope, year) {
  const key = scope + "|" + year;
  if (!factsCache.has(key)) {
    factsCache.set(key, Promise.all([
      settings.getJSON(`/harmonized?scope=${encodeURIComponent(scope)}`),
      settings.getJSON(`/forecast?scope=${encodeURIComponent(scope)}&year=${year}`)
    ]).then(([hist, fc]) => ({
      series: hist.series, months: fc.months, model: fc.model, dataEnds: fc.data_ends
    })).catch(() => null));
  }
  return factsCache.get(key);
}

function ordinal(value) {
  const suffix = ["th", "st", "nd", "rd"];
  const rest = value % 100;
  return value + (suffix[(rest - 20) % 10] || suffix[rest] || suffix[0]);
}

function factBullets(facts, month) {
  const row = facts.months.find((entry) => entry.month === month);
  if (!row || !(row.expected > 0)) return [];
  const monthLong = dateLabel({ year: 2000, month }).split(" ")[0];
  const bullets = [];

  const ratio = row.typical > 0 ? row.expected / row.typical : null;
  const against = ratio == null ? ""
    : ` — <b>${ratio.toFixed(1)}×</b> a typical ${monthLong} (${number.format(Math.round(row.typical))})`;
  bullets.push(`<b>${number.format(Math.round(row.expected))}</b> fire cell-days expected${against}.`);

  // Rank against every earlier year of this same month. The forecast is kept
  // out of the comparison so it never ranks against data it helped produce.
  const past = facts.series.filter((entry) => entry.month === month && entry.year <= facts.dataEnds);
  if (past.length > 2) {
    const rank = past.filter((entry) => entry.harmonized > row.expected).length + 1;
    const worst = past.reduce((a, b) => (b.harmonized > a.harmonized ? b : a), past[0]);
    bullets.push(`Would rank <b>${ordinal(rank)}</b> of ${past.length} ${monthLong}s since ${past[0].year}; ${worst.year} was the worst at <b>${number.format(Math.round(worst.harmonized))}</b>.`);
  }

  if (typeof row.p_above_normal === "number") {
    let driver = "";
    if (typeof row.oni === "number" && typeof row.enso_multiplier === "number" && Math.abs(row.oni) >= 0.5) {
      const phase = row.oni >= 1.5 ? "Strong El Niño" : row.oni >= 0.5 ? "El Niño"
        : row.oni <= -1.5 ? "Strong La Niña" : "La Niña";
      driver = ` ${phase} (ONI ${row.oni >= 0 ? "+" : "−"}${Math.abs(row.oni).toFixed(1)}) scales the seasonal pattern ${row.enso_multiplier.toFixed(1)}×.`;
    }
    bullets.push(`<b>${Math.round(row.p_above_normal * 100)}%</b> chance of an above-normal ${monthLong}.${driver}`);
  }
  return bullets;
}

async function renderFacts(scope) {
  const ticket = ++factsTicket;
  const facts = await factsFor(scope, settings.outlook.year);
  if (ticket !== factsTicket) return;
  const box = el("watch-facts");
  const bullets = facts ? factBullets(facts, forecastMonth) : [];
  if (!bullets.length) {
    box.hidden = true;
    el("watch-facts-list").replaceChildren();
    return;
  }
  el("watch-facts-list").innerHTML = bullets.map((text) => `<li>${text}</li>`).join("");
  box.hidden = false;
}

/* Show or hide the parts of the panel that only make sense with a forecast. */
function setForecastPartsVisible(on) {
  const gauge = el("watch-gauge")?.closest(".watch-subpanel");
  if (gauge) gauge.hidden = !on;
  const share = el("watch-share");
  if (share && !on) share.hidden = true;
  const facts = el("watch-facts");
  if (facts && !on) facts.hidden = true;
}

const countryOutlooks = new Map();
const countryForecasts = new Map();
const worldForecastSummary = new Map();
let outlookRequest = 0;
let worldForecastGrid = null;

function countryOutlook(country) {
  if (!countryOutlooks.has(country)) {
    countryOutlooks.set(country, settings.getJSON(`/world/fires/outlook/${encodeURIComponent(country)}`)
      .catch(() => { countryOutlooks.delete(country); return null; }));
  }
  return countryOutlooks.get(country);
}

function countryForecast(country, year, enso) {
  const key = `${country}|${year}|${enso}`;
  if (!countryForecasts.has(key)) {
    const query = new URLSearchParams({ year, enso }).toString();
    countryForecasts.set(key, settings.getJSON(`/world/fires/forecast/${encodeURIComponent(country)}?${query}`)
      .catch(() => { countryForecasts.delete(key); return null; }));
  }
  return countryForecasts.get(key);
}

function prefetchWorldForecasts() {
  const names = (saved || []).filter((name) => worldCountries.has(name));
  if (!names.length) return;
  const year = settings.outlook.year;
  const enso = settings.outlook.enso;
  Promise.all(names.map((name) => countryForecast(name, year, enso)
    .then((data) => { if (data) worldForecastSummary.set(name, { year, enso, data }); })))
    .then(() => renderList());
}

async function renderCountryDetails(country, city) {
  const ticket = ++outlookRequest;
  const requested = settings.outlook;
  setForecastPartsVisible(false);
  worldForecastGrid = null;
  el("watch-place-title").textContent = city?.n || country;
  el("watch-place-region").textContent = city ? `${country} · Country forecast` : "Country forecast";
  const flag = el("watch-place-flag");
  flag.dataset.flagCountry = country;
  flag.innerHTML = flagMarkup(country);
  flag.hidden = !country;
  el("watch-quote").dataset.level = "all";
  el("watch-quote-unit").textContent = "cells ≥50%";
  el("watch-quote-value").textContent = "…";
  el("watch-quote-chg").textContent = "";
  el("watch-quote-state").textContent = "Loading model estimate…";
  el("watch-place-description").textContent = "";
  const stats = el("watch-place-stats");
  stats.replaceChildren();
  el("watch-news").replaceChildren();
  delete el("watch-news").dataset.countries;

  const history = el("watch-world-history");
  history.hidden = true;
  worldHistory(country).then((data) => {
    if (ticket !== outlookRequest || !data?.latest) return;
    const { latest, peakMonthName, busiest } = data;
    el("watch-world-history-status").textContent =
      `${country} · ${data.sensor} satellite record · ${data.coverage}`;
    el("watch-world-history-stats").innerHTML =
      `<div><dt>Fire cell-days in ${latest.year}</dt><dd>${number.format(latest.fire_cell_days)}</dd></div>`
      + `<div><dt>Peak month</dt><dd>${peakMonthName || "–"}</dd></div>`
      + `<div><dt>Busiest year</dt><dd>${busiest ? busiest.year : "–"}</dd></div>`;
    history.hidden = false;
    renderList();
  });

  const month = forecastMonth || requested.month;
  const forecast = await countryForecast(country, requested.year, requested.enso);
  if (ticket !== outlookRequest) return;
  if (forecast) {
    renderWorldForecast(country, city, forecast, requested.year, month);
    return;
  }

  const data = await countryOutlook(country);
  if (ticket !== outlookRequest) return;
  el("watch-quote-unit").textContent = "estimated fire cell-days";
  const end = data?.data_through;
  const requestedIndex = requested.year * 12 + requested.month - 1;
  const firstForecast = end ? end.year * 12 + end.month : requestedIndex;
  const index = Math.max(firstForecast, requestedIndex);
  const period = { year: Math.floor(index / 12), month: index % 12 + 1 };
  const row = data?.months.find((entry) => entry.month === period.month);
  if (!row) {
    el("watch-quote-value").textContent = "–";
    el("watch-quote-state").textContent = "Seasonal forecast unavailable";
    el("watch-place-description").textContent = `No seasonal estimate is available for ${country} in ${dateLabel(period)}.`;
    return;
  }

  const range = `${number.format(row.historical_low)}–${number.format(row.historical_high)}`;
  el("watch-quote-value").textContent = number.format(row.expected);
  el("watch-quote-state").textContent = `Seasonal estimate · ${dateLabel(period)}`;
  const description = `The estimate for ${country} is the median of ${row.observations} past observations for this calendar month, using records through ${dateLabel(end)}.`;
  el("watch-place-description").textContent = city
    ? `The map is centered on ${city.n}. ${description}`
    : description;
  stats.innerHTML =
    `<div><dt>Historical middle 80%</dt><dd>${range}</dd></div>`
    + `<div><dt>Months in sample</dt><dd>${number.format(row.observations)}</dd></div>`;
}

function renderWorldForecast(country, city, data, year, month) {
  const detail = data.months?.[month - 1];
  const summary = data.summary?.[month - 1];
  if (!detail || !summary) {
    el("watch-quote-value").textContent = "–";
    el("watch-quote-state").textContent = "Model estimate unavailable";
    el("watch-place-description").textContent = `No cell forecast is available for ${country} in ${dateLabel({ year, month })}.`;
    return;
  }
  const area = detail.top_areas?.[0] || {};
  const high = area.high_risk_cells || 0;
  const max = area.max_chance_pct || 0;
  const period = dateLabel({ year, month });
  el("watch-quote").dataset.level = riskLevel(high, Math.max(1, data.cells));
  el("watch-quote-value").textContent = number.format(high);
  el("watch-quote-chg").textContent = max ? `peak cell ${max}%` : "";
  el("watch-quote-state").textContent = `Model estimate · ${period}`;
  el("watch-place-description").textContent = city
    ? `The map is centered on ${city.n}. For ${period}, the model gives ${number.format(high)} grid ${high === 1 ? "cell" : "cells"} in ${country} at least a 50% chance of one or more fire days.`
    : `For ${period}, the model gives ${number.format(high)} grid ${high === 1 ? "cell" : "cells"} in ${country} at least a 50% chance of one or more fire days.`;
  el("watch-place-stats").innerHTML =
    `<div><dt>Cells at ≥50%</dt><dd>${number.format(high)}</dd></div>`
    + `<div><dt>Highest cell chance</dt><dd>${max ? max + "%" : "–"}</dd></div>`
    + `<div><dt>Grid cells</dt><dd>${number.format(data.cells)}</dd></div>`;
  el("watch-share").hidden = true;
  setForecastPartsVisible(true);
  setGauge(detail.cells.map((row) => row[2]));
  renderWorldFacts(data, month);
  worldForecastGrid = data;
  updateMap();
}

function renderWorldFacts(data, month) {
  const row = data.summary?.[month - 1];
  const box = el("watch-facts");
  if (!row) {
    box.hidden = true;
    el("watch-facts-list").replaceChildren();
    return;
  }
  const monthLong = dateLabel({ year: 2000, month }).split(" ")[0];
  const bullets = [];
  const ratio = row.ratio_to_typical;
  const against = ratio == null ? ""
    : ` — <b>${ratio.toFixed(1)}×</b> a typical ${monthLong} (${number.format(Math.round(row.typical))})`;
  bullets.push(`<b>${number.format(Math.round(row.expected))}</b> fire cell-days expected${against}.`);
  if (row.years_compared > 2) {
    bullets.push(`Would rank <b>${ordinal(row.rank)}</b> of ${row.years_compared} ${monthLong}s since ${row.first_year}; ${row.worst_year} was the worst at <b>${number.format(Math.round(row.worst_value))}</b>.`);
  }
  if (typeof row.p_above_normal === "number") {
    let driver = "";
    if (typeof row.oni === "number" && typeof row.enso_multiplier === "number" && Math.abs(row.oni) >= 0.5) {
      const phase = row.oni >= 1.5 ? "Strong El Niño" : row.oni >= 0.5 ? "El Niño"
        : row.oni <= -1.5 ? "Strong La Niña" : "La Niña";
      driver = ` ${phase} (ONI ${row.oni >= 0 ? "+" : "−"}${Math.abs(row.oni).toFixed(1)}) scales the seasonal pattern ${row.enso_multiplier.toFixed(1)}×.`;
    }
    bullets.push(`<b>${Math.round(row.p_above_normal * 100)}%</b> chance of an above-normal ${monthLong}.${driver}`);
  }
  el("watch-facts-list").innerHTML = bullets.map((text) => `<li>${text}</li>`).join("");
  box.hidden = !bullets.length;
}

function renderDetails() {
  if (selectedCity || isWorld(selected)) {
    renderCountryDetails(selectedCity?.c || selected, selectedCity);
    return;
  }
  ++outlookRequest;
  worldForecastGrid = null;
  el("watch-world-history").hidden = true;
  setForecastPartsVisible(true);
  el("watch-quote-unit").textContent = "cells ≥50%";
  const place = catalog.get(selected);
  const scope = focusScope;
  const name = place?.name || (scope === "All" ? "All regions" : scope);
  el("watch-place-title").textContent = name;
  el("watch-place-region").textContent = place?.region
    || (scope === "All" ? "Malaysia & Indonesia" : scopedRegions(scope).map((region) => region.region).join(" · "));
  const country = place ? countryOfRegion(place.region) : countryOfScope(scope);
  const flag = el("watch-place-flag");
  const markup = flagMarkup(country);
  flag.dataset.flagCountry = country || "";
  flag.innerHTML = markup;
  flag.hidden = !country;
  const ai = el("watch-ai-generate");
  if (forecastGrid) {
    const regions = new Set(scopedRegions(scope).map((region) => region.region));
    const entries = place ? [place] : [...catalog.values()].filter((entry) => regions.has(entry.region));
    const high = entries.reduce((sum, item) => sum + item.high, 0);
    const max = Math.max(0, ...entries.map((item) => item.max));
    const period = dateLabel({ year: settings.outlook.year, month: forecastMonth });
    el("watch-place-description").textContent = `For ${period}, the model gives ${number.format(high)} grid ${high === 1 ? "cell" : "cells"} in ${scope === "All" && !place ? "the monitored regions" : name} at least a 50% chance of one or more fire days.`;
    el("watch-place-stats").innerHTML = `<div><dt>Cells at ≥50%</dt><dd>${number.format(high)}</dd></div>
      <div><dt>Highest cell chance</dt><dd>${max ? max + "%" : "–"}</dd></div>`;

    // Quote header. The count of cells at >=50% is the headline: it is the number
    // that separates one place from another. The peak cell chance sits beside it
    // as context, because it tops out at the same value almost everywhere.
    const allHigh = [...catalog.values()].reduce((sum, item) => sum + item.high, 0);
    const peak = Math.max(0, ...[...catalog.values()].map((item) => item.high));
    el("watch-quote").dataset.level = place ? riskLevel(high, peak) : "all";
    el("watch-quote-value").textContent = number.format(high);
    el("watch-quote-chg").textContent = max ? `peak cell ${max}%` : "";
    el("watch-quote-state").textContent = `Model estimate · ${period}`;

    // share bar: this place against every monitored cell, like volume vs average
    const share = allHigh ? Math.min(100, (high / allHigh) * 100) : 0;
    el("watch-share").hidden = !allHigh;
    el("watch-share-label").textContent = `${number.format(high)} of ${number.format(allHigh)}`;
    el("watch-share-hi").style.width = share + "%";
    el("watch-share-lo").style.width = (100 - share) + "%";
    setGauge(entries.flatMap((entry) => entry.cells).map((row) => row[2]));
    renderFacts(place?.region || scope);
    const question = `Write a short fire-risk briefing for ${name} in ${period}. This outlook shows ${high} grid cells at or above 50% chance of a fire day${max ? `, with a maximum of ${max}% for an individual cell` : ""}. Explain what these model estimates mean for monitoring. Distinguish model estimates from confirmed detections, and avoid treating the forecast as a live incident report.`;
    if (ai && ai.dataset.question !== question) {
      ai.dataset.question = question;
      ai.dataset.scope = place?.region || scope;
      ai.dataset.year = settings.outlook.year;
      ai.dataset.enso = settings.outlook.enso;
      ai.dispatchEvent(new Event("placechange"));
    }
  } else {
    el("watch-place-description").textContent = "Loading the fire forecast…";
    el("watch-place-stats").replaceChildren();
    el("watch-quote-value").textContent = "–";
    el("watch-quote-chg").textContent = "";
    el("watch-quote-state").textContent = "Loading";
    el("watch-share").hidden = true;
    el("watch-facts").hidden = true;
    setGauge([]);
    if (ai) {
      delete ai.dataset.question;
      ai.dispatchEvent(new Event("placechange"));
    }
  }
  const isMalaysia = scopedRegions(place?.region || scope).every((region) => region.country === "Malaysia");
  const countries = [...new Set(scopedRegions(place?.region || scope).map((region) => region.country))].sort();
  // built-in headlines first; replaced by the latest ones from /api/news when they arrive
  if (el("watch-news").dataset.countries !== countries.join(",")) {
    el("watch-news").innerHTML = news.filter((item) => !item.indonesia || !isMalaysia).map((item) =>
      `<li><small>${item.source} · ${item.date}</small><a href="${item.href}" target="_blank" rel="noopener noreferrer">${item.title} <span aria-hidden="true">↗</span></a></li>`
    ).join("");
    el("watch-news").dataset.countries = countries.join(",");
    loadLiveNews(countries);
  }
}

const liveNewsCache = new Map();
const newsDay = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
function loadLiveNews(countries) {
  const key = countries.join(",");
  const hit = liveNewsCache.get(key);
  if (!hit || Date.now() - hit.t > 30 * 60 * 1000) {
    liveNewsCache.set(key, {
      t: Date.now(),
      p: settings.getJSON("/news?" + new URLSearchParams({ topic: "fire", countries: key, limit: 4 }))
        .catch(() => { liveNewsCache.delete(key); return { items: [] }; }),
    });
  }
  liveNewsCache.get(key).p.then((d) => {
    const list = el("watch-news");
    if (list.dataset.countries !== key || !d.items?.length) return;
    list.innerHTML = d.items.map((n) =>
      `<li><small>${settings.escape(n.source || "News")} · ${newsDay.format(new Date(n.published))}</small><a href="${settings.escape(n.url)}" target="_blank" rel="noopener noreferrer">${settings.escape(n.title)} <span aria-hidden="true">↗</span></a></li>`
    ).join("") + `<li class="watch-news-live"><small><i aria-hidden="true"></i>Latest headlines, updated automatically</small></li>`;
  });
}
setInterval(() => {
  const list = el("watch-news");
  if (list && list.dataset.countries && !list.closest("[hidden]")) loadLiveNews(list.dataset.countries.split(","));
}, 30 * 60 * 1000);
