/* Explorer map renderers adapted from commit 92c9635. The toolbar, timeline
   and watchlist stay in the page and select data for the active renderer. */
import { createFlames } from "./fire-flames.js?v=animated-country-flames";
import { createRiskMap, loadMapLibre } from "./risk-map.js?v=world-cell-forecast";
import { explorerCamera, frameExplorerMap, satelliteStyle } from "./satellite-map.js";

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
const WORLD_FLAME_MIN = 100;
const WORLD_DOTS = "world-detection-dots";
const FIRE_LAYERS = [WORLD_DOTS, "fire-base", "fire-flat"];
const nf = new Intl.NumberFormat("en-US");
const date = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" });
const klass = (days) => days >= 8 ? 2 : days >= 3 ? 1 : 0;
let mapFocus, forecastPlan, globe, risk, globeLoading, riskLoading;
let riskFocus, worldOutlookRequest, worldOutlookKey = "";
const ramp = RISK_STOPS.map(([chance, color]) => `${color} ${(chance - 5) / 85 * 100}%`).join(", ");
document.querySelector("#explorer-map-panel .forecast-chance-scale").style.setProperty("--risk-ramp", `linear-gradient(90deg, ${ramp})`);
const forecastMode = $("hero-forecast-mode");
const forecastFlameLegend = $("forecast-flame-legend");
const forecastHeatLegend = $("forecast-heat-legend");
const forecastHidden = [false, false, false];

function bindLegendToggles(rows, state, apply) {
  rows.forEach((row, index) => {
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-pressed", String(!state[index]));
    row.classList.toggle("off", state[index]);
    const toggle = () => {
      state[index] = !state[index];
      row.classList.toggle("off", state[index]);
      row.setAttribute("aria-pressed", String(!state[index]));
      apply();
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); }
    });
  });
}

bindLegendToggles(document.querySelectorAll(".forecast-flame-legend li"), forecastHidden,
  () => risk?.setHiddenBands(forecastHidden));

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
const forecastWorld = $("hero-forecast-world");
forecastWorld.addEventListener("click", () => risk?.showGlobe());
forecastReset.addEventListener("click", () => risk?.resetView());

export function updateExplorerView(focus, forecast) {
  mapFocus = focus;
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
          risk.setHiddenBands(forecastHidden);
          forecastReset.disabled = false;
          forecastWorld.disabled = false;
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
  const plan = forecastPlan;
  const { grid, month, year, enso } = plan;
  const { selection } = mapFocus;
  risk.resize();
  risk.show(grid, month);
  if (selection !== riskFocus) {
    riskFocus = selection;
    risk.setFocus(mapFocus);
  }
  if (grid?.country) {
    risk.showWorld({ countries: [] }, month, year);
    forecastDetail.textContent = `Flames show the 1° cell forecast for ${grid.country}. Larger flames mean a higher chance of fire in that cell.`;
    return;
  }
  const variant = `${year}|${enso || "observed"}`;
  if (worldOutlookKey !== variant) {
    worldOutlookKey = variant;
    worldOutlookRequest = fetch(`${API}/world/fires/forecast-map?year=${year}&enso=${encodeURIComponent(enso || "observed")}`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }).catch(() => { worldOutlookKey = ""; return null; });
  }
  worldOutlookRequest.then((data) => {
    if (forecastPlan !== plan) return;
    risk.showWorld(data, month, year);
    forecastDetail.textContent = data
      ? "Flames show the model estimate for each country. Larger flames mean more grid cells with at least a 50% chance of fire."
      : "The global model estimate could not load.";
  });
}

