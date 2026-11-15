/* BurningView - talks to the FastAPI backend under /api.
   If you host this page somewhere else, set window.API_BASE = "http://127.0.0.1:8000" before this script. */
const API = (window.API_BASE || "") + "/api";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const VIIRS_START = 2012 * 12 + 2;

const state = {
  scope: "All", year: 2019, month: 9, sensor: "auto",
  calMode: "activity", raw: true, log: false,
  series: [], calib: [], regions: [], calibRegion: "Kalimantan", worldCountries: [],
  oni: null, fc: { year: null, enso: "observed", data: null, prev: null },
};

const $ = (s) => document.querySelector(s);
const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const compact = (v) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ym = (d) => d.year * 12 + d.month;

function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    surface: v("--surface"), ink: v("--ink"), ink2: v("--ink-2"), muted: v("--muted"),
    grid: v("--grid"), axis: v("--axis"), border: v("--border"), s1: v("--s1"), s2: v("--s2"),
    band: v("--band"), select: v("--select"), empty: v("--empty"), eraOld: v("--era-old"),
    seq: ["#e1eefc", "#9dcaf3", "#508ac4", "#245f9c", "#153656"],
    fire: ["#f7ceae", "#ed9a65", "#da5a25", "#a93413", "#72200a"],
    div: ["#245f9c", "#9dcaf3", "#f2f1ec", "#f3a39b", "#a72f2f"],
  };
}

/* ---------- colour ramps, interpolated in OKLab ---------- */
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function hexToLab(h) {
  h = h.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => toLin(parseInt(h.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
          1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
          0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function labToHex([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
               -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
               -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return "#" + rgb.map((c) => Math.round(Math.min(1, Math.max(0, toGam(c))) * 255).toString(16).padStart(2, "0")).join("");
}
function ramp(stops) {
  const labs = stops.map(hexToLab);
  return (t) => {
    t = Math.min(1, Math.max(0, t));
    const x = t * (labs.length - 1), i = Math.min(labs.length - 2, Math.floor(x)), f = x - i;
    return labToHex(labs[i].map((v, k) => v + (labs[i + 1][k] - v) * f));
  };
}
const gradient = (stops) => `linear-gradient(90deg, ${stops.join(", ")})`;

/* ---------- API ---------- */
async function getJSON(path) {
  const r = await fetch(API + path);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch (_) { /* not JSON */ }
    throw new Error(msg);
  }
  return r.json();
}
function setStatus(msg, err = false) {
  const el = $("#status");
  el.textContent = msg || "";
  el.classList.toggle("err", err);
}

/* ---------- shared tooltip ---------- */
const tip = $("#tip");
function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
  tip.style.left = Math.max(8, left) + "px";
  tip.style.top = Math.max(8, top) + "px";
}
const hideTip = () => { tip.hidden = true; };

function chartTooltip(t) {
  return {
    backgroundColor: t.surface, titleColor: t.ink, bodyColor: t.ink2, footerColor: t.ink2,
    borderColor: t.border, borderWidth: 1, padding: 10, cornerRadius: 8,
    boxWidth: 10, boxHeight: 2, usePointStyle: false,
    titleFont: { weight: "600" },
  };
}

/* ---------- searchable dropdown ----------
   Puts a text box over a <select>: click it to see every option, or type to
   filter. The hidden <select> stays the source of truth: picking sets its value
   and fires its normal "change", and any code that sets select.value (or
   disables it, or replaces its options) updates the box too. */
let sselSeq = 0;
function searchableSelect(select, placeholder) {
  if (select.dataset.searchable) return;
  select.dataset.searchable = "1";
  const id = "ssel-" + (++sselSeq);
  const wrap = document.createElement("span");
  wrap.className = "ssel";
  wrap.dataset.for = select.id;
  select.before(wrap);
  const input = document.createElement("input");
  Object.assign(input, { type: "text", autocomplete: "off", spellcheck: false, placeholder });
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", id);
  const arrow = document.createElement("span");
  arrow.className = "ssel-arrow"; arrow.setAttribute("aria-hidden", "true"); arrow.textContent = "▾";
  const list = document.createElement("ul");
  list.className = "ssel-list"; list.id = id; list.setAttribute("role", "listbox"); list.hidden = true;
  wrap.append(input, arrow, list, select);
  select.hidden = true; select.tabIndex = -1;

  let shown = [], active = -1, typed = false;
  const label = () => (select.selectedOptions[0]?.textContent || "").trim();
  const options = () => [...select.options].map((o) => ({
    value: o.value, text: o.textContent.trim(), sub: /^\s/.test(o.textContent),
  }));
  const syncDisabled = () => { input.disabled = select.disabled; wrap.classList.toggle("is-disabled", select.disabled); };

  function render() {
    const q = typed ? input.value.trim().toLowerCase() : "";
    shown = options();
    if (q) shown = shown.filter((o) => o.text.toLowerCase().includes(q))
      .sort((a, b) => (b.text.toLowerCase().startsWith(q) - a.text.toLowerCase().startsWith(q)));
    if (active < 0 || active >= shown.length) {
      active = q ? (shown.length ? 0 : -1) : shown.findIndex((o) => o.value === select.value);
    }
    const mark = (t) => {
      const i = q ? t.toLowerCase().indexOf(q) : -1;
      return i < 0 ? esc(t) : esc(t.slice(0, i)) + "<mark>" + esc(t.slice(i, i + q.length)) + "</mark>" + esc(t.slice(i + q.length));
    };
    list.innerHTML = shown.map((o, i) => `<li role="option" id="${id}-${i}" data-i="${i}" class="${!q && o.sub ? "in-group" : ""}"
        aria-selected="${i === active}"${o.value === select.value ? ' data-current=""' : ""}>${mark(o.text)}</li>`).join("")
      || `<li class="ssel-empty" role="presentation">No matches</li>`;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (active >= 0) {
      input.setAttribute("aria-activedescendant", `${id}-${active}`);
      list.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
    }
  }
  function close() {
    list.hidden = true; active = -1; typed = false;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    input.value = label();
  }
  function pick(o) {
    if (!o) return;
    const changed = o.value !== select.value;
    select.value = o.value;
    close();
    if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const openAll = () => { typed = false; active = -1; render(); };

  input.addEventListener("focus", () => { openAll(); input.select(); });
  input.addEventListener("click", () => { if (list.hidden) openAll(); });
  input.addEventListener("input", () => { typed = true; active = -1; render(); });
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) { openAll(); return; }
      if (!shown.length) return;
      active = e.key === "ArrowDown" ? (active + 1) % shown.length : (active <= 0 ? shown.length - 1 : active - 1);
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!list.hidden) pick(shown[active] || (shown.length === 1 ? shown[0] : null));
    } else if (e.key === "Escape" && !list.hidden) {
      e.preventDefault(); close();
    }
  });
  // mousedown keeps focus in the box, so blur doesn't close the list before the pick
  list.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const li = e.target.closest("[data-i]");
    if (li) pick(shown[+li.dataset.i]);
  });
  arrow.addEventListener("mousedown", (e) => {
    e.preventDefault();
    if (input.disabled) return;
    if (!list.hidden) close();
    else if (document.activeElement === input) openAll();
    else input.focus();
  });

  // keep the box in step when code changes the select
  const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  Object.defineProperty(select, "value", {
    configurable: true,
    get() { return proto.get.call(this); },
    set(v) { proto.set.call(this, v); if (list.hidden) input.value = label(); },
  });
  new MutationObserver(() => { syncDisabled(); if (list.hidden) input.value = label(); })
    .observe(select, { attributes: true, attributeFilter: ["disabled"], childList: true });
  syncDisabled();
  input.value = label();
}

/* ---------- filters ---------- */
/* "World" and countries outside Malaysia/Indonesia come from the 233-country
   record. Only the dashboard's calendar and history views can show them; the
   hotspot map, forecast and haze pages need the regional Malaysia/Indonesia data. */
const WORLD_SCOPE = "World";
const regionalCountries = () => new Set(state.regions.map((r) => r.country));
function isWorldScope(scope = state.scope) {
  if (scope === WORLD_SCOPE) return true;
  if (scope === "All" || regionalCountries().has(scope)) return false;
  return !state.regions.some((r) => r.region === scope);
}
const worldScopesAllowed = () => route.page === "dashboard" && route.section !== "hotspots";
let scopeOptionsWorld = null;

function fillScopeOptions() {
  const withWorld = worldScopesAllowed() && state.worldCountries.length > 0;
  if (scopeOptionsWorld === withWorld) return;
  scopeOptionsWorld = withWorld;
  const scope = $("#f-scope");
  const opts = withWorld ? [[WORLD_SCOPE, "Worldwide (all countries)"]] : [];
  opts.push(["All", "Malaysia & Indonesia"], ["Malaysia", "  Malaysia"], ["Indonesia", "  Indonesia"]);
  for (const r of state.regions) opts.push([r.region, `  ${r.region} (${r.country === "Malaysia" ? "MY" : "ID"})`]);
  if (withWorld) {
    const regional = regionalCountries();
    for (const c of state.worldCountries) if (!regional.has(c)) opts.push([c, c]);
  }
  scope.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
  scope.value = state.scope;
}

/* Called on every route change: offer world scopes only where they work, and
   default the dashboard to the whole world the first time it is opened. */
let dashboardScopeDefaulted = false;
function syncScopeForRoute() {
  if (!ready) return;
  let next = null;
  if (route.page === "dashboard" && !dashboardScopeDefaulted && state.worldCountries.length) {
    dashboardScopeDefaulted = true;
    if (state.scope === "All") next = WORLD_SCOPE;
  }
  if (!worldScopesAllowed() && isWorldScope()) next = "All";
  fillScopeOptions();
  if (next && next !== state.scope) changeScope(next);
}

