const $ = (id) => document.getElementById(id);
const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const monthNames = "January February March April May June July August September October November December".split(" ");
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0, signDisplay: "exceptZero" });
const regionColors = ["#b85435", "#e29a4b", "#358981", "#7764a5", "#5481af",
  "#bc697e", "#829047", "#358db0", "#986b53", "#9a79ae"];
const asShare = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const regionSeries = new Map();
let seasonChart, seasonMode = "count", rankPeriod = "month", dashboardRequest = 0, rankedCountry;

function cellDays(rows) {
  return rows.reduce((total, row) => total + row.harmonized, 0);
}

function renderMetrics(series, yearRows, selected, year, month) {
  const peak = yearRows.reduce((max, row) => !max || row.harmonized > max.harmonized ? row : max, null);
  $("dash-month-label").textContent = `${monthNames[month - 1]} ${year}`;
  $("dash-month").textContent = selected ? number.format(selected.harmonized) : "–";
  $("dash-month-detail").textContent = selected?.median > 0
    ? `Cell-days · ${percent.format(selected.harmonized / selected.median - 1)} vs typical`
    : selected ? "Fire cell-days" : "No observations";
  $("dash-year-label").textContent = `Fire cell-days in ${year}`;
  $("dash-year").textContent = yearRows.length ? number.format(cellDays(yearRows)) : "–";
  $("dash-year-detail").textContent = `${yearRows.length} of 12 months observed`;
  $("dash-peak").textContent = peak ? monthNames[peak.month - 1] : "–";
  $("dash-peak-detail").textContent = peak ? `${number.format(peak.harmonized)} fire cell-days` : "No observations";
  $("dash-record").textContent = series.length ? number.format(cellDays(series)) : "–";
  $("dash-record-detail").textContent = series.length
    ? `Cell-days · ${series[0].year}–${series.at(-1).year}` : "No observations";
}

function monthValues(records, year) {
  const byMonth = new Map(records.filter((row) => row.year === year).map((row) => [row.month, row.harmonized]));
  return months.map((_, index) => byMonth.get(index + 1) ?? null);
}

function renderLegend(datasets) {
  $("dash-legend").replaceChildren(...datasets.map((dataset) => {
    const item = document.createElement("span");
    const swatch = document.createElement("span");
    swatch.className = dataset.type === "line" ? "sw dashboard-median-swatch" : "sw dashboard-region-swatch";
    swatch.style.setProperty("--series-color", dataset.backgroundColor);
    swatch.setAttribute("aria-hidden", "true");
    item.append(swatch, dataset.label);
    return item;
  }));
}

