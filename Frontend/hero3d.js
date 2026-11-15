/* 3D hero: NASA Blue Marble imagery draped on real terrain, with one column per
   grid cell (0.1 degree, or 0.05 degree when zoomed to one region or a clicked spot) that had fire in the month selected below.
   Colour is the number of days with fire in that cell: light 1-2, moderate 3-7, heavy 8+.
   It reads the same /api/hotspots/grid endpoint as the 2D map, so it always
   matches the Year / Month filters. If WebGL is unavailable the page still works. */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

const API = (window.API_BASE || "") + "/api";
const host = document.getElementById("hero3d");
const labelHost = document.getElementById("hero-labels");
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const nf = new Intl.NumberFormat("en-US");

// Map window: lon 94..120, lat -7..8. One scene unit = one degree.
const LON0 = 94, LON1 = 120, LAT0 = -7, LAT1 = 8, GW = 1040, GH = 600;
const HS = 0.00022, DS = 0.00003;            // vertical scale for land (exaggerated) and sea
const P = (lon, lat, y = 0) => new THREE.Vector3(lon - 107, y, -(lat - 0.5));
let ELEV = null;

function elevAt(lon, lat) {
  let x = (lon - LON0) / (LON1 - LON0) * GW - 0.5, y = (LAT1 - lat) / (LAT1 - LAT0) * GH - 0.5;
  x = Math.max(0, Math.min(GW - 1.001, x)); y = Math.max(0, Math.min(GH - 1.001, y));
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * GW + x0;
  return ELEV[i] * (1 - fx) * (1 - fy) + ELEV[i + 1] * fx * (1 - fy) + ELEV[i + GW] * (1 - fx) * fy + ELEV[i + GW + 1] * fx * fy;
}
const yAt = (lon, lat) => { const e = elevAt(lon, lat); return e > 0 ? e * HS : e * DS; };

function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("could not load " + src)); i.src = src; });
}