function buildFilters() {
  const scope = $("#f-scope");
  fillScopeOptions();
  searchableSelect(scope, "Type a region or country");

  const years = [...new Set(state.series.map((d) => d.year))];
  $("#f-year").innerHTML = years.map((y) => `<option>${y}</option>`).join("");
  $("#f-month").innerHTML = MONTHS_LONG.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");
  const timeline = $("#f-timeline");
  const first = state.series[0];
  const last = state.series.at(-1);
  if (first && last) {
    // One track: observed months, then the two forecast years the API allows.
    state.timelineMin = ym(first);
    state.observedMax = ym(last);
    state.timelineMax = (last.year + 2) * 12 + 12;
    state.cursor ??= state.observedMax;
    timeline.min = state.timelineMin;
    timeline.max = state.timelineMax;
    timeline.disabled = state.timelineMin === state.timelineMax;
    $("#f-first-year").textContent = first.year;
    $("#f-last-year").textContent = last.year + 2;
    paintTimeline();
  }
  timeline.addEventListener("input", () => setCursor(timeline.valueAsNumber));
  $("#h-month").innerHTML = MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");
  $("#h-year").innerHTML = $("#f-year").innerHTML;
  $("#h-year").addEventListener("change", (e) => setYM(+e.target.value, state.month));
  $("#h-month").addEventListener("change", (e) => setYM(state.year, +e.target.value));

  $("#calib-pick").innerHTML = state.regions.map((r) => `<option>${esc(r.region)}</option>`).join("");

  scope.addEventListener("change", () => changeScope(scope.value));
  $("#f-year").addEventListener("change", (e) => setYM(+e.target.value, state.month));
  $("#f-month").addEventListener("change", (e) => setYM(state.year, +e.target.value));
  $("#cal-to-map").addEventListener("click", (e) => {   // calendar -> hotspot map for the selected month
    e.preventDefault();
    initRange().then(() => { rgMonth(state.year, state.month); location.hash = "/dashboard?section=hotspots"; });
  });
  $("#t-raw").addEventListener("change", (e) => { state.raw = e.target.checked; renderTS(); });
  $("#t-log").addEventListener("change", (e) => { state.log = e.target.checked; renderTS(); });
  $("#calib-pick").addEventListener("change", (e) => { state.calibRegion = e.target.value; renderCalib(); });
  document.querySelectorAll(".seg button[data-mode]").forEach((b) => b.addEventListener("click", () => {
    state.calMode = b.dataset.mode;
    document.querySelectorAll(".seg button[data-mode]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderCal();
  }));
}
function syncFilters() {
  $("#f-year").value = String(state.year);
  $("#f-month").value = String(state.month);
  syncTimeline();
  $("#h-year").value = String(state.year);
  $("#h-month").value = String(state.month);
}

/* The timeline cursor is a month index across both eras. Up to the last month of
   FIRMS data it means "show the detections"; past it, "show the forecast". */
const cursorDate = (cursor) => ({ year: Math.floor((cursor - 1) / 12), month: (cursor - 1) % 12 + 1 });
const isForecast = (cursor) => state.observedMax != null && cursor > state.observedMax;

function syncTimeline() {
  const timeline = $("#f-timeline");
  const wrap = timeline.closest(".timeline");
  if (!wrap || state.observedMax == null) return;
  state.cursor ??= ym(state);
  const { year, month } = cursorDate(state.cursor);
  const date = `${MONTHS_LONG[month - 1]} ${year}`;
  const forecast = isForecast(state.cursor);
  timeline.value = state.cursor;
  timeline.setAttribute("aria-valuetext", `${date}, ${forecast ? "forecast" : "satellite detections"}`);
  $("#f-date-label").textContent = date;
  wrap.dataset.mode = forecast ? "forecast" : "observed";
}

function paintTimeline() {
  const track = $("#f-track");
  if (!track || state.timelineMax == null) return;
  const span = state.timelineMax - state.timelineMin || 1;
  const pct = (value) => `${((value - state.timelineMin) / span) * 100}%`;
  track.style.setProperty("--split", pct(state.observedMax));
}

function setCursor(value) {
  state.cursor = value;
  // Keep year/month inside the observed range so the dashboard views stay valid.
  const observed = cursorDate(Math.min(value, state.observedMax));
  setYM(observed.year, observed.month);
  if (route.page === "explorer") loadExplorerWatchlist();
}

function setYM(year, month) {
  periodSelected = true;
  state.year = year;
  state.month = month;
  syncFilters();
  if (activeSection("dashboard", "calendar")) {
    renderTiles();
    tsChart?.update("none");
    renderCal();
  }
  if (activeSection("dashboard", "history")) renderHist();
}

let scopeRequest = 0;
let allRegionsSeries, previousScope;

async function changeScope(scope) {
  const request = ++scopeRequest;
  setStatus("Loading…");
  try {
    const data = await getJSON(`/harmonized?scope=${encodeURIComponent(scope)}`);
    if (request !== scopeRequest) return;
    state.series = data.series;
  } catch (e) {
    if (request !== scopeRequest) return;
    $("#f-scope").value = state.scope;
    setStatus(e.message, true);
    return;
  }
  state.scope = scope;
  $("#f-scope").value = scope;
  setStatus("");
  renderView();
}

let dashboardModule, periodSelected = false;

function loadDashboardSummary(jumpTarget = null) {
  const latest = state.series.at(-1);
  if (!periodSelected && latest) {
    periodSelected = true;
    state.year = latest.year;
    state.month = latest.month;
    syncFilters();
  }
  dashboardModule ??= import("./dashboard.js?v=world-dashboard").catch(() => {
    dashboardModule = null;
    if (route.page === "dashboard") setStatus("The dashboard summary could not load.", true);
  });
  dashboardModule.then(async (module) => {
    if (!module || route.page !== "dashboard") return;
    await module.renderDashboard({
      series: state.series, regions: state.regions, scope: state.scope, world: isWorldScope(),
      year: state.year, month: state.month, getJSON, setMonth: (month) => setYM(state.year, month),
      isVisible: () => route.page === "dashboard", tokens: tokens(), chartTooltip,
    });
    if (jumpTarget && route.page === "dashboard" && route.panel === jumpTarget.dataset.dashboardPanel) {
      jumpToDashboardPanel(jumpTarget);
    }
  });
}

/* ---------- KPI tiles ---------- */
function annualTotals(series) {
  const m = new Map();
  for (const d of series) m.set(d.year, (m.get(d.year) || 0) + d.harmonized);
  return m;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };

function renderTiles() {
  const s = state.series, totals = annualTotals(s);
  const yr = s.filter((d) => d.year === state.year);
  const total = totals.get(state.year) || 0;
  const typical = median([...totals.values()]);
  const ratio = total / typical;
  const peak = yr.reduce((a, d) => (d.harmonized > a.harmonized ? d : a), yr[0] || { harmonized: 0, month: 1 });
  let recY = null, recV = -1;
  for (const [y, v] of totals) if (v > recV) { recV = v; recY = y; }

  const regs = scopeRegionNames();
  const errs = state.calib.filter((c) => regs.includes(c.region)).map((c) => c.median_abs_pct_err_loyo);
  const errTxt = errs.length === 1 ? `±${errs[0]}%` : `±${Math.min(...errs)}–${Math.max(...errs)}%`;
  const world = isWorldScope();
  const worldSource = yr.find((d) => d.source)?.source || "";
  const src = world ? (worldSource.startsWith("VIIRS") ? "VIIRS observed" : "MODIS, scaled to VIIRS")
    : state.year > 2012 ? "VIIRS observed" : state.year < 2012 ? "MODIS, calibrated" : "MODIS Jan · VIIRS Feb–Dec";

  const tiles = [
    { k: `Fire cell-days in ${state.year}`, v: nf.format(total),
      d: isFinite(ratio) ? `${ratio.toFixed(1)}× a typical year (median ${compact(typical)})` : "" },
    { k: `Peak month of ${state.year}`, v: peak ? MONTHS_LONG[peak.month - 1] : "–",
      d: peak ? `${nf.format(peak.harmonized)} cell-days${peak.anomaly != null ? ` · ${peak.anomaly.toFixed(1)}× typical` : ""}` : "" },
    { k: "Worst year, 2003–2025", v: String(recY), d: `${nf.format(recV)} cell-days · ${(recV / typical).toFixed(1)}× typical` },
    { k: `Data for ${state.year}`, v: src, d: world
      ? "Worldwide record · VIIRS NOAA-20 scale, 233 countries"
      : `Calibration error ${errTxt} per month (validated)` },
  ];
  $("#tiles").innerHTML = tiles.map((t) =>
    `<div class="tile"><div class="k">${esc(t.k)}</div><div class="v">${esc(t.v)}</div><div class="d">${esc(t.d)}</div></div>`).join("");
}

function scopeRegionNames() {
  if (isWorldScope()) return [];
  if (state.scope === "All") return state.regions.map((r) => r.region);
  const single = state.regions.find((r) => r.region === state.scope);
  if (single) return [single.region];
  return state.regions.filter((r) => r.country === state.scope).map((r) => r.region);
}

/* ---------- time-series chart ---------- */
let tsChart = null;

const eraPlugin = {
  id: "era",
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea: a, scales: { x } } = chart;
    const s = state.series, t = tokens();
    const iV = s.findIndex((d) => ym(d) >= VIIRS_START);
    ctx.save();
    if (iV > 0) {
      const xv = x.getPixelForValue(iV) - (x.getPixelForValue(1) - x.getPixelForValue(0)) / 2;
      ctx.fillStyle = t.band;
      ctx.fillRect(a.left, a.top, xv - a.left, a.bottom - a.top);
      ctx.fillStyle = t.muted;
      ctx.font = "12px system-ui, -apple-system, 'Segoe UI', sans-serif";
      ctx.textBaseline = "top";
      const left = "MODIS, calibrated to VIIRS", right = "VIIRS observed";
      if (ctx.measureText(left).width + 16 < xv - a.left) ctx.fillText(left, a.left + 8, a.top + 6);
      if (ctx.measureText(right).width + 16 < a.right - xv) ctx.fillText(right, xv + 8, a.top + 6);
    }
    // selected year
    const i0 = s.findIndex((d) => d.year === state.year);
    if (i0 >= 0) {
      const step = x.getPixelForValue(1) - x.getPixelForValue(0);
      const i1 = i0 + s.filter((d) => d.year === state.year).length - 1;
      ctx.fillStyle = t.select;
      ctx.fillRect(x.getPixelForValue(i0) - step / 2, a.top, (i1 - i0 + 1) * step, a.bottom - a.top);
      const im = s.findIndex((d) => d.year === state.year && d.month === state.month);
      if (im >= 0) {
        ctx.strokeStyle = t.ink2;
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x.getPixelForValue(im)) + 0.5, a.top);
        ctx.lineTo(Math.round(x.getPixelForValue(im)) + 0.5, a.bottom);
        ctx.stroke();
      }
    }
    ctx.restore();
  },
};
const crosshairPlugin = {
  id: "crosshair",
  afterDatasetsDraw(chart) {
    const act = chart.tooltip && chart.tooltip.getActiveElements();
    if (!act || !act.length) return;
    const { ctx, chartArea: a } = chart, x = Math.round(act[0].element.x) + 0.5;
    ctx.save();
    ctx.strokeStyle = tokens().axis;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, a.top); ctx.lineTo(x, a.bottom); ctx.stroke();
    ctx.restore();
  },
};

function renderTS() {
  const s = state.series, t = tokens();
  const val = (v) => (state.log ? (v > 0 ? v : null) : v);
  const datasets = [{
    label: "Harmonized (VIIRS scale)", data: s.map((d) => val(d.harmonized)),
    borderColor: t.s1, backgroundColor: t.s1, borderWidth: 2, pointRadius: 0,
    pointHoverRadius: 4, pointHoverBorderWidth: 2, pointHoverBorderColor: t.surface, tension: 0, order: 1,
  }];
  if (state.raw) datasets.push({
    label: "Raw MODIS", data: s.map((d) => val(d.modis)),
    borderColor: t.s2, backgroundColor: t.s2, borderWidth: 1.5, pointRadius: 0,
    pointHoverRadius: 4, pointHoverBorderWidth: 2, pointHoverBorderColor: t.surface, tension: 0, order: 2,
  });

  $("#ts-legend").innerHTML = datasets.map((d) =>
    `<span><span class="sw" style="background:${d.borderColor}"></span>${esc(d.label)}</span>`).join("") +
    `<span><span class="band"></span>Before Feb 2012: MODIS only</span>`;

  const LOG_TICKS = new Set([1, 10, 100, 1000, 10000, 100000]);
  const cfg = {
    type: "line",
    data: { labels: s.map((d) => `${d.year}-${d.month}`), datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...chartTooltip(t),
          callbacks: {
            title: (items) => { const d = s[items[0].dataIndex]; return `${MONTHS_LONG[d.month - 1]} ${d.year}`; },
            label: (it) => ` ${it.dataset.label}: ${it.parsed.y == null ? "0" : nf.format(it.parsed.y)}`,
            footer: (items) => {
              const d = s[items[0].dataIndex];
              const out = [`Source: ${d.source}`];
              if (d.anomaly != null) out.push(`${d.anomaly.toFixed(2)}× a typical ${MONTHS[d.month - 1]}`);
              return out;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false }, border: { color: t.axis },
          ticks: {
            color: t.muted, autoSkip: false, maxRotation: 0,
            callback: (v, i) => (s[i] && s[i].month === 1 && s[i].year % 2 === 1 ? s[i].year : ""),
          },
        },
        y: {
          type: state.log ? "logarithmic" : "linear",
          min: state.log ? 1 : 0,
          grid: { color: t.grid }, border: { display: false },
          ticks: {
            color: t.muted, maxTicksLimit: 6,
            callback: (v) => (state.log ? (LOG_TICKS.has(v) ? compact(v) : "") : compact(v)),
          },
          title: { display: true, text: "Fire cell-days per month", color: t.muted },
        },
      },
      onClick: (_e, els) => { if (els.length) { const d = s[els[0].index]; setYM(d.year, d.month); } },
      onHover: (e, els) => { e.native.target.style.cursor = els.length ? "pointer" : "default"; },
    },
    plugins: [eraPlugin, crosshairPlugin],
  };
  if (tsChart) tsChart.destroy();
  tsChart = new Chart($("#ts"), cfg);
}