function renderSeason({ year, month, setMonth, tokens, chartTooltip }, series, sources) {
  const totals = monthValues(series, year);
  const byRegion = sources.map(({ name, color, records }) => ({
    label: name, backgroundColor: color, cellDays: monthValues(records || [], year),
  }));
  const hasBreakdown = byRegion.length > 0 && sources.every(({ records }) => records?.length);
  const complete = totals.map((total, index) => total != null && byRegion.every(({ cellDays }) => cellDays[index] != null));
  const useBreakdown = hasBreakdown && complete.some(Boolean);
  const useShare = useBreakdown && seasonMode === "share";
  const controls = $("dash-season-controls");
  controls.querySelector('[data-season-mode="share"]').disabled = !useBreakdown;
  for (const button of controls.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.seasonMode === (useShare ? "share" : "count")));
  }

  const observed = useBreakdown ? byRegion : [{ label: `${year} observations`, backgroundColor: tokens.s2, cellDays: totals }];
  const plottedTotals = totals.map((_, index) => useBreakdown
    ? byRegion.reduce((total, dataset) => total + (dataset.cellDays[index] ?? 0), 0)
    : totals[index]);
  const datasets = observed.map((dataset) => ({
    ...dataset, stack: "observations", order: 2,
    data: dataset.cellDays.map((count, index) => {
      if (useBreakdown && !complete[index]) return null;
      if (!useShare) return count;
      return plottedTotals[index] > 0 ? count / plottedTotals[index] : null;
    }),
  }));
  if (!useShare) {
    const typical = new Map(series.filter((row) => row.median != null).map((row) => [row.month, row.median]));
    datasets.push({
      type: "line", label: "Historical median", stack: "median", order: 1,
      data: months.map((_, index) => typical.get(index + 1) ?? null),
      borderColor: tokens.s1, backgroundColor: tokens.s1, borderDash: [4, 3],
      borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3,
    });
  }

  $("dash-season-note").textContent = useBreakdown
    ? useShare ? "Each region’s share of observed fire cell-days each month." : "Observed fire cell-days stacked by region, with the historical median for comparison."
    : "Observed fire cell-days and the historical median. Regional breakdown unavailable for this selection.";
  $("dash-season-status").textContent = useBreakdown && totals.some((total, index) => total != null && !complete[index])
    ? "Months with incomplete regional coverage are omitted from the stacks." : "";
  const canvas = $("dash-season");
  canvas.setAttribute("aria-label", useShare ? "Monthly share of fire cell-days by region"
    : useBreakdown ? "Monthly fire cell-days by region and historical median" : "Monthly fire cell-days and historical median");
  renderLegend(datasets);
  seasonChart?.destroy();
  seasonChart = new Chart(canvas, {
    type: "bar",
    data: { labels: months, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      datasets: { bar: { categoryPercentage: 0.86, barPercentage: 0.95 } },
      interaction: { mode: "index", intersect: false },
      onClick: (_, items) => {
        const index = items[0]?.index;
        if (index != null && totals[index] != null) setMonth(index + 1);
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...chartTooltip(tokens),
          filter: (item) => item.dataset.type === "line" || item.parsed.y > 0,
          itemSort: (a, b) => b.parsed.y - a.parsed.y,
          callbacks: {
            title: (items) => `${monthNames[items[0].dataIndex]} ${year}`,
            label: (item) => useShare
              ? `${item.dataset.label}: ${asShare.format(item.parsed.y)} (${number.format(item.dataset.cellDays[item.dataIndex])} cell-days)`
              : `${item.dataset.label}: ${number.format(item.parsed.y)} cell-days`,
            footer: (items) => {
              const index = items[0]?.dataIndex;
              return index != null && complete[index] && useBreakdown
                ? `Total: ${number.format(plottedTotals[index])} cell-days` : "";
            },
          },
        },
      },
      scales: {
        x: {
          stacked: true, grid: { display: false }, border: { color: tokens.grid },
          ticks: { color: (tick) => tick.index + 1 === month ? tokens.ink : tokens.muted, maxRotation: 0 },
        },
        y: {
          stacked: true, beginAtZero: true, max: useShare ? 1 : undefined,
          grid: { color: tokens.grid }, border: { display: false },
          ticks: { color: tokens.muted, maxTicksLimit: 5, callback: (value) => useShare ? asShare.format(value) : compact.format(value) },
        },
      },
    },
    plugins: [{
      id: "selectedMonth",
      beforeDatasetsDraw(chart) {
        const { ctx, chartArea, scales: { x } } = chart;
        if (!chartArea) return;
        const width = x.getPixelForValue(1) - x.getPixelForValue(0);
        const selected = x.getPixelForValue(month - 1);
        ctx.save();
        ctx.fillStyle = tokens.empty;
        ctx.fillRect(selected - width / 2, chartArea.top, width, chartArea.height);
        ctx.restore();
      },
    }],
  });
}

function loadRegion(name, getJSON) {
  if (!regionSeries.has(name)) {
    regionSeries.set(name, getJSON(`/harmonized?scope=${encodeURIComponent(name)}`)
      .then(({ series }) => series)
      .catch((error) => {
        regionSeries.delete(name);
        throw error;
      }));
  }
  return regionSeries.get(name);
}

function loadDashboardRegions({ series, regions, scope, getJSON }) {
  return Promise.all(regions.map(async ({ region, country }, index) => {
    if (scope !== "All" && scope !== country && scope !== region) return null;
    const color = regionColors[index % regionColors.length];
    const records = region === scope ? series : await loadRegion(region, getJSON).catch(() => null);
    return { name: region, country, color, records };
  })).then((sources) => sources.filter(Boolean));
}

