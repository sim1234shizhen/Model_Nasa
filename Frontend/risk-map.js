import { createFlames } from "./fire-flames.js?v=animated-country-flames";
/* Explorer forecast map: fire risk as a smoothed layer over a basemap.
   - The forecast grid (one chance per ~28 km cell and month) is smoothed into a continuous field and coloured,
     so risk reads as glowing areas instead of a mosaic of squares. Hovering still reports the cell's own value.
   - The field is drawn on a canvas that MapLibre drapes over the shared satellite globe, so it tilts and turns with the map.
   - Changing month blends the field from one month to the next.
   Built on MapLibre GL JS (BSD-3), the same library as the overview globe. */

import { explorerCamera, frameExplorerMap, satelliteStyle } from "./satellite-map.js";

const ML = "https://unpkg.com/maplibre-gl@5.24.1/dist/";
const PX = 10;            // canvas pixels per grid cell
/* A flame is only drawn once a cell has a real chance of burning. Below this the
   cell stays in the data and stays coloured on the heat map, it just gets no fire
   icon - otherwise a typical month paints a flame on nearly every cell. */
const FLAME_MIN = 30;
const chanceBand = (chance) => chance >= 70 ? 2 : chance >= 45 ? 1 : 0;
const PAD = 3;            // empty cells around the grid so the mist can fade out
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const EMPTY = { type: "FeatureCollection", features: [] };
const nf = new Intl.NumberFormat("en");

let library;
export function loadMapLibre() {
  if (library) return library;
  if (window.maplibregl) return Promise.resolve();
  if (!document.querySelector(`link[href="${ML}maplibre-gl.css"]`)) {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = ML + "maplibre-gl.css"; document.head.appendChild(link);
  }
  library = new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = ML + "maplibre-gl.js";
    s.onload = res; s.onerror = () => { library = null; s.remove(); rej(new Error("MapLibre could not load")); }; document.head.appendChild(s);
  });
  return library;
}

// colour and opacity for every whole percent, from the stops [pct, "#rrggbb", alpha]
function buildLut(stops) {
  const lut = new Uint8ClampedArray(101 * 4);
  const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  for (let p = 0; p <= 100; p++) {
    let i = 0; while (i < stops.length - 2 && p > stops[i + 1][0]) i++;
    const [p0, c0, a0] = stops[i], [p1, c1, a1] = stops[i + 1];
    const t = Math.min(1, Math.max(0, (p - p0) / (p1 - p0))), A = rgb(c0), B = rgb(c1);
    // below the first stop the mist thins out to nothing
    const fade = p >= p0 ? 1 : Math.max(0, (p - (p0 - 3.5)) / 3.5);
    for (let k = 0; k < 3; k++) lut[p * 4 + k] = A[k] + (B[k] - A[k]) * t;
    lut[p * 4 + 3] = (a0 + (a1 - a0) * t) * fade * 255;
  }
  return lut;
}

// cubic B-spline weights for each sub-pixel position: smooth upsampling with no blocky edges
const W4 = Array.from({ length: PX }, (_, i) => {
  const t = (i + 0.5) / PX, t2 = t * t, t3 = t2 * t;
  return [(1 - 3 * t + 3 * t2 - t3) / 6, (4 - 6 * t2 + 3 * t3) / 6, (1 + 3 * t + 3 * t2 - 3 * t3) / 6, t3 / 6];
});

