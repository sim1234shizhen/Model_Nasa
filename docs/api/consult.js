/* Ziro, the AI consultant, as a Vercel serverless function.

   The local site runs this in Python (backend/app/services/consultant.py: a
   LangChain agent whose tools call the live data services). The static site has
   no Python server, so this does the same job in Node: a tool-calling loop on
   Ollama Cloud whose tools read the JSON that tools/export_static.py exported
   into ./data - the same numbers the site's charts show.

   GET  /api/consult   {configured, model}
   POST /api/consult   {messages, context} -> Server-Sent Events:
        tool {name, args} | focus {name, kind, region} | delta {text} | done {ok} | error {message}

   Needs OLLAMA_API_KEY (and optionally OLLAMA_MODEL) in the Vercel project's env. */
"use strict";

const SYSTEM = require("./_system.json");

const BASE_URL = process.env.OLLAMA_BASE_URL || "https://ollama.com";
const MODEL = process.env.OLLAMA_MODEL || "glm-5.3-flash";
const MAX_STEPS = 6;                       // model calls per answer (tool rounds + final)
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const LAST_YEAR = 2025;                    // observed record ends December 2025

const slug = (s) => String(s).replace(/ /g, "_");
const r3 = (v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v);

/* ---------------------------------------------------------------- data */
let ORIGIN = "";
const cache = new Map();
async function data(rel) {
  if (cache.has(rel)) return cache.get(rel);
  const res = await fetch(`${ORIGIN}/data/${rel}`);
  if (!res.ok) throw new Error(`no data file ${rel} (HTTP ${res.status})`);
  const json = await res.json();
  if (cache.size > 60) cache.delete(cache.keys().next().value);
  cache.set(rel, json);
  return json;
}

async function regions() { return data("regions.json"); }

async function scopeName(scope) {
  const want = String(scope || "All").trim().toLowerCase();
  const names = ["All", "Malaysia", "Indonesia", ...(await regions()).map((r) => r.region)];
  const hit = names.find((n) => n.toLowerCase() === want) ||
    names.find((n) => n.toLowerCase().includes(want) || want.includes(n.toLowerCase()));
  if (!hit) throw new Error(`unknown scope '${scope}'. Use one of: ${names.join(", ")}`);
  return hit;
}

async function worldName(country) {
  const list = (await data("world/fires/countries.json")).countries.map((c) => c.country);
  const want = String(country || "").trim().toLowerCase();
  const exact = list.find((n) => n.toLowerCase() === want);
  if (exact) return exact;
  const hits = list.filter((n) => n.toLowerCase().includes(want));
  if (hits.length === 1) return hits[0];
  throw new Error(hits.length ? `'${country}' matches several countries: ${hits.slice(0, 6).join(", ")}`
                              : `'${country}' is not in the world record`);
}

