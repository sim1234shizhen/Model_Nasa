/* Overview map: a real 3D globe.
   - Imagery: NASA Blue Marble (GIBS) from far away, Esri World Imagery up close.
   - Relief: AWS Terrain Tiles, switched on once you zoom in.
   - Fire: the same /api/hotspots/grid cells as the 2D map, drawn as rising flame particles (fire-flames.js) or flat cells.
   Pick a country to fly to it, pick or click a city to zoom in.
   The fire record in this version covers Malaysia and Indonesia; other countries show the map only.
   Built on MapLibre GL JS (BSD-3). If the map library cannot load, the rest of the site still works. */

import { createFlames } from "./fire-flames.js";

const API = (window.API_BASE || "") + "/api";
const host = document.getElementById("hero3d");
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const nf = new Intl.NumberFormat("en-US");
const ML = "https://unpkg.com/maplibre-gl@5.24.1/dist/";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const CSS = `
#hero3d { background: radial-gradient(ellipse at 50% 45%, #0b1c2e 0%, #050b14 60%, #02050a 100%); }
#hero-labels { pointer-events: none; }
.hero-legend .lv0 { background: #f3d873 !important; } .hero-legend .lv1 { background: #ee9a52 !important; } .hero-legend .lv2 { background: #d9534a !important; }
#hero3d .maplibregl-canvas { outline: none; }
#hero3d .maplibregl-ctrl-top-left { top: 84px; left: 6px; }
.globe-panel { position: absolute; z-index: 3; top: 16px; right: 16px; width: min(250px, calc(100% - 32px)); padding: 10px 12px;
  background: var(--surface, #fff); border: 1px solid var(--border, #dce3ea); border-radius: 12px; box-shadow: 0 6px 24px rgba(10,20,30,.18); font-size: 13px; color: var(--ink, #18222e); }
.globe-panel label { display: block; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted, #586677); margin-bottom: 4px; }
.globe-panel input, .globe-panel select { width: 100%; box-sizing: border-box; padding: 6px 8px; font: inherit; color: inherit; background: var(--surface, #fff); border: 1px solid var(--axis, #b9c4cf); border-radius: 8px; }
.globe-panel input:focus-visible, .globe-panel select:focus-visible { outline: 2px solid var(--s1, #24629a); outline-offset: 1px; }
.globe-row { display: flex; gap: 6px; margin-top: 6px; }
.globe-row select { flex: 1; min-width: 0; }
.globe-world { flex: none; font: inherit; font-size: 12px; padding: 5px 9px; border-radius: 8px; cursor: pointer; white-space: nowrap;
  color: var(--s1, #24629a); background: var(--band, #edf3f9); border: 1px solid var(--border, #dce3ea); }
.globe-world:hover { border-color: var(--s1, #24629a); }
.globe-note { margin: 6px 0 0; font-size: 11.5px; line-height: 1.35; color: var(--muted, #586677); }
/* keep the read-out clear of the country picker on short screens */
.map-overview .hero-read { max-height: calc(100% - 190px) !important; }
.gcity { display: flex; align-items: center; gap: 5px; cursor: pointer; font: 600 11.5px/1 system-ui, sans-serif; color: #fff; text-shadow: 0 1px 3px #000, 0 0 6px #000; white-space: nowrap; }
.gcity i { width: 9px; height: 9px; border-radius: 50%; background: #fff; border: 2px solid #24629a; box-shadow: 0 0 0 2px rgba(255,255,255,.35); flex: none; }
@media (max-width: 720px) { .globe-panel { top: 96px; right: 8px; width: min(200px, 56%); padding: 8px 10px; } .globe-note { display: none; } }
`;

function loadLib() {
  if (window.maplibregl) return Promise.resolve();
  const link = document.createElement("link"); link.rel = "stylesheet"; link.href = ML + "maplibre-gl.css"; document.head.appendChild(link);
  return new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = ML + "maplibre-gl.js";
    s.onload = () => res(); s.onerror = () => rej(new Error("map library did not load")); document.head.appendChild(s);
  });
}