/* ---------- burning calendar ---------- */
function renderCal() {
  const s = state.series, t = tokens();
  const seq = ramp(t.seq), div = ramp(t.div);
  const max = Math.max(1, ...s.map((d) => d.harmonized));
  // log scale from the quiet-month level (10th percentile) to the max, so quiet vs burning months separate
  const pos = s.map((d) => d.harmonized).filter((v) => v > 0).sort((a, b) => a - b);
  const lo = Math.max(1, pos.length ? pos[Math.floor(pos.length * 0.1)] : 1);
  const colorOf = (d) => {
    if (state.calMode === "activity") {
      if (d.harmonized <= 0) return t.empty;
      return seq((Math.log(Math.max(d.harmonized, lo)) - Math.log(lo)) / Math.max(1e-9, Math.log(max) - Math.log(lo)));
    }
    if (d.anomaly == null) return t.empty;
    const l2 = Math.max(-2, Math.min(2, Math.log2(Math.max(d.anomaly, 1e-3))));
    return div((l2 + 2) / 4);
  };

  const byKey = new Map(s.map((d, i) => [`${d.year}-${d.month}`, i]));
  const years = [...new Set(s.map((d) => d.year))];
  let html = `<div></div>` + MONTHS.map((m) => `<div class="mh">${m[0]}</div>`).join("");
  for (const y of years) {
    if (y === 2012) html += `<div class="era" title="VIIRS from Feb 2012"></div>`;
    html += `<div class="yl${y === state.year ? " sel" : ""}">${y}</div>`;
    for (let m = 1; m <= 12; m++) {
      const i = byKey.get(`${y}-${m}`);
      if (i == null) { html += "<div></div>"; continue; }
      const d = s[i];
      const sel = y === state.year && m === state.month ? " sel" : "";
      const lab = `${MONTHS_LONG[m - 1]} ${y}: ${nf.format(d.harmonized)} fire cell-days` +
        (d.anomaly != null ? `, ${d.anomaly.toFixed(1)} times typical` : "");
      html += `<button type="button" class="cell${sel}" data-i="${i}" style="background:${colorOf(d)}" aria-label="${esc(lab)}"></button>`;
    }
  }
  const cal = $("#cal");
  cal.innerHTML = html;

  if (state.calMode === "activity") {
    $("#cal-note").textContent = "Fire cell-days per month (log colour scale). Stronger colour means more burning.";
    $("#cal-legend").innerHTML = `<span>≤${compact(lo)}</span><span class="bar" style="background:${gradient(t.seq)}"></span><span>${compact(max)} cell-days</span>`;
  } else {
    $("#cal-note").textContent = "Each month compared with the median of the same month across all years. Red means more burning than usual, blue means less.";
    $("#cal-legend").innerHTML = `<span>¼× typical</span><span class="bar" style="background:${gradient(t.div)}"></span><span>4× typical</span>`;
  }

  // table view (accessibility)
  const rows = s.map((d) => `<tr${d.year === state.year && d.month === state.month ? ' class="sel"' : ""}><td>${MONTHS[d.month - 1]} ${d.year}</td><td>${nf.format(d.harmonized)}</td><td>${d.anomaly != null ? d.anomaly.toFixed(2) + "×" : "–"}</td><td>${esc(d.source)}</td></tr>`).join("");
  $("#cal-table").innerHTML = `<table class="data"><thead><tr><th>Month</th><th>Cell-days</th><th>vs typical</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function calTip(e) {
  const b = e.target.closest(".cell");
  if (!b) return hideTip();
  const d = state.series[+b.dataset.i];
  showTip(`<b>${MONTHS_LONG[d.month - 1]} ${d.year}</b><br>${nf.format(d.harmonized)} fire cell-days` +
    (d.anomaly != null ? `<br>${d.anomaly.toFixed(2)}× a typical ${MONTHS[d.month - 1]} (median ${nf.format(d.median)})` : "") +
    `<br><span class="m">${esc(d.source)}</span>`, e.clientX, e.clientY);
}

/* ---------- map basemap (hotspot map and forecast map) ---------- */
function addLightBasemap(target) {
  return L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
    attribution: "Basemap &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors",
    maxZoom: 16,
  }).addTo(target);
}
/* ---------- calibration ---------- */
let scChart = null;
const predict = (c, m) => (c.model === "linear" ? c.k * m : c.a * Math.pow(m, c.b));

async function renderCalib() {
  const region = state.calibRegion;
  $("#calib-pick").value = region;

  // table
  const fmtModel = (c) => (c.model === "linear"
    ? `${c.k.toFixed(2)} × M`
    : `${c.a.toFixed(2)} × M<sup>${c.b.toFixed(2)}</sup>`);
  $("#calib-table").innerHTML =
    `<thead><tr><th>Region</th><th>VIIRS ≈</th><th>R² (LOYO)</th><th>Error</th><th>Lin. / pow.</th></tr></thead><tbody>` +
    state.calib.map((c) => `<tr${c.region === region ? ' class="sel"' : ""}><td>${esc(c.region)}</td><td>${fmtModel(c)}</td><td>${c.r2_leave_one_year_out.toFixed(3)}</td><td>±${c.median_abs_pct_err_loyo}%</td><td>${c.linear_mape_loyo} / ${c.power_mape_loyo}%</td></tr>`).join("") +
    `</tbody>`;
  $("#calib-foot").textContent = "M = MODIS fire cell-days per month. R² and error come from leave-one-year-out validation (each year predicted by a model fitted without it). Error is the median absolute % error per month; the last column shows it for the linear and power models, and the lower one is used.";

  let d;
  try { d = await getJSON(`/calibration/points?region=${encodeURIComponent(region)}`); } catch (e) {
    if (activeSection("data", "calibration") && region === state.calibRegion) setStatus(e.message, true);
    return;
  }
  if (region !== state.calibRegion) return;
  const c = d.calibration, t = tokens();
  const pts = d.points.filter((p) => p.modis > 0 && p.viirs > 0);
  const xs = pts.map((p) => p.modis);
  const lo = Math.max(1, Math.min(...xs)), hi = Math.max(...xs);
  const curve = Array.from({ length: 50 }, (_, i) => { const m = lo * Math.pow(hi / lo, i / 49); return { x: m, y: predict(c, m) }; });

  if (scChart) scChart.destroy();
  scChart = new Chart($("#scatter"), {
    type: "scatter",
    data: {
      datasets: [
        { label: "Months", data: pts.map((p) => ({ x: p.modis, y: p.viirs, p })), backgroundColor: t.s1,
          borderColor: t.surface, borderWidth: 1, pointRadius: 4, pointHoverRadius: 6, order: 2 },
        { label: `Fitted ${c.model} model`, type: "line", data: curve, borderColor: t.ink, borderWidth: 2,
          pointRadius: 0, pointHoverRadius: 0, order: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "nearest", intersect: true },
      plugins: {
        legend: { display: true, position: "top", align: "start",
                  labels: { color: t.ink2, boxWidth: 14, boxHeight: 2, useBorderRadius: true, borderRadius: 1 } },
        title: { display: true, text: `${region}: ${pts.length} overlap months`, color: t.ink, align: "start", font: { weight: "600" } },
        tooltip: {
          ...chartTooltip(t),
          filter: (it) => it.datasetIndex === 0,
          callbacks: {
            title: (items) => { const p = items[0].raw.p; return `${MONTHS_LONG[p.month - 1]} ${p.year}`; },
            label: (it) => {
              const p = it.raw.p;
              return [` MODIS: ${nf.format(p.modis)}`, ` VIIRS: ${nf.format(p.viirs)}`, ` Model predicts: ${nf.format(predict(c, p.modis))}`];
            },
          },
        },
      },
      scales: {
        x: { type: "logarithmic", title: { display: true, text: "MODIS fire cell-days per month (log)", color: t.muted },
             grid: { color: t.grid }, border: { color: t.axis },
             ticks: { color: t.muted, maxRotation: 0, autoSkip: false, callback: (v) => ([1, 10, 100, 1000, 10000].includes(v) ? compact(v) : "") } },
        y: { type: "logarithmic", title: { display: true, text: "VIIRS fire cell-days per month (log)", color: t.muted },
             grid: { color: t.grid }, border: { display: false },
             ticks: { color: t.muted, callback: (v) => ([1, 10, 100, 1000, 10000, 100000].includes(v) ? compact(v) : "") } },
      },
    },
  });
}

/* ---------- how does a month compare with history? ---------- */
let histChart = null;

function monthStats(month) {
  const rows = state.series.filter((d) => d.month === month);
  const med = median(rows.map((d) => d.harmonized));
  return { rows, med };
}

function verdict(ratio) {
  if (!isFinite(ratio)) return { cls: "near", label: "No comparison", text: "there is no typical level for this month." };
  if (ratio >= 3) return { cls: "", label: "Far above normal", text: "a severe burning month." };
  if (ratio >= 1.5) return { cls: "", label: "Above normal", text: "an unusually active month." };
  if (ratio >= 0.67) return { cls: "near", label: "Near normal", text: "a typical month." };
  return { cls: "below", label: "Below normal", text: "a quieter month than usual." };
}

const medianLinePlugin = {
  id: "medianLine",
  afterDatasetsDraw(chart, _a, opts) {
    const { ctx, chartArea: a, scales: { y } } = chart;
    if (!isFinite(opts.value)) return;
    const t = tokens(), py = Math.round(y.getPixelForValue(opts.value)) + 0.5;
    ctx.save();
    ctx.strokeStyle = t.ink2; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(a.left, py); ctx.lineTo(a.right, py); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = t.ink2; ctx.font = "11px system-ui, -apple-system, 'Segoe UI', sans-serif";
    ctx.textAlign = "right"; ctx.textBaseline = "bottom";
    ctx.fillText(`median ${nf.format(opts.value)}`, a.right - 2, py - 3);
    ctx.restore();
  },
};

function renderHist() {
  const t = tokens(), { rows, med } = monthStats(state.month);
  const colors = rows.map((d) => (d.year === state.year ? t.s2 : (d.year * 12 + d.month < VIIRS_START ? t.eraOld : t.s1)));
  $("#hist-legend").innerHTML =
    `<span><span class="area" style="background:${t.eraOld}"></span>MODIS era (calibrated)</span>` +
    `<span><span class="area" style="background:${t.s1}"></span>VIIRS era</span>` +
    `<span><span class="area" style="background:${t.s2}"></span>Selected year</span>`;

  if (histChart) histChart.destroy();
  histChart = new Chart($("#hist"), {
    type: "bar",
    data: { labels: rows.map((d) => d.year), datasets: [{ data: rows.map((d) => d.harmonized), backgroundColor: colors,
      borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "start", categoryPercentage: 0.85, barPercentage: 0.9 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: false },
        medianLine: { value: med },
        tooltip: { ...chartTooltip(t), displayColors: false, callbacks: {
          title: (it) => `${MONTHS_LONG[state.month - 1]} ${rows[it[0].dataIndex].year}`,
          label: (it) => { const d = rows[it.dataIndex]; return [`${nf.format(d.harmonized)} fire cell-days`, `${(d.harmonized / med).toFixed(1)}× the median`, d.source]; },
        } },
      },
      scales: {
        x: { grid: { display: false }, border: { color: t.axis },
             ticks: { color: t.muted, maxRotation: 0, autoSkip: false, callback: (v, i) => (rows[i] && rows[i].year % 2 === 1 ? rows[i].year : "") } },
        y: { beginAtZero: true, grid: { color: t.grid }, border: { display: false }, ticks: { color: t.muted, maxTicksLimit: 5, callback: (v) => compact(v) } },
      },
      onClick: (_e, els) => { if (els.length) setYM(rows[els[0].index].year, state.month); },
      onHover: (e, els) => { e.native.target.style.cursor = els.length ? "pointer" : "default"; },
    },
    plugins: [medianLinePlugin],
  });

  const d = rows.find((r) => r.year === state.year);
  const box = $("#hist-callout");
  if (!d) { box.textContent = ""; return; }
  const ratio = d.harmonized / med;
  const rank = [...rows].sort((a, b) => b.harmonized - a.harmonized).findIndex((r) => r.year === state.year) + 1;
  const v = verdict(ratio);
  box.className = `callout ${v.cls}`;
  box.innerHTML = `<b>${MONTHS[state.month - 1]} ${state.year}:</b> ${nf.format(d.harmonized)} fire cell-days = <b>${ratio.toFixed(1)}×</b> the 2003–2025 median. ` +
    `Rank ${rank} of ${rows.length} years. <b>${esc(v.label)}</b>: ${esc(v.text)}`;
}

/* ---------- haze preparedness ---------- */
function seasonLevels() {
  const meds = Array.from({ length: 12 }, (_, i) => monthStats(i + 1).med);
  const max = Math.max(...meds), mean = meds.reduce((a, b) => a + b, 0) / 12;
  return meds.map((m) => (m >= 0.5 * max ? "hi" : m > mean ? "mid" : ""));
}
const listMonths = (idx) => idx.map((i) => MONTHS[i]).join(", ");

function prepAdvice() {
  const regs = scopeRegionNames();
  const countries = new Set(state.regions.filter((r) => regs.includes(r.region)).map((r) => r.country));
  const sources = [];
  if (countries.has("Malaysia")) sources.push("Malaysia: APIMS");
  if (countries.has("Indonesia")) sources.push("Indonesia: ISPU");
  sources.push("Singapore: NEA PSI");
  const airLinks = [];
  if (countries.has("Malaysia")) airLinks.push(
    { kind: "live", label: "APIMS – official Air Pollutant Index", source: "Malaysia DOE", href: "https://eqms.doe.gov.my/APIMS/main" },
    { kind: "news", label: "Why your AQI app says 250 when the official API is 175", source: "Malay Mail · 8 Oct 2026", href: "https://www.malaymail.com/news/malaysia/2026/10/08/hazy-math-doe-explains-why-your-aqi-says-250-when-the-official-api-is-175/238237" });
  if (countries.has("Indonesia")) airLinks.push(
    { kind: "live", label: "ISPU – Indeks Standar Pencemar Udara", source: "Indonesia KLH", href: "https://ispu.kemenlh.go.id" },
    { kind: "news", label: "KLH: 17 areas reach the hazardous ISPU category", source: "Metro TV · 22 Oct 2026", href: "https://www.metrotvnews.com/read/KXyCmpdl-klh-udara-17-wilayah-kategori-berbahaya-ispu-tembus-1-299" });
  airLinks.push({ kind: "live", label: "Haze updates and PSI readings", source: "Singapore NEA", href: "https://www.haze.gov.sg" });
  return [
    { tone: "air", icon: PREP_ICONS.air, title: "Watch the air",
      text: `Follow official air-quality readings (${sources.join("; ")}) and set alerts.`,
      facts: [
        "Use the official index for your country. Phone apps often show an international AQI, which uses a different scale and can read much higher for the same air.",
        "Malaysia's API and Indonesia's ISPU share the same bands: 0–50 good, 51–100 moderate, 101–200 unhealthy, 201–300 very unhealthy, above 300 hazardous.",
        "Smoke can drift across borders within days, so check readings even when fires are far away.",
      ],
      links: airLinks },
    { tone: "mask", icon: PREP_ICONS.mask, title: "Get the right mask",
      text: "Stock well-fitting N95/KN95 masks. Surgical masks do little against fine smoke particles.",
      facts: [
        "A mask only protects if it seals over both nose and mouth. A loose N95 lets smoke leak in around the edges.",
        "Short trips, such as home to school or work, usually don't need an N95. Long or hard outdoor activity in unhealthy air does.",
        "People with severe heart or lung problems should ask a doctor before wearing an N95, because it makes breathing harder.",
      ],
      links: [
        { kind: "guide", label: "How to protect yourself against the haze", source: "HealthHub Singapore", href: "https://www.healthhub.sg/live-healthy/how-to-protect-yourself-against-haze" },
        { kind: "guide", label: "Public health advice during wildfires", source: "WHO Europe", href: "https://www.who.int/europe/news-room/questions-and-answers/item/public-health-advice-during-the-wildfires--how-to-protect-your-health-and-keep-safe" },
        { kind: "news", label: "Singapore agencies step up haze measures", source: "NEA · Aug 2026", href: "https://www.nea.gov.sg/media/news/news/index/singapore-government-agencies-implement-measures-to-mitigate-impact-of-haze-Aug2026" },
      ] },
    { tone: "health", icon: PREP_ICONS.health, title: "Check your health plan",
      text: "People with asthma, heart or lung conditions: check medication and an action plan with a doctor.",
      facts: [
        "Most at risk: babies and young children, older people, pregnant women, and anyone with heart or lung disease.",
        "Keep enough medication at home for a hazy spell, and know when to use your reliever or action plan.",
        "Get medical help quickly for trouble breathing, chest pain or wheezing that does not settle.",
      ],
      links: [
        { kind: "news", label: "Wildfire smoke poses a hidden health threat", source: "UN News · Jul 2026", href: "https://news.un.org/en/story/2026/07/1168060" },
        { kind: "guide", label: "Who is most at risk, and what to do", source: "WHO Europe", href: "https://www.who.int/europe/news-room/questions-and-answers/item/public-health-advice-during-the-wildfires--how-to-protect-your-health-and-keep-safe" },
      ] },
    { tone: "home", icon: PREP_ICONS.home, title: "Make a clean-air room",
      text: "Schools and parents: plan indoor activities and keep a clean-air room (windows shut, air purifier).",
      facts: [
        "Pick a room everyone fits in, ideally with a bathroom nearby. Close its windows and doors, but keep it easy to leave.",
        "Run a portable HEPA air cleaner, or set the air-conditioner to recirculate.",
        "Don't add smoke indoors: no candles, incense, smoking or frying. Clean with a damp cloth so dust doesn't fly back up.",
        "Air the room out once the outdoor readings improve.",
      ],
      links: [
        { kind: "guide", label: "Create a clean room during wildfire smoke", source: "US EPA", href: "https://www.epa.gov/indoor-air-quality-iaq/create-clean-room-protect-indoor-air-quality-during-wildfire" },
        { kind: "guide", label: "Clean room infographic (printable)", source: "US EPA", href: "https://www.epa.gov/emergencies-iaq/create-clean-room-during-wildfire-infographic" },
        { kind: "guide", label: "Haze guidelines for workplaces", source: "Singapore MOM", href: "https://www.mom.gov.sg/haze" },
      ] },
  ];
}
const PREP_KIND = { live: "Live data", guide: "Guide", news: "News" };
const prepOpen = new Set();

/* ---- live headlines: /api/news (backend fetches Google News, cached ~2 h) ----
   The built-in News links above are the fallback; when the backend has newer
   headlines they replace them. Re-checked every 30 minutes while the page is open. */
const NEWS_TTL = 30 * 60 * 1000;
const newsCache = new Map();
function liveNews(topic, countries) {
  const key = topic + "|" + countries.join(",");
  const hit = newsCache.get(key);
  if (hit && Date.now() - hit.t < NEWS_TTL) return hit.p;
  const p = getJSON("/news?" + new URLSearchParams({ topic, countries: countries.join(","), limit: 3 }))
    .catch(() => { newsCache.delete(key); return { items: [] }; });
  newsCache.set(key, { t: Date.now(), p });
  return p;
}
const newsDay = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
function newsWhen(iso) {
  const d = new Date(iso), days = Math.floor((Date.now() - d) / 864e5);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? days + " days ago" : newsDay.format(d);
}
function scopeCountries() {
  const regs = scopeRegionNames();
  return [...new Set(state.regions.filter((r) => regs.includes(r.region)).map((r) => r.country))].sort();
}
let prepNewsToken = 0;
function updatePrepNews() {
  const token = ++prepNewsToken, countries = scopeCountries();
  for (const tone of ["air", "mask", "health", "home"]) {
    liveNews(tone, countries).then((d) => {
      const ul = $("#prep-links-" + tone);
      if (token !== prepNewsToken || !ul || !d.items?.length) return;
      ul.querySelectorAll('li[data-kind="news"]').forEach((li) => li.remove());
      ul.insertAdjacentHTML("afterbegin", d.items.map((n) => `<li data-kind="news"><a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">
          <span class="prep-kind prep-kind-news">News · ${esc(newsWhen(n.published))}</span>
          <span class="prep-link-text">${esc(n.title)}<small>${esc(n.source || "News")}</small></span>
          <span class="prep-ext" aria-hidden="true">↗</span><span class="sr-only">(opens in a new tab)</span></a></li>`).join(""));
      const head = $("#prep-src-" + tone);
      if (head) head.innerHTML = `Read more <span class="prep-live"><i aria-hidden="true"></i>Latest news, updated automatically</span>`;
    });
  }
}
setInterval(() => { if (route.page === "haze") updatePrepNews(); }, NEWS_TTL);

// Small cartoon icons for the haze kit cards (48×48, inline SVG, decorative).
const PREP_ICONS = {
  air: `<svg viewBox="0 0 48 48"><rect x="12" y="5" width="22" height="38" rx="5" fill="#fff" stroke="currentColor" stroke-width="2.5"/>
    <path d="M17 27a6 6 0 0 1 12 0" fill="none" stroke="#22c55e" stroke-width="3" stroke-linecap="round"/>
    <path d="M23 27l3-4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><circle cx="23" cy="27" r="1.8" fill="currentColor"/>
    <rect x="18" y="34" width="10" height="3" rx="1.5" fill="currentColor" opacity=".35"/>
    <g class="prep-ring"><path d="M36 9a5 5 0 0 1 5 5v4l2 3H31l2-3v-4a5 5 0 0 1 3-5z" fill="#facc15" stroke="#b45309" stroke-width="1.6"/><circle cx="37" cy="23" r="1.8" fill="#b45309"/></g></svg>`,
  mask: `<svg viewBox="0 0 48 48"><path d="M6 20c-3 0-3 9 3 10M42 20c3 0 3 9-3 10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M8 18q16-8 32 0l-2 14q-14 9-28 0z" fill="#fff" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M13 23q11-4 22 0M13 28q11-4 22 0" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".45"/>
    <text x="24" y="40" text-anchor="middle" font-size="7" font-weight="700" fill="currentColor" font-family="sans-serif">N95</text></svg>`,
  health: `<svg viewBox="0 0 48 48"><path class="prep-beat" d="M24 41S6 30 6 17a9 9 0 0 1 18-3 9 9 0 0 1 18 3c0 13-18 24-18 24z" fill="#fda4af" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M10 23h8l3-6 4 11 3-5h10" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  home: `<svg viewBox="0 0 48 48"><path d="M6 22L24 7l18 15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M10 20v21h28V20" fill="#fff" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
    <rect x="17" y="26" width="14" height="13" rx="2.5" fill="#ddd6fe" stroke="currentColor" stroke-width="2"/>
    <g class="prep-fan"><path d="M24 32.5l0-4.5M24 32.5l3.9 2.2M24 32.5l-3.9 2.2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></g>
    <circle cx="24" cy="32.5" r="1.3" fill="currentColor"/>
    <path class="prep-breeze" d="M34 12q4-2 6 1M36 16q4-2 7 1" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"/></svg>`,
};

