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
  async function answer(path, p) {
    if (path === "regions" || path === "calibration" || path === "enso" || path === "status") return file(path + ".json");
    if (path === "harmonized") return file(`harmonized/${slug(p.get("scope") || "All")}.json`);
    if (path === "calibration/points") return file(`calibration-points/${slug(p.get("region"))}.json`);
    if (path === "forecast" || path === "forecast/map")
      return file(`${path.replace("/", "-")}/${slug(p.get("scope") || "All")}_${p.get("year")}_${p.get("enso") || "observed"}.json`);
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
