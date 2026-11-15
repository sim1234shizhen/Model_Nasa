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
  el("overview-detected-date").textContent = "Observed · " + dateLabel(observed);
  el("overview-watch-date").textContent = "Forecast · " + dateLabel(outlook);
  for (const id of ["detected", "repeat", "area-count", "watch-count"]) el("overview-" + id).textContent = "–";
  const observedStatus = el("overview-observed-status"), forecastStatus = el("overview-watch-status");
  const openMap = el("overview-open-map");
  openMap.disabled = true;
  observedStatus.textContent = "Loading satellite detections…";
  forecastStatus.textContent = "Loading the fire forecast…";
  el("overview-top-places").replaceChildren();
  const { year, month } = observed;
  getJSON("/hotspots/grid?" + new URLSearchParams({ scope, year, month, cell: "0.25" })).then((grid) => {
    if (request !== homeRequest) return;
    el("overview-detected").textContent = number.format(grid.cells.length);
    el("overview-repeat").textContent = number.format(grid.cells.filter(({ cell_days }) => cell_days >= 8).length);
    observedStatus.textContent = `${number.format(grid.hotspots)} ${grid.sensor} detections in ${number.format(grid.cells.length)} grid cells, each about 28 km across.`;
    openMap.disabled = false;
    openMap.onclick = () => openExplorer(year, month);
  }).catch(() => {
    if (request === homeRequest) observedStatus.textContent = "Satellite detections are unavailable for this month.";
  });
  forecastFor(getJSON, scope, outlook).then((grid) => {
    if (request !== homeRequest) return;
    const places = [...catalogFor(grid, outlook.month).values()].filter((place) => place.high > 0).sort(byRisk);
    el("overview-area-count").textContent = number.format(places.length);
    el("overview-watch-count").textContent = number.format(places.reduce((sum, place) => sum + place.high, 0));
    forecastStatus.textContent = places.length
      ? "Areas ranked by the number of cells with at least a 50% chance of a fire day."
      : "No grid cells reach a 50% chance of a fire day for this area and month.";
    el("overview-top-places").replaceChildren(...places.slice(0, 5).map((place) => {
      const item = document.createElement("li");
      item.textContent = place.name + " · " + number.format(place.high) + (place.high === 1 ? " cell" : " cells");
      return item;
    }));
  }).catch(() => {
    if (request === homeRequest) forecastStatus.textContent = "The fire forecast is unavailable for this month.";
  });
}