function periodTotal(records, year, selectedMonths) {
  const matching = records.filter((row) => row.year === year && selectedMonths.includes(row.month) && row.harmonized != null);
  return selectedMonths.length && matching.length === selectedMonths.length ? cellDays(matching) : null;
}

function rankRow({ name, color, total, previous }, index, top) {
  const share = top ? total / top * 100 : 0;
  const delta = previous > 0 ? total / previous - 1 : previous === 0 && total === 0 ? 0 : null;
  const tr = document.createElement("tr");
  const place = document.createElement("th");
  place.scope = "row";
  const swatch = document.createElement("span");
  swatch.className = "dashboard-rank-swatch";
  swatch.style.backgroundColor = color;
  swatch.setAttribute("aria-hidden", "true");
  place.append(swatch, name);
  const rank = tr.insertCell();
  rank.className = "dashboard-rank-number";
  rank.textContent = String(index + 1);
  tr.append(place);
  const volume = tr.insertCell();
  volume.textContent = number.format(total);
  renderRankBar(volume, share, color);
  const change = tr.insertCell();
  change.className = "dashboard-rank-change";
  change.textContent = delta == null ? "–" : percent.format(delta);
  if (delta == null) change.title = "No comparable prior-year baseline";
  else if (delta !== 0) change.dataset.direction = delta > 0 ? "higher" : "lower";
  return tr;
}

function renderRankBar(volume, share, color) {
  const track = document.createElement("span");
  const fill = document.createElement("i");
  track.className = "dashboard-rank-bar";
  track.setAttribute("aria-hidden", "true");
  fill.style.backgroundColor = color;
  fill.style.width = `${share}%`;
  track.append(fill);
  volume.append(track);
}

function renderLeaderboard({ year, month }, sources, yearRows) {
  const monthly = rankPeriod === "month";
  const chosen = monthly ? [month] : yearRows.map((row) => row.month);
  const results = $("dash-rank-results");
  const status = $("dash-rank-status");
  $("dash-rank-period").textContent = `${monthly ? monthNames[month - 1] + " " : ""}${year} · vs the same period in ${year - 1}`;
  const ranked = sources.filter(({ records }) => records).map(({ name, country, color, records }) => ({
    name, country, color, total: periodTotal(records, year, chosen), previous: periodTotal(records, year - 1, chosen),
  })).filter((row) => row.total != null).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  status.textContent = ranked.length === 0 ? "No regional data available for this period."
    : ranked.length < sources.length ? `Data available for ${ranked.length} of ${sources.length} regions.` : "";
  $("dash-rank-rows").replaceChildren(...ranked.map((row, index) => rankRow(row, index, ranked[0].total)));
  results.hidden = ranked.length === 0;

  const groups = ["Malaysia", "Indonesia"].map((name) => {
    const regions = ranked.filter((row) => row.country === name);
    const total = regions.reduce((sum, row) => sum + row.total, 0);
    return { name, total, regions, color: name === "Malaysia" ? "#eb8854" : "#55a49c" };
  }).sort((a, b) => b.total - a.total);
  const total = groups.reduce((sum, group) => sum + group.total, 0);
  $("dash-category-period").textContent = `${monthly ? monthNames[month - 1] + " " : ""}${year} · Share of ranked fire cell-days`;
  renderCategories(groups, total);
}


function buildTreemap(regions, horizontal = true) {
  if (regions.length === 1) return regions[0].tile;
  const total = regions.reduce((sum, region) => sum + region.total, 0);
  let left = 0, split = 0;
  do {
    left += regions[split++].total;
  } while (split < regions.length - 1 && left + regions[split].total / 2 < total / 2);
  const branch = document.createElement("div");
  branch.className = horizontal ? "dashboard-treemap-branch" : "dashboard-treemap-branch vertical";
  const first = buildTreemap(regions.slice(0, split), !horizontal);
  const rest = buildTreemap(regions.slice(split), !horizontal);
  first.style.flexGrow = String(left / total);
  rest.style.flexGrow = String((total - left) / total);
  branch.append(first, rest);
  return branch;
}