/* Hero "jump" buttons (Outlook, Prepare): scroll to a section on the same page.
   Buttons, not #anchors, because the hash is used for page routing. */
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-jump]");
  if (!b) return;
  const target = document.getElementById(b.dataset.jump);
  if (!target) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  target.classList.remove("pg-flash"); void target.offsetWidth; target.classList.add("pg-flash");
});

/* "Open … in World": jump to the World map (#/explorer) showing the area picked
   here. The Area filter is shared by every page, so the map opens on it. */
function syncOpenWorld() {
  const name = $("#haze-open-world-name");
  if (!name) return;
  const label = ($("#f-scope").selectedOptions[0]?.textContent || "All regions").trim();
  name.textContent = state.scope === "All" ? "all regions" : label.replace(/\s*\((MY|ID)\)$/, "");
  const btn = $("#haze-open-world");
  if (!btn.dataset.bound) {
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => { location.hash = "/explorer"; });
  }
}

/* ---------- haze history (Prepare page) ----------
   Yearly fire activity for the selected area from the harmonized monthly series,
   rated against the area's own typical year. Well-known regional haze episodes
   get a short note. */
const HAZE_EVENTS = {
  2006: "Fires in Sumatra and Kalimantan sent thick smoke across Malaysia and Singapore in September and October.",
  2013: "In June, smoke from Riau in Sumatra pushed Singapore's PSI to a then-record 401, and parts of Johor in Malaysia declared an emergency.",
  2015: "The worst haze since 1997: months of peat fires in Sumatra and Kalimantan, with schools closed across Malaysia and Singapore in September and October.",
  2019: "Fires in Sumatra and Kalimantan brought haze to Malaysia in September; Sarawak was among the hardest hit and many schools closed.",
  2023: "An El Niño year: fires in South Sumatra and Kalimantan brought haze back to Malaysia in October.",
};
// These episodes were the Sumatra / Borneo haze that reached Malaysia and Singapore;
// the notes are shown only for the areas involved.
const HAZE_EVENT_AREAS = new Set(["All", "Malaysia", "Indonesia", "Sumatra", "Kalimantan",
  "Peninsular Malaysia", "Sarawak", "Sabah"]);
let hzYear = null, hzScope = null;

function hazeYears() {
  const by = new Map();
  for (const d of state.series) {
    if (!by.has(d.year)) by.set(d.year, []);
    by.get(d.year).push(d);
  }
  const years = [...by.entries()].filter(([, ms]) => ms.length === 12)
    .map(([year, ms]) => ({ year, months: ms.sort((a, b) => a.month - b.month), total: ms.reduce((s, d) => s + d.harmonized, 0) }));
  const typical = median(years.map((y) => y.total));
  for (const y of years) {
    y.ratio = typical ? y.total / typical : 0;
    y.level = y.ratio >= 2 ? "sev" : y.ratio >= 1.3 ? "high" : "norm";
    y.peak = y.months.reduce((a, d) => (d.harmonized > a.harmonized ? d : a), y.months[0]);
  }
  return { years, typical };
}

const HZ_LEVEL = { sev: "Severe", high: "High", norm: "Normal" };
function renderHazeHistory() {
  const box = $("#hz-chart");
  if (!box) return;
  const scopeLabel = state.scope === "All" ? "all regions" : state.scope;
  $("#hz-area").textContent = scopeLabel;

  const { years, typical } = hazeYears();
  const events = HAZE_EVENT_AREAS.has(state.scope) ? HAZE_EVENTS : {};
  if (!years.length) { box.innerHTML = ""; $("#hz-top").innerHTML = ""; $("#hz-detail").innerHTML = ""; return; }
  if (hzScope !== state.scope || !years.some((y) => y.year === hzYear)) {
    hzScope = state.scope;
    hzYear = years.reduce((a, y) => (y.total > a.total ? y : a)).year;   // start on the worst year
  }

  // worst three years
  const worst = [...years].sort((a, b) => b.total - a.total).slice(0, 3);
  $("#hz-top").innerHTML = `<span class="hz-top-h">Worst years</span>` + worst.map((y, i) =>
    `<button type="button" class="hz-top-card hz-${y.level}" data-year="${y.year}" aria-pressed="${y.year === hzYear}">
      <span class="hz-rank">${i + 1}</span><b>${y.year}</b><small>${y.ratio.toFixed(1)}× a normal year</small></button>`).join("");

  // one bar per year, with the typical-year line
  const max = Math.max(...years.map((y) => y.total));
  box.style.setProperty("--typ", (typical / max * 200).toFixed(1) + "px");
  box.innerHTML = `<span class="hz-typ" aria-hidden="true"><em>Normal year</em></span>` + years.map((y) =>
    `<button type="button" class="hz-bar hz-${y.level}" data-year="${y.year}" aria-pressed="${y.year === hzYear}"
       title="${y.year}: ${nf.format(Math.round(y.total))} fire cell-days, ${y.ratio.toFixed(1)}× a normal year (${HZ_LEVEL[y.level]})"
       aria-label="${y.year}, ${y.ratio.toFixed(1)} times a normal year, ${HZ_LEVEL[y.level]}${events[y.year] ? ", known haze year" : ""}">
       <span class="hz-fill" style="height:${Math.max(2, y.total / max * 100).toFixed(2)}%">${events[y.year] ? '<i class="hz-flag" aria-hidden="true"></i>' : ""}</span>
       <span class="hz-year">${y.year}</span></button>`).join("");

  // selected year
  const y = years.find((v) => v.year === hzYear);
  const mMax = Math.max(...y.months.map((d) => d.harmonized), 1);
  $("#hz-detail").innerHTML = `
    <div class="hz-detail-head">
      <b class="hz-detail-year">${y.year}</b>
      <span class="hz-pill hz-${y.level}">${HZ_LEVEL[y.level]}</span>
      <span class="hz-detail-stat"><b>${y.ratio.toFixed(1)}×</b> a normal year</span>
      <span class="hz-detail-stat"><b>${nf.format(Math.round(y.total))}</b> fire cell-days</span>
      <span class="hz-detail-stat">Peak: <b>${MONTHS_LONG[y.peak.month - 1]}</b></span>
    </div>
    <div class="hz-months" aria-label="Fire activity by month in ${y.year}">${y.months.map((d) =>
      `<span class="hz-month${d.month === y.peak.month ? " is-peak" : ""}" title="${MONTHS_LONG[d.month - 1]} ${y.year}: ${nf.format(Math.round(d.harmonized))} fire cell-days${d.anomaly != null ? `, ${d.anomaly.toFixed(1)}× a typical ${MONTHS_LONG[d.month - 1]}` : ""}">
        <i style="height:${Math.max(3, d.harmonized / mMax * 100).toFixed(1)}%"></i><small>${MONTHS[d.month - 1][0]}</small></span>`).join("")}</div>
    ${events[y.year] ? `<p class="hz-event"><span aria-hidden="true">⚑</span> <b>Known haze year.</b> ${esc(events[y.year])}</p>` : ""}`;

  const sec = box.closest(".hz-hist");
  if (!sec.dataset.bound) {
    sec.dataset.bound = "1";
    sec.addEventListener("click", (e) => {
      const yb = e.target.closest("[data-year]");
      if (yb) { hzYear = +yb.dataset.year; renderHazeHistory(); }
    });
  }
}