/* ---------------------------------------------------------------- tools */
const TOOLS = {
  async list_regions() {
    const rs = await regions();
    return { regions: rs.map((r) => ({ region: r.region, country: r.country })),
             scopes_accepted: ["All", "Malaysia", "Indonesia", ...rs.map((r) => r.region)] };
  },

  async get_enso() {
    const info = await data("enso.json");
    return { ...info, meaning: "ONI >= +0.5 is El Nino (drier, more fire in the Jun-Nov dry season); " +
                               "<= -0.5 is La Nina (wetter); in between is neutral." };
  },

  async get_forecast({ scope = "All", year, enso = "observed" } = {}) {
    year = Number(year || LAST_YEAR + 1);
    if (!(year > LAST_YEAR && year <= LAST_YEAR + 2)) {
      return { error: `There is no forecast for ${year}.`,
               reason: `The observed record ends in ${LAST_YEAR}, so the model only forecasts ${LAST_YEAR + 1} and ${LAST_YEAR + 2}.`,
               use_instead: `For ${year} and earlier, call get_history - those months were observed, not forecast.` };
    }
    const name = await scopeName(scope);
    const f = await data(`forecast/${slug(name)}_${year}_${String(enso)}.json`);
    const bt = f.backtest.chosen;
    return {
      scope: f.scope, year: f.year, data_ends: f.data_ends, model: f.model, enso_used: f.enso_used,
      unit: "fire cell-days (a 0.05 deg cell burning on a day counts once)",
      months: f.months.map((m) => ({ month: m.month, name: MONTHS[m.month - 1], expected: m.expected,
        low: m.low, high: m.high, typical_for_that_month: m.typical, ratio_to_typical: m.ratio_to_typical,
        chance_above_normal: m.p_above_normal, enso_multiplier: m.enso_multiplier })),
      annual: f.annual,
      accuracy: { backtest_years: bt.test_years, typical_monthly_error_pct: bt.median_abs_pct_err,
        note: "Backtested with the verifying year's observed ONI, so real forward skill is weaker than this figure suggests." },
      notes: f.notes,
    };
  },

  async get_history({ scope = "All", year, month } = {}) {
    const name = await scopeName(scope);
    const rows = (await data(`harmonized/${slug(name)}.json`)).series;
    year = year ? Number(year) : null; month = month ? Number(month) : null;
    if (year && month) {
      const hit = rows.find((r) => r.year === year && r.month === month);
      if (!hit) return { error: `no data for ${year}-${String(month).padStart(2, "0")}` };
      const same = rows.filter((r) => r.month === month).map((r) => r.harmonized).sort((a, b) => b - a);
      return { scope: name, year, month, name: MONTHS[month - 1], fire_cell_days: r3(hit.harmonized),
        median_for_that_month: r3(hit.median), ratio_to_median: r3(hit.anomaly),
        rank: same.indexOf(hit.harmonized) + 1, of_years: same.length, data_source: hit.source };
    }
    if (year) {
      const yr = rows.filter((r) => r.year === year);
      return { scope: name, year, total: Math.round(yr.reduce((s, r) => s + r.harmonized, 0) * 10) / 10,
        months: yr.map((r) => ({ month: r.month, name: MONTHS[r.month - 1], fire_cell_days: r3(r.harmonized),
          ratio_to_median: r3(r.anomaly) })) };
    }
    const tot = {};
    for (const r of rows) tot[r.year] = (tot[r.year] || 0) + r.harmonized;
    const vals = Object.values(tot).sort((a, b) => a - b);
    const mid = vals.length / 2;
    const med = vals.length % 2 ? vals[Math.floor(mid)] : (vals[mid - 1] + vals[mid]) / 2;
    const round = (v) => Math.round(v * 10) / 10;
    return { scope: name, unit: "fire cell-days per year", median_year: round(med),
      annual_totals: Object.entries(tot).map(([y, v]) => ({ year: +y, total: round(v) })),
      worst_years: Object.entries(tot).sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([y, v]) => ({ year: +y, total: round(v), times_typical: Math.round((v / med) * 100) / 100 })) };
  },

  async get_risk_map({ scope = "All", year, month } = {}) {
    const name = await scopeName(scope);
    year = Number(year || LAST_YEAR + 1);
    const fm = await data(`forecast-map/${slug(name)}_${year}_observed.json`);
    const months = month ? fm.months.filter((m) => m.month === Number(month)) : fm.months;
    const sk = fm.skill;
    return {
      scope: fm.scope, year: fm.year, cell_size_deg: fm.cell_deg,
      skill: { backtest_years: sk.test_years, ranking_auc: sk.auc,
        ranking_auc_means: `Given one cell that burned and one that did not, the model ranks the right one higher ${Math.round(sk.auc * 100)}% of the time. 50% is guessing.`,
        concentration_means: `The 10% of cells it rated riskiest contained ${sk.top10_capture_pct}% of all the fire days that actually happened.`,
        brier: sk.brier, brier_if_same_chance_everywhere: sk.base_rate_brier,
        brier_means: "Lower is better, so the model's probabilities beat a flat guess." },
      months: months.map((m) => ({ month: m.month, name: MONTHS[m.month - 1],
        expected_fire_days_total: m.expected_fire_days, top_areas: m.top_areas.slice(0, 6) })),
    };
  },

  async get_accuracy({ region } = {}) {
    let c = await data("calibration.json");
    if (region) c = c.filter((r) => r.region.toLowerCase() === String(region).toLowerCase());
    return { what_this_is: "How well MODIS was rescaled onto the VIIRS scale, so 2003-2011 can be compared " +
                           "with 2012 onward. Validated leave-one-year-out.", per_region: c };
  },

  async focus_map({ place } = {}) {
    const query = String(place || "").trim().toLowerCase();
    if (!query) return { error: "no place given" };
    const rs = await regions();
    const regional = new Set(rs.map((r) => r.country));
    const targets = [];
    for (const c of regional) targets.push([c.toLowerCase(), c, "country", ""]);
    for (const c of (await data("world/fires/countries.json")).countries)
      if (!regional.has(c.country)) targets.push([c.country.toLowerCase(), c.country, "country", ""]);
    for (const r of rs) {
      targets.push([r.region.toLowerCase(), r.region, "region", r.region]);
      let areas = [];
      try { areas = (await data(`forecast-map/${slug(r.region)}_${LAST_YEAR + 1}_observed.json`)).areas || []; } catch (e) { /* no map */ }
      for (const a of areas) {
        targets.push([a.toLowerCase(), a, "area", r.region]);
        for (const part of a.split("/")) if (part.trim().toLowerCase() !== a.toLowerCase())
          targets.push([part.trim().toLowerCase(), a, "area", r.region]);
      }
    }
    let hit = targets.find((t) => t[0] === query);
    if (!hit) {
      const partial = targets.filter((t) => t[0].includes(query) || query.includes(t[0]));
      if (partial.length === 1) hit = partial[0];
      else if (partial.length) return { error: `'${place}' matches more than one place`,
        did_you_mean: [...new Set(partial.map((t) => t[1]))].sort().slice(0, 6) };
    }
    if (!hit) return { error: `'${place}' is not a place this map covers` };
    const [, name, kind, region] = hit;
    const country = (rs.find((r) => r.region === region) || {}).country || (kind === "country" ? name : "");
    return { focused: name, kind, region, country, note: "The map on screen has moved to this place." };
  },

  async get_world_country({ country, sensor = "VIIRS" } = {}) {
    const name = await worldName(country);
    const s = String(sensor).toUpperCase() === "MODIS" ? "MODIS" : "VIIRS";
    const d = await data(`world/fires/country/${slug(name)}_${s}.json`);
    return { country: d.country, sensor: d.sensor, unit: d.unit, peak_month: d.peak_month,
      peak_month_name: d.peak_month ? MONTHS[d.peak_month - 1] : null,
      typical_season: d.typical_season.map((t) => ({ ...t, name: MONTHS[t.month - 1] })),
      recent_years: d.annual_totals.slice(-6), annual_totals: d.annual_totals,
      coverage: d.months.length ? `${d.months[0].year}-${d.months[d.months.length - 1].year}` : "",
      limits: "Observed history. A cell-level forecast for 2026-2027 is available through get_world_forecast. " +
              "Counts are uncalibrated and not comparable with the Malaysia/Indonesia figures." };
  },

  async get_world_ranking({ year, month, limit = 10, sensor = "auto" } = {}) {
    year = Number(year);
    let s = String(sensor).toUpperCase();
    if (s === "AUTO") s = year >= 2018 ? "VIIRS" : "MODIS";
    const suffix = month ? `_${String(month).padStart(2, "0")}` : "";
    const d = await data(`world/fires/ranking/${year}${suffix}_${s}.json`);
    return { year: d.year, month: d.month, sensor: d.sensor, unit: d.unit,
      countries: d.countries.slice(0, Math.max(1, Math.min(50, Number(limit) || 10))),
      limits: `Observed history, ${d.sensor} only, uncalibrated.` };
  },

  async get_world_outlook({ country } = {}) {
    const d = await data(`world/fires/outlook/${slug(await worldName(country))}.json`);
    return { ...d, limits: "Historical seasonality only - not a forecast, and it does not use this year's weather. " +
                           "Country-level counts, not a place inside the country." };
  },

  async get_world_forecast({ country, year = 2026, enso = "observed" } = {}) {
    const bundle = await data(`world/fires/forecast/${slug(await worldName(country))}.json`);
    const d = bundle[`${year}_${enso}`];
    if (!d) return { error: `no world forecast for ${year} with enso=${enso}`, available: Object.keys(bundle) };
    return {
      country: d.country, year: d.year, data_ends: d.data_ends, cell_deg: d.cell_deg, cells: d.cells,
      enso_used: d.enso_used, model: d.model, skill: d.skill,
      months: d.months.map((m, i) => {
        const a = m.top_areas[0] || {}, s = d.summary[i] || {};
        return { month: m.month, cells_at_50: a.high_risk_cells, peak_cell_pct: a.max_chance_pct,
          expected_fire_cell_days: a.expected_fire_days, typical_fire_cell_days: s.typical,
          ratio_to_typical: s.ratio_to_typical, p_above_normal: s.p_above_normal, oni: s.oni,
          enso_multiplier: s.enso_multiplier };
      }),
      limits: "1-degree global cells, harmonized counts rather than verified daily fire days. " +
              "Not comparable with the 0.25-degree Malaysia/Indonesia forecast.",
    };
  },
};