export function renderExplorerWatchlist(options) {
  settings = options;
  if (!initialized) init();
  const { outlook, getJSON } = settings;
  const period = [outlook.year, outlook.enso].join("/");
  if (period === watchPeriod && forecastGrid) {
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
    if (saved === null) saved = readSaved() ?? [...catalog.values()].sort(byRisk).slice(0, 5).map((place) => place.name);
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
  document.querySelectorAll("[data-explorer-layer]").forEach((button) => {
    button.addEventListener("click", () => {
      layer = button.dataset.explorerLayer;
      updateMap();
    });
  });
  el("f-forecast-timeline").addEventListener("input", (event) => {
    if (!forecastGrid) return;
    forecastMonth = event.currentTarget.valueAsNumber;
    catalog = catalogFor(forecastGrid, forecastMonth);
    renderSelection();
  });
  el("overview-open-map").addEventListener("click", () => { layer = "observed"; });
  const form = el("watch-add-form");
  const toggle = el("watch-add-toggle");
  toggle.addEventListener("click", () => {
    form.hidden = !form.hidden;
    toggle.setAttribute("aria-expanded", String(!form.hidden));
    if (!form.hidden) el("watch-add-place").focus();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = el("watch-add-place").value;
    if (!catalog.has(name)) return;
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
  const mode = canForecast ? layer : "observed";
  const panel = el("explorer-map-panel");
  panel.dataset.mapMode = mode;
  const timeline = el("f-forecast-timeline");
  const period = dateLabel({ year: settings.outlook.year, month: forecastMonth });
  timeline.min = settings.outlook.month;
  timeline.disabled = !canForecast;
  timeline.value = forecastMonth;
  timeline.setAttribute("aria-valuetext", period);
  el("f-forecast-date").textContent = period;
  for (const button of panel.querySelectorAll("[data-explorer-layer]")) {
    const forecast = button.dataset.explorerLayer === "forecast";
    button.disabled = forecast && !canForecast;
    button.setAttribute("aria-pressed", String(button.dataset.explorerLayer === mode));
  }
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

function focusRow(name) {
  [...el("explorer-watchlist").querySelectorAll("[data-place]")].find((button) => button.dataset.place === name)?.focus();
}

function renderList() {
  const prior = document.activeElement?.dataset.place;
  const entries = [
    { name: "", region: "Malaysia & Indonesia",
      high: [...catalog.values()].reduce((sum, place) => sum + place.high, 0),
      max: Math.max(0, ...[...catalog.values()].map((place) => place.max)) },
    ...saved.map((name) => catalog.get(name)).filter(Boolean),
  ];
  const peak = Math.max(0, ...entries.filter((entry) => entry.name).map((entry) => entry.high));
  el("explorer-watchlist").innerHTML = entries.map(({ name, region, high, max }) => {
    const label = settings.escape(name || "All regions");
    const summary = `${label}, ${number.format(high)} cells at 50% or higher${max ? ", maximum " + max + "%" : ""}`;
    const active = selected === name && (Boolean(name) || explorerScope() === "All");
    const badge = settings.escape((name || "All").trim().charAt(0).toUpperCase());
    return `<li><button type="button" data-place="${settings.escape(name)}" data-level="${name ? riskLevel(high, peak) : "all"}" aria-label="${summary}" aria-pressed="${active}">
      <span class="watch-sym"><i class="watch-badge" aria-hidden="true">${badge}</i>
        <span><strong>${label}</strong><small>${settings.escape(region || "")}</small></span></span>
      <span class="watch-num">${number.format(high)}</span><span class="watch-max">${max ? max + "%" : "–"}</span>
      </button>${name ? `<button type="button" class="watch-remove" data-remove-place="${label}" aria-label="Remove ${label}">×</button>` : ""}</li>`;
  }).join("");
  if (prior !== undefined) focusRow(prior);
  const select = el("watch-add-place");
  select.replaceChildren(new Option("Choose a place", ""));
  select.options[0].disabled = true;
  select.options[0].selected = true;
  for (const name of catalog.keys()) {
    if (!saved.includes(name)) select.add(new Option(name, name));
  }
  el("watch-add-toggle").disabled = select.options.length === 1;
}

function renderDetails() {
  const place = catalog.get(selected);
  const scope = explorerScope();
  const name = place?.name || (scope === "All" ? "All regions" : scope);
  el("watch-place-title").textContent = name;
  el("watch-place-region").textContent = place?.region || (scope === "All" ? "Malaysia & Indonesia" : "");
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
    const question = `Write a short fire-risk briefing for ${name} in ${period}. This outlook shows ${high} grid cells at or above 50% chance of a fire day${max ? `, with a maximum of ${max}% for an individual cell` : ""}. Explain what these model estimates mean for monitoring. Distinguish model estimates from confirmed detections, and avoid treating the forecast as a live incident report.`;
    if (ai.dataset.question !== question) {
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
    delete ai.dataset.question;
    ai.dispatchEvent(new Event("placechange"));
  }
  const isMalaysia = scopedRegions(place?.region || scope).every((region) => region.country === "Malaysia");
  el("watch-news").innerHTML = news.filter((item) => !item.indonesia || !isMalaysia).map((item) =>
    `<li><small>${item.source} · ${item.date}</small><a href="${item.href}" target="_blank" rel="noopener noreferrer">${item.title} <span aria-hidden="true">↗</span></a></li>`
  ).join("");
}