async function start() {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch (e) { fail("3D view unavailable in this browser"); return; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  host.appendChild(renderer.domElement);
  const labels = new CSS2DRenderer();
  labelHost.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x03080d, 0.016);
  const camera = new THREE.PerspectiveCamera(36, 2, 0.1, 160);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.enableZoom = false; controls.enablePan = false;   // keep page scrolling natural
  controls.maxPolarAngle = 1.35; controls.minPolarAngle = 0.05;
  const TARGET = P(107, 0.2, 0);           // where the camera looks; moves with the Area filter
  let halfW = 13, halfH = 7.5;             // half extent of the area in view, in degrees
  controls.target.copy(TARGET);

  scene.add(new THREE.HemisphereLight(0xbfe6ff, 0x08141c, 0.7));
  const sun = new THREE.DirectionalLight(0xfff0dc, 2.8); sun.position.set(-9, 3.2, -6); scene.add(sun);

  // ---- terrain ----
  const dem = await loadImage("assets/dem.png");
  const cv = document.createElement("canvas"); cv.width = GW; cv.height = GH;
  const cx = cv.getContext("2d", { willReadFrequently: true }); cx.drawImage(dem, 0, 0);
  const px = cx.getImageData(0, 0, GW, GH).data; ELEV = new Float32Array(GW * GH);
  for (let i = 0; i < GW * GH; i++) ELEV[i] = px[i * 4] * 256 + px[i * 4 + 1] - 32768;
  const tex = await new THREE.TextureLoader().loadAsync("assets/earth.jpg");
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const world = new THREE.Group(); scene.add(world);   // everything that rises from flat
  const geo = new THREE.PlaneGeometry(LON1 - LON0, LAT1 - LAT0, 519, 299); geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let k = 0; k < pos.count; k++) pos.setY(k, yAt(pos.getX(k) + 107, 0.5 - pos.getZ(k)));
  geo.computeVertexNormals();
  const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0 }));
  world.add(terrain);
  const wgeo = new THREE.PlaneGeometry(LON1 - LON0, LAT1 - LAT0, 208, 120); wgeo.rotateX(-Math.PI / 2);
  const wpos = wgeo.attributes.position;
  for (let k = 0; k < wpos.count; k++) wpos.setY(k, yAt(wpos.getX(k) + 107, 0.5 - wpos.getZ(k)) + 0.012);
  const quad = [];   // lines along the grid only, no diagonals
  for (let j = 0; j <= 120; j++) for (let i = 0; i <= 208; i++) {
    const a = j * 209 + i; if (i < 208) quad.push(a, a + 1); if (j < 120) quad.push(a, a + 209);
  }
  const lgeo = new THREE.BufferGeometry(); lgeo.setAttribute("position", wpos); lgeo.setIndex(quad);
  world.add(new THREE.LineSegments(lgeo, new THREE.LineBasicMaterial({ color: 0x4fd8ff, transparent: true, opacity: 0.16, depthWrite: false, toneMapped: false })));

  // slab sides
  const BASE = -0.7, edge = [[LON0, LAT1], [LON1, LAT1], [LON1, LAT0], [LON0, LAT0], [LON0, LAT1]];
  const wp = [], wc = [];
  for (let e = 0; e < 4; e++) {
    const [a, b] = edge[e], [c, d] = edge[e + 1], n = 120;
    for (let s = 0; s < n; s++) {
      const p0 = [a + (c - a) * s / n, b + (d - b) * s / n], p1 = [a + (c - a) * (s + 1) / n, b + (d - b) * (s + 1) / n];
      const A = P(p0[0], p0[1], yAt(...p0)), B = P(p1[0], p1[1], yAt(...p1)), C = P(p1[0], p1[1], BASE), D = P(p0[0], p0[1], BASE);
      wp.push(...A.toArray(), ...B.toArray(), ...C.toArray(), ...A.toArray(), ...C.toArray(), ...D.toArray());
      const top = [0.05, 0.3, 0.4], bot = [0.01, 0.03, 0.05];
      wc.push(...top, ...top, ...bot, ...top, ...bot, ...bot);
    }
  }
  const wg = new THREE.BufferGeometry();
  wg.setAttribute("position", new THREE.Float32BufferAttribute(wp, 3));
  wg.setAttribute("color", new THREE.Float32BufferAttribute(wc, 3));
  world.add(new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  const grid = new THREE.GridHelper(120, 240, 0x0e3a4c, 0x0a2533);
  grid.position.y = BASE - 0.02; grid.material.transparent = true; grid.material.opacity = 0.5; scene.add(grid);

  // ---- region outlines ----
  const lineMats = [];
  const drape = (ring, lift) => {
    const out = [];
    for (let k = 0; k < ring.length - 1; k++) {
      const [a, b] = ring[k], [c, d] = ring[k + 1], n = Math.max(1, Math.ceil(Math.hypot(c - a, d - b) / 0.03));
      for (let s = 0; s < n; s++) { const lo = a + (c - a) * s / n, la = b + (d - b) * s / n; out.push(P(lo, la, Math.max(yAt(lo, la), 0) + lift)); }
    }
    return out;
  };
  try {
    const outlines = await (await fetch("assets/outlines.json")).json();
    const COL = { sumatra: [1.0, 0.62, 0.22], kalimantan: [1.0, 0.62, 0.22], pen_my: [0.3, 0.86, 1.0], east_my: [0.3, 0.86, 1.0] };
    for (const [id, rings] of Object.entries(outlines)) for (const ring of rings) {
      const pts = drape(ring, 0.04); if (pts.length < 2) continue;
      const g = new LineGeometry(); g.setPositions(pts.flatMap((v) => [v.x, v.y, v.z]));
      const m = new LineMaterial({ color: new THREE.Color(...COL[id]), linewidth: 2, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false });
      lineMats.push(m); world.add(new Line2(g, m));
    }
  } catch (e) { /* outlines are decorative */ }

  // ---- labels ----
  const label = (text, cls, lon, lat) => {
    const d = document.createElement("div"); d.className = cls; d.textContent = text;
    const o = new CSS2DObject(d); o.position.copy(P(lon, lat, Math.max(yAt(lon, lat), 0) + 0.6)); world.add(o);
  };
  label("SUMATRA", "hl fire", 100.4, -0.8); label("KALIMANTAN", "hl fire", 113.6, -0.9);
  label("PENINSULAR MALAYSIA", "hl", 102.3, 4.6); label("SARAWAK", "hl", 113.2, 2.5); label("SABAH", "hl", 116.9, 5.4);

  // ---- fire columns ----
  const MAX = 20000, box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
  const beam = { value: 1 };   // 1 = fading light beam, 0 = solid (flat cells)
  const colMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, depthWrite: false });
  colMat.onBeforeCompile = (sh) => {
    sh.uniforms.uBeam = beam;
    sh.vertexShader = sh.vertexShader.replace("void main() {", "varying float vH;\nvoid main() {\n  vH = position.y;");
    sh.fragmentShader = sh.fragmentShader.replace("void main() {", "varying float vH;\nuniform float uBeam;\nvoid main() {")
      .replace("#include <dithering_fragment>", "#include <dithering_fragment>\n  gl_FragColor.a *= mix(1.0, 0.92 * pow(1.0 - vH, 1.6) + 0.04, uBeam);");
  };
  const cols = new THREE.InstancedMesh(box, colMat, MAX);
  cols.count = 0; cols.frustumCulled = false; world.add(cols);
  const M4 = new THREE.Matrix4(), C = new THREE.Color();
  let cells = [], grow = 0, cellDeg = 0.1;
  let flatCells = false;
  // column height follows the size of the view, so columns stay in proportion when zoomed in
  const zoomK = () => Math.max(0.22, Math.min(1, halfW / 5));
  // more vertical exaggeration when zoomed in, so hills still read
  const relief = () => 1;
  let introDone = REDUCED;                       // flat cells (clearest) or 3D columns
  const hidden = [false, false, false];   // legend rows switch a class off and on
  const drawCols = () => {
    const n = Math.min(cells.length, MAX);
    for (let i = 0; i < n; i++) {
      const [lo, la, days] = cells[i];
      const k = days >= 8 ? 2 : days >= 3 ? 1 : 0, hk = cellDeg / 0.1;
      const wd = hidden[k] ? 0 : flatCells ? cellDeg * 0.9 : cellDeg * [0.2, 0.3, 0.42][k];
      M4.makeScale(wd, flatCells ? 0.012 * hk : Math.max(0.008 * hk, (0.04 + days * 0.02) * zoomK() * grow), wd);
      M4.setPosition(lo - 107, Math.max(yAt(lo, la), 0), -(la - 0.5));
      cols.setMatrixAt(i, M4);
    }
    cols.count = n; cols.instanceMatrix.needsUpdate = true;
  };
  // three classes by days with fire in the month
  const LIGHT = 0xffd84d, MODERATE = 0xff8a2a, HEAVY = 0xff3327;
  const klass = (days) => (days >= 8 ? 2 : days >= 3 ? 1 : 0);
  const colour = (days) => C.setHex([LIGHT, MODERATE, HEAVY][klass(days)]);

  // ---- tweening (no extra library) ----
  const tweens = new Set();
  const tween = (ms, step, done) => {
    if (REDUCED || ms <= 0) { step(1); done && done(); return; }
    const tw = { el: 0, ms, step, done }; tweens.add(tw); return tw;
  };
  const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

  // ---- data: follow the Year / Month filters ----
  const elWhen = document.getElementById("hero-when"), elCount = document.getElementById("hero-count"), elDetail = document.getElementById("hero-detail");
  let shown = "", req = 0, growTween = null;
  async function load(year, month, scope, cell) {
    const key = year + "-" + month + "-" + scope + "-" + cell; if (key === shown) return; shown = key;
    const mine = ++req;
    try {
      const r = await fetch(`${API}/hotspots/grid?scope=${encodeURIComponent(scope)}&year=${year}&month=${month}&sensor=auto&cell=${cell}`);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json(); if (mine !== req) return;
      cells = d.cells.map((c) => [c.lon + d.cell / 2, c.lat + d.cell / 2, c.cell_days, c.hotspots, c.frp])
        .filter((c) => c[0] > LON0 && c[0] < LON1 && c[1] > LAT0 && c[1] < LAT1).sort((a, b) => a[2] - b[2]);
      if (cells.length > MAX) cells = cells.slice(cells.length - MAX);   // keep the most active cells
      cells.forEach((c, i) => cols.setColorAt(i, colour(c[2])));
      const n = [0, 0, 0]; cells.forEach((c) => n[klass(c[2])]++);
      ["hero-n0", "hero-n1", "hero-n2"].forEach((id, i) => { const el = document.getElementById(id); if (el) el.textContent = nf.format(n[i]); });
      if (cols.instanceColor) cols.instanceColor.needsUpdate = true;
      elWhen.textContent = `${scope === "All" ? "All regions" : scope} · ${MONTHS[month - 1]} ${year} · ${d.sensor}`;
      elCount.textContent = nf.format(d.hotspots);
      cellDeg = d.cell; sensorShown = d.sensor;
      elDetail.textContent = `hotspots in ${nf.format(d.cells.length)} cells of ${d.cell}° (about ${(d.cell * 111).toFixed(d.cell < 0.1 ? 1 : 0)} km)`;
      describe();
      if (growTween) tweens.delete(growTween);
      grow = 0; drawCols();
      growTween = tween(900, (x) => { grow = ease(x); drawCols(); });
    } catch (e) {
      if (mine !== req) return;
      shown = ""; elWhen.textContent = "Hotspot data not loaded yet"; elCount.textContent = "–"; elDetail.textContent = "The map fills in once the server has the data.";
    }
  }
  const selYear = document.getElementById("f-year"), selMonth = document.getElementById("f-month");
  const selScope = document.getElementById("f-scope");
  // region boxes from the API, used to point the camera at the chosen area
  let boxes = null;
  fetch(`${API}/regions`).then((r) => r.json()).then((rs) => { boxes = rs; }).catch(() => {});
  // ---- sharper imagery when zoomed in ----
  // Whole-area views use the bundled NASA Blue Marble (about 700 m a pixel). For one region or a clicked
  // spot, a Sentinel-2 cloudless mosaic (EOX, 10 m source) is requested for just that box and draped on
  // the same terrain. If the request fails, the Blue Marble stays.
  let patch = null, patchReq = 0, dim = 1;
  function sharpen(x0, y0, x1, y1) {
    const mine = ++patchReq;
    if (patch) { world.remove(patch); patch.geometry.dispose(); patch.material.map.dispose(); patch.material.dispose(); patch = null; }
    x0 = Math.max(LON0, x0 - 0.3); x1 = Math.min(LON1, x1 + 0.3); y0 = Math.max(LAT0, y0 - 0.3); y1 = Math.min(LAT1, y1 + 0.3);
    if (x1 - x0 > 12.5 || x1 <= x0 || y1 <= y0) return;
    const w = 4096, h = Math.max(256, Math.min(4096, Math.round(w * (y1 - y0) / (x1 - x0))));
    const url = (window.IMAGERY_WMS || "https://tiles.maps.eox.at/wms") + `?service=WMS&request=GetMap&version=1.1.1&layers=s2cloudless&styles=&format=image/jpeg&srs=EPSG:4326&bbox=${x0},${y0},${x1},${y1}&width=${w}&height=${h}`;
    const tl = new THREE.TextureLoader(); tl.setCrossOrigin("anonymous");
    tl.load(url, (t) => {
      if (mine !== patchReq) { t.dispose(); return; }
      t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const g = new THREE.PlaneGeometry(x1 - x0, y1 - y0, Math.min(400, Math.ceil((x1 - x0) / 0.025)), Math.min(400, Math.ceil((y1 - y0) / 0.025)));
      g.rotateX(-Math.PI / 2);
      const q = g.attributes.position, cxm = (x0 + x1) / 2, cym = (y0 + y1) / 2;
      for (let k = 0; k < q.count; k++) {
        const lon = q.getX(k) + cxm, lat = cym - q.getZ(k);
        q.setXYZ(k, lon - 107, yAt(lon, lat), -(lat - 0.5));
      }
      g.computeVertexNormals();
      const m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.92, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      m.color.setScalar(dim);
      patch = new THREE.Mesh(g, m); world.add(patch);
      const cr = document.getElementById("hero-img"); if (cr) cr.textContent = "Sentinel-2 cloudless by EOX (Copernicus Sentinel data)";
    }, undefined, () => {});
    const cr = document.getElementById("hero-img"); if (cr) cr.textContent = "NASA Blue Marble";
  }
  let scopeShown = "All", local = null, sensorShown = "";
  const REGION_NAMES = () => (boxes || []).map((r) => r.region);
  const isRegion = (sc) => REGION_NAMES().includes(sc);
  // finer cells when the view is one region or a clicked spot
  const cellFor = (sc) => (local || isRegion(sc) ? 0.05 : 0.1);
  function focus(scope, force) {
    if (!boxes || (scope === scopeShown && !force)) return;
    if (scope !== scopeShown) local = null;
    scopeShown = scope;
    const rs = scope === "All" ? [] : boxes.filter((r) => r.region === scope || r.country === scope);
    let x0 = LON0 + 0.5, y0 = LAT0, x1 = LON1 - 0.5, y1 = LAT1;
    if (rs.length) { x0 = Math.min(...rs.map((r) => r.bbox[0])); y0 = Math.min(...rs.map((r) => r.bbox[1])); x1 = Math.max(...rs.map((r) => r.bbox[2])); y1 = Math.max(...rs.map((r) => r.bbox[3])); }
    if (local) { x0 = local.lon - 1.5; x1 = local.lon + 1.5; y0 = local.lat - 0.9; y1 = local.lat + 0.9; }
    sharpen(x0, y0, x1, y1);
    const from = TARGET.clone(), to = P((x0 + x1) / 2, (y0 + y1) / 2 - (rs.length || local ? 0 : 0.3), 0);
    const w0 = halfW, h0 = halfH, w1 = (x1 - x0) / 2, h1 = (y1 - y0) / 2;
    userMoved = false; dir.copy(tilted);
    tween(1400, (x) => {
      const k = ease(x); TARGET.lerpVectors(from, to, k); halfW = w0 + (w1 - w0) * k; halfH = h0 + (h1 - h0) * k;
      controls.target.copy(TARGET); dist = fitDist(); place();
      if (introDone) world.scale.y = relief(); drawCols();
    });
  }
  setInterval(() => {
    const y = +selYear.value, m = +selMonth.value, sc = selScope.value || "All";
    if (y && m) { focus(sc); load(y, m, sc, cellFor(sc)); }
  }, 600);

  // ---- camera ----
  const tilted = new THREE.Vector3(0, 0.62, 0.78).normalize(), flat = new THREE.Vector3(0, 1, 0.02).normalize();
  let dir = flat.clone(), dist = 20, userMoved = false;
  controls.addEventListener("start", () => { userMoved = true; });
  const fitDist = () => {
    const v = THREE.MathUtils.degToRad(camera.fov) / 2;
    const pad = Math.min(1, halfW / 6);   // smaller margin when zoomed in
    return Math.max((halfW + 0.6 * pad) / (Math.tan(v) * camera.aspect), (halfH + 0.4 * pad) * 0.7 / Math.tan(v));
  };
  const place = () => { if (!userMoved) camera.position.copy(TARGET).addScaledVector(dir, dist); };
  function resize() {
    const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h); labels.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    lineMats.forEach((m) => m.resolution.set(w, h));
    dist = fitDist(); place();
  }
  new ResizeObserver(resize).observe(host); resize();

  // ---- click a spot: zoom to it and read the hotspots there ----
  const elPick = document.getElementById("hero-pick"), elReset = document.getElementById("hero-reset"), elScale = document.getElementById("hero-scale");
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const fmtLL = (lon, lat) => `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"}, ${lon.toFixed(2)}°E`;
  function describe() {
    if (!elPick) return;
    if (!local) { elPick.hidden = true; if (elReset) elReset.hidden = true; return; }
    let hs = 0, nc = 0, top = 0;
    for (const c of cells) if (Math.abs(c[0] - local.lon) <= 0.25 && Math.abs(c[1] - local.lat) <= 0.25) { hs += c[3] || 0; nc++; top = Math.max(top, c[2]); }
    elPick.hidden = false; if (elReset) elReset.hidden = false;
    elPick.innerHTML = `<b>${fmtLL(local.lon, local.lat)}</b><br>${nf.format(hs)} hotspots within about 28 km of this point` +
      (nc ? ` · ${nc} cells with fire · up to ${top} day${top === 1 ? "" : "s"} in one cell` : "");
  }
  let downAt = null;
  renderer.domElement.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;   // a drag, not a click
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(terrain, false)[0]; if (!hit) return;
    const lon = hit.point.x + 107, lat = 0.5 - hit.point.z;
    local = { lon: Math.max(LON0 + 1.5, Math.min(LON1 - 1.5, lon)), lat: Math.max(LAT0 + 0.9, Math.min(LAT1 - 0.9, lat)) };
    local.lon = lon; local.lat = lat;
    focus(scopeShown, true); describe();
  });
  if (elReset) elReset.addEventListener("click", () => { local = null; focus(scopeShown, true); describe(); });
  // legend rows are switches: click one to hide or show that class
  document.querySelectorAll(".hero-legend li").forEach((li, i) => {
    li.setAttribute("role", "button"); li.tabIndex = 0; li.title = "Click to hide or show";
    const flip = () => { hidden[i] = !hidden[i]; li.classList.toggle("off", hidden[i]); li.setAttribute("aria-pressed", String(!hidden[i])); drawCols(); };
    li.addEventListener("click", flip);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });
  });
  // flat cells / 3D columns switch; the imagery is dimmed in flat mode so the cells read clearly
  const elMode = document.getElementById("hero-mode");
  const applyMode = () => { dim = flatCells ? 0.62 : 0.78; beam.value = flatCells ? 0 : 1; terrain.material.color.setScalar(dim); if (patch) patch.material.color.setScalar(dim); if (elMode) elMode.textContent = flatCells ? "Show 3D columns" : "Show flat cells"; drawCols(); };
  if (elMode) elMode.addEventListener("click", () => { flatCells = !flatCells; applyMode(); });
  applyMode();
  // hover: read one cell
  const elTip = document.getElementById("hero-tip"), NAMES = ["Light", "Moderate", "Heavy"];
  let tipAt = 0;
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (!elTip || e.buttons) { if (elTip) elTip.hidden = true; return; }
    const now = performance.now(); if (now - tipAt < 60) return; tipAt = now;
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(cols, false)[0], c = hit && cells[hit.instanceId];
    if (!c || hidden[klass(c[2])]) { elTip.hidden = true; return; }
    elTip.innerHTML = `<b>${fmtLL(c[0], c[1])}</b><span>${elWhen.textContent.split(" · ").slice(1, 2)}</span>` +
      `<dl><dt>Hotspots</dt><dd>${nf.format(c[3])}</dd><dt>Days with fire</dt><dd>${c[2]}</dd><dt>Level</dt><dd>${NAMES[klass(c[2])]}</dd>` +
      `<dt>Cell size</dt><dd>${(cellDeg * 111).toFixed(cellDeg < 0.1 ? 1 : 0)} km</dd></dl><i>Click to zoom in here</i>`;
    elTip.hidden = false;
    const x = e.clientX - r.left, y = e.clientY - r.top;
    elTip.style.left = Math.min(x + 16, r.width - 230) + "px"; elTip.style.top = Math.max(8, Math.min(y + 16, r.height - 170)) + "px";
  });
  renderer.domElement.addEventListener("pointerleave", () => { if (elTip) elTip.hidden = true; });
  // scale bar: real ground distance at the centre of the view
  const sa = new THREE.Vector3(), sb = new THREE.Vector3();
  function scaleBar() {
    if (!elScale) return;
    sa.copy(TARGET).project(camera); sb.copy(TARGET).add(new THREE.Vector3(1, 0, 0)).project(camera);
    const pxPerDeg = Math.abs(sb.x - sa.x) / 2 * host.clientWidth; if (!(pxPerDeg > 0)) return;
    const pxPerKm = pxPerDeg / 111.3;
    const km = [10, 20, 50, 100, 200, 500, 1000].find((k) => k * pxPerKm >= 70) || 1000;
    elScale.style.width = Math.round(km * pxPerKm) + "px"; elScale.textContent = km + " km";
  }

  // ---- intro: a flat map seen from above rises into 3D terrain ----
  world.scale.y = REDUCED ? 1 : 0.02;
  if (REDUCED) { dir.copy(tilted); place(); }
  else setTimeout(() => tween(2800, (x) => {
    const k = ease(x); world.scale.y = 0.02 + 0.98 * k;
    dir.copy(flat).lerp(tilted, k).normalize(); place();
  }, () => { introDone = true; world.scale.y = relief(); }), 700);

  // ---- render only while visible ----
  let visible = true;
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; }).observe(host);
  let last = performance.now();
  (function loop(now) {
    requestAnimationFrame(loop);
    // advance by at most 50 ms a frame, so a slow first frame cannot skip the intro
    const dt = Math.min(50, Math.max(0, now - last)); last = now;
    if (!visible || document.hidden) return;
    for (const tw of [...tweens]) {
      tw.el += dt; const x = Math.min(1, tw.el / tw.ms); tw.step(x);
      if (x >= 1) { tweens.delete(tw); tw.done && tw.done(); }
    }
    controls.update();
    renderer.render(scene, camera); labels.render(scene, camera); scaleBar();
  })(performance.now());
}

function fail(msg) {
  const w = document.getElementById("hero-when"); if (w) w.textContent = msg;
}
start().catch((e) => { console.warn("[hero3d]", e); fail("3D view could not load"); });