const SCOPES = "All, Malaysia, Indonesia, or one region: Peninsular Malaysia, Sarawak, Sabah, Sumatra, " +
               "Kalimantan, Java, Nusa Tenggara, Sulawesi, Maluku, Papua";
const fn = (name, description, properties = {}, required = []) =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
const str = (description) => ({ type: "string", description });
const int = (description) => ({ type: "integer", description });

const TOOL_SCHEMAS = [
  fn("list_regions", "List the regions this project covers and the scope names the other tools accept."),
  fn("get_enso", "Latest NOAA El Nino index (ONI) and whether conditions are El Nino, La Nina or neutral."),
  fn("get_forecast", "Month-by-month fire forecast for an area in Malaysia/Indonesia: expected fire cell-days, the 80% range, how it compares with a typical year, and the chance of an above-normal month. Use for 'how bad will it be' questions.",
     { scope: str(`one of ${SCOPES}`), year: int("forecast year, 2026 or 2027; defaults to 2026"),
       enso: str("'observed' (default) or a scenario ONI: '2', '1', '0', '-1'") }),
  fn("get_history", "Observed fire history from the harmonized MODIS + VIIRS record, 2003-2025, for Malaysia/Indonesia. No year: annual totals and worst years. Year only: that year month by month. Year and month: that month against the long-run median, with its rank.",
     { scope: str(`one of ${SCOPES}`), year: int("year"), month: int("1-12") }),
  fn("get_risk_map", "Which specific areas (provinces, states, divisions) in Malaysia/Indonesia are most at risk, with expected fire days per area, plus how well the area ranking was validated (AUC, concentration, Brier). Use for 'where' questions.",
     { scope: str(`one of ${SCOPES}`), year: int("2026 or 2027"), month: int("1-12, omit for all twelve months") }),
  fn("get_accuracy", "How accurate the HISTORICAL RECORD is: how well MODIS 2003-2011 was rescaled onto the VIIRS scale, per region. Use only when asked whether the past data can be trusted. Says nothing about forecast skill.",
     { region: str("optional region name") }),
  fn("focus_map", "Move the map on screen to a place (a country, a region such as Sarawak, or an area such as Miri or Jambi). Call whenever the user asks about somewhere specific, then answer as normal. Returns no fire figures.",
     { place: str("the name the user used") }, ["place"]),
  fn("get_world_country", "Observed fire history for ANY country on Earth from the worldwide FIRMS record: typical season, peak month and yearly totals. Use for countries outside Malaysia and Indonesia.",
     { country: str("country name"), sensor: str("VIIRS (2018 onwards, default) or MODIS (2003 onwards)") }, ["country"]),
  fn("get_world_ranking", "Which countries burned most in a given year, or one month of it, worldwide. Observed, uncalibrated.",
     { year: int("year, 2003-2025"), month: int("1-12, omit for the whole year"), limit: int("how many countries, default 10"),
       sensor: str("auto (VIIRS from 2018, MODIS before), VIIRS or MODIS") }, ["year"]),
  fn("get_world_outlook", "Country-level seasonal fire estimate (historical seasonality, not a forecast) for any country on Earth.",
     { country: str("country name") }, ["country"]),
  fn("get_world_forecast", "Cell-level fire forecast for any country on Earth for 2026 or 2027: per month the number of 1-degree cells with at least a 50% chance of fire, the peak cell chance and expected fire cell-days.",
     { country: str("country name"), year: int("2026 or 2027"), enso: str("'observed' or a scenario -1, 0, 1, 2") }, ["country"]),
];

