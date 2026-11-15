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

export function renderOverview({ observed, outlook, getJSON, scope, openExplorer }) {
  const request = ++homeRequest;
  el("overview-detected-date").textContent = dateLabel(observed);
  el("overview-watch-date").textContent = dateLabel(outlook);
  el("overview-chip-obs").textContent = dateLabel(observed);
  el("overview-chip-fc").textContent = dateLabel(outlook);
  for (const id of ["detected", "repeat", "area-count", "watch-count"]) el("overview-" + id).textContent = "–";
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
          <span class="ov-rank-name"><b>${escapeHTML(place.name)}</b><small>${escapeHTML(place.region || "")}</small></span>
          <span class="ov-rank-val">${cells}</span>
          <span class="ov-rank-track" aria-hidden="true"><i style="width:${(place.high / peak * 100).toFixed(1)}%"></i></span>
        </a></li>`;
    }).join("");
  }).catch(() => {
    if (request === homeRequest) forecastStatus.textContent = "The fire forecast is unavailable for this month.";
  });
}

const escapeHTML = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Numbers tick up to their value once, so the tiles feel alive on arrival.
function countUp(node, value) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || value < 10) { node.textContent = number.format(value); return; }
  const start = performance.now(), ms = 700;
  const token = (node.dataset.count = String(Math.random()));
  const step = (now) => {
    if (node.dataset.count !== token) return;
    const t = Math.min(1, (now - start) / ms);
    node.textContent = number.format(Math.round(value * (1 - Math.pow(1 - t, 3))));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
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
  if (!initialized) init();
  const { outlook, getJSON } = settings;
  const period = [outlook.year, outlook.enso].join("/");
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
    el("watch-place-description").textContent = "The forecast is unavailable for this month.";
  });
}

function init() {
  initialized = true;
  initPlaceSearch();
  initCombo();
  // The timeline is the only era control now: app.js passes layer with each render.
  const form = el("watch-add-form");
  const toggle = el("watch-add-toggle");
  toggle.addEventListener("click", () => {
    form.hidden = !form.hidden;
    toggle.setAttribute("aria-expanded", String(!form.hidden));
    if (!form.hidden) el("watch-add-place").focus();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = resolveAddName();
    if (!catalog.has(name)) { el("watch-add-place").focus(); renderCombo(); return; }
    closeCombo();
    if (!saved.includes(name)) { saved.push(name); storeSaved(); }
    selectPlace(name);
    form.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    focusRow(name);
  });
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

const searchText = (value) => value.toLowerCase().normalize("NFD")
  .replace(/\p{Diacritic}/gu, "").replace(/[^a-z0-9]+/g, " ").trim();

function renderPlaceResults() {
  const query = searchText(el("place-search-input").value);
  const countries = [...new Set(settings.regions.map(({ country }) => country))];
  const entries = [
    ...countries.map((name) => ({ name, scope: name, subtitle: "Country" })),
    ...settings.regions.map(({ region, country }) => ({ name: region, scope: region, subtitle: country })),
    ...(forecastGrid ? [...catalog.values()].map(({ name, region }) =>
      ({ name, place: name, scope: region, subtitle: region })) : []),
  ];
  const matches = entries.flatMap((entry) => {
    const name = searchText(entry.name);
    const context = searchText(`${entry.name} ${entry.subtitle || ""}`);
    if (!context.includes(query)) return [];
    const rank = name === query ? 0 : name.startsWith(query) ? 1 : 2;
    return [{ ...entry, rank }];
  }).sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

  el("place-search-results").replaceChildren(...matches.map(({ name, place, scope, subtitle }) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const label = document.createElement("strong");
    const region = document.createElement("span");
    button.type = "button";
    label.textContent = name;
    region.textContent = subtitle || "";
    button.append(label, region);
    button.addEventListener("click", () => {
      el("place-search-dialog").close();
      selectPlace(place || "", scope);
    });
    item.append(button);
    return item;
  }));
  el("place-search-empty").hidden = matches.length !== 0;
}

function initPlaceSearch() {
  const trigger = el("place-search-open");
  const dialog = el("place-search-dialog");
  const input = el("place-search-input");
  const results = el("place-search-results");
  if (!trigger) return;   // the toolbar "Search places" button was removed
  trigger.disabled = false;
  trigger.addEventListener("click", () => {
    input.value = "";
    renderPlaceResults();
    dialog.showModal();
  });
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
  if (selected && catalog.get(selected)?.region !== el("f-scope").value) selected = "";
  renderList();
  renderDetails();
  updateMap();
}

const explorerScope = () => el("f-scope").value || "All";
function scopedRegions(scope) {
  return settings.regions.filter((region) => scope === "All" || region.region === scope || region.country === scope);
}

function updateMap() {
  const canForecast = Boolean(forecastGrid);
  const mode = canForecast && (settings.layer ?? layer) === "forecast" ? "forecast" : "observed";
  const panel = el("explorer-map-panel");
  panel.dataset.mapMode = mode;
  const place = forecastGrid ? catalog.get(selected) : null;
  const scope = explorerScope();
  const regions = scopedRegions(scope);
  const names = new Set(regions.map((region) => region.region));
  const bounds = place?.cells.length
    ? [
        Math.min(...place.cells.map(([, lon]) => lon)), Math.min(...place.cells.map(([lat]) => lat)),
        Math.max(...place.cells.map(([, lon]) => lon)) + forecastGrid.cell_deg,
        Math.max(...place.cells.map(([lat]) => lat)) + forecastGrid.cell_deg,
      ]
    : regions.find((region) => region.region === place?.region)?.bbox;
  const focus = place && bounds ? { name: place.name, bounds } : null;
  let plan = null;
  if (mode === "forecast") {
    const areaIds = forecastGrid.areas.flatMap((name, index) =>
      (place ? name === place.name : names.has(catalog.get(name)?.region)) ? [index] : []);
    plan = { grid: forecastGrid, month: forecastMonth, areaIds,
      selection: JSON.stringify([scope, place?.name]), bounds: bounds || regionBounds(regions) };
  }
  settings.updateTerrain(focus, plan);
}

/* Which country the site opens on. The browser's own time zone separates
   Malaysia from Indonesia without asking for a location permission; anything
   else falls back to Malaysia. */
/* National flags, drawn inline so the panel needs no image requests and works
   offline. Emoji flags are not an option: Windows ships no flag glyphs and
   renders them as letter pairs. Each is cropped from its left edge inside the
   round badge, which keeps Malaysia's canton - the recognisable part - visible. */
const FLAGS = {
  Malaysia: `<svg viewBox="0 0 28 14" preserveAspectRatio="xMinYMid slice">
    <rect width="28" height="14" fill="#fff"/>
    <g fill="#cc0001"><rect width="28" height="1" y="0"/><rect width="28" height="1" y="2"/>
      <rect width="28" height="1" y="4"/><rect width="28" height="1" y="6"/>
      <rect width="28" height="1" y="8"/><rect width="28" height="1" y="10"/>
      <rect width="28" height="1" y="12"/></g>
    <rect width="14" height="8" fill="#010066"/>
    <circle cx="7.2" cy="4" r="2.5" fill="#ffcc00"/>
    <circle cx="8.3" cy="4" r="2.1" fill="#010066"/>
    <polygon fill="#ffcc00" points="10.7,2.1 11.159,3.369 12.507,3.413 11.442,4.241 11.817,5.537
      10.7,4.78 9.583,5.537 9.958,4.241 8.893,3.413 10.241,3.369"/>
  </svg>`,
  Indonesia: `<svg viewBox="0 0 24 16" preserveAspectRatio="xMinYMid slice">
    <rect width="24" height="8" fill="#ce1126"/><rect y="8" width="24" height="8" fill="#fff"/>
  </svg>`,
};

const countryOfRegion = (region) =>
  settings.regions.find((entry) => entry.region === region)?.country || "";

/* A scope is either "All", a country name, or a region name. */
function countryOfScope(scope) {
  if (!scope || scope === "All") return "";
  return settings.regions.some((entry) => entry.country === scope) ? scope : countryOfRegion(scope);
}

function badgeFor(name, region) {
  return FLAGS[countryOfRegion(region)]
    || settings.escape(name.trim().charAt(0).toUpperCase());
}

function homeCountry() {
  let zone = "";
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { /* not supported */ }
  return /^Asia\/(Jakarta|Pontianak|Makassar|Jayapura)$/.test(zone) ? "Indonesia" : "Malaysia";
}

/* First visit: watch the busiest places in the visitor's own country, and open
   on that country rather than on both at once. */
function seedWatchlist() {
  const home = homeCountry();
  const country = new Map(settings.regions.map((region) => [region.region, region.country]));
  const mine = [...catalog.values()].filter((place) => country.get(place.region) === home);
  saved = (mine.length ? mine : [...catalog.values()]).sort(byRisk).slice(0, 5).map((place) => place.name);
  if (mine.length) settings.onPlace(home);
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

function selectPlace(name, scope = catalog.get(name)?.region || "All") {
  selected = name;
  settings.onPlace(scope);
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
  const entries = saved.map((name) => catalog.get(name)).filter(Boolean);
  const peak = Math.max(0, ...entries.map((entry) => entry.high));
  el("explorer-watchlist").innerHTML = entries.map(({ name, region, high, max }) => {
    const label = settings.escape(name);
    const summary = `${label}, ${number.format(high)} cells at 50% or higher${max ? ", maximum " + max + "%" : ""}`;
    const badge = badgeFor(name, region);
    return `<li><button type="button" data-place="${label}" data-level="${riskLevel(high, peak)}" aria-label="${summary}" aria-pressed="${selected === name}">
      <span class="watch-sym"><i class="watch-badge" aria-hidden="true">${badge}</i>
        <span><strong>${label}</strong><small>${settings.escape(region || "")}</small></span></span>
      <span class="watch-num">${number.format(high)}</span><span class="watch-max">${max ? max + "%" : "–"}</span>
      </button><button type="button" class="watch-remove" data-remove-place="${label}" aria-label="Remove ${label}">×</button></li>`;
  }).join("");
  el("explorer-watch-status").textContent = entries.length
    ? "" : "No places saved yet — add one to start watching it.";
  if (prior !== undefined) focusRow(prior);
  addChoices = [...catalog.keys()].filter((name) => !saved.includes(name));
  el("watch-add-place").value = "";
  if (!el("watch-add-options").hidden) renderCombo();
  el("watch-add-toggle").disabled = addChoices.length === 0;
}

/* ---- "Add place" search box: click to see every place, type to filter ---- */
let addChoices = [], comboMatches = [], comboActive = -1;

function comboFilter() {
  const q = el("watch-add-place").value.trim().toLowerCase();
  if (!q) return addChoices;
  const hits = addChoices.filter((name) => (name + " " + (catalog.get(name)?.region || "")).toLowerCase().includes(q));
  // names that start with the text first, then the rest
  return hits.sort((a, b) => (b.toLowerCase().startsWith(q) - a.toLowerCase().startsWith(q)) || a.localeCompare(b));
}

function renderCombo() {
  const input = el("watch-add-place"), list = el("watch-add-options");
  const q = input.value.trim();
  comboMatches = comboFilter();
  if (comboActive >= comboMatches.length) comboActive = comboMatches.length - 1;
  const mark = (name) => {
    const i = q ? name.toLowerCase().indexOf(q.toLowerCase()) : -1;
    if (i < 0) return settings.escape(name);
    return settings.escape(name.slice(0, i)) + "<mark>" + settings.escape(name.slice(i, i + q.length)) + "</mark>" + settings.escape(name.slice(i + q.length));
  };
  list.innerHTML = comboMatches.length
    ? comboMatches.map((name, i) => `<li role="option" id="watch-opt-${i}" data-index="${i}" aria-selected="${i === comboActive}">
        <span>${mark(name)}</span><small>${settings.escape(catalog.get(name)?.region || "")}</small></li>`).join("")
    : `<li class="combo-empty" role="presentation">No matching places</li>`;
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
  if (comboActive >= 0) {
    input.setAttribute("aria-activedescendant", "watch-opt-" + comboActive);
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  } else input.removeAttribute("aria-activedescendant");
}

function closeCombo() {
  el("watch-add-options").hidden = true;
  el("watch-add-place").setAttribute("aria-expanded", "false");
  el("watch-add-place").removeAttribute("aria-activedescendant");
  comboActive = -1;
}

function initCombo() {
  const input = el("watch-add-place"), list = el("watch-add-options");
  const pick = (name) => { input.value = name; closeCombo(); el("watch-add-form").requestSubmit(); };
  input.addEventListener("focus", () => { comboActive = -1; renderCombo(); });
  input.addEventListener("click", () => { if (list.hidden) renderCombo(); });
  input.addEventListener("input", () => { comboActive = input.value.trim() ? 0 : -1; renderCombo(); });
  input.addEventListener("blur", closeCombo);
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.hidden) { renderCombo(); return; }
      const n = comboMatches.length;
      if (!n) return;
      comboActive = event.key === "ArrowDown" ? (comboActive + 1) % n : (comboActive <= 0 ? n - 1 : comboActive - 1);
      renderCombo();
    } else if (event.key === "Enter" && !list.hidden && comboActive >= 0 && comboMatches[comboActive]) {
      event.preventDefault();
      pick(comboMatches[comboActive]);
    } else if (event.key === "Escape" && !list.hidden) {
      event.preventDefault();
      closeCombo();
    }
  });
  // mousedown (not click) so the input keeps focus and blur doesn't close the list first
  list.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const item = event.target.closest("[data-index]");
    if (item) pick(comboMatches[+item.dataset.index]);
  });
}

// Turn what was typed into a place name: exact match (any case), or the only match left.
function resolveAddName() {
  const typed = el("watch-add-place").value.trim().toLowerCase();
  if (!typed) return "";
  const exact = addChoices.find((name) => name.toLowerCase() === typed);
  if (exact) return exact;
  const hits = comboFilter();
  return hits.length === 1 ? hits[0] : "";
}

function renderDetails() {
  const place = catalog.get(selected);
  const scope = explorerScope();
  const name = place?.name || (scope === "All" ? "All regions" : scope);
  el("watch-place-title").textContent = name;
  el("watch-place-region").textContent = place?.region
    || (scope === "All" ? "Malaysia & Indonesia" : scopedRegions(scope).map((region) => region.region).join(" · "));
  const country = place ? countryOfRegion(place.region) : countryOfScope(scope);
  const flag = el("watch-place-flag");
  flag.innerHTML = FLAGS[country] || "";
  flag.hidden = !FLAGS[country];
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
