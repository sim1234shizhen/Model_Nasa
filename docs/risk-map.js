/* Forecast "where" map: fire risk as a mist on a tilted disc.
   - The forecast grid (one chance per ~28 km cell and month) is smoothed into a continuous field and coloured,
     so risk reads as glowing areas instead of a mosaic of squares. Hovering still reports the cell's own value.
   - The field is drawn on a canvas that MapLibre drapes over a dark basemap, so it tilts and turns with the map.
   - Changing month blends the field from one month to the next.
   - The study area is cut out as a disc with ring lines; the view drifts slowly until the reader takes over.
   Built on MapLibre GL JS (BSD-3), the same library as the overview globe. */

const ML = "https://unpkg.com/maplibre-gl@5.24.1/dist/";
const PX = 10;            // canvas pixels per grid cell
const PAD = 3;            // empty cells around the grid so the mist can fade out
const BG = "#070b10";
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const EMPTY = { type: "FeatureCollection", features: [] };

function loadLib() {
  if (window.maplibregl) return Promise.resolve();
  if (!document.querySelector(`link[href="${ML}maplibre-gl.css"]`)) {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = ML + "maplibre-gl.css"; document.head.appendChild(link);
  }
  return new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = ML + "maplibre-gl.js";
    s.onload = () => res(); s.onerror = () => rej(new Error("map library did not load")); document.head.appendChild(s);
  });
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
  await loadLib();
  const maplibregl = window.maplibregl;
  const reduced = !!opts.reduced;
  const lut = buildLut(opts.stops);

  const map = new maplibregl.Map({
    container: host, center: [107, 1], zoom: 3.6, pitch: 46, bearing: -8, maxPitch: 60, minZoom: 2.5, maxZoom: 9,
    attributionControl: false, dragRotate: true,
    style: {
      version: 8,
      sources: {
        dark: { type: "raster", tileSize: 256, maxzoom: 12, attribution: "Basemap © Esri, HERE, Garmin, © OpenStreetMap contributors",
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"] },
        names: { type: "raster", tileSize: 256, maxzoom: 12,
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}"] },
        mask: { type: "geojson", data: EMPTY }, rings: { type: "geojson", data: EMPTY },
        area: { type: "geojson", data: EMPTY }, cell: { type: "geojson", data: EMPTY },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": BG } },
        { id: "dark", type: "raster", source: "dark", paint: { "raster-brightness-max": 0.85, "raster-saturation": -0.2 } },
        // the mist layer is inserted here once the forecast arrives
        { id: "names", type: "raster", source: "names", minzoom: 4.6, paint: { "raster-opacity": 0.7 } },
        { id: "area-fill", type: "fill", source: "area", paint: { "fill-color": "#ffffff", "fill-opacity": 0.1 } },
        { id: "area-line", type: "line", source: "area", paint: { "line-color": "#ffe9a8", "line-width": 1.6, "line-opacity": 0.95 } },
        { id: "cell-line", type: "line", source: "cell", paint: { "line-color": "#ffffff", "line-width": 1.4 } },
        { id: "mask", type: "fill", source: "mask", paint: { "fill-color": BG, "fill-antialias": true } },
        { id: "rings", type: "line", source: "rings", paint: { "line-color": "#5fd4c4", "line-width": ["get", "w"], "line-opacity": ["get", "o"] } },
      ],
    },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-left");
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
  new ResizeObserver(() => map.resize()).observe(host);
  await new Promise((res) => (map.loaded() ? res() : map.once("load", res)));

  const tip = document.createElement("div"); tip.className = "rk-tip"; tip.hidden = true; host.parentElement.appendChild(tip);

  // ---- state for the forecast currently shown ----
  let data = null, month = 0, cell = 0.25;
  let lon0 = 0, lat0 = 0, cols = 0, rows = 0;         // grid origin (SW corner) and size, padding included
  let grids = [], info = [];                           // per month: Float32Array of chance, Map(index -> [pct, fireDays*10, area])
  let shown = null, anim = 0, home = null, pins = [], hlArea = -1;
  const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d");
  let img = null, tmp = null;

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

  // ---- a new forecast: rebuild the grid, the disc and the mist layer ----
  const circle = (cx, cy, r, n = 96) => Array.from({ length: n + 1 }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)]);
  function setData(d) {
    data = d; cell = d.cell_deg; shown = null;
    let a = Infinity, b = Infinity, c = -Infinity, e = -Infinity;
    for (const m of d.months) for (const [la, lo] of m.cells) { if (lo < a) a = lo; if (la < b) b = la; if (lo > c) c = lo; if (la > e) e = la; }
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
    map.addLayer({ id: "mist", type: "raster", source: "mist", paint: { "raster-fade-duration": 0, "raster-resampling": "linear", "raster-opacity": 0.94 } }, "names");

    // the disc: everything outside a circle around the forecast area is covered
    const cx = (a + c + cell) / 2, cy = (b + e + cell) / 2, r = Math.hypot((c - a + cell) / 2, (e - b + cell) / 2) * 0.86 + 0.6;
    map.getSource("mask").setData({ type: "Feature", properties: {}, geometry: { type: "Polygon",
      coordinates: [[[-179.9, -84], [179.9, -84], [179.9, 84], [-179.9, 84], [-179.9, -84]], circle(cx, cy, r).reverse()] } });
    map.getSource("rings").setData({ type: "FeatureCollection", features: [[1, 1.4, 0.8], [1.045, 0.8, 0.35], [1.1, 0.6, 0.18]].map(([k, wd, o]) =>
      ({ type: "Feature", properties: { w: wd, o }, geometry: { type: "LineString", coordinates: circle(cx, cy, r * k) } })) });
    home = [[cx - r * 0.9, cy - r * 0.9], [cx + r * 0.9, cy + r * 0.9]];   // tighter than the disc: the tilt leaves room
    resetView(false);
  }

  // ---- labels for the leading areas of the month ----
  function setPins() {
    pins.forEach((p) => p.remove()); pins = [];
    if (!data) return;
    const mo = data.months[month - 1];
    mo.top_areas.slice(0, 5).forEach((a, rank) => {
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
      const el = p.getElement(), pt = map.project(p.getLngLat()), w = el.offsetWidth || 120;
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
    stopDrift();
    map.fitBounds([[Math.min(...cs.map((c) => c[1])) - 0.5, Math.min(...cs.map((c) => c[0])) - 0.5], [Math.max(...cs.map((c) => c[1])) + cell + 0.5, Math.max(...cs.map((c) => c[0])) + cell + 0.5]],
      { padding: 30, pitch: 46, maxZoom: 7.5, duration: reduced ? 0 : 1600, essential: true });
    if (opts.onMoved) opts.onMoved(true);
  }
  function resetView(animate = true) {
    if (!home) return;
    map.fitBounds(home, { padding: { top: 8, bottom: 8, left: 8, right: 8 }, pitch: 46, bearing: -8, duration: animate && !reduced ? 1400 : 0, essential: true });
    if (opts.onMoved) opts.onMoved(false);
  }

  // ---- slow drift of the view until the reader takes over ----
  let drifting = !reduced, driftT = 0, lastT = 0, lastFit = 0;
  function stopDrift() { drifting = false; }
  ["mousedown", "touchstart", "wheel", "keydown"].forEach((ev) => host.addEventListener(ev, () => { stopDrift(); if (opts.onMoved) opts.onMoved(true); }, { passive: true }));
  (function drift(now) {
    if (!drifting) return;
    if (host.clientWidth && !document.hidden && !map.isMoving()) {
      driftT += Math.min(60, now - (lastT || now)) / 1000;
      map.setBearing(-8 + Math.sin(driftT * 0.16) * 13);
      if (now - lastFit > 400) { lastFit = now; declutter(); }
    }
    lastT = now;
    requestAnimationFrame(drift);
  })(0);

  // ---- hover: the cell's own forecast, and its true outline ----
  function probe(e) {
    if (!data) return;
    const c = Math.floor((e.lngLat.lng - lon0) / cell), r = Math.floor((e.lngLat.lat - lat0) / cell);
    const hit = c >= 0 && c < cols && r >= 0 && r < rows ? info[month - 1].get(r * cols + c) : null;
    if (!hit) { tip.hidden = true; map.getSource("cell").setData(EMPTY); map.getCanvas().style.cursor = ""; return; }
    const la = lat0 + r * cell, lo = lon0 + c * cell, [pct, fd10, ai] = hit;
    map.getSource("cell").setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: square(la, lo) } });
    map.getCanvas().style.cursor = "crosshair";
    tip.innerHTML = `<b>${pct}% chance</b> of fire in ${MONTHS_LONG[month - 1]} ${data.year}<br>${esc(data.areas[ai])} · about ${(fd10 / 10).toFixed(1)} fire days expected` +
      `<span>This cell: ${Math.abs(la + cell / 2).toFixed(2)}°${la + cell / 2 >= 0 ? "N" : "S"}, ${(lo + cell / 2).toFixed(2)}°E · ${cell}° wide</span>`;
    tip.hidden = false;
    const w = host.clientWidth, h = host.clientHeight;
    tip.style.left = Math.min(e.point.x + 14, w - 236) + "px"; tip.style.top = Math.max(6, Math.min(e.point.y + 14, h - 96)) + "px";
  }
  map.on("mousemove", probe);
  map.on("click", probe);      // touch screens have no hover
  map.on("mouseout", () => { tip.hidden = true; map.getSource("cell").setData(EMPTY); });

  return {
    // show a forecast and a month; a new forecast rebuilds the map, a new month blends the mist
    show(d, m) {
      const fresh = d !== data;
      if (fresh) setData(d);
      if (fresh || m !== month) {
        month = m; hlArea = -2; highlightArea(-1);
        blendTo(grids[m - 1], !fresh);
        setPins();
      }
    },
    highlightArea, focusArea, resetView,
    resize() { map.resize(); },
  };
}