function renderCategories(groups, total) {
  const treemap = $("dash-treemap");
  const controls = $("dash-country-controls");
  const details = $("dash-category-breakdown");
  const status = $("dash-category-status");
  treemap.replaceChildren();
  controls.replaceChildren();
  treemap.hidden = details.hidden = total <= 0;
  status.textContent = total > 0 ? "" : "No positive fire cell-days to chart for this period.";
  if (total <= 0) return;

  const activeGroups = groups.filter((group) => group.total > 0);
  rankedCountry = activeGroups.some(({ name }) => name === rankedCountry) ? rankedCountry : activeGroups[0].name;
  function showCountry(name) {
    rankedCountry = name;
    const group = activeGroups.find((entry) => entry.name === name);
    for (const button of controls.querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.country === name));
    }
    $("dash-country-title").textContent = `${name} · ${number.format(group.total)} fire cell-days`;
    $("dash-country-rows").replaceChildren(...group.regions.map((region) => {
      const row = document.createElement("li");
      for (const text of [region.name, number.format(region.total), asShare.format(region.total / group.total)]) {
        const span = document.createElement("span");
        span.textContent = text;
        row.append(span);
      }
      return row;
    }));
  }

  for (const { name, total: countryDays, regions, color } of activeGroups) {
    const group = document.createElement("div");
    group.className = "dashboard-treemap-country";
    group.style.flexGrow = String(countryDays / total);
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", name);
    const tiles = regions.filter((region) => region.total > 0).map((region, index) => {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "dashboard-treemap-tile";
      tile.style.setProperty("--category-fill", `color-mix(in srgb, ${color} ${91 - index % 4 * 8}%, white)`);
      tile.title = `${region.name} · ${number.format(region.total)} cell-days · ${asShare.format(region.total / total)} of ranked activity`;
      tile.setAttribute("aria-label", `${tile.title}. Show ${name} breakdown.`);
      const label = document.createElement("strong");
      label.textContent = region.name;
      const share = document.createElement("span");
      share.textContent = asShare.format(region.total / total);
      tile.append(label, share);
      tile.addEventListener("click", () => showCountry(name));
      return { total: region.total, tile };
    });
    group.append(buildTreemap(tiles));
    treemap.append(group);

    const button = document.createElement("button");
    button.type = "button";
    button.dataset.country = name;
    const swatch = document.createElement("span");
    swatch.className = "dashboard-rank-swatch";
    swatch.style.backgroundColor = color;
    swatch.setAttribute("aria-hidden", "true");
    button.append(swatch, `${name} ${asShare.format(countryDays / total)}`);
    button.addEventListener("click", () => showCountry(name));
    controls.append(button);
  }
  showCountry(rankedCountry);
}

export async function renderDashboard(options) {
  const request = ++dashboardRequest;
  const series = options.series.filter((row) => row.harmonized != null);
  const yearRows = series.filter((row) => row.year === options.year);
  const selected = yearRows.find((row) => row.month === options.month);
  renderMetrics(series, yearRows, selected, options.year, options.month);

  const sources = await loadDashboardRegions(options);
  if (request !== dashboardRequest || !options.isVisible()) return;
  renderSeason(options, series, sources);
  renderLeaderboard(options, sources, yearRows);

  const seasonControls = $("dash-season-controls");
  seasonControls.onclick = (event) => {
    const button = event.target.closest("[data-season-mode]");
    if (!button || button.disabled || button.getAttribute("aria-pressed") === "true") return;
    seasonMode = button.dataset.seasonMode;
    renderSeason(options, series, sources);
  };

  const rankControls = $("dash-rank-controls");
  rankControls.onclick = (event) => {
    const button = event.target.closest("[data-rank-period]");
    if (!button || button.dataset.rankPeriod === rankPeriod) return;
    rankPeriod = button.dataset.rankPeriod;
    for (const option of rankControls.querySelectorAll("button")) {
      option.setAttribute("aria-pressed", String(option === button));
    }
    renderLeaderboard(options, sources, yearRows);
  };
}