function renderHaze() {
  syncOpenWorld();
  renderHazeHistory();
  const lv = seasonLevels();
  $("#season-chips").innerHTML = lv.map((l, i) =>
    `<span class="chip ${l}" title="${l === "hi" ? "High-risk month" : l === "mid" ? "Above-average month" : "Lower-risk month"}">${MONTHS[i]}</span>`).join("");
  const hi = lv.map((l, i) => (l === "hi" ? i : -1)).filter((i) => i >= 0);
  const mid = lv.map((l, i) => (l === "mid" ? i : -1)).filter((i) => i >= 0);
  $("#season-line").innerHTML = `<b>High-risk months:</b> ${esc(listMonths(hi) || "none")}.` +
    (mid.length ? ` Lighter shading marks above-average months (${esc(listMonths(mid))}).` : "");
  const list = $("#prep-list");
  list.innerHTML = prepAdvice().map((tip, i) => {
    const open = prepOpen.has(tip.tone);
    return `<li class="prep-card prep-${tip.tone}" style="--i:${i}">
      <span class="prep-icon" aria-hidden="true">${tip.icon}</span>
      <span class="prep-step" aria-hidden="true">${i + 1}</span>
      <b>${esc(tip.title)}</b><span class="prep-text">${esc(tip.text)}</span>
      <button type="button" class="prep-more-btn" data-tone="${tip.tone}" aria-expanded="${open}" aria-controls="prep-more-${tip.tone}">
        <span>${open ? "Show less" : "Learn more"}</span><i aria-hidden="true">â–¾</i></button>
      <div class="prep-more" id="prep-more-${tip.tone}"${open ? "" : " hidden"}>
        <ul class="prep-facts">${tip.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
        <p class="prep-src-h" id="prep-src-${tip.tone}">Read more</p>
        <ul class="prep-links" id="prep-links-${tip.tone}">${tip.links.map((l) => `<li data-kind="${l.kind}"><a href="${l.href}" target="_blank" rel="noopener noreferrer">
          <span class="prep-kind prep-kind-${l.kind}">${PREP_KIND[l.kind]}</span>
          <span class="prep-link-text">${esc(l.label)}<small>${esc(l.source)}</small></span>
          <span class="prep-ext" aria-hidden="true">↗</span><span class="sr-only">(opens in a new tab)</span></a></li>`).join("")}</ul>
      </div></li>`;
  }).join("");
  updatePrepNews();
  if (!list.dataset.bound) {
    list.dataset.bound = "1";
    list.addEventListener("click", (e) => {
      const btn = e.target.closest(".prep-more-btn");
      if (!btn) return;
      const open = btn.getAttribute("aria-expanded") !== "true";
      btn.setAttribute("aria-expanded", String(open));
      btn.querySelector("span").textContent = open ? "Show less" : "Learn more";
      $("#prep-more-" + btn.dataset.tone).hidden = !open;
      if (open) prepOpen.add(btn.dataset.tone); else prepOpen.delete(btn.dataset.tone);
    });
  }
  renderOutlookChips();
}

function renderOutlookChips() {
  const f = state.fc.data, wrap = $("#outlook-wrap");
  if (!f) { wrap.hidden = true; return; }
  wrap.hidden = false;
  $("#outlook-label").textContent = `Forecast for ${f.year} (${f.enso_used}): chance of an above-normal month`;
  $("#outlook-chips").innerHTML = f.months.map((m) => {
    const cls = m.p_above_normal >= 0.5 ? "hi" : m.p_above_normal >= 0.25 ? "mid" : "";
    return `<span class="chip ${cls}" title="${Math.round(m.p_above_normal * 100)}% chance of more than ${f.above_normal_threshold}× the usual ${MONTHS_LONG[m.month - 1]}">${MONTHS[m.month - 1]}<small>${Math.round(m.p_above_normal * 100)}%</small></span>`;
  }).join("");
  const risky = f.months.filter((m) => m.p_above_normal >= 0.5).map((m) => m.month - 1);
  $("#outlook-line").textContent = risky.length
    ? `Higher than usual risk in ${listMonths(risky)} (50% chance or more of burning above ${f.above_normal_threshold}× the usual level for that month).`
    : `No month has a 50% or higher chance of above-normal burning in this forecast.`;
}

/* ---------- forecast ---------- */
let fcChart = null, fcReq = 0;

function buildForecastControls() {
  const last = Math.max(...state.series.map((d) => d.year));
  state.fc.year = state.fc.year || last + 1;
  $("#fc-year").innerHTML = [last + 1, last + 2].map((y) => `<option>${y}</option>`).join("");
  $("#fc-year").value = String(state.fc.year);
  fillEnsoOptions();
  $("#fc-year").addEventListener("change", (e) => { state.fc.year = +e.target.value; fillEnsoOptions(); loadForecast(); });
  $("#fc-enso").addEventListener("change", (e) => { state.fc.enso = e.target.value; loadForecast(); });
}

function fillEnsoOptions() {
  const o = state.oni || {};
  const hasObs = o.available && o.latest_year >= state.fc.year;
  const opts = [];
  if (hasObs) opts.push(["observed", `NOAA observed (latest ${o.latest_value > 0 ? "+" : ""}${o.latest_value}, ${o.state})`]);
  opts.push(["2", "Strong El Niño (+2.0)"], ["1", "Moderate El Niño (+1.0)"], ["0", "Neutral (0)"], ["-1", "La Niña (−1.0)"]);
  $("#fc-enso").innerHTML = opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
  if (!opts.some(([v]) => v === state.fc.enso)) state.fc.enso = hasObs ? "observed" : "0";
  $("#fc-enso").value = state.fc.enso;
}

async function loadForecast() {
  const id = ++fcReq;
  const showMap = route.page === "forecast";
  if (showMap) loadWhere();
  const q = (year, enso) => `/forecast?${new URLSearchParams({ scope: state.scope, year, enso })}`;
  const status = showMap ? $("#fc-notes") : $("#haze-status");
  status.textContent = "Computing forecast…";
  $("#outlook-wrap").hidden = true;
  try {
    const main = await getJSON(q(state.fc.year, state.fc.enso));
    // for the 2nd year, also fetch the 1st so the chart has no gap
    const prev = main.year > main.data_ends + 1
      ? await getJSON(q(main.data_ends + 1, state.oni && state.oni.available && state.oni.latest_year > main.data_ends ? "observed" : "0"))
      : null;
    if (id !== fcReq) return;
    state.fc.data = main;
    state.fc.prev = prev;
  } catch (e) {
    if (id === fcReq) status.textContent = `Forecast unavailable: ${e.message}`;
    return;
  }
  status.textContent = "";
  if (route.page === "forecast") renderForecast();
  if (route.page === "haze") renderOutlookChips();
}

