/* Forecast "where" map: a flat map drawn on real state and province borders.
   Level 1: every state is coloured by its average chance of fire for the chosen month.
   Level 2: click a state to open it and see the forecast for each ~28 km cell inside it.
   It reads the same forecast that app.js already loaded (where.data, where.month),
   so the numbers are the page's own. Borders: Natural Earth admin-1 (public domain). */
(function () {
  const host = document.getElementById("fc-map");
  if (!host || typeof where === "undefined") return;
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const NS = "http://www.w3.org/2000/svg";

  // five clear steps, light to dark
  const COL = ["#fff1c9", "#fdc66f", "#f58a3c", "#d6452b", "#8f1d1b"];
  let S_BREAKS = [10, 20, 30, 40], S_LABELS = ["under 10%", "10–20%", "20–30%", "30–40%", "40% +"];
  // in a strong fire month most states pass 40%, so the steps widen to keep them apart
  function fitBreaks(top) {
    S_BREAKS = top > 55 ? [15, 30, 45, 60] : [10, 20, 30, 40];
    S_LABELS = [`under ${S_BREAKS[0]}%`, ...S_BREAKS.slice(0, 3).map((b, i) => `${b}–${S_BREAKS[i + 1]}%`), `${S_BREAKS[3]}% +`];
  }
  const C_BREAKS = [15, 30, 50, 70], C_LABELS = ["under 15%", "15–30%", "30–50%", "50–70%", "70% +"];
  const klass = (v, br) => br.reduce((i, b) => i + (v >= b ? 1 : 0), 0);

  const css = `
#fc-map.map { display: none !important; }
.forecast-map-tools { display: none !important; }
#top-title, #top-areas { display: none !important; }
.sm-wrap { position: relative; border: 1px solid var(--border, #dce3ea); border-radius: 12px; background: #eaf1f7; overflow: hidden; }
.sm-bar { position: absolute; z-index: 2; left: 10px; top: 10px; right: 10px; display: flex; align-items: center; gap: 8px; pointer-events: none; font-size: 12.5px; }
.sm-crumb { pointer-events: auto; padding: 5px 10px; border-radius: 8px; background: rgba(255,255,255,.94); border: 1px solid var(--border, #dce3ea); color: var(--ink-2, #435162); }
.sm-crumb b { color: var(--ink, #18222e); }
.sm-back { pointer-events: auto; font: inherit; font-weight: 600; padding: 5px 11px; border-radius: 8px; cursor: pointer; background: var(--ink, #18222e); color: #fff; border: 0; }
.sm-back[hidden] { display: none; }
.sm-svg { display: block; width: 100%; height: auto; aspect-ratio: 16 / 8.6; touch-action: manipulation; }
.sm-ctx { fill: #f4f5f6; stroke: #cfd6de; stroke-width: 1; vector-effect: non-scaling-stroke; }
.sm-state { stroke: #fff; stroke-width: 1.4; stroke-linejoin: round; vector-effect: non-scaling-stroke; cursor: pointer; transition: fill .35s ease, opacity .35s ease; outline: none; }
.sm-state.none { fill: #e3e7ec; cursor: default; }
.sm-state.dim { opacity: .28; }
.sm-state.open { fill: #f3f5f7 !important; cursor: default; }
.sm-hi { fill: none; stroke: var(--ink, #18222e); stroke-width: 2.8; stroke-linejoin: round; vector-effect: non-scaling-stroke; pointer-events: none; }
.sm-cell { stroke: rgba(255,255,255,.55); stroke-width: .6; vector-effect: non-scaling-stroke; cursor: pointer; }
.sm-cell:hover { stroke: var(--ink, #18222e); stroke-width: 2; }
.sm-label { font-family: var(--body, system-ui), sans-serif; font-weight: 700; text-anchor: middle; pointer-events: none; paint-order: stroke; stroke-width: 3px; stroke-linejoin: round; }
.sm-label tspan.v { font-family: var(--mono, ui-monospace), monospace; font-weight: 600; }
.sm-in { animation: sm-in .5s ease both; }
@keyframes sm-in { from { opacity: 0; } to { opacity: 1; } }
.sm-tip { position: absolute; z-index: 3; width: 232px; pointer-events: none; padding: 10px 12px; border-radius: 10px; background: #fff; border: 1px solid var(--axis, #b9c4cf); box-shadow: 0 8px 22px rgba(20,30,45,.2); font-size: 12px; color: var(--ink-2, #435162); }
.sm-tip[hidden] { display: none; }
.sm-tip b { font-size: 14.5px; color: var(--ink, #18222e); }
.sm-tip small { margin-left: 6px; color: var(--muted, #586677); }
.sm-tip dl { display: grid; grid-template-columns: 1fr auto; gap: 3px 10px; margin: 7px 0 0; }
.sm-tip dd { margin: 0; font: 700 12px var(--mono, ui-monospace), monospace; color: var(--ink, #18222e); text-align: right; }
.sm-tip i { display: block; margin-top: 7px; font-style: normal; color: var(--s2, #a83e1c); font-weight: 600; }
.sm-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; margin: 8px 2px 0; font-size: 11.5px; color: var(--muted, #586677); }
.sm-legend b { color: var(--ink-2, #435162); font-weight: 600; margin-right: 2px; }
.sm-legend span { display: inline-flex; align-items: center; gap: 5px; font-family: var(--mono, ui-monospace), monospace; }
.sm-legend span::before { content: ""; width: 22px; height: 11px; border-radius: 2px; background: var(--c); border: 1px solid rgba(0,0,0,.12); }
.sm-note { margin: 6px 2px 0; font-size: 11.5px; color: var(--muted, #586677); }
.sm-rank { list-style: none; margin: 0; padding: 0; }
.sm-rank li { padding: 7px 8px 8px; border-radius: 8px; cursor: pointer; }
.sm-rank li:hover, .sm-rank li.on { background: var(--band, #edf3f9); }
.sm-rank .top { display: flex; justify-content: space-between; gap: 8px; font-weight: 700; font-size: 13px; color: var(--ink, #18222e); }
.sm-rank .top span:last-child { font-family: var(--mono, ui-monospace), monospace; }
.sm-rank .bar { height: 8px; border-radius: 4px; margin: 5px 0 4px; background: var(--grid, #e7ecf0); }
.sm-rank .bar i { display: block; height: 100%; border-radius: 4px; border: 1px solid rgba(0,0,0,.12); box-sizing: border-box; }
.sm-rank .meta { font-size: 11px; color: var(--muted, #586677); }
.sm-rank-h { margin: 0 0 6px; font-size: 14px; font-weight: 700; color: var(--ink, #18222e); }
@media (prefers-reduced-motion: reduce) { .sm-in { animation: none; } .sm-state { transition: none; } }
`;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  // ---- page elements ----
  const wrap = document.createElement("div"); wrap.className = "sm-wrap";
  wrap.innerHTML = `<div class="sm-bar"><span class="sm-crumb" id="sm-crumb"></span><button type="button" class="sm-back" id="sm-back" hidden>‹ Back</button></div>
    <svg class="sm-svg" id="sm-svg" role="group" aria-label="Forecast fire chance by state"></svg><div class="sm-tip" id="sm-tip" hidden></div>`;
  host.parentElement.insertBefore(wrap, host);
  const legend = document.createElement("div"); legend.className = "sm-legend"; wrap.after(legend);
  const note = document.createElement("p"); note.className = "sm-note"; legend.after(note);
  const topList = document.getElementById("top-areas"), rankBox = document.createElement("div");
  rankBox.innerHTML = `<h4 class="sm-rank-h" id="sm-rank-h"></h4><ol class="sm-rank" id="sm-rank"></ol>`;
  if (topList) topList.parentElement.appendChild(rankBox);
  const svg = wrap.querySelector("#sm-svg"), tip = wrap.querySelector("#sm-tip"), crumb = wrap.querySelector("#sm-crumb"), back = wrap.querySelector("#sm-back");
  const rank = rankBox.querySelector("#sm-rank"), rankH = rankBox.querySelector("#sm-rank-h");

  // ---- geometry: plain lon/lat, y flipped; near the equator this is close to true shape ----
  const K = 100;   // viewBox units per degree, keeps strokes and text crisp
  const px = (lon) => lon * K, py = (lat) => -lat * K;
  const pathOf = (rings) => rings.map((r) => "M" + r.map(([x, y]) => `${px(x).toFixed(1)} ${py(y).toFixed(1)}`).join("L") + "Z").join("");
  function inside(x, y, ring) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  let admin = null, ctx = null, shown = null, open = null, hover = null, stats = new Map(), view = null, anim = 0;
  const owner = new Map();   // "lat,lon" -> state name, so each cell is placed once
  let only = null;           // when the page shows one country, cells can only belong to its states
  function countryOfScope() {
    const sc = (typeof state !== "undefined" && state.scope) || "All";
    if (sc === "Malaysia" || sc === "Indonesia") return sc;
    const r = typeof state !== "undefined" && (state.regions || []).find((x) => x.region === sc);
    return r ? r.country : null;
  }

  function stateOf(lat, lon, cell) {
    const key = lat + "," + lon; if (owner.has(key)) return owner.get(key);
    const x = lon + cell / 2, y = lat + cell / 2; let best = null;
    const pool = only ? admin.filter((s) => s.c === only) : admin;
    for (const s of pool) { if (x < s.b[0] || x > s.b[2] || y < s.b[1] || y > s.b[3]) continue; if (s.r.some((r) => inside(x, y, r))) { best = s.n; break; } }
    if (!best) {   // a coastal cell whose centre is just offshore: nearest state by bounding box
      let bd = 1e9;
      for (const s of pool) { const dx = Math.max(s.b[0] - x, 0, x - s.b[2]), dy = Math.max(s.b[1] - y, 0, y - s.b[3]), d = dx * dx + dy * dy; if (d < bd) { bd = d; best = s.n; } }
      if (bd > 0.6) best = null;
    }
    owner.set(key, best); return best;
  }

  function compute(d, mo) {
    stats = new Map(); let total = 0;
    for (const [lat, lon, pct, fd10, ai] of mo.cells) {
      const n = stateOf(lat, lon, d.cell_deg); if (!n) continue;
      let s = stats.get(n); if (!s) stats.set(n, (s = { n, sum: 0, cells: [], hi: 0, max: 0, fd: 0 }));
      s.sum += pct; s.hi += pct >= 50 ? 1 : 0; s.max = Math.max(s.max, pct); s.fd += fd10 / 10; s.cells.push([lat, lon, pct, fd10, ai]); total += fd10 / 10;
    }
    for (const s of stats.values()) { s.mean = s.sum / s.cells.length; s.share = total ? (100 * s.fd) / total : 0; }
    const order = [...stats.values()].sort((a, b) => b.mean - a.mean); order.forEach((s, i) => (s.rank = i + 1));
    fitBreaks(order.length ? order[0].mean : 0);
    return order;
  }

  // ---- view box, animated ----
  function setView(v) { view = v; svg.setAttribute("viewBox", v.map((n) => n.toFixed(1)).join(" ")); }
  function boxFor(b, pad) {   // [lon0, lat0, lon1, lat1] -> viewBox with the svg's aspect ratio
    const ar = 16 / 8.6; let w = (b[2] - b[0]) * K * (1 + pad), h = (b[3] - b[1]) * K * (1 + pad);
    if (w / h < ar) w = h * ar; else h = w / ar;
    return [px((b[0] + b[2]) / 2) - w / 2, py((b[1] + b[3]) / 2) - h / 2, w, h];
  }
  function flyTo(v) {
    cancelAnimationFrame(anim);
    if (REDUCED || !view) { setView(v); relabel(); return; }
    const from = view.slice(), t0 = performance.now();
    (function step(now) {
      const k = Math.min(1, (now - t0) / 520), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      setView(from.map((f, i) => f + (v[i] - f) * e));
      if (k < 1) anim = requestAnimationFrame(step); else relabel();
    })(t0);
  }

  const scopeStates = () => {
    const sc = (typeof state !== "undefined" && state.scope) || "All";
    const withData = admin.filter((s) => stats.has(s.n));
    const country = sc === "Malaysia" || sc === "Indonesia" ? sc : null;
    return { sc, list: country ? admin.filter((s) => s.c === country) : withData.length ? admin.filter((s) => stats.has(s.n) || withData.some((w) => w.c === s.c && sc === "All")) : admin };
  };
  const bboxOf = (list) => list.reduce((b, s) => [Math.min(b[0], s.b[0]), Math.min(b[1], s.b[1]), Math.max(b[2], s.b[2]), Math.max(b[3], s.b[3])], [999, 999, -999, -999]);

  const el = (name, attrs, parent) => { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
  let gStates, gCells, gHi, gLabels, monthName = "", yearNo = 0, cellDeg = 0.25, areas = [];

  function draw(first) {
    const d = where.data, mo = d.months[where.month - 1]; monthName = MON[where.month - 1]; yearNo = d.year; cellDeg = d.cell_deg; areas = d.areas || [];
    const c0 = countryOfScope(); if (c0 !== only) { only = c0; owner.clear(); }
    const order = compute(d, mo), { sc, list } = scopeStates();
    if (open && !stats.has(open)) open = null;
    svg.innerHTML = "";
    const gCtx = el("g", {}, svg);
    if (ctx) for (const c of ctx) el("path", { class: "sm-ctx", d: c }, gCtx);
    gStates = el("g", {}, svg); gCells = el("g", {}, svg); gHi = el("g", {}, svg); gLabels = el("g", {}, svg);
    list.forEach((s, i) => {
      const v = stats.get(s.n), p = el("path", { class: "sm-state" + (v ? "" : " none") + (first ? " sm-in" : ""), d: pathOf(s.r), "data-n": s.n }, gStates);
      if (first) p.style.animationDelay = Math.min(i * 28, 700) + "ms";
      if (v) { p.setAttribute("fill", COL[klass(v.mean, S_BREAKS)]); p.setAttribute("tabindex", "0"); p.setAttribute("role", "button");
        p.setAttribute("aria-label", `${s.n}: average chance of fire ${Math.round(v.mean)}%, rank ${v.rank} of ${order.length}. Press Enter to open.`); }
    });
    // ranking
    rankH.textContent = `Ranked by average chance · ${monthName} ${yearNo}`;
    const top = order[0] ? order[0].mean : 1;
    rank.innerHTML = order.slice(0, 10).map((s) => `<li data-n="${esc(s.n)}"><div class="top"><span>${s.rank}. ${esc(s.n)}</span><span>${Math.round(s.mean)}%</span></div>
      <div class="bar"><i style="width:${Math.max(3, (100 * s.mean) / top)}%;background:${COL[klass(s.mean, S_BREAKS)]}"></i></div>
      <div class="meta">highest cell ${s.max}% · ${s.hi} of ${s.cells.length} cells at 50%+ · ${s.share.toFixed(1)}% of expected fire days</div></li>`).join("");
    note.textContent = `State and province borders are real (Natural Earth). Each one shows the average, over its ~${Math.round(cellDeg * 111)} km forecast cells, of the chance of at least one fire day in ${monthName} ${yearNo}. Grey means no forecast cells there.`;
    shown = { list, sc };
    if (open) openState(open, true); else { closeState(true); }
  }

  function relabel() {   // labels only where they fit at the current zoom
    if (!gLabels || !view) return; gLabels.innerHTML = "";
    const unit = view[2] / svg.clientWidth;   // viewBox units per screen pixel
    if (open) return;
    for (const s of shown.list) {
      const v = stats.get(s.n); if (!v) continue;
      const wpx = ((s.b[2] - s.b[0]) * K) / unit, hpx = ((s.b[3] - s.b[1]) * K) / unit;
      const full = s.n.length * 6.9 + 10;   // rough width of the name at 12px
      if (hpx < 30 || wpx < 36) continue;
      const showName = wpx >= full;
      const dark = klass(v.mean, S_BREAKS) >= 3;
      const t = el("text", { class: "sm-label", x: px(s.p[0]), y: py(s.p[1]), "font-size": 12 * unit, fill: dark ? "#fff" : "#18222e", stroke: dark ? "rgba(0,0,0,.35)" : "rgba(255,255,255,.85)", "stroke-width": 3 * unit }, gLabels);
      if (showName) el("tspan", { x: px(s.p[0]), dy: 0 }, t).textContent = s.n;
      const tv = el("tspan", { class: "v", x: px(s.p[0]), dy: (showName ? 13.5 : 4) * unit, "font-size": 11 * unit }, t); tv.textContent = Math.round(v.mean) + "%";
    }
  }

  function setLegend(labels, title) {
    legend.innerHTML = `<b>${title}</b>` + labels.map((l, i) => `<span style="--c:${COL[i]}">${l}</span>`).join("");
  }

  function highlight(n) {
    hover = n; gHi.innerHTML = "";
    rank.querySelectorAll("li").forEach((li) => li.classList.toggle("on", li.dataset.n === n));
    const s = n && admin.find((a) => a.n === n); if (s && !open) el("path", { class: "sm-hi", d: pathOf(s.r) }, gHi);
  }

  function closeState(quiet) {
    open = null; back.hidden = true; gCells.innerHTML = ""; gHi.innerHTML = "";
    gStates.querySelectorAll(".sm-state").forEach((p) => p.classList.remove("dim", "open"));
    crumb.innerHTML = `<b>${esc(shown.sc === "All" ? "Malaysia & Indonesia" : shown.sc)}</b> · click a state to open it`;
    setLegend(S_LABELS, "Average chance of fire");
    const withData = shown.list.filter((s) => stats.has(s.n));
    const v = boxFor(bboxOf(withData.length ? withData : shown.list), 0.12); if (quiet && !view) { setView(v); relabel(); } else flyTo(v);
    tip.hidden = true;
  }

  function openState(n, quiet) {
    const s = admin.find((a) => a.n === n), v = stats.get(n); if (!s || !v) return;
    open = n; back.hidden = false; tip.hidden = true; gHi.innerHTML = ""; gLabels.innerHTML = "";
    gStates.querySelectorAll(".sm-state").forEach((p) => { const me = p.dataset.n === n; p.classList.toggle("dim", !me); p.classList.toggle("open", me); });
    gCells.innerHTML = "";
    const id = "sm-clip"; const cp = el("clipPath", { id }, gCells); el("path", { d: pathOf(s.r) }, cp);
    const g = el("g", { "clip-path": `url(#${id})` }, gCells);
    for (const c of v.cells) {
      const r = el("rect", { class: "sm-cell" + (REDUCED ? "" : " sm-in"), x: px(c[1]), y: py(c[0] + cellDeg), width: cellDeg * K, height: cellDeg * K, fill: COL[klass(c[2], C_BREAKS)] }, g);
      r.__c = c;
    }
    el("path", { class: "sm-hi", d: pathOf(s.r), style: "stroke-width:2" }, gCells);
    crumb.innerHTML = `${esc(shown.sc === "All" ? "Malaysia & Indonesia" : shown.sc)} › <b>${esc(n)}</b> · average ${Math.round(v.mean)}% · rank ${v.rank}`;
    setLegend(C_LABELS, "Chance of fire in each cell");
    const v2 = boxFor(s.b, 0.22); if (quiet) { setView(v2); } else flyTo(v2);
    rank.querySelectorAll("li").forEach((li) => li.classList.toggle("on", li.dataset.n === n));
  }

  // ---- pointer, touch and keyboard ----
  function place(e) {
    const r = wrap.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    tip.style.left = Math.max(6, Math.min(x + 16, r.width - 244)) + "px"; tip.style.top = Math.max(44, Math.min(y + 16, r.height - 150)) + "px";
  }
  svg.addEventListener("pointermove", (e) => {
    const t = e.target;
    if (t.classList && t.classList.contains("sm-cell")) {
      const c = t.__c; tip.hidden = false;
      tip.innerHTML = `<b>${c[2]}% chance</b><small>${monthName} ${yearNo}</small><dl><dt>Expected fire days</dt><dd>${(c[3] / 10).toFixed(1)}</dd>` +
        `<dt>Cell centre</dt><dd>${Math.abs(c[0] + cellDeg / 2).toFixed(2)}°${c[0] >= 0 ? "N" : "S"} ${(c[1] + cellDeg / 2).toFixed(2)}°E</dd>` +
        `<dt>Model area</dt><dd>${esc(areas[c[4]] || "–")}</dd></dl>`;
      place(e); return;
    }
    const n = t.classList && t.classList.contains("sm-state") && !open ? t.dataset.n : null, v = n && stats.get(n);
    if (!v) { if (!open) highlight(null); tip.hidden = true; return; }
    if (hover !== n) highlight(n);
    tip.hidden = false;
    tip.innerHTML = `<b>${esc(n)}</b><small>rank ${v.rank} of ${stats.size}</small><dl><dt>Average chance of fire</dt><dd>${Math.round(v.mean)}%</dd>` +
      `<dt>Highest chance in one cell</dt><dd>${v.max}%</dd><dt>Cells at 50% or more</dt><dd>${v.hi} of ${v.cells.length}</dd>` +
      `<dt>Share of expected fire days</dt><dd>${v.share.toFixed(1)}%</dd></dl><i>Click to open ${esc(n)} ›</i>`;
    place(e);
  });
  svg.addEventListener("pointerleave", () => { tip.hidden = true; if (!open) highlight(null); });
  svg.addEventListener("click", (e) => {
    const t = e.target;
    if (t.classList && t.classList.contains("sm-cell")) return;
    if (t.classList && t.classList.contains("sm-state")) {
      const n = t.dataset.n;
      if (open) { if (n !== open) closeState(); return; }
      if (stats.has(n)) openState(n); return;
    }
    if (open) closeState();
  });
  svg.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) { closeState(); return; }
    const t = e.target;
    if ((e.key === "Enter" || e.key === " ") && t.classList && t.classList.contains("sm-state") && stats.has(t.dataset.n)) { e.preventDefault(); if (open === t.dataset.n) closeState(); else openState(t.dataset.n); }
  });
  svg.addEventListener("focusin", (e) => { const t = e.target; if (!open && t.classList && t.classList.contains("sm-state")) highlight(t.dataset.n); });
  back.addEventListener("click", () => closeState());
  rank.addEventListener("pointerover", (e) => { const li = e.target.closest("li"); if (li && !open) highlight(li.dataset.n); });
  rank.addEventListener("pointerleave", () => { if (!open) highlight(null); });
  rank.addEventListener("click", (e) => { const li = e.target.closest("li"); if (!li) return; if (open === li.dataset.n) closeState(); else openState(li.dataset.n); });
  new ResizeObserver(() => relabel()).observe(svg);

  // ---- data ----
  fetch("assets/admin1.json").then((r) => r.json()).then((a) => { admin = a; }).catch(() => { note.textContent = "State borders could not load."; });
  fetch("assets/countries.geojson").then((r) => r.json()).then((g) => {
    const keep = new Set(["Thailand", "Brunei", "Singapore", "Philippines", "Vietnam", "Cambodia", "Papua New Guinea", "Timor-Leste", "Myanmar", "Malaysia", "Indonesia", "Australia"]);
    ctx = g.features.filter((f) => keep.has(f.properties.name)).map((f) => pathOf((f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates).map((p) => p[0])));
    last = "";   // redraw with the neighbours in place
  }).catch(() => {});

  // follow app.js: redraw whenever the forecast, month or area changes
  let last = "", firstDraw = true;
  setInterval(() => {
    if (!admin || !where.data || !where.month) return;
    const key = [where.data.scope, where.data.year, where.data.enso_used, where.month, where.data.months.length, ctx ? 1 : 0].join("|");
    if (key === last) return;
    const scopeChanged = last.split("|")[0] !== where.data.scope; last = key;
    if (scopeChanged) { open = null; view = null; owner.clear(); }
    draw(firstDraw); firstDraw = false;
  }, 250);
})();
