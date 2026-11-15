/* Explorer map renderers adapted from commit 92c9635. The toolbar, timeline
   and watchlist stay in the page and select data for the active renderer. */
import { createFlames } from "./fire-flames.js?v=forecast-flames";
import { createRiskMap, loadMapLibre } from "./risk-map.js?v=forecast-flames";
import { explorerCamera, frameExplorerMap, regionBounds, satelliteStyle } from "./satellite-map.js";

const API = (window.API_BASE || "") + "/api";
const $ = (id) => document.getElementById(id);
const host = $("hero3d");
const forecastHost = $("explorer-risk-map");
const status = $("hero-status");
const forecastDetail = $("hero-forecast-detail");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const LEVEL = ["#f3d873", "#ee9a52", "#d9534a"];
const NAMES = ["Light", "Moderate", "Heavy"];
const RISK_STOPS = [[5, "#2f9e8f", 0.32], [20, "#7cc36a", 0.52], [35, "#f2cf4a", 0.68],
  [50, "#f59432", 0.82], [70, "#ee4f2a", 0.92], [90, "#ff2020", 0.97]];
const EMPTY = { type: "FeatureCollection", features: [] };
const FIRE_LAYERS = ["fire-base", "fire-flat"];
const nf = new Intl.NumberFormat("en-US");
const date = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" });
const klass = (days) => days >= 8 ? 2 : days >= 3 ? 1 : 0;
let watchFocus, forecastPlan, globe, risk, globeLoading, riskLoading;
let forecastSource, forecastSelection, filteredForecast, riskFocus;
const ramp = RISK_STOPS.map(([chance, color]) => `${color} ${(chance - 5) / 85 * 100}%`).join(", ");
document.querySelector("#explorer-map-panel .forecast-chance-scale").style.setProperty("--risk-ramp", `linear-gradient(90deg, ${ramp})`);
const forecastMode = $("hero-forecast-mode");
const forecastFlameLegend = $("forecast-flame-legend");
const forecastHeatLegend = $("forecast-heat-legend");

function syncForecastDisplay() {
  forecastMode.disabled = !risk.canShowFlames;
  forecastMode.hidden = !risk.canShowFlames;
  forecastMode.textContent = risk.showingFlames ? "Show heat map" : "Show flames";
  forecastFlameLegend.hidden = !risk.showingFlames;
  forecastHeatLegend.hidden = risk.showingFlames;
}

forecastMode.addEventListener("click", () => {
  risk?.toggleFlames();
  if (risk) syncForecastDisplay();
});
const forecastReset = $("hero-forecast-reset");
forecastReset.addEventListener("click", () => risk?.resetView());

export function updateExplorerView(place, forecast) {
  watchFocus = place;
  forecastPlan = forecast;
  renderMap();
}

function renderMap() {
  const forecast = Boolean(forecastPlan);
  host.hidden = forecast;
  forecastHost.hidden = !forecast;
  $("hero-tip").hidden = true;
  forecastDetail.hidden = !forecast;
  if (forecast) {
    status.textContent = "";
    if (!risk) {
      forecastDetail.textContent = "Loading the forecast map…";
      riskLoading ??= createRiskMap(forecastHost, { stops: RISK_STOPS, reduced })
        .then((map) => {
          risk = map;
          forecastReset.disabled = false;
          syncForecastDisplay();
          if (forecastPlan) renderForecast();
        })
        .catch((error) => {
          console.warn("[forecast map]", error);
          riskLoading = null;
          if (forecastPlan) forecastDetail.textContent = "The forecast map could not load.";
        });
    } else {
      renderForecast();
    }
    return;
  }

  if (globe) {
    globe.update();
    return;
  }

  globeLoading ??= startGlobe()
    .then((map) => { globe = map; if (!forecastPlan) globe.update(); })
    .catch((error) => {
      console.warn("[globe]", error);
      globeLoading = null;
      if (!forecastPlan) status.textContent = "The satellite globe could not load.";
    });
}

function renderForecast() {
  const { grid, month, areaIds, selection, bounds } = forecastPlan;
  if (grid !== forecastSource || selection !== forecastSelection) {
    forecastSource = grid;
    forecastSelection = selection;
    const areas = new Set(areaIds);
    filteredForecast = {
      ...grid, extentMonths: grid.months,
      months: grid.months.map((entry) => ({
        ...entry,
        cells: entry.cells.filter((cell) => areas.has(cell[4])),
        top_areas: entry.top_areas.filter(({ area }) => areas.has(grid.areas.indexOf(area))),
      })),
    };
  }
  risk.resize();
  risk.show(filteredForecast, month);
  if (selection !== riskFocus) {
    riskFocus = selection;
    risk.setFocus(bounds);
  }
  forecastDetail.textContent = filteredForecast.months[month - 1].cells.length
    ? "" : "No forecast cells for this place and month.";
}