export async function createRiskMap(host, opts = {}) {
  await loadMapLibre();
  const maplibregl = window.maplibregl;
  const reduced = !!opts.reduced;
  const lut = buildLut(opts.stops);

  const style = satelliteStyle();
  Object.assign(style.sources, {
    area: { type: "geojson", data: EMPTY },
    cell: { type: "geojson", data: EMPTY },
    "world-outlook-points": { type: "geojson", data: EMPTY },
  });
  const countryLine = style.layers.findIndex(({ id }) => id === "country-line");
  style.layers.splice(countryLine, 0,
    { id: "world-outlook", type: "fill", source: "countries", paint: {
      "fill-color": "transparent", "fill-outline-color": "transparent",
    } },
    { id: "world-outlook-points", type: "circle", source: "world-outlook-points", paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "activity"], 0, 8, 1, 14],
      "circle-color": "#f18436", "circle-opacity": 0.85,
    } },
  );
  style.layers.push(
    { id: "area-fill", type: "fill", source: "area", paint: { "fill-color": "#ffffff", "fill-opacity": 0.1 } },
    { id: "area-line", type: "line", source: "area", paint: { "line-color": "#ffe9a8", "line-width": 1.6, "line-opacity": 0.95 } },
    { id: "cell-line", type: "line", source: "cell", paint: { "line-color": "#ffffff", "line-width": 1.4 } },
  );

  const map = new maplibregl.Map({ ...explorerCamera, container: host, style });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-left");
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Forecast map did not finish loading")), 15000);
      map.once("load", () => { clearTimeout(timeout); resolve(); });
    });
  } catch (error) {
    map.remove();
    throw error;
  }

  let flames;
  let hiddenBands = [false, false, false];
  try {
    flames = createFlames(map, {
      reduced,
      classify: (chance) => chance >= 70 ? 2 : chance >= 45 ? 1 : 0,
      heightValue: (chance) => chance / 5,
      // FLAME_MIN draws as a small ember, 80%+ as a full flame
      sizeValue: (chance) => 0.42 + 0.58 * Math.min(1, Math.max(0, (chance - FLAME_MIN) / (80 - FLAME_MIN))),
    });
    flames?.setHidden(hiddenBands);
  } catch (error) {
    host.querySelector(".fire-flames")?.remove();
    console.warn("[forecast flames]", error);
  }
  let showFlames = Boolean(flames);
  // Keep the circle layer available for hover and as a fallback without the animation canvas.
  if (flames) map.setPaintProperty("world-outlook-points", "circle-opacity", 0);

  const tip = document.createElement("div"); tip.className = "rk-tip"; tip.hidden = true; host.appendChild(tip);

  // ---- state for the forecast currently shown ----
  let data = null, month = 0, cell = 0.25;
  let lon0 = 0, lat0 = 0, cols = 0, rows = 0;         // grid origin (SW corner) and size, padding included
  let grids = [], info = [];                           // per month: Float32Array of chance, Map(index -> [pct, fireDays*10, area])
  let shown = null, anim = 0, focus = null, pins = [], hlArea = -1;
  const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d");
  let img = null, tmp = null;
  let autoFrame = true;
  let seasonalData, seasonalMonth, seasonalYear, cityMarker;
  const seasonalPlaces = new Map();

  function showWorld(outlook, selectedMonth, selectedYear) {
    if (outlook === seasonalData && selectedMonth === seasonalMonth && selectedYear === seasonalYear) return;
    seasonalData = outlook;
    seasonalMonth = selectedMonth;
    seasonalYear = selectedYear;
    seasonalPlaces.clear();
    const points = [], markers = [];
    for (const entry of outlook?.countries ?? []) {
      const estimate = entry.months[selectedMonth];
      if (!estimate) continue;
      const [high, activity] = estimate;
      const values = {
        name: entry.country, high, activity,
        peak: entry.peak?.[selectedMonth] ?? 0,
        expected: entry.expected?.[selectedMonth] ?? 0,
      };
      seasonalPlaces.set(entry.country, values);
      for (const name of entry.shapes) seasonalPlaces.set(name, values);
      // This pin represents the country's total, so use its map center.
      if (high > 0 && entry.center) {
        markers.push([...entry.center, activity]);
        points.push({
          type: "Feature", properties: values,
          geometry: { type: "Point", coordinates: entry.center },
        });
      }
    }
    map.getSource("world-outlook-points").setData({ type: "FeatureCollection", features: points });
    flames?.setCountryMarkers(markers);
    tip.hidden = true;
  }

  function showGlobe() {
    autoFrame = false;
    map.flyTo({ center: [map.getCenter().lng, 6], zoom: 1.4, pitch: 0, bearing: 0, duration: reduced ? 0 : 1000 });
  }


  // ---- draw one field (chance per cell) onto the canvas ----
  function paint(vals) {
    const W = cols * PX, H = rows * PX, out = img.data;
    // horizontal pass
    for (let r = 0; r < rows; r++) {
      const base = r * cols;
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5) / PX - 0.5, c = Math.floor(u), w = W4[Math.min(PX - 1, Math.floor((u - c) * PX))];
        let v = 0;
        for (let k = 0; k < 4; k++) { const cc = c - 1 + k; if (cc >= 0 && cc < cols) v += vals[base + cc] * w[k]; }
        tmp[r * W + x] = v;
      }
    }
    // vertical pass, colour lookup; canvas row 0 is the north edge
    for (let y = 0; y < H; y++) {
      const u = (H - 1 - y + 0.5) / PX - 0.5, r0 = Math.floor(u), w = W4[Math.min(PX - 1, Math.floor((u - r0) * PX))];
      for (let x = 0; x < W; x++) {
        let v = 0;
        for (let k = 0; k < 4; k++) { const rr = r0 - 1 + k; if (rr >= 0 && rr < rows) v += tmp[rr * W + x] * w[k]; }
        // the smoothing flattens single-cell peaks a little; lift the field so strong cells still read as strong
        const p = Math.min(100, Math.max(0, Math.round(v * 1.12))) * 4, o = (y * W + x) * 4;
        out[o] = lut[p]; out[o + 1] = lut[p + 1]; out[o + 2] = lut[p + 2]; out[o + 3] = lut[p + 3];
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  function refresh(keepPlaying) {
    const src = map.getSource("mist"); if (!src) return;
    src.play(); map.triggerRepaint();
    if (!keepPlaying) setTimeout(() => { if (!anim) src.pause(); }, 120);
  }
  function blendTo(target, animate) {
    cancelAnimationFrame(anim); anim = 0;
    if (!shown || !animate || reduced) { shown = Float32Array.from(target); paint(shown); refresh(false); return; }
    const from = Float32Array.from(shown), t0 = performance.now(), DUR = 750;
    (function step(now) {
      const t = Math.min(1, (now - t0) / DUR), e = t * t * (3 - 2 * t);
      for (let i = 0; i < shown.length; i++) shown[i] = from[i] + (target[i] - from[i]) * e;
      paint(shown); refresh(true);
      if (t < 1) anim = requestAnimationFrame(step); else { anim = 0; refresh(false); }
    })(t0);
  }

  // ---- a new forecast: rebuild the grid and the mist layer ----
  function setData(d) {
    data = d; cell = d.cell_deg; shown = null;
    let a = Infinity, b = Infinity, c = -Infinity, e = -Infinity;
    for (const m of d.extentMonths || d.months) for (const [la, lo] of m.cells) { if (lo < a) a = lo; if (la < b) b = la; if (lo > c) c = lo; if (la > e) e = la; }
    if (!Number.isFinite(a)) { img = null; return; }
    lon0 = a - PAD * cell; lat0 = b - PAD * cell;
    cols = Math.round((c - a) / cell) + 1 + PAD * 2; rows = Math.round((e - b) / cell) + 1 + PAD * 2;
    grids = []; info = [];
    for (const m of d.months) {
      const g = new Float32Array(cols * rows), mp = new Map();
      for (const [la, lo, pct, fd10, ai] of m.cells) {
        const i = Math.round((la - lat0) / cell) * cols + Math.round((lo - lon0) / cell);
        g[i] = pct; mp.set(i, [pct, fd10, ai]);
      }
      grids.push(g); info.push(mp);
    }
    canvas.width = cols * PX; canvas.height = rows * PX;
    img = ctx.createImageData(canvas.width, canvas.height); tmp = new Float32Array(rows * canvas.width);

    if (map.getLayer("mist")) map.removeLayer("mist");
    if (map.getSource("mist")) map.removeSource("mist");
    const w = lon0, s = lat0, ee = lon0 + cols * cell, n = lat0 + rows * cell;
    map.addSource("mist", { type: "canvas", canvas, animate: false, coordinates: [[w, n], [ee, n], [ee, s], [w, s]] });
    map.addLayer({ id: "mist", type: "raster", source: "mist", layout: { visibility: showFlames ? "none" : "visible" }, paint: { "raster-fade-duration": 0, "raster-resampling": "linear", "raster-opacity": 0.94 } }, "places");

  }

  // ---- labels for the leading areas of the month ----
  function setPins() {
    pins.forEach((p) => p.remove()); pins = [];
    if (!data) return;
    const mo = data.months[month - 1];
    mo.top_areas.filter((a) => !hiddenBands[chanceBand(a.max_chance_pct)]).slice(0, 5).forEach((a, rank) => {
      const ai = data.areas.indexOf(a.area);
      let sx = 0, sy = 0, sw = 0;
      for (const [la, lo, pct, , cai] of mo.cells) if (cai === ai) { const w = pct * pct; sx += (lo + cell / 2) * w; sy += (la + cell / 2) * w; sw += w; }
      if (!sw) return;
      const el = document.createElement("button"); el.type = "button"; el.className = "rk-pin" + (rank === 0 ? " first" : "");
      el.innerHTML = `<span><b>${rank + 1}</b>${esc(a.area)}<i>${a.max_chance_pct}%</i></span>`;
      el.addEventListener("click", (ev) => { ev.stopPropagation(); focusArea(ai); });
      pins.push(new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([sx / sw, sy / sw]).addTo(map));
    });
    declutter();
  }
  // labels that would cover each other stand on longer stems instead
  function declutter() {
    const taken = [];
    for (const p of pins) {
      const el = p.getElement(), location = p.getLngLat();
      el.hidden = map.getZoom() < 2.75 || Boolean(map.transform.isLocationOccluded?.(location));
      if (el.hidden) continue;
      const pt = map.project(location), w = el.offsetWidth || 120;
      let level = 0, box;
      for (; level < 5; level++) {
        const stem = 18 + level * 25;
        box = [pt.x - w / 2 - 3, pt.y - stem - 24, pt.x + w / 2 + 3, pt.y - stem];
        if (!taken.some((t) => box[0] < t[2] && box[2] > t[0] && box[1] < t[3] && box[3] > t[1])) break;
      }
      const stem = 18 + Math.min(level, 4) * 25;
      el.style.paddingBottom = stem + "px"; el.style.backgroundSize = `1px ${stem}px`;
      taken.push(box);
    }
  }
  map.on("moveend", declutter);

  const square = (la, lo) => [[lo, la], [lo + cell, la], [lo + cell, la + cell], [lo, la + cell], [lo, la]];
  function highlightArea(ai) {
    if (ai === hlArea) return; hlArea = ai;
    const feats = [];
    if (data && ai >= 0) for (const [la, lo, , , cai] of data.months[month - 1].cells) if (cai === ai) feats.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [square(la, lo)] } });
    map.getSource("area").setData({ type: "FeatureCollection", features: feats });
  }
  function focusArea(ai) {
    if (!data) return;
    const cs = data.months[month - 1].cells.filter((c) => c[4] === ai); if (!cs.length) return;
    autoFrame = false;
    frameExplorerMap(map, [
      Math.min(...cs.map((c) => c[1])), Math.min(...cs.map((c) => c[0])),
      Math.max(...cs.map((c) => c[1])) + cell, Math.max(...cs.map((c) => c[0])) + cell,
    ], reduced ? 0 : 900);
  }

  function resetView(animate = true) {
    autoFrame = true;
    frameExplorerMap(map, focus, animate && !reduced ? 900 : 0);
  }

  map.on("movestart", (event) => { if (event.originalEvent) autoFrame = false; });
  new ResizeObserver(() => {
    if (!host.clientWidth || !host.clientHeight) return;
    map.resize();
    if (autoFrame) resetView(false);
  }).observe(host);

  // ---- hover: the cell's own forecast, and its true outline ----
  function probe(e) {
    const c = Math.floor((e.lngLat.lng - lon0) / cell), r = Math.floor((e.lngLat.lat - lat0) / cell);
    const hit = data && c >= 0 && c < cols && r >= 0 && r < rows ? info[month - 1]?.get(r * cols + c) : null;
    if (!hit) {
      map.getSource("cell").setData(EMPTY);
      const feature = map.queryRenderedFeatures(e.point, { layers: ["world-outlook-points", "world-outlook"] })
        .find((entry) => seasonalPlaces.has(entry.properties.name));
      const country = seasonalPlaces.get(feature?.properties.name);
      map.getCanvas().style.cursor = country ? "pointer" : "";
      if (!country) { tip.hidden = true; return; }
      tip.innerHTML = `<b>${esc(country.name)}</b> · ${MONTHS_LONG[seasonalMonth - 1]} ${seasonalYear}<br>`
        + `${nf.format(country.high)} cells ≥50% · peak ${country.peak}%<span>Country model estimate · ${nf.format(country.expected)} fire cell-days expected</span>`;
      positionTip(e);
      return;
    }
    const la = lat0 + r * cell, lo = lon0 + c * cell, [pct, fd10, ai] = hit;
    map.getSource("cell").setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: square(la, lo) } });
    map.getCanvas().style.cursor = "crosshair";
    tip.innerHTML = `<b>${pct}% chance</b> of fire in ${MONTHS_LONG[month - 1]} ${data.year}<br>${esc(data.areas[ai])} · about ${(fd10 / 10).toFixed(1)} fire days expected` +
      `<span>This cell: ${Math.abs(la + cell / 2).toFixed(2)}°${la + cell / 2 >= 0 ? "N" : "S"}, ${(lo + cell / 2).toFixed(2)}°E · ${cell}° wide</span>`;
    positionTip(e);
  }

  function positionTip(e) {
    tip.hidden = false;
    const w = host.clientWidth, h = host.clientHeight;
    tip.style.left = Math.max(6, Math.min(e.point.x + 14, w - 236)) + "px"; tip.style.top = Math.max(6, Math.min(e.point.y + 14, h - 96)) + "px";
  }
  map.on("mousemove", probe);
  map.on("click", probe);      // touch screens have no hover
  map.on("mouseout", () => { tip.hidden = true; map.getSource("cell").setData(EMPTY); });

  function drawForecast(animate) {
    if (!img) return;
    if (showFlames) {
      // Only cells with a real chance get a flame. The API sends everything from 5%
      // up, and in a typical month most of that is 10-30% - drawing a flame on each
      // one covers the map and makes a 22% cell look like a severe one. The heat map
      // mode still shows the full continuous field, including the low end.
      const cells = data.months[month - 1].cells
        .filter(([, , chance]) => chance >= FLAME_MIN)
        .map(([lat, lon, chance]) => [lon, lat, chance]);
      flames.setCells(cells, cell);
    } else {
      blendTo(grids[month - 1], animate);
    }
  }

  return {
    // show a forecast and a month; a new forecast rebuilds the map, a new month blends the mist
    showWorld,
    showGlobe,
    show(d, m) {
      if (!d) {
        data = null;
        pins.forEach((pin) => pin.remove());
        pins = [];
        flames?.setCells([], cell);
        if (map.getLayer("mist")) map.removeLayer("mist");
        if (map.getSource("mist")) map.removeSource("mist");
        return;
      }
      const fresh = d !== data;
      if (fresh) setData(d);
      if (!img) return;
      if (fresh || m !== month) {
        month = m; hlArea = -2; highlightArea(-1);
        drawForecast(!fresh);
        setPins();
      }
    },
    get canShowFlames() { return Boolean(flames); },
    get showingFlames() { return showFlames; },
    setHiddenBands(h) {
      hiddenBands = h.slice();
      flames?.setHidden(hiddenBands);
      if (data) setPins();
    },
    toggleFlames() {
      if (!flames) return;
      showFlames = !showFlames;
      flames.setGridVisible(showFlames);
      if (map.getLayer("mist")) {
        map.setLayoutProperty("mist", "visibility", showFlames ? "none" : "visible");
      }
      if (showFlames) {
        cancelAnimationFrame(anim);
        anim = 0;
        shown = null;
        map.getSource("mist")?.pause();
      }
      drawForecast(false);
    },
    resetView,
    setFocus(target) {
      focus = target;
      const city = target?.city;
      if (city) {
        if (!cityMarker) {
          const pin = document.createElement("div");
          pin.className = "city-pin";
          cityMarker = new maplibregl.Marker({ element: pin, anchor: "bottom" })
            .setLngLat([city.lon, city.lat]).addTo(map);
        }
        cityMarker.setLngLat([city.lon, city.lat]).getElement().textContent = city.name;
      } else if (cityMarker) {
        cityMarker.remove();
        cityMarker = null;
      }
      resetView();
    },
    resize() { map.resize(); },
  };
}