function detectionFeature(lon, lat, degrees, values) {
  const margin = degrees * 0.04;
  const x0 = lon + margin, y0 = lat + margin;
  const x1 = lon + degrees - margin, y1 = lat + degrees - margin;
  return {
    type: "Feature",
    properties: { ...values, degrees, lon: lon + degrees / 2, lat: lat + degrees / 2 },
    geometry: { type: "Polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] },
  };
}

async function startGlobe() {
  await loadMapLibre();
  const maplibregl = window.maplibregl;
  const style = satelliteStyle();
  style.sources.cells = { type: "geojson", data: EMPTY };
  style.sources[WORLD_DOTS] = { type: "geojson", data: EMPTY };
  style.layers.push(
      { id: "fire-flat", type: "fill", source: "cells", layout: { visibility: "none" },
        paint: { "fill-color": ["match", ["get", "k"], 0, LEVEL[0], 1, LEVEL[1], LEVEL[2]], "fill-opacity": 0.8 } },
      // under the flames: a faint scorched footprint of each cell, which also carries hover and click
      { id: "fire-base", type: "fill", source: "cells",
        paint: { "fill-color": ["match", ["get", "k"], 0, LEVEL[0], 1, LEVEL[1], LEVEL[2]],
          "fill-opacity": ["interpolate", ["linear"], ["zoom"],
            4, ["case", ["get", "world"], 0.04, 0.18],
            8, ["case", ["get", "world"], 0.04, 0.32],
            11, ["case", ["get", "world"], 0.04, 0.22]],
          "fill-outline-color": ["case", ["==", ["get", "world"], true], "transparent", "rgba(60,30,10,0.35)"] } },
      { id: WORLD_DOTS, type: "circle", source: WORLD_DOTS,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["get", "count"], 1, 1.5, WORLD_FLAME_MIN, 3.5],
          "circle-color": "#ffc270", "circle-opacity": 0.7,
        } },
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
  let flat = false, current, requested, pending, observedDate = "", dataWarning = "";
  let selectionShown;

  let cityMarker;
  function focus() {
    map.resize();
    frameExplorerMap(map, mapFocus, reduced ? 0 : 1250);
    const city = mapFocus?.city;
    if (city) {
      if (!cityMarker) {
        const pin = document.createElement("div");
        pin.className = "city-pin";
        cityMarker = new maplibregl.Marker({ element: pin, anchor: "bottom" })
          .setLngLat([city.lon, city.lat]).addTo(map);
      }
      cityMarker.setLngLat([city.lon, city.lat]);
      cityMarker.getElement().textContent = city.name;
    } else if (cityMarker) {
      cityMarker.remove();
      cityMarker = null;
    }
  }

  function applyFilter() {
    const filter = ["any", ["==", ["get", "world"], true],
      ["in", ["get", "k"], ["literal", [0, 1, 2].filter((level) => !hidden[level])]]];
    const flatNow = flat || !flames;
    map.setFilter("fire-flat", filter);
    map.setFilter("fire-base", filter);
    map.setLayoutProperty("fire-flat", "visibility", flatNow ? "visible" : "none");
    map.setLayoutProperty("fire-base", "visibility", flatNow ? "none" : "visible");
    map.setLayoutProperty(WORLD_DOTS, "visibility", flatNow ? "none" : "visible");
    flames?.setHidden(hidden);
    flames?.setVisible(!flatNow);
    elMode.disabled = !flames;
    elMode.textContent = flatNow ? "Show flames" : "Show flat cells";
  }

  function showDetectionStatus() {
    if (!forecastPlan) {
      status.textContent = dataWarning;
    }
  }

  async function load(year, month) {
    const key = [year, month].join("/");
    if (key === requested) {
      if (key === current) showDetectionStatus();
      return;
    }
    requested = key;
    pending?.abort();
    if (key === current) { showDetectionStatus(); return; }
    const controller = new AbortController();
    pending = controller;
    status.textContent = "Loading satellite detections…";
    try {
      const query = new URLSearchParams({ scope: "All", year, month, cell: 0.1, sensor: "auto" });
      const getGrid = async (path) => {
        const response = await fetch(API + path, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      };
      const [grid, worldGrid] = await Promise.all([
        getGrid(`/hotspots/grid?${query}`).catch(() => null),
        getGrid(`/world/fires/grid?${new URLSearchParams({ year, month })}`).catch(() => null),
      ]);
      if (controller.signal.aborted) return;
      if (!grid && !worldGrid) throw new Error("No detection data loaded");
      current = key;
      observedDate = date.format(new Date(Date.UTC(year, month - 1, 1)));
      const cellDeg = grid?.cell ?? 0.1;
      const cells = (grid?.cells ?? []).map((c) => [c.lon, c.lat, c.cell_days, c.hotspots]);
      const counts = [0, 0, 0];
      const regionalTiles = new Set(cells.map(([lon, lat]) =>
        `${Math.floor(lon + cellDeg / 2)}/${Math.floor(lat + cellDeg / 2)}`));
      const worldCells = (worldGrid?.cells ?? []).filter(([lon, lat, count]) =>
        count > 0 && !regionalTiles.has(`${lon}/${lat}`));

      const worldFlames = [], worldDots = [];
      const features = worldCells.map(([lon, lat, count]) => {
        const feature = detectionFeature(lon, lat, 1, { k: 1, count, world: true });
        if (count >= WORLD_FLAME_MIN) {
          worldFlames.push([lon, lat, count]);
        } else {
          worldDots.push({
            type: "Feature", properties: feature.properties,
            geometry: { type: "Point", coordinates: [feature.properties.lon, feature.properties.lat] },
          });
        }
        return feature;
      });
      for (const [lon, lat, days, hotspots] of cells) {
        const k = klass(days);
        counts[k]++;
        features.push(detectionFeature(lon, lat, cellDeg, { k, days, hotspots, world: false }));
      }
      map.getSource("cells").setData({ type: "FeatureCollection", features });
      map.getSource(WORLD_DOTS).setData({ type: "FeatureCollection", features: worldDots });
      flames?.setCells(cells, cellDeg, worldFlames);
      counts.forEach((count, index) => { $(`hero-n${index}`).textContent = nf.format(count); });
      dataWarning = !worldGrid ? "Global detections could not load."
        : !grid ? "Showing the global grid. Detailed regional detections could not load." : "";
      showDetectionStatus();
    } catch (error) {
      if (controller.signal.aborted) return;
      requested = null;
      if (!forecastPlan) status.textContent = "Satellite detections could not load.";
    }
  }

  function update() {
    if (forecastPlan || !host.clientWidth) return;
    if (mapFocus?.selection !== selectionShown) {
      selectionShown = mapFocus.selection;
      focus();
    }
    const year = +$("f-year").value, month = +$("f-month").value;
    if (year && month) load(year, month);
  }

  elReset.addEventListener("click", () => focus());
  elWorld.addEventListener("click", () => map.flyTo({ center: [map.getCenter().lng, 6], zoom: 1.4, pitch: 0, bearing: 0, duration: reduced ? 0 : 1400 }));
  elMode.addEventListener("click", () => { flat = !flat; applyFilter(); });
  bindLegendToggles(document.querySelectorAll(".hero-legend li"), hidden, applyFilter);

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
    const details = cell.world
      ? `<dt>Global fire cell-days</dt><dd>${nf.format(cell.count)}</dd><dt>Grid size</dt><dd>1° (about 110 km)</dd>`
      : `<dt>Hotspots</dt><dd>${nf.format(cell.hotspots)}</dd><dt>Days with fire</dt><dd>${Number(cell.days)}</dd>
         <dt>Level</dt><dd>${NAMES[cell.k]}</dd><dt>Cell size</dt><dd>${(cell.degrees * 111).toFixed(1)} km</dd>`;
    elTip.innerHTML = `<b>${lat}, ${lon}</b><span>${observedDate}</span><dl>${details}</dl>`;
    elTip.style.left = Math.max(6, Math.min(event.point.x + 16, host.clientWidth - 216)) + "px";
    elTip.style.top = Math.max(6, Math.min(event.point.y + 16, host.clientHeight - 155)) + "px";
  });
  map.on("mouseout", () => { elTip.hidden = true; });
  map.on("click", (event) => map.flyTo({ center: event.lngLat, zoom: Math.min(12, map.getZoom() + 2), pitch: 46, duration: reduced ? 0 : 1100 }));
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