function renderForecast() {
  const f = state.fc.data, prev = state.fc.prev, t = tokens();
  if (!f) return;
  const o = f.oni;
  $("#enso-line").innerHTML = o && o.available
    ? `Latest NOAA El Niño index (ONI): <b>${o.latest_value > 0 ? "+" : ""}${o.latest_value}</b> for ${esc(o.latest_season)} ${o.latest_year}, which is <b>${esc(o.state)}</b>. Model for this area: <b>${esc(f.model)}</b>.`
    : `El Niño index unavailable (offline?). Using the seasonal model only.`;

  // tiles
  const a = f.annual, bt = f.backtest.chosen;
  const peak = f.months.reduce((x, m) => (m.expected > x.expected ? m : x), f.months[0]);
  const riskiest = f.months.reduce((x, m) => (m.p_above_normal > x.p_above_normal ? m : x), f.months[0]);
  const ratio = a.expected / a.typical;
  $("#fc-tiles").innerHTML = [
    { k: `Expected fire cell-days, ${f.year}`, v: nf.format(a.expected), d: `80% range ${compact(a.low)}–${compact(a.high)}` },
    { k: "Compared with a typical year", v: `${ratio.toFixed(1)}×`, d: `Typical (median) year: ${compact(a.typical)}` },
    { k: "Peak month expected", v: MONTHS_LONG[peak.month - 1], d: `${nf.format(peak.expected)} cell-days · ${riskiest.p_above_normal >= 0.25 ? `${MONTHS[riskiest.month - 1]} has a ${Math.round(riskiest.p_above_normal * 100)}% chance of above normal` : "low chance of an above-normal month"}` },
    { k: "Backtest accuracy", v: `±${bt.median_abs_pct_err}%`, d: `Typical monthly error, ${bt.test_years}. ${bt.coverage_80}% of months fell inside the 80% range.` },
  ].map((x) => `<div class="tile"><div class="k">${esc(x.k)}</div><div class="v">${esc(x.v)}</div><div class="d">${esc(x.d)}</div></div>`).join("");

  // chart: last 24 actual months + forecast months
  const pts = [];
  for (const r of f.recent) pts.push({ y: r.year, m: r.month, actual: r.value });
  const addFc = (fc) => fc.months.forEach((m) => pts.push({ y: fc.year, m: m.month, fc: m.expected, lo: m.low, hi: m.high, typ: m.typical, p: m.p_above_normal, oni: m.oni }));
  if (prev) addFc(prev);
  addFc(f);
  const typ = f.months.map((m) => m.typical);
  pts.forEach((p) => { if (p.typ == null) p.typ = typ[p.m - 1]; });
  // connect the forecast line to the last actual point
  const lastActual = pts.filter((p) => p.actual != null).length - 1;
  pts[lastActual].fc = pts[lastActual].actual;

  const band = t.s1 + "26";
  $("#fc-legend").innerHTML =
    `<span><span class="sw" style="background:${t.s1}"></span>Actual</span>` +
    `<span><span class="dash" style="border-color:${t.s1}"></span>Forecast (most likely)</span>` +
    `<span><span class="area" style="background:${band}"></span>80% range</span>` +
    `<span><span class="dot" style="border-color:${t.muted}"></span>Typical month (2003–2025 median)</span>`;

  if (fcChart) fcChart.destroy();
  fcChart = new Chart($("#fc-chart"), {
    type: "line",
    data: {
      labels: pts.map((p) => `${MONTHS[p.m - 1]} ${p.y}`),
      datasets: [
        { label: "low", data: pts.map((p) => p.lo ?? null), borderWidth: 0, pointRadius: 0, pointHoverRadius: 0, fill: false },
        { label: "80% range", data: pts.map((p) => p.hi ?? null), borderWidth: 0, pointRadius: 0, pointHoverRadius: 0, backgroundColor: band, fill: "-1" },
        { label: "Typical", data: pts.map((p) => p.typ), borderColor: t.muted, borderWidth: 1.5, borderDash: [2, 3], pointRadius: 0, pointHoverRadius: 0 },
        { label: "Actual", data: pts.map((p) => p.actual ?? null), borderColor: t.s1, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBorderColor: t.surface, pointHoverBorderWidth: 2 },
        { label: "Forecast", data: pts.map((p) => p.fc ?? null), borderColor: t.s1, borderWidth: 2, borderDash: [6, 4], pointRadius: 0, pointHoverRadius: 4, pointHoverBorderColor: t.surface, pointHoverBorderWidth: 2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { ...chartTooltip(t), displayColors: false,
          filter: (it) => {
            const p = pts[it.dataIndex], l = it.dataset.label;
            return (l === "Actual" && p.actual != null) || (l === "Forecast" && p.lo != null) || l === "Typical";
          },
          callbacks: {
            label: (it) => {
              const p = pts[it.dataIndex];
              if (it.dataset.label === "Actual") return `Actual: ${nf.format(p.actual)}`;
              if (it.dataset.label === "Forecast") return `Forecast: ${nf.format(p.fc)} (80% range ${nf.format(p.lo)}–${nf.format(p.hi)})`;
              return `Typical: ${nf.format(p.typ)}`;
            },
            footer: (items) => { const p = pts[items[0].dataIndex]; return p.p != null ? [`Chance above normal: ${Math.round(p.p * 100)}%`, p.oni != null ? `ONI used: ${p.oni > 0 ? "+" : ""}${p.oni}` : ""] : ""; },
          } },
      },
      scales: {
        x: { grid: { display: false }, border: { color: t.axis },
             ticks: { color: t.muted, maxRotation: 0, autoSkip: false, callback: (v, i) => (pts[i] && (pts[i].m === 1 || pts[i].m === 7) ? `${MONTHS[pts[i].m - 1]} ${pts[i].y}` : "") } },
        y: { beginAtZero: true, grid: { color: t.grid }, border: { display: false },
             ticks: { color: t.muted, maxTicksLimit: 6, callback: (v) => compact(v) },
             title: { display: true, text: "Fire cell-days per month", color: t.muted } },
      },
    },
    plugins: [{
      id: "fcStart",
      beforeDatasetsDraw(chart) {
        const { ctx, chartArea: ar, scales: { x } } = chart;
        const i0 = lastActual + 1;
        if (i0 >= pts.length) return;
        const px = x.getPixelForValue(i0) - (x.getPixelForValue(1) - x.getPixelForValue(0)) / 2;
        ctx.save();
        ctx.fillStyle = t.band; ctx.fillRect(px, ar.top, ar.right - px, ar.bottom - ar.top);
        ctx.fillStyle = t.muted; ctx.font = "12px system-ui, -apple-system, 'Segoe UI', sans-serif"; ctx.textBaseline = "top";
        ctx.fillText("Forecast", px + 8, ar.top + 6);
        ctx.restore();
      },
    }],
  });

  // notes + table
  const notes = [...f.notes];
  if (prev) notes.unshift(`${prev.year} is shown with ${prev.enso_used.toLowerCase()} so the chart has no gap.`);
  notes.push("Monthly fire counts are very variable, so treat the range as more meaningful than the single number. Rainfall, the Indian Ocean Dipole and fire policy also matter, and this model doesn't see them.");
  $("#fc-notes").textContent = notes.join(" ");
  $("#fc-table").innerHTML = `<thead><tr><th>Month</th><th>Most likely</th><th>80% range</th><th>Typical</th><th>vs typical</th><th>Chance above normal</th><th>ONI used</th></tr></thead><tbody>` +
    f.months.map((m) => `<tr><td>${MONTHS_LONG[m.month - 1]} ${f.year}</td><td>${nf.format(m.expected)}</td><td>${nf.format(m.low)}–${nf.format(m.high)}</td><td>${nf.format(m.typical)}</td><td>${m.ratio_to_typical != null ? m.ratio_to_typical.toFixed(1) + "×" : "–"}</td><td>${Math.round(m.p_above_normal * 100)}%</td><td>${m.oni != null ? (m.oni > 0 ? "+" : "") + m.oni : "–"}</td></tr>`).join("") + `</tbody>`;
}

/* ---------- forecast: where ---------- */
let fcMap = null, fcBase = null, fcCells = null, whereReq = 0;
const where = { data: null, month: null };

function initFcMap() {
  fcMap = L.map("fc-map", { preferCanvas: true, minZoom: 4, maxZoom: 11, zoomSnap: 0.25 });
  setFcBasemap();
  $("#fc-map-reset").addEventListener("click", fitFcMap);
}
function setFcBasemap() {
  if (!fcMap) return;
  if (fcBase) fcMap.removeLayer(fcBase);
  fcBase = addLightBasemap(fcMap);
}
function fitFcMap() {
  const regs = scopeRegionNames();
  const boxes = state.regions.filter((r) => regs.includes(r.region)).map((r) => r.bbox);
  if (!boxes.length || !fcMap) return;
  fcMap.fitBounds([[Math.min(...boxes.map((x) => x[1])), Math.min(...boxes.map((x) => x[0]))],
                   [Math.max(...boxes.map((x) => x[3])), Math.max(...boxes.map((x) => x[2]))]], { padding: [4, 4] });
}

async function loadWhere() {
  const id = ++whereReq;
  $("#where-note").textContent = "Computing the place-by-place forecast… (the first time can take a few seconds)";
  let d;
  try {
    d = await getJSON(`/forecast/map?${new URLSearchParams({ scope: state.scope, year: state.fc.year, enso: state.fc.enso })}`);
  } catch (e) {
    if (id === whereReq) $("#where-note").textContent = `Place-by-place forecast unavailable: ${e.message}`;
    return;
  }
  if (id !== whereReq) return;
  where.data = d;
  $("#fc-map-reset").disabled = false;
  // default month: the month with most expected fire days
  if (!where.month) where.month = d.months.reduce((a, m) => (m.expected_fire_days > a.expected_fire_days ? m : a), d.months[0]).month;
  $("#where-note").textContent = `Chance of at least one fire day in each ${d.cell_deg}° (~28 km) grid cell, ${d.year} (${d.enso_used}). Pick a month.`;
  const s = d.skill;
  $("#where-skill").textContent = `How reliable: tested on ${s.test_years} (each year predicted from earlier years only). The 10% of cells rated riskiest contained ${s.top10_capture_pct}% of all fire days. Ranking skill AUC = ${s.auc} (0.5 = guessing, 1 = perfect). Brier score ${s.brier}, compared with ${s.base_rate_brier} for guessing the same chance everywhere (lower is better).`;
  fitFcMap();
  renderWhere();
}

function renderWhere() {
  const d = where.data, t = tokens();
  if (!d) return;
  const mi = where.month - 1, mo = d.months[mi];

  // month picker, coloured by how much fire is expected that month
  const maxTot = Math.max(...d.months.map((m) => m.expected_fire_days));
  $("#where-months").innerHTML = d.months.map((m) => {
    const share = m.expected_fire_days / maxTot;
    const cls = share >= 0.5 ? "hi" : share >= 0.2 ? "mid" : "";
    return `<button type="button" role="radio" class="chip ${cls}" data-m="${m.month}" aria-checked="${m.month === where.month}">${MONTHS[m.month - 1]}</button>`;
  }).join("");

  // map
  const r = ramp(t.fire);
  if (fcCells) fcCells.remove();
  fcCells = L.layerGroup(mo.cells.map(([lat, lon, pct, fd10, ai]) =>
    L.rectangle([[lat, lon], [lat + d.cell_deg, lon + d.cell_deg]], {
      stroke: false, fillColor: r((pct - 5) / 85), fillOpacity: 0.85,
    }).bindTooltip(`<b>${pct}% chance</b> of fire in ${MONTHS_LONG[mi]} ${d.year}<br>${esc(d.areas[ai])} · about ${(fd10 / 10).toFixed(1)} fire days expected<br><span style="opacity:.75">${lat.toFixed(2)}°, ${lon.toFixed(2)}° (cell SW corner)</span>`, { sticky: true })
  )).addTo(fcMap);
  $("#fc-map-legend").innerHTML = `<span>5%</span><span class="bar" style="background:${gradient(t.fire)}"></span><span>90%</span>`;

  // top areas
  $("#top-title").textContent = `Top areas in ${MONTHS_LONG[mi]} ${d.year}`;
  const maxShare = Math.max(1, ...mo.top_areas.map((a) => a.share_pct));
  $("#top-areas").innerHTML = mo.top_areas.map((a) =>
    `<li data-area="${esc(a.area)}"><span class="an">${esc(a.area)}</span> <span class="ar">${esc(a.region)}</span>
      <div class="bar" style="width:${(a.share_pct / maxShare) * 100}%"></div>
      <div class="meta">${a.share_pct}% of expected fire days · ${a.high_risk_cells} cell${a.high_risk_cells === 1 ? "" : "s"} at ≥50% chance · highest ${a.max_chance_pct}%</div></li>`).join("");

  // area x month matrix
  $("#matrix-year").textContent = d.year;
  const rows = d.area_matrix.slice(0, 14);
  let html = `<div></div>` + MONTHS.map((m) => `<div class="mh">${m}</div>`).join("");
  for (const row of rows) {
    // colour relative to the area's own peak month -> shows each area's season
    const rowMax = Math.max(1e-9, ...row.values);
    html += `<div class="rh">${esc(row.area)} <small>${esc(row.region)} · ${compact(row.total)}/yr</small></div>`;
    row.values.forEach((v, i) => {
      const c = v < 0.5 ? t.empty : r(v / rowMax);
      const cls = `mc${row.peak_month === i + 1 ? " pk" : ""}${i === mi ? " sel" : ""}`;
      html += `<button type="button" class="${cls}" data-m="${i + 1}" data-a="${esc(row.area)}" data-v="${v}" style="background:${c}" aria-label="${esc(row.area)}, ${MONTHS_LONG[i]}: about ${Math.round(v)} fire days"></button>`;
    });
  }
  $("#fc-matrix").innerHTML = html;
}

function whereEvents() {
  $("#where-months").addEventListener("click", (e) => {
    const b = e.target.closest("[data-m]");
    if (b) { where.month = +b.dataset.m; renderWhere(); }
  });
  const mtx = $("#fc-matrix");
  mtx.addEventListener("click", (e) => {
    const b = e.target.closest("[data-m]");
    if (b) { where.month = +b.dataset.m; renderWhere(); }
  });
  mtx.addEventListener("mousemove", (e) => {
    const b = e.target.closest(".mc");
    if (!b) return hideTip();
    showTip(`<b>${esc(b.dataset.a)}</b><br>${MONTHS_LONG[b.dataset.m - 1]} ${where.data.year}: about ${nf.format(+b.dataset.v)} fire days expected`, e.clientX, e.clientY);
  });
  mtx.addEventListener("mouseleave", hideTip);
  // click a top area -> zoom map to its cells
  $("#top-areas").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-area]");
    if (!li || !where.data) return;
    const d = where.data, ai = d.areas.indexOf(li.dataset.area);
    const cs = d.months[where.month - 1].cells.filter((c) => c[4] === ai);
    if (!cs.length) return;
    fcMap.fitBounds([[Math.min(...cs.map((c) => c[0])), Math.min(...cs.map((c) => c[1]))],
                     [Math.max(...cs.map((c) => c[0])) + d.cell_deg, Math.max(...cs.map((c) => c[1])) + d.cell_deg]], { padding: [20, 20] });
  });
}

/* ---------- Dashboard: specific dates ----------
   /api/hotspots/range gives totals, day-by-day counts, regions and the strongest
   15,000 detections for the map; /api/hotspots/range.csv downloads all of them. */
let rgMap = null, rgLayer = null, rgChart = null, rgData = null, rgReq = 0, rgDates = null;
const pad2 = (n) => String(n).padStart(2, "0");
const isoDate = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayLabel = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const fmtDay = (iso) => dayLabel.format(new Date(iso + "T00:00:00Z"));
const scopeSlug = () => state.scope.replace(/[^A-Za-z0-9]+/g, "_");

function rgClamp(iso) {
  if (!rgDates) return iso;
  return iso < rgDates.first ? rgDates.first : iso > rgDates.last ? rgDates.last : iso;
}
function rgSet(start, end) {
  start = rgClamp(start); end = rgClamp(end);
  if (start > end) [start, end] = [end, start];
  $("#rg-start").value = start;
  $("#rg-end").value = end;
}
function rgMonth(y, m) { rgSet(isoDate(y, m, 1), isoDate(y, m, lastDayOf(y, m))); }
const rgQuery = () => new URLSearchParams({ scope: state.scope, start: $("#rg-start").value, end: $("#rg-end").value, sensor: $("#rg-sensor").value });

async function initRange() {
  if (rgDates) return;
  try { rgDates = await getJSON("/hotspots/dates"); }
  catch { rgDates = { first: "2003-01-01", last: "2025-12-31", viirs_from: "2012-02-01" }; }
  for (const id of ["#rg-start", "#rg-end"]) { $(id).min = rgDates.first; $(id).max = rgDates.last; }
  if (!$("#rg-start").value) rgMonth(state.year, state.month);
  $("#rg-avail").textContent = `Fire detections are available from ${fmtDay(rgDates.first)} to ${fmtDay(rgDates.last)}. ` +
    `VIIRS (finer, 375 m) is used from ${fmtDay(rgDates.viirs_from)}; MODIS before that.`;
  $("#rg-form").addEventListener("submit", (e) => { e.preventDefault(); rgSet($("#rg-start").value, $("#rg-end").value); loadRange(); });
  $("#rg-form").addEventListener("click", (e) => {
    const b = e.target.closest("[data-quick]");
    if (!b) return;
    const s = $("#rg-start").value || isoDate(state.year, state.month, 1);
    if (b.dataset.quick === "day") rgSet(s, s);
    else if (b.dataset.quick === "week") rgSet(s, addDays(s, 6));
    else if (b.dataset.quick === "month") rgMonth(+s.slice(0, 4), +s.slice(5, 7));   // the month of the From date
    else if (b.dataset.quick === "last30") rgSet(addDays(rgDates.last, -29), rgDates.last);
    loadRange();
  });
}

function renderRange() {
  initRange().then(() => {
    if (rgMap) rgMap.invalidateSize({ pan: false });
    loadRange();
  });
}