async function runTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) return { error: `unknown tool ${name}` };
  try { return await tool(args || {}); }
  catch (e) { return { error: String(e && e.message || e), tool: name }; }
}

/* ---------------------------------------------------------------- model */
async function* chatStream(key, messages) {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOL_SCHEMAS, stream: true, think: false,
                           options: { temperature: 0.3 } }),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf);
}

const sse = (res, event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  let raw = "";
  for await (const c of req) raw += c;
  return raw ? JSON.parse(raw) : {};
}

module.exports = async function handler(req, res) {
  const key = (process.env.OLLAMA_API_KEY || "").trim();
  if (req.method === "GET") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ configured: Boolean(key), model: MODEL, base_url: BASE_URL, framework: "vercel-node" }));
    return;
  }
  if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }

  const proto = req.headers["x-forwarded-proto"] || "https";
  ORIGIN = `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`;

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  try {
    if (!key) { sse(res, "error", { message: "The consultant has no Ollama API key on this server." }); return res.end(); }
    const body = await readBody(req);
    let system = SYSTEM;
    const ctx = body.context || {};
    const bits = Object.entries(ctx).filter(([, v]) => v !== null && v !== "" && v !== "undefined" && v !== undefined)
      .map(([k, v]) => `${k}: ${v}`);
    if (bits.length) system += "\n\nThe user is currently looking at this part of the site - use it to read vague " +
                               "questions like 'is this bad?' - " + bits.join("; ");
    const messages = [{ role: "system", content: system },
      ...(body.messages || []).slice(-12).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user",
                                                       content: String(m.content || "") }))];

    let sentAny = false;
    for (let step = 0; step < MAX_STEPS; step++) {
      let content = "";
      const calls = [];
      for await (const part of chatStream(key, messages)) {
        const msg = part.message || {};
        if (msg.content) { content += msg.content; sentAny = true; sse(res, "delta", { text: msg.content }); }
        if (Array.isArray(msg.tool_calls)) calls.push(...msg.tool_calls);
      }
      if (!calls.length) break;
      messages.push({ role: "assistant", content, tool_calls: calls });
      for (const call of calls) {
        const name = call.function && call.function.name;
        let args = call.function && call.function.arguments;
        if (typeof args === "string") { try { args = JSON.parse(args); } catch (e) { args = {}; } }
        sse(res, "tool", { name, args: args || {} });
        const out = await runTool(name, args);
        if (name === "focus_map" && out && out.focused)
          sse(res, "focus", { name: out.focused, kind: out.kind, region: out.region || "" });
        messages.push({ role: "tool", tool_name: name, content: JSON.stringify(out) });
      }
    }
    if (!sentAny) sse(res, "error", { message: "The model returned no answer. Try again." });
    else sse(res, "done", { ok: true });
  } catch (e) {
    sse(res, "error", { message: String(e && e.message || e) });
  }
  res.end();
};
