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
  async function answer(path, p) {
    if (path === "regions" || path === "calibration" || path === "enso" || path === "status") return file(path + ".json");
    if (path === "harmonized") return file(`harmonized/${slug(p.get("scope") || "All")}.json`);
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
    const d = await answer(u.pathname.slice(i + 5).replace(/\/$/, ""), u.searchParams);
    return d ? json(d) : json({ detail: "Not available in the static version of this site" }, 404);
  };
})();