const LEVEL = ["#f3d873", "#ee9a52", "#d9534a"], NAMES = ["Light", "Moderate", "Heavy"];
const klass = (days) => (days >= 8 ? 2 : days >= 3 ? 1 : 0);
const fmtLL = (lon, lat) => `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
const EMPTY = { type: "FeatureCollection", features: [] };
const DATA_COUNTRIES = ["Malaysia", "Indonesia"];
const HOME = [[94.5, -7], [119.5, 8]];   // Malaysia, Sumatra and Kalimantan

async function start() {
  const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
  await loadLib();
  const maplibregl = window.maplibregl;

  const style = {
    version: 8,
    projection: { type: "globe" },
    sky: { "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0] },
    sources: {
      sat: { type: "raster", tileSize: 256, maxzoom: 17, attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"] },
      bm: { type: "raster", tileSize: 256, maxzoom: 8, attribution: "NASA Blue Marble (GIBS)",
        tiles: ["https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg"] },
      places: { type: "raster", tileSize: 256, maxzoom: 13,
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"] },
      dem: { type: "raster-dem", tileSize: 256, maxzoom: 9, encoding: "terrarium", attribution: "Terrain: AWS Terrain Tiles",
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"] },
      countries: { type: "geojson", data: "assets/countries.geojson" },
      cells: { type: "geojson", data: EMPTY },
    },
    layers: [
      { id: "space", type: "background", paint: { "background-color": "#0a1826" } },
      { id: "sat", type: "raster", source: "sat", paint: { "raster-fade-duration": 120 } },
      // NASA Blue Marble on top while far away; it fades out as the sharper imagery takes over
      { id: "bm", type: "raster", source: "bm", maxzoom: 7, paint: { "raster-opacity": ["interpolate", ["linear"], ["zoom"], 4.5, 1, 6.5, 0] } },
      { id: "places", type: "raster", source: "places", minzoom: 4.5, maxzoom: 13.4, paint: { "raster-opacity": 0.9 } },
      { id: "country-fill", type: "fill", source: "countries", paint: { "fill-color": "#fff", "fill-opacity": 0.001 } },
      { id: "country-line", type: "line", source: "countries", paint: { "line-color": "#ffffff", "line-opacity": 0.28, "line-width": 0.6 } },
      { id: "country-sel", type: "line", source: "countries", filter: ["==", ["id"], -1], paint: { "line-color": "#6fe0ff", "line-width": 2.2 } },
      { id: "fire-flat", type: "fill", source: "cells", layout: { visibility: "none" },
        paint: { "fill-color": ["match", ["get", "k"], 0, LEVEL[0], 1, LEVEL[1], LEVEL[2]], "fill-opacity": 0.8 } },
      // under the flames: a faint scorched footprint of each cell, which also carries hover and click
      { id: "fire-base", type: "fill", source: "cells",
        paint: { "fill-color": ["match", ["get", "k"], 0, LEVEL[0], 1, LEVEL[1], LEVEL[2]],
          "fill-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0.18, 8, 0.32, 11, 0.22], "fill-outline-color": "rgba(60,30,10,0.35)" } },
    ],
  };

  const map = new maplibregl.Map({
    container: host, style, center: [107, 2], zoom: 1.4, pitch: 0, maxPitch: 62, minZoom: 0.8, maxZoom: 15,
    attributionControl: false, dragRotate: true, cooperativeGestures: false,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-left");
  let flames = null;
  try { flames = createFlames(map, { reduced: REDUCED }); } catch (e) { console.warn("[flames]", e); }
  new ResizeObserver(() => map.resize()).observe(host);

  // ---- read-out elements already on the page ----
  const elWhen = $("hero-when"), elCount = $("hero-count"), elDetail = $("hero-detail"), elPick = $("hero-pick");
  const elMode = $("hero-mode"), elReset = $("hero-reset"), elScale = $("hero-scale"), elTip = $("hero-tip"), elImg = $("hero-img");
  if (elImg) elImg.textContent = "NASA Blue Marble (GIBS) · Imagery © Esri, Maxar, Earthstar Geographics · AWS Terrain Tiles";

  // ---- country and city picker ----
  const panel = document.createElement("div"); panel.className = "globe-panel";
  panel.innerHTML = `<label for="globe-country">Country</label>
    <input id="globe-country" list="globe-countries" placeholder="Type or pick a country" autocomplete="off">
    <datalist id="globe-countries"></datalist>
    <div class="globe-row">
      <select id="globe-cities" aria-label="City" disabled><option value="">City…</option></select>
      <button type="button" class="globe-world" id="globe-world">Whole globe</button>
    </div>
    <p class="globe-note" id="globe-note">Pick a country, or click one on the globe.</p>`;
  host.parentElement.appendChild(panel);
  const inCountry = $("globe-country"), elCities = $("globe-cities"), elNote = $("globe-note");
  let world = [];
  fetch("assets/world.json").then((r) => r.json()).then((w) => {
    world = w;
    $("globe-countries").innerHTML = w.map((c) => c.name).sort().map((n) => `<option value="${esc(n)}">`).join("");
  }).catch(() => { elNote.textContent = "Country list could not load."; });

  let markers = [], country = null, userTook = false, spinning = !REDUCED;
  const stopSpin = () => { spinning = false; userTook = true; };
  ["mousedown", "touchstart", "wheel", "keydown"].forEach((ev) => host.addEventListener(ev, stopSpin, { passive: true }));

  function flyCity(c) {
    stopSpin();
    map.flyTo({ center: [c.lon, c.lat], zoom: 11, pitch: 45, bearing: 18, duration: REDUCED ? 0 : 3200, essential: true });
    showPick(c.lon, c.lat, c.n);
  }
  function selectCountry(c, fromFilter, noFly) {
    if (!c) return;
    country = c; stopSpin(); inCountry.value = c.name;
    map.setFilter("country-sel", ["==", ["id"], c.i]);
    markers.forEach((m) => m.remove()); markers = [];
    elCities.innerHTML = `<option value="">City…</option>` + c.cities.map((ct, i) => `<option value="${i}">${esc(ct.n)}</option>`).join("");
    elCities.disabled = !c.cities.length;
    for (const ct of c.cities) {
      const el = document.createElement("div"); el.className = "gcity"; el.innerHTML = `<i></i>${esc(ct.n)}`;
      el.addEventListener("click", (e) => { e.stopPropagation(); flyCity(ct); });
      markers.push(new maplibregl.Marker({ element: el, anchor: "left" }).setLngLat([ct.lon, ct.lat]).addTo(map));
    }
    const has = DATA_COUNTRIES.includes(c.name);
    elNote.textContent = has
      ? `Fire record 2003–2025 shown.`
      : `Map only. Fire record covers Malaysia and Indonesia.`;
    if (noFly) return;
    const [x0, y0, x1, y1] = c.bbox;
    map.fitBounds([[x0, y0], [x1, y1]], { padding: 70, pitch: 30, bearing: 0, maxZoom: 8, duration: REDUCED ? 0 : 2600, essential: true });
    if (elReset) elReset.hidden = false;
    // keep the page's Area filter in step when the country has data
    if (has && !fromFilter) {
      const sel = $("f-scope");
      if (sel && sel.value !== c.name && [...sel.options].some((o) => o.value === c.name)) { sel.value = c.name; sel.dispatchEvent(new Event("change", { bubbles: true })); scopeShown = c.name; }
    }
  }
  inCountry.addEventListener("change", () => { const c = world.find((w) => w.name.toLowerCase() === inCountry.value.trim().toLowerCase()); if (c && c !== country) selectCountry(c); });
  elCities.addEventListener("change", () => { const ct = country && country.cities[+elCities.value]; if (elCities.value !== "" && ct) flyCity(ct); });
  $("globe-world").addEventListener("click", () => {
    stopSpin(); country = null; inCountry.value = ""; elCities.innerHTML = `<option value="">City…</option>`; elCities.disabled = true; markers.forEach((m) => m.remove()); markers = [];
    map.setFilter("country-sel", ["==", ["id"], -1]); elNote.textContent = "Pick a country, or click one on the globe.";
    map.flyTo({ center: [map.getCenter().lng, 10], zoom: 1.4, pitch: 0, bearing: 0, duration: REDUCED ? 0 : 2400, essential: true });
  });

  // ---- fire cells ----
  let cells = [], cellDeg = 0.1, flat = false, shown = "", req = 0;
  const hidden = [false, false, false];
  function draw() {
    const full = [];
    for (const c of cells) {
      const [lo, la, days, hs, frp] = c, k = klass(days), props = { k, days, hs, frp, lo: lo + cellDeg / 2, la: la + cellDeg / 2 };
      const m = cellDeg * 0.04;
      full.push({ type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [[[lo + m, la + m], [lo + cellDeg - m, la + m], [lo + cellDeg - m, la + cellDeg - m], [lo + m, la + cellDeg - m], [lo + m, la + m]]] } });
    }
    map.getSource("cells").setData({ type: "FeatureCollection", features: full });
    if (flames) flames.setCells(cells, cellDeg);
  }
  function applyFilter() {
    const keep = [0, 1, 2].filter((k) => !hidden[k]);
    const f = ["in", ["get", "k"], ["literal", keep]];
    // without WebGL flames the flat cells are the only view
    const flatNow = flat || !flames;
    map.setFilter("fire-flat", f); map.setFilter("fire-base", f);
    map.setLayoutProperty("fire-flat", "visibility", flatNow ? "visible" : "none");
    map.setLayoutProperty("fire-base", "visibility", flatNow ? "none" : "visible");
    if (flames) { flames.setHidden(hidden); flames.setVisible(!flatNow); }
    if (elMode) { elMode.textContent = flatNow ? "Show flames" : "Show flat cells"; elMode.hidden = !flames; }
  }
  async function load(year, month, scope, cell) {
    const key = [year, month, scope, cell].join("-"); if (key === shown) return; shown = key;
    const mine = ++req;
    try {
      const r = await fetch(`${API}/hotspots/grid?scope=${encodeURIComponent(scope)}&year=${year}&month=${month}&sensor=auto&cell=${cell}`);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json(); if (mine !== req) return;
      cellDeg = d.cell; cells = d.cells.map((c) => [c.lon, c.lat, c.cell_days, c.hotspots, c.frp]);
      const n = [0, 0, 0]; cells.forEach((c) => n[klass(c[2])]++);
      ["hero-n0", "hero-n1", "hero-n2"].forEach((id, i) => { const el = $(id); if (el) el.textContent = nf.format(n[i]); });
      elWhen.textContent = `${scope === "All" ? "Malaysia & Indonesia" : scope} · ${MONTHS[month - 1]} ${year} · ${d.sensor}`;
      elCount.textContent = nf.format(d.hotspots);
      elDetail.textContent = `hotspots in ${nf.format(d.cells.length)} cells of ${d.cell}° (about ${(d.cell * 111).toFixed(d.cell < 0.1 ? 1 : 0)} km)`;
      draw();
    } catch (e) {
      if (mine !== req) return;
      shown = ""; elWhen.textContent = "Hotspot data not loaded yet"; elCount.textContent = "–"; elDetail.textContent = "The map fills in once the data is available.";
    }
  }

  // ---- follow the page's Area / Year / Month filters ----
  let boxes = null, scopeShown = "All", ready = false;
  fetch(`${API}/regions`).then((r) => r.json()).then((rs) => { boxes = rs; }).catch(() => {});
  const isRegion = (sc) => (boxes || []).some((r) => r.region === sc);
  const cellFor = (sc) => (isRegion(sc) || map.getZoom() >= 6.6 ? 0.05 : 0.1);
  function focusScope(scope) {
    if (!boxes) return;
    if (DATA_COUNTRIES.includes(scope)) { const c = world.find((w) => w.name === scope); if (c) { selectCountry(c, true); return; } }
    const rs = scope === "All" ? [] : boxes.filter((r) => r.region === scope || r.country === scope);
    // a region was picked: show its country and cities in the panel, then fly to the region
    if (rs.length) { const c = world.find((w) => w.name === rs[0].country); if (c && c !== country) selectCountry(c, true, true); }
    const b = rs.length
      ? [[Math.min(...rs.map((r) => r.bbox[0])), Math.min(...rs.map((r) => r.bbox[1]))], [Math.max(...rs.map((r) => r.bbox[2])), Math.max(...rs.map((r) => r.bbox[3]))]]
      : HOME;
    stopSpin();
    map.fitBounds(b, { padding: 60, pitch: rs.length ? 45 : 30, bearing: 0, duration: REDUCED ? 0 : 2400, essential: true });
    if (elReset) elReset.hidden = !rs.length;
  }
  function tick() {
    const y = +($("f-year") || {}).value, m = +($("f-month") || {}).value, sc = (($("f-scope") || {}).value) || "All";
    if (!y || !m || !ready) return;
    if (sc !== scopeShown) { scopeShown = sc; focusScope(sc); }
    load(y, m, sc, cellFor(sc));
  }
  setInterval(tick, 600);
  map.on("zoomend", tick);

  // ---- relief only when close enough to see it ----
  let relief = false;
  map.on("zoom", () => {
    const z = map.getZoom();
    // Relief is for landscapes. At street level the elevation data is coarser than the buildings in the
    // photos, which bends them and can throw up spikes, so the ground goes flat again there.
    if (z >= 6.8 && z <= 11.6 && !relief) { relief = true; try { map.setTerrain({ source: "dem", exaggeration: 1.2 }); } catch (e) { /* relief is optional */ } }
    else if ((z < 4.2 || z > 12.2) && relief) { relief = false; try { map.setTerrain(null); } catch (e) { /* ignore */ } }
  });

  // ---- hover and click ----
  const FIRE = ["fire-base", "fire-flat"];
  function showPick(lon, lat, name) {
    if (!elPick) return;
    let hs = 0, nc = 0, top = 0;
    for (const c of cells) if (Math.abs(c[0] + cellDeg / 2 - lon) <= 0.25 && Math.abs(c[1] + cellDeg / 2 - lat) <= 0.25) { hs += c[3] || 0; nc++; top = Math.max(top, c[2]); }
    elPick.hidden = false; if (elReset) elReset.hidden = false;
    elPick.innerHTML = `<b>${name ? esc(name) + " · " : ""}${fmtLL(lon, lat)}</b><br>` +
      (nc ? `${nf.format(hs)} hotspots within about 28 km · ${nc} cells with fire · up to ${top} day${top === 1 ? "" : "s"} in one cell`
          : `No hotspots within about 28 km in the month and area shown.`);
  }
  map.on("mousemove", (e) => {
    if (!elTip) return;
    const f = map.queryRenderedFeatures(e.point, { layers: FIRE.filter((id) => map.getLayer(id)) })[0];
    if (!f) { elTip.hidden = true; map.getCanvas().style.cursor = ""; return; }
    const p = f.properties; map.getCanvas().style.cursor = "pointer";
    elTip.innerHTML = `<b>${fmtLL(+p.lo, +p.la)}</b><span>${esc(elWhen.textContent.split(" · ").slice(1, 2).join(""))}</span>` +
      `<dl><dt>Hotspots</dt><dd>${nf.format(+p.hs)}</dd><dt>Days with fire</dt><dd>${p.days}</dd><dt>Level</dt><dd>${NAMES[+p.k]}</dd>` +
      `<dt>Cell size</dt><dd>${(cellDeg * 111).toFixed(cellDeg < 0.1 ? 1 : 0)} km</dd></dl><i>Click to zoom in here</i>`;
    elTip.hidden = false;
    const w = host.clientWidth, h = host.clientHeight;
    elTip.style.left = Math.min(e.point.x + 16, w - 230) + "px"; elTip.style.top = Math.max(8, Math.min(e.point.y + 16, h - 170)) + "px";
  });
  map.on("mouseout", () => { if (elTip) elTip.hidden = true; });
  map.on("click", (e) => {
    stopSpin();
    const z = map.getZoom();
    if (z < 4.6) {   // far away: a click picks the country
      const f = map.queryRenderedFeatures(e.point, { layers: ["country-fill"] })[0];
      const c = f && world.find((w) => w.i === f.id);
      if (c) { selectCountry(c); return; }
    }
    map.flyTo({ center: e.lngLat, zoom: Math.min(11.5, Math.max(z + 2.2, 7.4)), pitch: 46, duration: REDUCED ? 0 : 2200, essential: true });
    showPick(e.lngLat.lng, e.lngLat.lat);
  });
  if (elReset) elReset.addEventListener("click", () => {
    if (elPick) elPick.hidden = true;
    if (country) selectCountry(country, true); else { scopeShown = "__"; tick(); }
  });
  if (elMode) elMode.addEventListener("click", () => { flat = !flat; applyFilter(); });
  document.querySelectorAll(".hero-legend li").forEach((li, i) => {
    li.setAttribute("role", "button"); li.tabIndex = 0; li.setAttribute("aria-pressed", "true"); li.title = "Click to hide or show";
    const flip = () => { hidden[i] = !hidden[i]; li.classList.toggle("off", hidden[i]); li.setAttribute("aria-pressed", String(!hidden[i])); applyFilter(); };
    li.addEventListener("click", flip);
    li.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); flip(); } });
  });

  // ---- scale bar: real ground distance at the centre of the view ----
  function scaleBar() {
    if (!elScale) return;
    const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return;
    const a = map.unproject([w / 2 - 50, h / 2]), b = map.unproject([w / 2 + 50, h / 2]);
    const pxPerKm = 100 / (a.distanceTo(b) / 1000); if (!(pxPerKm > 0) || !isFinite(pxPerKm)) return;
    const km = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find((k) => k * pxPerKm >= 70) || 5000;
    elScale.hidden = false; elScale.style.width = Math.round(km * pxPerKm) + "px"; elScale.textContent = km + " km";
  }
  map.on("move", scaleBar);

  // ---- intro: the whole Earth turning, then down to Malaysia and Indonesia ----
  map.on("load", () => {
    ready = true; applyFilter(); scaleBar(); tick();
    if (REDUCED) { map.fitBounds(HOME, { padding: 60, pitch: 30, duration: 0 }); return; }
    let last = performance.now();
    (function spin(now) {
      if (!spinning) return;
      const dt = Math.min(60, now - last); last = now;
      const c = map.getCenter(); map.setCenter([c.lng + dt * 0.004, c.lat]);
      requestAnimationFrame(spin);
    })(last);
    setTimeout(() => {
      if (userTook) return;
      spinning = false;
      map.fitBounds(HOME, { padding: 60, pitch: 30, duration: 4200, essential: true });
    }, 3200);
  });
  map.on("error", (e) => { if (e && e.error && !/tile|404|Failed to fetch|AJAX/i.test(String(e.error.message))) console.warn("[globe]", e.error.message); });
}

start().catch((e) => {
  console.warn("[globe]", e);
  const w = document.getElementById("hero-when"); if (w) w.textContent = "3D globe could not load";
});