async function loadRange() {
  const start = $("#rg-start").value, end = $("#rg-end").value;
  if (!start || !end) return;
  const req = ++rgReq, q = rgQuery();
  const st = $("#rg-status");
  st.classList.remove("err");
  st.textContent = "Loading fire detections…";
  let d;
  try { d = await getJSON("/hotspots/range?" + q); }
  catch (e) {
    if (req !== rgReq) return;
    st.textContent = "Could not load fire detections: " + e.message; st.classList.add("err"); return;
  }
  if (req !== rgReq) return;
  rgData = { ...d, start, end };
  const span = start === end ? fmtDay(start) : `${fmtDay(start)} – ${fmtDay(end)}`;
  st.textContent = d.hotspots ? "" : `No fire detections in ${state.scope === "All" ? "the monitored regions" : state.scope} for ${span} (${d.sensor}).`;
  $("#rg-results").hidden = !d.hotspots;
  if (!d.hotspots) return;

  // tiles
  const top = d.regions[0];
  const tiles = [
    { k: `Fire detections · ${span}`, v: nf.format(d.hotspots), d: d.days_in_range === 1 ? `${d.sensor} · one day` : `${d.sensor} · ${d.fire_days} of ${d.days_in_range} days had fire` },
    { k: "Fire cell-days", v: nf.format(d.cell_days), d: "5 km patches burning on a day, the site's standard unit" },
    { k: "Busiest day", v: fmtDay(d.busiest_day.date), d: `${nf.format(d.busiest_day.hotspots)} detections that day` },
    { k: "Most fires in", v: top.region, d: `${top.share}% of detections · peak ${fmtDay(top.peak_date)}` },
  ];
  $("#rg-tiles").innerHTML = tiles.map((t) =>
    `<div class="tile"><div class="k">${esc(t.k)}</div><div class="v">${esc(t.v)}</div><div class="d">${esc(t.d)}</div></div>`).join("");

  // regions
  $("#rg-regions").innerHTML = d.regions.map((r) => `<li>
      <span class="rg-r-name"><b>${esc(r.region)}</b><small>${nf.format(r.hotspots)} detections · ${r.fire_days} fire days · peak ${esc(fmtDay(r.peak_date))}</small></span>
      <span class="rg-r-share">${r.share}%</span>
      <span class="rg-r-bar" aria-hidden="true"><i style="width:${Math.max(1, r.share)}%"></i></span></li>`).join("");

  // day-by-day chart, with empty days filled in so gaps show
  const t = tokens();
  const byDay = new Map(d.daily.map((x) => [x.date, x.hotspots]));
  let labels = d.daily.map((x) => x.date);
  if (d.days_in_range <= 800) { labels = []; for (let x = start; x <= end; x = addDays(x, 1)) labels.push(x); }
  const values = labels.map((x) => byDay.get(x) || 0);
  rgChart?.destroy();
  rgChart = new Chart($("#rg-chart"), {
    type: "bar",
    data: { labels, datasets: [{ label: "Fire detections", data: values,
      backgroundColor: labels.map((x) => (x === d.busiest_day.date ? t.fire[3] : t.fire[1])),
      borderRadius: { topLeft: 3, topRight: 3 }, borderSkipped: "start", categoryPercentage: 0.9, barPercentage: 0.95, maxBarThickness: 48 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      plugins: { legend: { display: false }, tooltip: { ...chartTooltip(t),
        callbacks: { title: (it) => fmtDay(labels[it[0].dataIndex]), label: (it) => `${nf.format(it.raw)} fire detections` } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: t.muted, maxTicksLimit: 8, maxRotation: 0,
          callback: (v, i) => (labels.length > 366 ? labels[i].slice(0, 7) : fmtDay(labels[i]).replace(/ \d{4}$/, "")) } },
        y: { beginAtZero: true, grid: { color: t.grid }, ticks: { color: t.muted, callback: (v) => compact(v) },
          title: { display: true, text: "Detections per day", color: t.muted } },
      },
    },
  });

  // map of the detections, coloured by fire intensity (FRP)
  if (!rgMap) {
    rgMap = L.map("rg-map", { preferCanvas: true, minZoom: 3, maxZoom: 12, zoomSnap: 0.25 });
    addLightBasemap(rgMap);
  }
  rgMap.invalidateSize({ pan: false });
  rgLayer?.remove();
  const col = ramp(t.fire), renderer = L.canvas({ padding: 0.3 });
  rgLayer = L.layerGroup(d.points.map(([lat, lon, frp, day, region]) => L.circleMarker([lat, lon], {
    renderer, radius: frp >= 100 ? 4.5 : frp >= 20 ? 3.5 : 2.6, weight: 0,
    fillColor: col(Math.log10(frp + 1) / Math.log10(500)), fillOpacity: 0.85,
  }).bindTooltip(`<b>${esc(fmtDay(day))}</b><br>${esc(region)} · ${lat.toFixed(3)}, ${lon.toFixed(3)}<br>Fire radiative power ${frp} MW`)))
    .addTo(rgMap);
  const lats = d.points.map((p) => p[0]), lons = d.points.map((p) => p[1]);
  rgMap.fitBounds([[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]], { padding: [20, 20], maxZoom: 9 });
  $("#rg-map-note").textContent = d.points_truncated
    ? `· showing the ${nf.format(d.points.length)} strongest of ${nf.format(d.hotspots)} detections (the CSV has all of them)`
    : `· all ${nf.format(d.hotspots)} detections`;
  $("#rg-legend").innerHTML = `<span>Weaker fire</span><span class="bar" style="background:${gradient(t.fire)}"></span><span>Stronger fire (fire radiative power, MW)</span>`;

  // strongest 100 as a table
  $("#rg-table").innerHTML = `<thead><tr><th>Date</th><th>Region</th><th class="num">Latitude</th><th class="num">Longitude</th><th class="num">FRP (MW)</th></tr></thead><tbody>` +
    d.points.slice(0, 100).map(([lat, lon, frp, day, region]) =>
      `<tr><td>${esc(day)}</td><td>${esc(region)}</td><td class="num">${lat.toFixed(4)}</td><td class="num">${lon.toFixed(4)}</td><td class="num">${frp}</td></tr>`).join("") + "</tbody>";

  // full CSV straight from the server
  const a = $("#rg-dl-points");
  a.href = API + "/hotspots/range.csv?" + q;
  a.download = `fire_points_${scopeSlug()}_${start}_to_${end}.csv`;
  $("#rg-dl-count").textContent = ` · ${nf.format(d.hotspots)} rows`;
}

/* ---------- downloads: CSV tables and chart images ---------- */
const csvCell = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCSV = (rows) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
function saveFile(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob(["﻿" + data], { type });   // BOM so Excel reads UTF-8
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function saveChart(canvas, name, title) {
  if (!canvas) return;
  const pad = 24, head = title ? 34 : 0, out = document.createElement("canvas");
  out.width = canvas.width + pad * 2; out.height = canvas.height + pad * 2 + head;
  const g = out.getContext("2d"), t = tokens();
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, out.width, out.height);
  if (title) { g.fillStyle = t.ink; g.font = `600 ${Math.round(16 * (window.devicePixelRatio || 1))}px "Instrument Sans", sans-serif`; g.fillText(title, pad, pad + 16); }
  g.drawImage(canvas, pad, pad + head);
  out.toBlob((b) => saveFile(name, b), "image/png");
}
const areaName = () => (state.scope === "All" ? "All regions" : state.scope);

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-dl]");
  if (!b) return;
  const kind = b.dataset.dl, slug = scopeSlug();
  if (kind === "series-csv") {
    saveFile(`monthly_fire_activity_${slug}.csv`, toCSV([
      ["area", "year", "month", "fire_cell_days_viirs_scale", "modis_cell_days", "viirs_cell_days", "source", "median_same_month", "times_typical"],
      ...state.series.map((d) => [areaName(), d.year, d.month, d.harmonized, d.modis, d.viirs, d.source, d.median, d.anomaly])]), "text/csv");
  } else if (kind === "hist-csv") {
    const m = +$("#h-month").value;
    saveFile(`${MONTHS_LONG[m - 1]}_every_year_${slug}.csv`, toCSV([
      ["area", "month", "year", "fire_cell_days", "median_2003_2025", "times_typical", "source"],
      ...state.series.filter((d) => d.month === m).map((d) => [areaName(), MONTHS_LONG[m - 1], d.year, d.harmonized, d.median, d.anomaly, d.source])]), "text/csv");
  } else if (kind === "ts-png") {
    saveChart($("#ts"), `monthly_fire_activity_${slug}.png`, `Monthly fire activity · ${areaName()}`);
  } else if (kind === "hist-png") {
    const m = +$("#h-month").value;
    saveChart($("#hist"), `${MONTHS_LONG[m - 1]}_every_year_${slug}.png`, `${MONTHS_LONG[m - 1]} in every year · ${areaName()}`);
  } else if (kind === "rg-png" && rgData) {
    saveChart($("#rg-chart"), `fire_detections_per_day_${slug}_${rgData.start}_to_${rgData.end}.png`,
      `Fire detections per day · ${areaName()} · ${fmtDay(rgData.start)} – ${fmtDay(rgData.end)}`);
  } else if (kind === "rg-csv" && rgData) {
    const d = rgData;
    saveFile(`fire_analysis_${slug}_${d.start}_to_${d.end}.csv`, toCSV([
      ["Fire analysis", areaName(), `${d.start} to ${d.end}`, `sensor ${d.sensor}`],
      [],
      ["Summary", "value"],
      ["Fire detections", d.hotspots], ["Fire cell-days", d.cell_days], ["Days in range", d.days_in_range],
      ["Days with fire", d.fire_days], ["Total fire radiative power (MW)", d.frp_total],
      ["Busiest day", d.busiest_day.date], ["Detections on busiest day", d.busiest_day.hotspots],
      [],
      ["By region", "detections", "share_percent", "fire_days", "peak_date", "total_frp_mw"],
      ...d.regions.map((r) => [r.region, r.hotspots, r.share, r.fire_days, r.peak_date, r.frp]),
      [],
      ["Day by day", "detections", "total_frp_mw"],
      ...d.daily.map((x) => [x.date, x.hotspots, x.frp]),
    ]), "text/csv");
  }
});

/* ---------- fire watch overview ---------- */
const ensoFor = (year) =>
  (state.oni?.available && state.oni.latest_year >= year ? "observed" : "0");

function firstForecastPeriod(lastObserved) {
  const { year, month } = cursorDate(ym(lastObserved) + 1);
  return { year, month, enso: ensoFor(year) };
}

function loadOverview() {
  const observed = state.series.at(-1);
  if (!observed) return;
  const outlook = firstForecastPeriod(observed);
  import("./overview.js?v=countup-fix").then(({ renderOverview }) => {
    if (route.page === "home") {
      renderOverview({ observed, outlook, getJSON, scope: state.scope, regions: state.regions, openExplorer(year, month) {
        setCursor(ym({ year, month }));
        location.hash = "/explorer";
      } });
    }
  }).catch(() => {
    $("#overview-observed-status").textContent = "The fire watch summary could not load.";
    $("#overview-watch-status").textContent = "The forecast summary could not load.";
  });
}

function loadExplorerWatchlist() {
  const latest = state.series.at(-1);
  if (!latest) return;
  // The timeline decides the era: past the last observed month it is a forecast
  // month, otherwise the watchlist keeps showing the nearest forecast period.
  const forecast = isForecast(state.cursor ?? ym(state));
  const picked = cursorDate(state.cursor ?? ym(state));
  const outlook = forecast
    ? { year: picked.year, month: picked.month, enso: ensoFor(picked.year) }
    : firstForecastPeriod(latest);
  import("./overview.js?v=countup-fix").then(({ renderExplorerWatchlist }) => {
    if (route.page !== "explorer") return;
    renderExplorerWatchlist({
      outlook, layer: forecast ? "forecast" : "observed",
      getJSON, regions: state.regions, escape: esc,
      updateTerrain(focus, forecast) {
        terrainModule.then((module) => module?.updateExplorerView?.(focus, forecast));
      },
    });
  }).catch(() => { $("#explorer-watch-status").textContent = "The place watchlist could not load."; });
}

/* ---------- navigation ---------- */
const pages = {
  home: "Overview",
  explorer: "World",
  dashboard: "Fire Dashboard",
  forecast: "Fire Outlook",
  haze: "Prepare for Haze",
  data: "Data & Methods",
  docs: "Docs",
};
const sections = {
  dashboard: ["calendar", "hotspots", "history"],
  data: ["sources", "methods", "calibration", "world"],
  docs: ["key", "catalogue", "climate", "world", "skill", "limits", "files", "reproduce"],
};
let route = { page: "home" };
let ready = false;
let terrainModule;

function activeSection(page, section) {
  return route.page === page && route.section === section;
}

const dashboardNav = $(".dashboard-nav");
const dashboardLinks = new Map(dashboardNav ? [...dashboardNav.querySelectorAll("a")].map((link) => [
  new URLSearchParams(link.hash.split("?")[1]).get("panel"), link,
]) : []);
const dashboardPanels = [...document.querySelectorAll("[data-dashboard-panel]")];

function dashboardPanel(name) {
  return dashboardPanels.find((panel) => panel.dataset.dashboardPanel === name);
}

function highlightDashboardSection(name) {
  const link = dashboardLinks.get(name);
  if (!link || !dashboardNav) return;
  const previous = dashboardNav.querySelector("[aria-current]");
  if (link === previous) return;
  previous?.removeAttribute("aria-current");
  link.setAttribute("aria-current", "location");

  if (dashboardNav.scrollWidth > dashboardNav.clientWidth) {
    const nav = dashboardNav.getBoundingClientRect();
    const item = link.getBoundingClientRect();
    const offset = item.left < nav.left ? item.left - nav.left : Math.max(0, item.right - nav.right);
    if (offset) dashboardNav.scrollBy({ left: offset, behavior: "instant" });
  }
}

