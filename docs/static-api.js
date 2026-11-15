/* Static hosting: the page normally asks the FastAPI server under /api.
   On GitHub Pages there is no server, so this answers the same requests
   from JSON files in ./data that export_static.py wrote from the real API. */
(function () {
  const DATA = new URL("data/", document.baseURI).href;
  const real = window.fetch.bind(window);
  const slug = (s) => String(s).replace(/ /g, "_");
  const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json" } });
  const cache = new Map();
  async function file(rel) {
    if (!cache.has(rel)) cache.set(rel, real(DATA + rel).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    const d = await cache.get(rel);
    if (cache.size > 80) cache.delete(cache.keys().next().value);
    return d;
  }
  const SENSORS = ["MODIS", "VIIRS"];
  const sensorOf = (value) => {
    const sensor = String(value || "VIIRS").toUpperCase();
    return SENSORS.includes(sensor) ? sensor : null;
  };
  async function worldCountry(name) {
    const wanted = String(name || "").trim().toLowerCase();
    const list = await file("world/fires/countries.json");
    if (!list) return null;
    const names = list.countries.map((row) => row.country);
    const exact = names.find((n) => n === name) ||
      names.find((n) => n.toLowerCase() === wanted);
    const hits = names.filter((n) => n.toLowerCase().includes(wanted));
    return exact || (hits.length === 1 ? hits[0] : null);
  }
  /* ---- Hotspot map (Dashboard): every cleaned detection, from data/hotspots/<YYYY-MM>.bin
     (16 bytes per row, written by tools/export_hotspots_static.py). Mirrors
     hotspot_range / hotspot_range_csv in backend/app/services/harmonized.py. */
  const binCache = new Map();
  function monthBin(key) {
    if (!binCache.has(key)) {
      binCache.set(key, real(DATA + `hotspots/${key}.bin`)
        .then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null));
      if (binCache.size > 36) binCache.delete(binCache.keys().next().value);
    }
    return binCache.get(key);
  }
  const dateKey = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || "") ? +iso.replace(/-/g, "") : NaN);
  const r1 = (v) => Math.round(v * 10) / 10;
  const F05 = Math.fround(0.05);
  async function hotspotRows(p) {
    const idx = await file("hotspots/index.json");
    if (!idx) return null;
    const start = dateKey(p.get("start")), end = dateKey(p.get("end"));
    if (!(start <= end)) return null;
    const scope = p.get("scope") || "All";
    let wanted = idx.regions.filter((r) => scope === "All" || r === scope || idx.countries[r] === scope);
    if (!wanted.length) return null;
    let sensor = p.get("sensor") || "auto";
    if (sensor === "auto") sensor = start >= dateKey(idx.viirs_from) ? "VIIRS" : "MODIS";
    const regionOk = idx.regions.map((r) => wanted.includes(r));
    const sensorCode = sensor === "both" ? -1 : sensor === "VIIRS" ? 1 : 0;
    const rows = [];
    let y = Math.floor(start / 10000), m = Math.floor(start / 100) % 100;
    const lastY = Math.floor(end / 10000), lastM = Math.floor(end / 100) % 100;
    const keys = [];
    while (y < lastY || (y === lastY && m <= lastM)) {
      keys.push([y, m]);
      if (++m > 12) { m = 1; y++; }
    }
    const bufs = await Promise.all(keys.map(([yy, mm]) => {
      const k = `${yy}-${String(mm).padStart(2, "0")}`;
      return idx.months[k] ? monthBin(k) : Promise.resolve(null);
    }));
    keys.forEach(([yy, mm], i) => {
      const buf = bufs[i];
      if (!buf) return;
      const v = new DataView(buf), n = buf.byteLength / 16;
      const ym = `${yy}-${String(mm).padStart(2, "0")}-`;
      for (let j = 0; j < n; j++) {
        const o = j * 16, day = v.getUint8(o + 12), dk = yy * 10000 + mm * 100 + day;
        if (dk < start || dk > end) continue;
        const reg = v.getUint8(o + 13), sen = v.getUint8(o + 14);
        if (!regionOk[reg] || (sensorCode >= 0 && sen !== sensorCode)) continue;
        rows.push({ lat: v.getFloat32(o, true), lon: v.getFloat32(o + 4, true), frp: v.getFloat32(o + 8, true),
                    date: ym + String(day).padStart(2, "0"), region: idx.regions[reg], sensor: sen ? "VIIRS" : "MODIS" });
      }
    });
    const days = Math.round((Date.parse(p.get("end")) - Date.parse(p.get("start"))) / 86400000) + 1;
    return { scope, sensor, days, rows };
  }
  async function hotspotRange(p, maxPoints = 15000) {
    const got = await hotspotRows(p);
    if (!got) return null;
    const { scope, sensor, days, rows } = got;
    const base = { scope, sensor, days_in_range: days };
    if (!rows.length) return { ...base, hotspots: 0, fire_days: 0, cell_days: 0, frp_total: 0, busiest_day: null,
                               daily: [], regions: [], points: [], points_truncated: false };
    const cells = new Set(), daily = new Map(), reg = new Map();
    let frpTotal = 0;
    for (const r of rows) {
      // 0.05 deg cells, in float32 like the server (numpy float32 / 0.05), so edge points land the same way
      cells.add(`${Math.floor(Math.fround(r.lat / F05))}_${Math.floor(Math.fround(r.lon / F05))}_${r.date}`);
      frpTotal += r.frp;
      const d = daily.get(r.date) || daily.set(r.date, { date: r.date, hotspots: 0, frp: 0 }).get(r.date);
      d.hotspots++; d.frp += r.frp;
      const g = reg.get(r.region) || reg.set(r.region, { hotspots: 0, frp: 0, days: new Map() }).get(r.region);
      g.hotspots++; g.frp += r.frp; g.days.set(r.date, (g.days.get(r.date) || 0) + 1);
    }
    const dailyList = [...daily.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((d) => ({ ...d, frp: r1(d.frp) }));
    const busiest = dailyList.reduce((a, b) => (b.hotspots > a.hotspots ? b : a));
    const regions = [...reg.entries()].sort((a, b) => b[1].hotspots - a[1].hotspots).map(([name, g]) => {
      let peak = "", peakN = -1;
      for (const [date, n] of [...g.days.entries()].sort()) if (n > peakN) { peak = date; peakN = n; }
      return { region: name, hotspots: g.hotspots, share: r1(g.hotspots / rows.length * 100),
               frp: r1(g.frp), fire_days: g.days.size, peak_date: peak };
    });
    const strongest = rows.slice().sort((a, b) => b.frp - a.frp);
    const r4 = (v) => Math.round(v * 10000) / 10000;
    const points = strongest.slice(0, maxPoints).map((r) => [r4(r.lat), r4(r.lon), r1(r.frp), r.date, r.region]);
    return { ...base, hotspots: rows.length, fire_days: dailyList.length, cell_days: cells.size,
             frp_total: r1(frpTotal), busiest_day: { date: busiest.date, hotspots: busiest.hotspots },
             daily: dailyList, regions, points, points_truncated: strongest.length > maxPoints };
  }
  async function hotspotCSV(p) {
    const got = await hotspotRows(p);
    if (!got) return null;
    const rows = got.rows.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.region < b.region ? -1 : a.region > b.region ? 1 : 0));
    return "date,lat,lon,frp,sensor,region\n" + rows.map((r) =>
      `${r.date},${r.lat.toFixed(4)},${r.lon.toFixed(4)},${r.frp.toFixed(4)},${r.sensor},${r.region}`).join("\n") + "\n";
  }
  // The "Download CSV" link points at /api/hotspots/range.csv; build the file here instead.
  document.addEventListener("click", async (e) => {
    const a = e.target.closest && e.target.closest('a[href*="/api/hotspots/range.csv"]');
    if (!a) return;
    e.preventDefault();
    const u = new URL(a.href, document.baseURI);
    const text = await hotspotCSV(u.searchParams);
    if (text == null) return;
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    const tmp = Object.assign(document.createElement("a"), { href: url, download: a.download || "fire_points.csv" });
    document.body.appendChild(tmp); tmp.click(); tmp.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }, true);

  async function answer(path, p) {
    if (path === "hotspots/dates") {
      const idx = await file("hotspots/index.json");
      return idx && { first: idx.first, last: idx.last, viirs_from: idx.viirs_from };
    }
    if (path === "hotspots/range") return hotspotRange(p);
    if (path === "regions" || path === "calibration" || path === "enso" || path === "status") return file(path + ".json");
    if (path === "harmonized") {
      const scope = p.get("scope") || "All";
      // Malaysia/Indonesia scopes and "World" first, then one file per other country
      return (await file(`harmonized/${slug(scope)}.json`))
        || file(`harmonized/world/${String(scope).replace(/[^\p{L}\p{N}]/gu, "_")}.json`);
    }
    if (path === "harmonized/areas") return file("harmonized/areas.json");
    if (path === "harmonized/countries") return file(`harmonized/countries/${p.get("year")}.json`);
    if (path === "calibration/points") return file(`calibration-points/${slug(p.get("region"))}.json`);
    if (path === "forecast" || path === "forecast/map")
      return file(`${path.replace("/", "-")}/${slug(p.get("scope") || "All")}_${p.get("year")}_${p.get("enso") || "observed"}.json`);
    if (path === "world/coverage") return file("world/coverage.json");
    if (path === "world/danger") {
      const variable = String(p.get("variable") || "FWI").toUpperCase();
      if (variable !== "FWI" && variable !== "DC") return null;
      return file(`world/danger/${variable}_${p.get("year")}-${String(p.get("month")).padStart(2, "0")}.json`);
    }
    if (path === "world/fires") return file("world/fires/coverage.json");
    if (path === "world/fires/countries") return file("world/fires/countries.json");
    if (path === "world/fires/grid") {
      const year = Number(p.get("year")), month = Number(p.get("month"));
      if (!Number.isInteger(year) || year < 2000 || year > 2030 || !Number.isInteger(month) || month < 1 || month > 12) return null;
      return await file(`world/fires/grid/${year}-${String(month).padStart(2, "0")}.json`)
        || { year, month, cell: 1, cells: [] };
    }
    if (path === "world/fires/outlook-map") return file("world/fires/outlook-map.json");
    if (path === "world/fires/forecast-map") {
      const year = p.get("year") || "2026";
      const enso = p.get("enso") || "observed";
      return file(`world/fires/forecast-map/${year}_${enso}.json`);
    }
    if (path.startsWith("world/fires/forecast/")) {
      const name = await worldCountry(decodeURIComponent(path.slice("world/fires/forecast/".length)));
      if (!name) return null;
      const bundle = await file(`world/fires/forecast/${slug(name)}.json`);
      const year = p.get("year") || "2026";
      const enso = p.get("enso") || "observed";
      return bundle ? bundle[`${year}_${enso}`] || null : null;
    }
    if (path.startsWith("world/fires/outlook/")) {
      const name = await worldCountry(decodeURIComponent(path.slice("world/fires/outlook/".length)));
      return name ? file(`world/fires/outlook/${slug(name)}.json`) : null;
    }
    if (path.startsWith("world/fires/country/")) {
      const sensor = sensorOf(p.get("sensor"));
      if (!sensor) return null;
      const name = await worldCountry(decodeURIComponent(path.slice("world/fires/country/".length)));
      return name ? file(`world/fires/country/${slug(name)}_${sensor}.json`) : null;
    }
    if (path === "world/fires/ranking") {
      const sensor = sensorOf(p.get("sensor"));
      if (!sensor) return null;
      const month = p.get("month");
      const suffix = month ? `_${String(month).padStart(2, "0")}` : "";
      const data = await file(`world/fires/ranking/${p.get("year")}${suffix}_${sensor}.json`);
      if (!data) return null;
      const limit = Math.max(1, Math.min(200, +(p.get("limit") || 20)));
      return Object.assign({}, data, { countries: data.countries.slice(0, limit) });
    }
    if (path === "hotspots/grid") {
      const b = await file(`grid/${slug(p.get("scope") || "All")}/${p.get("year")}-${String(p.get("month")).padStart(2, "0")}.json`);
      if (!b) return null;
      const want = +(p.get("cell") || 0.1);
      const key = Object.keys(b.cells).reduce((a, c) => (Math.abs(+c - want) < Math.abs(+a - want) ? c : a));
      let sensor = p.get("sensor") || "auto"; if (sensor === "auto") sensor = b.auto;
      const d = b.cells[key][sensor]; if (!d) return null;
      const k = d.k || [];
      return Object.assign({}, d, { k: undefined, cells: d.cells.map((row) => Object.fromEntries(k.map((name, i) => [name, row[i]]))) });
    }
    return null;
  }
  window.fetch = async function (input, init) {
    let u;
    try { u = new URL(typeof input === "string" ? input : input.url, document.baseURI); } catch (e) { return real(input, init); }
    const i = u.pathname.indexOf("/api/");
    if (u.origin !== location.origin || i < 0) return real(input, init);
    // The consultant is a real serverless function (api/consult.js), not a static file.
    if (/^consult\/?$/.test(u.pathname.slice(i + 5))) return real(input, init);
    const d = await answer(u.pathname.slice(i + 5).replace(/\/$/, ""), u.searchParams);
    return d ? json(d) : json({ detail: "Not available in the static version of this site" }, 404);
  };
})();
