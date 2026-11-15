/* World fire danger.
 *
 * Renders the GFWED percentile grid (180 x 360, one degree) straight into a
 * canvas. Only land has values, so the continents appear on their own - no
 * coastlines, no tiles, no basemap to download.
 */

const API = (window.API_BASE || "") + "/api";

const RAMP = [
  [ 26,  98, 154],   // 1  - wet
  [ 74, 158, 170],
  [168, 198, 132],
  [226, 202,  98],
  [228, 152,  62],
  [200,  74,  42],   // 100 - extreme
];

const state = { ready: false, months: [], byKey: new Map(), token: 0 };

async function getJSON(url) {
  const res = await fetch(API + url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
  return res.json();
}

function colour(rank) {
  const t = Math.min(1, Math.max(0, (rank - 1) / 99));
  const x = t * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  const a = RAMP[i], b = RAMP[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function paint(grid) {
  const canvas = document.getElementById("world-canvas");
  if (!canvas) return;
  const rows = 180, cols = 360;

  const off = document.createElement("canvas");
  off.width = cols;
  off.height = rows;
  const octx = off.getContext("2d");
  const img = octx.createImageData(cols, rows);
  const px = img.data;

  for (let r = 0; r < rows; r += 1) {
    // the grid runs south to north; the canvas runs north to south
    const src = (rows - 1 - r) * cols;
    for (let c = 0; c < cols; c += 1) {
      const rank = grid[src + c];
      const i = (r * cols + c) * 4;
      if (!rank) { px[i + 3] = 0; continue; }
      const [red, green, blue] = colour(rank);
      px[i] = red; px[i + 1] = green; px[i + 2] = blue; px[i + 3] = 235;
    }
  }
  octx.putImageData(img, 0, 0);

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

  // graticule, so the map reads as a map and not as weather noise
  ctx.strokeStyle = "rgba(24, 34, 46, 0.13)";
  ctx.lineWidth = 1;
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = ((90 - lat) / 180) * canvas.height;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }
  for (let lon = -150; lon <= 150; lon += 30) {
    const x = ((lon + 180) / 360) * canvas.width;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  }
}

function decode(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function draw() {
  const monthEl = document.getElementById("world-month");
  const varEl = document.getElementById("world-variable");
  const statusEl = document.getElementById("world-status");
  if (!monthEl || !varEl) return;

  const [year, month] = monthEl.value.split("-").map(Number);
  if (!year || !month) return;
  const variable = varEl.value;
  const token = ++state.token;
  statusEl.textContent = "Loading…";

  try {
    const data = await getJSON(`/world/danger?year=${year}&month=${month}&variable=${variable}`);
    if (token !== state.token) return;
    paint(decode(data.grid));
    const span = `${data.years_compared[0]}–${data.years_compared[1]}`;
    statusEl.textContent = `${data.cells.toLocaleString("en")} land cells · compared with ${span}`;
  } catch (error) {
    if (token !== state.token) return;
    statusEl.textContent = error.message;
  }
}

export async function renderWorldMap() {
  const monthEl = document.getElementById("world-month");
  if (!monthEl) return;

  if (!state.ready) {
    let coverage;
    try {
      coverage = await getJSON("/world/coverage");
    } catch (error) {
      document.getElementById("world-status").textContent = "World data is not available on this server.";
      return;
    }
    if (!coverage.available) {
      document.getElementById("world-status").textContent =
        "World fire weather has not been pulled yet — run pull_gfwed_world.py.";
      return;
    }

    const months = [];
    const [firstYear, firstMonth] = coverage.first.split("-").map(Number);
    const [lastYear, lastMonth] = coverage.last.split("-").map(Number);
    let y = lastYear, m = lastMonth;
    while (y > firstYear || (y === firstYear && m >= firstMonth)) {
      months.push(`${y}-${m}`);
      m -= 1;
      if (m === 0) { m = 12; y -= 1; }
    }

    monthEl.innerHTML = months.slice(0, 120).map((key) => {
      const [yy, mm] = key.split("-");
      const label = new Date(Date.UTC(+yy, +mm - 1, 1))
        .toLocaleDateString("en", { month: "long", year: "numeric", timeZone: "UTC" });
      return `<option value="${key}">${label}</option>`;
    }).join("");

    monthEl.addEventListener("change", draw);
    document.getElementById("world-variable").addEventListener("change", draw);
    state.ready = true;
  }

  draw();
}