let dashboardScrollFrame = 0;
function trackDashboardScroll() {
  if (route.page !== "dashboard" || dashboardScrollFrame || !dashboardPanels.length) return;
  dashboardScrollFrame = requestAnimationFrame(() => {
    dashboardScrollFrame = 0;
    if (route.page !== "dashboard") return;

    const readingLine = parseFloat(getComputedStyle(dashboardPanels[0]).scrollMarginTop) + 16;
    let activePanel = null;
    for (const panel of dashboardPanels) {
      if (panel.getBoundingClientRect().top > readingLine) break;
      activePanel = panel;
    }

    // The last section may be too short to reach the reading line.
    const page = document.scrollingElement;
    if (page.scrollTop > 0 && page.scrollTop + page.clientHeight >= page.scrollHeight - 2) {
      activePanel = dashboardPanels.at(-1);
    }
    highlightDashboardSection(activePanel?.dataset.dashboardPanel ?? null);
  });
}

function jumpToDashboardPanel(panel, animate = false) {
  if (!panel) return;
  const behavior = animate && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "instant";
  panel.scrollIntoView({ block: "start", behavior });
  const heading = panel.querySelector("h2");
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}

function updateRoute(moveFocus = false) {
  const [path, query] = location.hash.slice(1).split("?");
  const name = path.startsWith("/") ? path.slice(1) : "";
  const pageName = name === "explore" ? "dashboard" : name;
  const page = Object.hasOwn(pages, pageName) ? pageName : "home";
  const options = sections[page] || [];
  const params = new URLSearchParams(query);
  const requested = params.get("section");
  const section = options.includes(requested) ? requested : options[0];
  const changedPage = route.page !== page;
  const changedSection = route.section !== section;
  const legacyPanel = ["calendar", "hotspots", "history"].includes(requested) ? requested : null;
  const jumpTarget = page === "dashboard" ? dashboardPanel(params.get("panel") ?? legacyPanel) : null;
  const panel = jumpTarget?.dataset.dashboardPanel ?? null;
  const changedPanel = (route.panel ?? null) !== panel;
  route = { page, section, panel };
  if (page !== "explorer") $("#place-search-dialog").close();
  document.title = pages[page] + " · BurningView";
  document.body.classList.toggle("map-page", page === "explorer");
  document.body.classList.toggle("dashboard-page", page === "dashboard");

  document.querySelectorAll("[data-page]").forEach((view) => { view.hidden = view.dataset.page !== page; });
  const view = document.querySelector('[data-page="' + page + '"]');
  view.querySelectorAll("[data-section]").forEach((sectionView) => { sectionView.hidden = sectionView.dataset.section !== section; });
  document.querySelectorAll("[data-nav]").forEach((link) => {
    if (link.dataset.nav === page) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  view.querySelectorAll(".section-nav a").forEach((link) => {
    const linkParams = new URLSearchParams(link.hash.split("?")[1]);
    if (linkParams.get("section") === section) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });

  const filters = $("#filters");
  const slot = view.querySelector("[data-filters]");
  filters.hidden = !slot;
  if (slot && filters.parentElement !== slot) slot.append(filters);
  const observed = page === "dashboard" && section === "calendar";   // the hotspot map has its own date picker
  const forecast = page === "forecast" || page === "haze";
  filters.querySelector("[data-timeline-filter]").hidden = page !== "explorer";
  filters.querySelector("[data-scope-filter]").hidden = page === "explorer";   // Explorer has its own place search
  filters.querySelectorAll("[data-observed-filter]").forEach((label) => { label.hidden = !observed; });
  filters.querySelectorAll("[data-forecast-filter]").forEach((label) => { label.hidden = !forecast; });
  $("#status").hidden = (page === "data" && section !== "calibration") || page === "docs";
  hideTip();

  const changedView = changedPage || changedSection;
  if (jumpTarget) {
    if (changedPage || changedPanel) jumpToDashboardPanel(jumpTarget, moveFocus && !changedPage);
  } else if (moveFocus && (changedPage || (page === "dashboard" && (changedSection || changedPanel))
    || (changedSection && !document.activeElement.closest(".section-nav")))) {
    window.scrollTo(0, 0);
    if (changedPage || !document.activeElement.closest(".section-nav")) {
      view.querySelector("h1").focus({ preventScroll: true });
    }
  }
  syncScopeForRoute();
  if (ready && changedView) renderView(jumpTarget);
}

function renderDocToc() {
  const box = document.getElementById("doc-toc-links");
  if (!box) return;
  const panel = document.querySelector('[data-page="docs"] [data-section]:not([hidden])');
  const heads = panel ? [...panel.querySelectorAll("h3[id]")] : [];
  box.replaceChildren(...heads.map((h) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = h.textContent.trim();
    b.addEventListener("click", () => h.scrollIntoView({ behavior: "smooth", block: "start" }));
    return b;
  }));
}

function renderView(jumpTarget = dashboardPanel(route.panel)) {
  switch (route.page) {
    case "home":
      loadOverview();
      break;
    case "explorer":
      terrainModule ??= import("./hero3d.js?v=world-cell-forecast").catch(() => { $("#hero-status").textContent = "3D view could not load"; });
      loadExplorerWatchlist();
      break;
    case "dashboard":
      if (route.section === "calendar") {
        renderTiles();
        renderCal();
        renderTS();
      } else if (route.section === "history") {
        renderHist();
      } else {
        renderRange();   // hotspot map for a chosen day or date range
      }
      break;
    case "forecast":
      if (!fcMap) initFcMap();
      fcMap.invalidateSize({ pan: false });
      loadForecast();
      break;
    case "haze":
      renderHaze();
      loadForecast();
      break;
    case "data":
      if (route.section === "calibration") renderCalib();
      if (route.section === "world") {
        import("./world-map.js?v=watchlist-add").then((m) => m.renderWorldMap()).catch(() => {});
      }
      break;
    case "docs":
      renderDocToc();
      break;
  }
}

async function boot() {
  setStatus("Loading…");
  try {
    const [regions, calib, h, oni, areas] = await Promise.all([
      getJSON("/regions"), getJSON("/calibration"), getJSON(`/harmonized?scope=${encodeURIComponent(state.scope)}`),
      getJSON("/enso").catch(() => ({ available: false })),
      getJSON("/harmonized/areas").catch(() => ({ countries: [] })),
    ]);
    state.regions = regions;
    state.worldCountries = areas.countries || [];
    state.calib = calib;
    state.series = allRegionsSeries = h.series;
    state.oni = oni;
  } catch (e) {
    setStatus(`Could not reach the API: ${e.message}`, true);
    return;
  }
  setStatus("");
  buildFilters();
  buildForecastControls();
  syncFilters();
  $("#filters").querySelectorAll("select").forEach((select) => { select.disabled = false; });
  whereEvents();

  const cal = $("#cal");
  cal.addEventListener("mousemove", calTip);
  cal.addEventListener("mouseleave", hideTip);
  cal.addEventListener("click", (e) => {
    const b = e.target.closest(".cell");
    if (b) {
      const index = b.dataset.i;
      const d = state.series[+index];
      setYM(d.year, d.month);
      cal.querySelector(`[data-i="${index}"]`).focus({ preventScroll: true });
    }
  });
  cal.addEventListener("focusin", (e) => {
    const b = e.target.closest(".cell");
    if (b) { const r = b.getBoundingClientRect(); calTip({ target: b, clientX: r.right, clientY: r.bottom }); }
  });
  cal.addEventListener("focusout", hideTip);

  ready = true;
  syncScopeForRoute();
  renderView(dashboardPanel(route.panel));
}

$(".skip").addEventListener("click", (event) => {
  event.preventDefault();
  $("#main").focus();
});
window.addEventListener("scroll", trackDashboardScroll, { passive: true });
window.addEventListener("resize", trackDashboardScroll);
const dashboardContent = $(".dashboard-content");
if (dashboardContent) new ResizeObserver(trackDashboardScroll).observe(dashboardContent);

dashboardNav?.addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (!link || link.hash !== location.hash || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const panel = dashboardPanel(route.panel);
  if (panel) jumpToDashboardPanel(panel, true);
  else window.scrollTo(0, 0);
});
window.addEventListener("hashchange", () => updateRoute(true));
updateRoute();
boot();


/* ---- floating watchlist layer -------------------------------------------
   Detaches the watchlist from the page grid into its own layer: drag the
   panel header to move, drag the corner grip to resize. State is kept in
   localStorage. Docks itself again below 900px wide. */
(function initFloatingWatchlist() {
  const sidebar = document.querySelector(".watch-sidebar");
  const workspace = sidebar && sidebar.closest(".explorer-workspace");
  const toggle = document.getElementById("watch-float-toggle");
  if (!sidebar || !workspace || !toggle) return;

  const KEY = "fireExplorer.watchFloat.v1";
  const MARGIN = 8, MIN_W = 260, MIN_H = 220, NARROW = 900;
  const state = { on: false, x: null, y: null, w: 340, h: 620 };

  const grip = document.createElement("div");
  grip.className = "watch-resize-grip";
  grip.hidden = true;
  grip.setAttribute("aria-hidden", "true");
  document.body.appendChild(grip);

  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved && typeof saved === "object") Object.assign(state, saved);
  } catch (err) { /* first run or storage blocked */ }

  const canFloat = () => window.innerWidth > NARROW;

  function clamp() {
    const maxW = Math.max(MIN_W, window.innerWidth - MARGIN * 2);
    const maxH = Math.max(MIN_H, window.innerHeight - MARGIN * 2);
    state.w = Math.min(Math.max(state.w || 340, MIN_W), maxW);
    state.h = Math.min(Math.max(state.h || 620, MIN_H), maxH);
    if (state.x == null) state.x = window.innerWidth - state.w - 24;
    if (state.y == null) state.y = 80;
    state.x = Math.min(Math.max(state.x, MARGIN), Math.max(MARGIN, window.innerWidth - state.w - MARGIN));
    state.y = Math.min(Math.max(state.y, MARGIN), Math.max(MARGIN, window.innerHeight - state.h - MARGIN));
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (err) { /* ignore */ }
  }

  function syncGrip() {
    /* a position:fixed element has no offsetParent, so test size, not offsetParent */
    if (!state.on || workspace.hidden) { grip.hidden = true; return; }
    const r = sidebar.getBoundingClientRect();
    if (!r.width || !r.height) { grip.hidden = true; return; }
    grip.hidden = false;
    grip.style.left = (r.right - 20) + "px";
    grip.style.top = (r.bottom - 20) + "px";
  }

  function paint() {
    if (state.on && canFloat()) {
      clamp();
      sidebar.dataset.floating = "true";
      sidebar.style.left = state.x + "px";
      sidebar.style.top = state.y + "px";
      sidebar.style.width = state.w + "px";
      sidebar.style.height = state.h + "px";
      workspace.dataset.sidebar = "float";
    } else {
      state.on = false;
      delete sidebar.dataset.floating;
      sidebar.style.left = sidebar.style.top = sidebar.style.width = sidebar.style.height = "";
      delete workspace.dataset.sidebar;
    }
    toggle.setAttribute("aria-pressed", String(state.on));
    toggle.title = state.on
      ? "Dock the panel back into the page"
      : "Float panel - drag to move, corner to resize";
    syncGrip();
  }

  toggle.addEventListener("click", () => {
    if (!canFloat()) return;
    state.on = !state.on;
    paint();
    save();
  });

  const head = sidebar.querySelector("section > .watch-panel-head");
  let drag = null;
  head.addEventListener("pointerdown", (e) => {
    if (!state.on || e.button !== 0) return;
    if (e.target.closest("button, a, input, select, textarea")) return;
    const r = sidebar.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    sidebar.classList.add("is-dragging");
    try { head.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
    e.preventDefault();
  });
  head.addEventListener("pointermove", (e) => {
    if (!drag) return;
    state.x = e.clientX - drag.dx;
    state.y = e.clientY - drag.dy;
    clamp();
    sidebar.style.left = state.x + "px";
    sidebar.style.top = state.y + "px";
    syncGrip();
  });
  function endDrag(e) {
    if (!drag) return;
    drag = null;
    sidebar.classList.remove("is-dragging");
    try { head.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    save();
  }
  head.addEventListener("pointerup", endDrag);
  head.addEventListener("pointercancel", endDrag);

  let rz = null;
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const r = sidebar.getBoundingClientRect();
    rz = { sx: e.clientX, sy: e.clientY, w: r.width, h: r.height };
    sidebar.classList.add("is-resizing");
    try { grip.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
    e.preventDefault();
  });
  grip.addEventListener("pointermove", (e) => {
    if (!rz) return;
    state.w = Math.max(MIN_W, rz.w + (e.clientX - rz.sx));
    state.h = Math.max(MIN_H, rz.h + (e.clientY - rz.sy));
    clamp();
    sidebar.style.width = state.w + "px";
    sidebar.style.height = state.h + "px";
    syncGrip();
  });
  function endResize(e) {
    if (!rz) return;
    rz = null;
    sidebar.classList.remove("is-resizing");
    try { grip.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    save();
  }
  grip.addEventListener("pointerup", endResize);
  grip.addEventListener("pointercancel", endResize);

  window.addEventListener("resize", () => { if (state.on) paint(); });
  new MutationObserver(syncGrip).observe(workspace, { attributes: true, attributeFilter: ["hidden"] });

  paint();
})();
