/* World Fire Atlas page (#/world).
   Uses helpers from app.js: $, getJSON, tokens, ramp, gradient, nf, compact, esc,
   MONTHS, MONTHS_LONG, chartTooltip, showTip, hideTip, median.
   Data: /api/global/{summary, series, ranking, map} (step2_harmonize_global.py outputs). */
(function () {
  const W = {
    summary: null, byName: new Map(), names: [],
    year: 2023, month: 0, country: "World",
    series: null, ranking: null, mapData: null, cellIndex: new Map(),
    map: null, layer: null, chart: null, showAll: false,
    reqPeriod: 0, reqCountry: 0, initPromise: null,
  };
  const VIIRS_FROM = 2018 * 12 + 4; // April 2018
  const periodLabel = () => (W.month ? `${MONTHS_LONG[W.month - 1]} ${W.year}` : String(W.year));
  const status = (msg, err) => { const el = $("#w-status"); el.textContent = msg || ""; el.classList.toggle("err", !!err); };
  const fmtRatio = (r) => (r == null ? "–" : `${r >= 10 ? Math.round(r) : r.toFixed(1)}×`);

  /* ---------- setup ---------- */
  function init() {
    if (!W.initPromise) {
      W.initPromise = (async () => {
        W.summary = await getJSON("/global/summary");
        W.names = W.summary.countries.map((c) => c.country);
        W.summary.countries.forEach((c) => W.byName.set(c.country, c));
        const [y0, y1] = W.summary.years;
        W.year = y1;
        // optional deep link: #/world?country=Indonesia&year=2019&month=9
        const q = new URLSearchParams(location.hash.split("?")[1] || "");
        if (W.byName.has(q.get("country"))) W.country = q.get("country");
        if (+q.get("year") >= y0 && +q.get("year") <= y1) W.year = +q.get("year");
        if (+q.get("month") >= 0 && +q.get("month") <= 12) W.month = +q.get("month") || 0;
        $("#w-year").innerHTML = Array.from({ length: y1 - y0 + 1 }, (_, i) => y1 - i).map((y) => `<option>${y}</option>`).join("");
        $("#w-month").innerHTML = `<option value="0">Whole year</option>` + MONTHS_LONG.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");
        const byFire = [...W.summary.countries].filter((c) => c.total > 0).sort((a, b) => b.total - a.total);
        $("#w-country").innerHTML = `<option value="World">World (all countries)</option>` +
          `<optgroup label="Most fire activity">${byFire.slice(0, 15).map((c) => `<option>${esc(c.country)}</option>`).join("")}</optgroup>` +
          `<optgroup label="All countries A–Z">${W.names.map((n) => `<option>${esc(n)}</option>`).join("")}</optgroup>`;
        W.combos = [
          searchableSelect($("#w-year"), "Type a year"),
          searchableSelect($("#w-month"), "Type a month"),
          searchableSelect($("#w-country"), "Type a country"),
        ];
        syncControls();
        $("#w-year").addEventListener("change", (e) => setPeriod(+e.target.value, W.month));
        $("#w-month").addEventListener("change", (e) => setPeriod(W.year, +e.target.value));
        $("#w-country").addEventListener("change", (e) => setCountry(e.target.value, true));
        $("#w-rank").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-c]"); if (tr) setCountry(tr.dataset.c, true); });
        $("#w-rank").addEventListener("keydown", (e) => {
          const tr = e.target.closest("tr[data-c]");
          if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setCountry(tr.dataset.c, true); }
        });
        $("#w-rank-more").addEventListener("click", () => { W.showAll = !W.showAll; renderRanking(); });
        calEvents();
        initMap();
        renderValidation();
      })();
    }
    return W.initPromise;
  }

  function syncControls() {
    $("#w-year").value = String(W.year);
    $("#w-month").value = String(W.month);
    $("#w-country").value = W.country;
    (W.combos || []).forEach((c) => c.refresh());
  }

  /* ---------- searchable dropdown ----------
     Puts a text box over a <select>: click it to see every option (with the
     select's groups), or type to filter. The hidden <select> stays the source of
     truth, so picking an option sets its value and fires its normal "change". */
  let comboSeq = 0;
  function searchableSelect(select, placeholder) {
    const id = "wsel-" + (++comboSeq);
    const wrap = document.createElement("span");
    wrap.className = "wsel";
    wrap.dataset.for = select.id;
    select.before(wrap);
    const input = document.createElement("input");
    Object.assign(input, { type: "text", autocomplete: "off", spellcheck: false, placeholder });
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", id);
    const arrow = document.createElement("span");
    arrow.className = "wsel-arrow"; arrow.setAttribute("aria-hidden", "true"); arrow.textContent = "▾";
    const list = document.createElement("ul");
    list.className = "wsel-list"; list.id = id; list.setAttribute("role", "listbox"); list.hidden = true;
    wrap.append(input, arrow, list, select);
    select.hidden = true; select.tabIndex = -1;

    let shown = [], active = -1, typed = false;
    const label = () => select.selectedOptions[0]?.textContent || "";
    const options = () => [...select.querySelectorAll("option")].map((o) => ({
      value: o.value, text: o.textContent, group: o.parentElement.tagName === "OPTGROUP" ? o.parentElement.label : "",
    }));

    function render() {
      const q = typed ? input.value.trim().toLowerCase() : "";
      let items = options();
      if (q) {
        const seen = new Set();
        items = items.filter((o) => o.text.toLowerCase().includes(q) && !seen.has(o.value) && seen.add(o.value))
          .sort((a, b) => (b.text.toLowerCase().startsWith(q) - a.text.toLowerCase().startsWith(q)));
      }
      shown = items;
      if (active < 0 || active >= shown.length) {
        active = q ? (shown.length ? 0 : -1) : shown.findIndex((o) => o.value === select.value);
      }
      const mark = (t) => {
        const i = q ? t.toLowerCase().indexOf(q) : -1;
        return i < 0 ? esc(t) : esc(t.slice(0, i)) + "<mark>" + esc(t.slice(i, i + q.length)) + "</mark>" + esc(t.slice(i + q.length));
      };
      let group = null, html = "";
      shown.forEach((o, i) => {
        if (!q && o.group && o.group !== group) html += `<li class="wsel-group" role="presentation">${esc(o.group)}</li>`;
        if (!q) group = o.group;
        html += `<li role="option" id="${id}-${i}" data-i="${i}" class="${!q && o.group ? "in-group" : ""}"
          aria-selected="${i === active}"${o.value === select.value ? ' data-current=""' : ""}>${mark(o.text)}</li>`;
      });
      list.innerHTML = html || `<li class="wsel-empty" role="presentation">No matches</li>`;
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

    input.addEventListener("focus", () => { typed = false; active = -1; render(); input.select(); });
    input.addEventListener("click", () => { if (list.hidden) { typed = false; active = -1; render(); } });
    input.addEventListener("input", () => { typed = true; active = -1; render(); });
    input.addEventListener("blur", close);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (list.hidden) { render(); return; }
        if (!shown.length) return;
        active = e.key === "ArrowDown" ? (active + 1) % shown.length : (active <= 0 ? shown.length - 1 : active - 1);
        render();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (!list.hidden) pick(shown[active] || (shown.length === 1 ? shown[0] : null));
      } else if (e.key === "Escape") {
        if (!list.hidden) { e.preventDefault(); close(); }
      }
    });
    // mousedown keeps focus in the box, so blur doesn't close the list before the pick
    list.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const li = e.target.closest("[data-i]");
      if (li) pick(shown[+li.dataset.i]);
    });
    arrow.addEventListener("mousedown", (e) => { e.preventDefault(); 
      if (!list.hidden) close();
      else if (document.activeElement === input) { typed = false; active = -1; render(); }
      else input.focus();
    });

    return { refresh: () => { if (list.hidden) input.value = label(); } };
  }

  function setPeriod(year, month) {
    W.year = year; W.month = month;
    syncControls();
    loadPeriod();
    if (W.series) { renderSeries(); renderCal(); }
  }

  function setCountry(name, zoom) {
    W.country = name;
    syncControls();
    loadCountry();
    renderRanking();
    drawMap();
    renderValidation();
    if (zoom) zoomTo(name);
  }

  /* ---------- data loading ---------- */
  async function loadPeriod() {
    const id = ++W.reqPeriod;
    status("Loading…");
    $("#w-map-title").textContent = `Fire activity map · ${periodLabel()}`;
    $("#w-rank-title").textContent = `Countries ranked · ${periodLabel()}`;
    try {
      const q = `year=${W.year}&month=${W.month}`;
      const [ranking, mapData] = await Promise.all([getJSON(`/global/ranking?${q}`), getJSON(`/global/map?${q}`)]);
      if (id !== W.reqPeriod) return;
      W.ranking = ranking; W.mapData = mapData;
      W.cellIndex = new Map(mapData.cells.map((c) => [`${c[0]},${c[1]}`, c]));
      status("");
    } catch (e) {
      if (id === W.reqPeriod) status(`Could not load world data: ${e.message}`, true);
      return;
    }
    renderTiles();
    renderRanking();
    drawMap();
  }

  async function loadCountry() {
    const id = ++W.reqCountry;
    try {
      const d = await getJSON(`/global/series?country=${encodeURIComponent(W.country)}`);
      if (id !== W.reqCountry) return;
      W.series = d.series;
    } catch (e) {
      if (id === W.reqCountry) status(`Could not load ${W.country}: ${e.message}`, true);
      return;
    }
    renderTiles();
    renderSeries();
    renderCal();
  }

  /* ---------- tiles ---------- */
  function renderTiles() {
    const r = W.ranking, s = W.series;
    if (!r || !s) return;
    const world = W.country === "World";
    const row = world ? null : r.countries.find((c) => c.country === W.country);
    const value = world ? r.world : (row ? row.value : 0);
    const typical = world ? r.world_typical : (row ? row.typical : (W.byName.get(W.country) || {}).typical_year);
    const ratio = typical > 0 ? value / typical : null;
    const rank = row ? r.countries.indexOf(row) + 1 : null;
    const top = r.countries[0];

    const byMonth = Array.from({ length: 12 }, (_, i) => median(s.filter((d) => d.month === i + 1).map((d) => d.value)));
    const peak = byMonth.indexOf(Math.max(...byMonth));
    const info = W.byName.get(W.country);
    const v = W.summary.validation;

    const tiles = [
      { k: `Fire cell-days · ${periodLabel()}`, v: nf.format(value),
        d: ratio != null ? `${fmtRatio(ratio)} the typical ${W.month ? MONTHS_LONG[W.month - 1] : "year"} · ${r.source}` : r.source },
      world
        ? { k: "Most fire activity", v: top ? top.country : "–", d: top ? `${top.share_pct}% of the world total` : "" }
        : { k: "Share of world fire", v: row ? `${row.share_pct}%` : "0%", d: rank ? `Rank ${rank} of ${r.countries.length} countries` : "No fire detected in this period" },
      { k: "Typical peak month", v: isFinite(byMonth[peak]) && byMonth[peak] > 0 ? MONTHS_LONG[peak] : "–", d: "Median 2003–2025" },
      world
        ? { k: "Calibration (global)", v: `k = ${v.k_global.toFixed(2)}`, d: `Median leave-one-year-out R² ${v.median_r2_loyo.toFixed(2)}` }
        : { k: "Calibration", v: info && info.k != null ? `k = ${info.k.toFixed(2)}` : "–",
            d: info && info.k_source === "country" ? `Own fit · R² ${info.r2_loyo != null ? info.r2_loyo.toFixed(2) : "–"} (leave-one-year-out)` : "Too few fires: uses the global k" },
    ];
    $("#w-tiles").innerHTML = tiles.map((t) =>
      `<div class="tile"><div class="k">${esc(t.k)}</div><div class="v">${esc(t.v)}</div><div class="d">${esc(t.d)}</div></div>`).join("");
  }

  /* ---------- ranking table ---------- */
  function ratioCell(ratio) {
    if (ratio == null) return `<td class="num">–</td>`;
    const div = ramp(tokens().div);
    const l2 = Math.max(-2, Math.min(2, Math.log2(Math.max(ratio, 1e-3))));
    return `<td class="num"><span class="ratio-sw" style="background:${div((l2 + 2) / 4)}"></span>${fmtRatio(ratio)}</td>`;
  }

  function renderRanking() {
    const r = W.ranking;
    if (!r) return;
    const limit = W.showAll ? r.countries.length : 25;
    let rows = r.countries.slice(0, limit);
    const selIdx = r.countries.findIndex((c) => c.country === W.country);
    if (selIdx >= limit) rows = rows.concat([r.countries[selIdx]]);
    $("#w-rank").innerHTML =
      `<thead><tr><th class="num">#</th><th class="name">Country</th><th class="num">Fire cell-days</th><th class="num">vs typical</th><th class="num">Share</th></tr></thead><tbody>` +
      rows.map((c) => {
        const i = r.countries.indexOf(c) + 1;
        return `<tr data-c="${esc(c.country)}" tabindex="0"${c.country === W.country ? ' class="sel" aria-selected="true"' : ""}>` +
          `<td class="num">${i}</td><td class="name">${esc(c.country)}</td><td class="num">${nf.format(c.value)}</td>${ratioCell(c.ratio)}<td class="num">${c.share_pct}%</td></tr>`;
      }).join("") + `</tbody>`;
    const more = $("#w-rank-more");
    more.hidden = r.countries.length <= 25;
    more.textContent = W.showAll ? "Show top 25 only" : `Show all ${r.countries.length} countries`;
  }

  /* ---------- map ---------- */
  function initMap() {
    // whole zoom levels (no tile seams) and no wrapped copies beyond +-180 degrees
    W.map = L.map("w-map", { preferCanvas: true, worldCopyJump: false, minZoom: 2, maxZoom: 8, zoomSnap: 1,
                             maxBounds: [[-85, -200], [85, 200]], maxBoundsViscosity: 1 });
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Basemap &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors", maxZoom: 16, noWrap: true,
      bounds: [[-85.05, -180], [85.05, 180]],   // never request placeholder tiles beyond the date line
    }).addTo(W.map);
    worldView();
    W.map.on("mousemove", (e) => {
      const c = cellAt(e.latlng);
      if (!c) return hideTip();
      const name = W.names[c[3]] || "Unknown";
      showTip(`<b>${esc(name)}</b><br>${nf.format(c[2])} fire cell-days in ${periodLabel()}<br>` +
              `<span class="m">1° cell ${c[1]}° to ${c[1] + 1}° lat, ${c[0]}° to ${c[0] + 1}° lon</span>`,
              e.originalEvent.clientX, e.originalEvent.clientY);
    });
    W.map.on("mouseout", hideTip);
    W.map.on("click", (e) => { const c = cellAt(e.latlng); if (c && W.names[c[3]]) setCountry(W.names[c[3]], false); });
  }

  const worldView = () => W.map.setView([22, 12], 2);

  const cellAt = (ll) => W.cellIndex.get(`${Math.floor(ll.lng)},${Math.floor(ll.lat)}`);

  function drawMap() {
    if (!W.map || !W.mapData) return;
    const t = tokens(), r = ramp(t.fire), d = W.mapData;
    const max = Math.max(1, d.max);
    const selIdx = W.names.indexOf(W.country);
    if (W.layer) W.layer.remove();
    const shapes = d.cells.map(([lon, lat, v, ci]) => L.rectangle([[lat, lon], [lat + 1, lon + 1]], {
      stroke: ci === selIdx, color: t.ink, weight: 1, opacity: 0.9,
      fillColor: r(Math.log1p(v) / Math.log1p(max)), fillOpacity: ci === selIdx || selIdx < 0 ? 0.88 : 0.55,
      interactive: false,
    }));
    W.layer = L.layerGroup(shapes).addTo(W.map);
    $("#w-map-legend").innerHTML = d.cells.length
      ? `<span>1</span><span class="bar" style="background:${gradient(t.fire)}"></span><span>${nf.format(max)} fire cell-days per 1° cell (log scale)</span>` +
        (selIdx >= 0 ? `<span>· outlined: ${esc(W.country)}</span>` : "")
      : "No fire detected in this period.";
  }

  function zoomTo(name) {
    if (!W.map) return;
    const c = W.byName.get(name);
    if (name === "World" || !c || !c.bbox) { worldView(); return; }
    const [x0, y0, x1, y1] = c.bbox;
    if (x1 - x0 > 300) W.map.setView([c.lat, c.lon], 3);   // spans the date line (e.g. Russia, Fiji)
    else W.map.fitBounds([[y0, x0], [y1, x1]], { padding: [20, 20], maxZoom: 6 });
  }

  /* ---------- country series + calendar ---------- */
  function renderSeries() {
    const s = W.series, t = tokens();
    if (!s) return;
    const info = W.byName.get(W.country);
    $("#w-country-title").textContent = W.country === "World" ? "World: monthly fire activity" : `${W.country}: monthly fire activity`;
    $("#w-country-note").textContent = W.country === "World"
      ? `All ${W.summary.world.countries_with_fire} countries together. Before April 2018 the values are MODIS × each country's k (shaded). Click a month to select it.`
      : `Typical year: ${nf.format(info ? info.typical_year : 0)} fire cell-days. Before April 2018 the values are MODIS × k (shaded). Click a month to select it.`;
    $("#w-series-legend").innerHTML =
      `<span><span class="sw" style="background:${t.s1}"></span>Fire cell-days (VIIRS NOAA-20 scale)</span>` +
      `<span><span class="dot" style="border-color:${t.muted}"></span>Typical month (median)</span>` +
      `<span><span class="band"></span>MODIS, scaled</span>`;
    const iV = s.findIndex((d) => d.year * 12 + d.month >= VIIRS_FROM);

    const band = {
      id: "wBand",
      beforeDatasetsDraw(chart) {
        const { ctx, chartArea: a, scales: { x } } = chart;
        const step = x.getPixelForValue(1) - x.getPixelForValue(0);
        ctx.save();
        if (iV > 0) {
          const xv = x.getPixelForValue(iV) - step / 2;
          ctx.fillStyle = t.band; ctx.fillRect(a.left, a.top, xv - a.left, a.bottom - a.top);
        }
        const i0 = s.findIndex((d) => d.year === W.year && (!W.month || d.month === W.month));
        if (i0 >= 0) {
          const n = W.month ? 1 : s.filter((d) => d.year === W.year).length;
          ctx.fillStyle = t.select;
          ctx.fillRect(x.getPixelForValue(i0) - step / 2, a.top, n * step, a.bottom - a.top);
        }
        ctx.restore();
      },
    };

    if (W.chart) W.chart.destroy();
    W.chart = new Chart($("#w-series"), {
      type: "line",
      data: {
        labels: s.map((d) => `${MONTHS[d.month - 1]} ${d.year}`),
        datasets: [
          { label: "Fire cell-days", data: s.map((d) => d.value), borderColor: t.s1, borderWidth: 1.75, pointRadius: 0,
            pointHoverRadius: 4, pointHoverBorderColor: t.surface, pointHoverBorderWidth: 2, tension: 0 },
          { label: "Typical", data: s.map((d) => d.median), borderColor: t.muted, borderWidth: 1.25, borderDash: [2, 3],
            pointRadius: 0, pointHoverRadius: 0 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { ...chartTooltip(t), displayColors: false, callbacks: {
            label: (it) => (it.datasetIndex === 0 ? `Fire cell-days: ${nf.format(it.parsed.y)}` : `Typical: ${nf.format(it.parsed.y)}`),
            footer: (items) => { const d = s[items[0].dataIndex]; return [d.anomaly != null ? `${fmtRatio(d.anomaly)} typical` : "", d.source]; },
          } },
        },
        scales: {
          x: { grid: { display: false }, border: { color: t.axis },
               ticks: { color: t.muted, maxRotation: 0, autoSkip: false,
                        callback: (v, i) => (s[i] && s[i].month === 1 && s[i].year % 2 === 1 ? s[i].year : "") } },
          y: { beginAtZero: true, grid: { color: t.grid }, border: { display: false },
               ticks: { color: t.muted, maxTicksLimit: 6, callback: (v) => compact(v) } },
        },
        onClick: (_e, els) => { if (els.length) { const d = s[els[0].index]; setPeriod(d.year, d.month); } },
        onHover: (e, els) => { e.native.target.style.cursor = els.length ? "pointer" : "default"; },
      },
      plugins: [band],
    });
  }

  function renderCal() {
    const s = W.series, t = tokens();
    if (!s) return;
    const seq = ramp(t.fire);
    const pos = s.map((d) => d.value).filter((v) => v > 0).sort((a, b) => a - b);
    const lo = Math.max(1, pos.length ? pos[Math.floor(pos.length * 0.1)] : 1);
    const max = Math.max(lo + 1, ...pos);
    const col = (v) => (v <= 0 ? t.empty : seq((Math.log(Math.max(v, lo)) - Math.log(lo)) / (Math.log(max) - Math.log(lo))));
    const years = [...new Set(s.map((d) => d.year))];
    let html = `<div></div>` + MONTHS.map((m) => `<div class="mh">${m[0]}</div>`).join("");
    for (const y of years) {
      html += `<div class="yl${y === W.year ? " sel" : ""}">${y}</div>`;
      for (let m = 1; m <= 12; m++) {
        const i = s.findIndex((d) => d.year === y && d.month === m);
        if (i < 0) { html += "<div></div>"; continue; }
        const d = s[i];
        const sel = y === W.year && (W.month ? m === W.month : true) ? " sel" : "";
        const lab = `${MONTHS_LONG[m - 1]} ${y}: ${nf.format(d.value)} fire cell-days` + (d.anomaly != null ? `, ${fmtRatio(d.anomaly)} typical` : "");
        html += `<button type="button" class="cell${W.month ? sel : ""}" data-i="${i}" style="background:${col(d.value)}" aria-label="${esc(lab)}"></button>`;
      }
    }
    $("#w-cal").innerHTML = html;
    $("#w-cal-legend").innerHTML = `<span>≤${compact(lo)}</span><span class="bar" style="background:${gradient(t.fire)}"></span><span>${compact(max)} fire cell-days / month</span>`;
  }

  function calEvents() {
    const cal = $("#w-cal");
    cal.addEventListener("mousemove", (e) => {
      const b = e.target.closest(".cell");
      if (!b || !W.series) return hideTip();
      const d = W.series[+b.dataset.i];
      showTip(`<b>${MONTHS_LONG[d.month - 1]} ${d.year}</b><br>${nf.format(d.value)} fire cell-days` +
              (d.anomaly != null ? `<br>${fmtRatio(d.anomaly)} the typical ${MONTHS[d.month - 1]}` : "") +
              `<br><span class="m">${esc(d.source)}</span>`, e.clientX, e.clientY);
    });
    cal.addEventListener("mouseleave", hideTip);
    cal.addEventListener("click", (e) => {
      const b = e.target.closest(".cell");
      if (b) { const d = W.series[+b.dataset.i]; setPeriod(d.year, d.month); }
    });
  }

  /* ---------- calibration ---------- */
  function renderValidation() {
    const v = W.summary.validation;
    $("#w-val").innerHTML = [
      { k: "Global factor", v: `k = ${v.k_global.toFixed(2)}`, d: "VIIRS NOAA-20 ≈ k × MODIS, all countries pooled" },
      { k: "Countries with own k", v: nf.format(v.countries_own_k), d: `covering ${(v.share_fires_with_own_k * 100).toFixed(1)}% of fire activity` },
      { k: "Leave-one-year-out", v: `R² ${v.median_r2_loyo.toFixed(2)}`, d: "median across countries" },
      { k: "Hold-out 2024–25", v: `R² ${v.global_monthly_r2_holdout_2024_25.toFixed(2)}`,
        d: `world monthly totals · total ${v.global_total_err_pct_holdout_2024_25 > 0 ? "+" : ""}${v.global_total_err_pct_holdout_2024_25.toFixed(1)}%` },
    ].map((t) => `<div class="tile"><div class="k">${esc(t.k)}</div><div class="v">${esc(t.v)}</div><div class="d">${esc(t.d)}</div></div>`).join("");

    const top = [...W.summary.countries].sort((a, b) => b.total - a.total);
    let rows = top.slice(0, 20);
    const sel = W.byName.get(W.country);
    if (sel && !rows.includes(sel)) rows = rows.concat([sel]);
    const f = (x, d = 2) => (x == null ? "–" : x.toFixed(d));
    $("#w-calib").innerHTML =
      `<thead><tr><th>Country</th><th class="num">k</th><th>Fit</th><th class="num">R² (leave one year out)</th><th class="num">R² (2024–25 hold-out)</th><th class="num">2024–25 total error</th></tr></thead><tbody>` +
      rows.map((c) => `<tr${c.country === W.country ? ' class="sel"' : ""}><td>${esc(c.country)}</td><td class="num">${f(c.k)}</td>` +
        `<td>${c.k_source === "country" ? "own" : "global"}</td><td class="num">${f(c.r2_loyo)}</td><td class="num">${f(c.r2_holdout)}</td>` +
        `<td class="num">${c.holdout_err_pct == null ? "–" : (c.holdout_err_pct > 0 ? "+" : "") + c.holdout_err_pct.toFixed(0) + "%"}</td></tr>`).join("") +
      `</tbody>`;
  }

  /* ---------- entry point (called by app.js renderView) ---------- */
  window.renderWorld = async function () {
    try {
      await init();
    } catch (e) {
      status(`World data unavailable: ${e.message}`, true);
      return;
    }
    W.map.invalidateSize({ pan: false });
    if (!W.ranking) loadPeriod();
    if (!W.series) { loadCountry(); renderValidation(); if (W.country !== "World") zoomTo(W.country); }
  };
})();