async function startGlobe() {
  await loadMapLibre();
  const maplibregl = window.maplibregl;
  const style = satelliteStyle();
  style.sources.cells = { type: "geojson", data: EMPTY };
  style.layers.push(
      { id: "fire-flat", type: "fill", source: "cells", layout: { visibility: "none" },
        paint: { "fill-color": ["match", ["get", "k"], 0, LEVEL[0], 1, LEVEL[1], LEVEL[2]], "fill-opacity": 0.8 } },
      // under the flames: a faint scorched footprint of each cell, which also carries hover and click
      { id: "fire-base", type: "fill", source: "cells",
        paint: { "fill-color": ["match", ["get", "k"], 0, LEVEL[0], 1, LEVEL[1], LEVEL[2]],
          "fill-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0.18, 8, 0.32, 11, 0.22], "fill-outline-color": "rgba(60,30,10,0.35)" } },
  );

  const map = new maplibregl.Map({ ...explorerCamera, container: host, style });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-left");
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Satellite globe did not finish loading")), 15000);
      map.once("load", () => { clearTimeout(timeout); resolve(); });
    });
  } catch (error) {
    map.remove();
    throw error;
  }
  new ResizeObserver(() => { if (host.clientWidth) map.resize(); }).observe(host);

  let flames;
  try {
    flames = createFlames(map, { reduced });
  } catch (error) {
    host.querySelector(".fire-flames")?.remove();
    console.warn("[flames]", error);
  }
  const elMode = $("hero-mode"), elReset = $("hero-reset"), elWorld = $("hero-world");
  const elScale = $("hero-scale"), elTip = $("hero-tip");
  elWorld.disabled = false;
  elReset.disabled = false;
  const hidden = [false, false, false];
  let flat = false, current, requested, pending, observedDate = "", cellDeg;
  let scopeShown, placeShown;
  const regions = fetch(`${API}/regions`).then((r) => r.json()).catch(() => []);
  let boxes = [];
  regions.then((result) => {
    if (Array.isArray(result)) boxes = result;
    if (!forecastPlan && !watchFocus) focus();
  });

  function focus(scope = $("f-scope").value || "All") {
    const regionsInScope = boxes.filter((region) => scope === "All" || region.region === scope || region.country === scope);
    const bounds = watchFocus?.bounds || regionBounds(regionsInScope);
    map.resize();
    frameExplorerMap(map, bounds, reduced ? 0 : 1250);
  }

  function applyFilter() {
    const filter = ["in", ["get", "k"], ["literal", [0, 1, 2].filter((level) => !hidden[level])]];
    const flatNow = flat || !flames;
    map.setFilter("fire-flat", filter);
    map.setFilter("fire-base", filter);
    map.setLayoutProperty("fire-flat", "visibility", flatNow ? "visible" : "none");
    map.setLayoutProperty("fire-base", "visibility", flatNow ? "none" : "visible");
    flames?.setHidden(hidden);
    flames?.setVisible(!flatNow);
    elMode.disabled = !flames;
    elMode.textContent = flatNow ? "Show flames" : "Show flat cells";
  }

  async function load(year, month, scope) {
    const cell = watchFocus || boxes.some((r) => r.region === scope) || map.getZoom() >= 6.6 ? 0.05 : 0.1;
    const key = [year, month, scope, cell].join("/");
    if (key === requested) return;
    requested = key;
    pending?.abort();
    if (key === current) { status.textContent = ""; return; }
    const controller = new AbortController();
    pending = controller;
    status.textContent = "Loading satellite detections…";
    try {
      const query = new URLSearchParams({ scope, year, month, cell, sensor: "auto" });
      const response = await fetch(`${API}/hotspots/grid?${query}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const grid = await response.json();
      if (controller.signal.aborted) return;
      current = key;
      cellDeg = grid.cell;
      observedDate = date.format(new Date(Date.UTC(year, month - 1, 1)));
      const cells = grid.cells.map((c) => [c.lon, c.lat, c.cell_days, c.hotspots, c.frp]);
      const counts = [0, 0, 0];
      const features = cells.map(([lon, lat, days, hotspots]) => {
        const k = klass(days);
        counts[k]++;
        const margin = cellDeg * 0.04;
        const x0 = lon + margin, y0 = lat + margin, x1 = lon + cellDeg - margin, y1 = lat + cellDeg - margin;
        return {
          type: "Feature", properties: { k, days, hotspots, lon: lon + cellDeg / 2, lat: lat + cellDeg / 2 },
          geometry: { type: "Polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] },
        };
      });
      map.getSource("cells").setData({ type: "FeatureCollection", features });
      flames?.setCells(cells, cellDeg);
      counts.forEach((count, index) => { $(`hero-n${index}`).textContent = nf.format(count); });
      if (!forecastPlan) status.textContent = "";
    } catch (error) {
      if (controller.signal.aborted) return;
      requested = null;
      if (!forecastPlan) status.textContent = "Satellite detections could not load.";
    }
  }

  function update() {
    if (forecastPlan || !host.clientWidth) return;
    const scope = $("f-scope").value || "All", place = watchFocus?.name;
    if (scope !== scopeShown || place !== placeShown) {
      scopeShown = scope;
      placeShown = place;
      focus(scope);
    }
    const year = +$("f-year").value, month = +$("f-month").value;
    if (year && month) load(year, month, scope);
  }

  elReset.addEventListener("click", () => focus());
  elWorld.addEventListener("click", () => map.flyTo({ center: [map.getCenter().lng, 6], zoom: 1.4, pitch: 0, bearing: 0, duration: reduced ? 0 : 1400 }));
  elMode.addEventListener("click", () => { flat = !flat; applyFilter(); });
  document.querySelectorAll(".hero-legend li").forEach((row, index) => {
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-pressed", "true");
    const toggle = () => {
      hidden[index] = !hidden[index];
      row.classList.toggle("off", hidden[index]);
      row.setAttribute("aria-pressed", String(!hidden[index]));
      applyFilter();
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); }
    });
  });

  let relief = false;
  map.on("zoom", () => {
    const zoom = map.getZoom();
    if (!relief && zoom >= 6.8 && zoom <= 11.6) {
      map.setTerrain({ source: "dem", exaggeration: 1.2 });
      relief = true;
    } else if (relief && (zoom < 4.2 || zoom > 12.2)) {
      map.setTerrain(null);
      relief = false;
    }
  });

  map.on("mousemove", (event) => {
    const cell = map.queryRenderedFeatures(event.point, { layers: FIRE_LAYERS })[0]?.properties;
    elTip.hidden = !cell;
    if (!cell) return;
    const lat = `${Math.abs(cell.lat).toFixed(2)}°${cell.lat >= 0 ? "N" : "S"}`;
    const lon = `${Math.abs(cell.lon).toFixed(2)}°${cell.lon >= 0 ? "E" : "W"}`;
    elTip.innerHTML = `<b>${lat}, ${lon}</b><span>${observedDate}</span>
      <dl><dt>Hotspots</dt><dd>${nf.format(cell.hotspots)}</dd><dt>Days with fire</dt><dd>${Number(cell.days)}</dd>
      <dt>Level</dt><dd>${NAMES[cell.k]}</dd><dt>Cell size</dt><dd>${(cellDeg * 111).toFixed(1)} km</dd></dl>`;
    elTip.style.left = Math.max(6, Math.min(event.point.x + 16, host.clientWidth - 216)) + "px";
    elTip.style.top = Math.max(6, Math.min(event.point.y + 16, host.clientHeight - 155)) + "px";
  });
  map.on("mouseout", () => { elTip.hidden = true; });
  map.on("click", (event) => map.flyTo({ center: event.lngLat, zoom: Math.min(12, map.getZoom() + 2), pitch: 46, duration: reduced ? 0 : 1100 }));
  map.on("zoomend", update);
  map.on("move", () => {
    const { clientWidth: w, clientHeight: h } = host;
    if (!w || !h) return;
    const distance = map.unproject([w / 2 - 50, h / 2]).distanceTo(map.unproject([w / 2 + 50, h / 2]));
    const pxPerKm = 100000 / distance;
    if (!Number.isFinite(pxPerKm) || pxPerKm <= 0) return;
    const km = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find((n) => n * pxPerKm >= 70) || 5000;
    elScale.hidden = false;
    elScale.style.width = Math.round(km * pxPerKm) + "px";
    elScale.textContent = km + " km";
  });
  applyFilter();
  return { update };
}

renderMap();
