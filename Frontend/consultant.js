/* AI environmental consultant — slide-in panel.
   Talks to POST /api/consult, which streams Server-Sent Events:
     tool  {name, args}   a data lookup started
     delta {text}         a piece of the answer
     done  {ok}
     error {message}
   Self-contained: reads the page's own filter controls for context and touches
   nothing in app.js. */
(() => {
  "use strict";

  const API = (typeof window.API === "string" ? window.API : "");
  const $ = (id) => document.getElementById(id);

  const openBtn = $("ask-open"), panel = $("ask-panel"), scrim = $("ask-scrim"),
        closeBtn = $("ask-close"), log = $("ask-log"), form = $("ask-form"),
        input = $("ask-input"), send = $("ask-send"), seeds = $("ask-seeds");
  if (!openBtn || !panel) return;

  let history = [];       // {role, content} sent back to the model
  let busy = false;
  let lastFocus = null;

  /* ---------- open / close ---------- */
  function open() {
    panel.hidden = false; scrim.hidden = false;
    openBtn.setAttribute("aria-expanded", "true");
    lastFocus = document.activeElement;
    setTimeout(() => input.focus(), 60);
  }
  function close() {
    panel.hidden = true; scrim.hidden = true;
    openBtn.setAttribute("aria-expanded", "false");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  openBtn.addEventListener("click", () => (panel.hidden ? open() : close()));
  closeBtn.addEventListener("click", close);
  scrim.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) close();
  });

  /* ---------- what the user is looking at ---------- */
  const val = (id) => { const el = $(id); return el && el.value ? el.value : null; };
  function pageContext() {
    const page = (location.hash.replace(/^#\/?/, "").split("?")[0] || "home");
    const ctx = { page: { "": "overview", home: "overview" }[page] || page };
    const scope = val("f-scope"); if (scope) ctx.area_selected = scope;
    if (page === "forecast") {
      const y = val("fc-year"); if (y) ctx.forecast_year_selected = y;
      const e = val("fc-enso"); if (e && e !== "observed") ctx.el_nino_scenario = e;
    } else {
      const y = val("f-year"); if (y) ctx.year_selected = y;
      const m = val("f-month"); if (m) ctx.month_selected = m;
    }
    return ctx;
  }

  /* ---------- tiny markdown (input is escaped first) ---------- */
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function md(src) {
    const out = [];
    let items = null, tag = "ul";
    const flush = () => {
      if (items) out.push(`<${tag}>` + items.map((t) => `<li>${t}</li>`).join("") + `</${tag}>`);
      items = null;
    };
    for (const raw of esc(src).split("\n")) {
      const line = raw.trim();
      const bullet = line.match(/^[-*+]\s+(.*)$/);
      const number = line.match(/^\d{1,2}[.)]\s+(.*)$/);
      if (bullet || number) {
        const want = bullet ? "ul" : "ol";
        if (items && tag !== want) flush();
        tag = want;
        (items = items || []).push((bullet || number)[1]);
        continue;
      }
      flush();
      if (line.startsWith("#")) { out.push(`<p><strong>${line.replace(/^#+\s*/, "")}</strong></p>`); continue; }
      if (line) out.push(`<p>${line}</p>`);
    }
    flush();
    return out.join("")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  /* ---------- rendering ---------- */
  const scroll = () => { log.scrollTop = log.scrollHeight; };
  function bubble(cls, html) {
    const d = document.createElement("div");
    d.className = "ask-msg " + cls;
    d.innerHTML = html;
    log.appendChild(d); scroll();
    return d;
  }
  const TOOL_LABEL = {
    get_forecast: "Reading the forecast", get_history: "Checking the record",
    get_risk_map: "Finding the hot spots", get_enso: "Checking El Niño",
    get_accuracy: "Checking the calibration", list_regions: "Listing regions",
  };

  /* ---------- ask ---------- */
  async function ask(question) {
    if (busy || !question.trim()) return;
    busy = true; send.disabled = true;
    const intro = log.querySelector(".ask-intro");
    if (intro) intro.remove();

    bubble("user", esc(question));
    history.push({ role: "user", content: question });

    const tools = document.createElement("div");
    tools.className = "ask-tools";
    log.appendChild(tools);
    const reply = bubble("bot", '<span class="ask-dots"><i></i><i></i><i></i></span>');
    let text = "", failed = false;

    try {
      const res = await fetch(API + "/api/consult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, context: pageContext() }),
      });
      if (!res.ok || !res.body) throw new Error("HTTP " + res.status);

      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split("\n\n"); buf = frames.pop();
        for (const frame of frames) {
          const ev = (frame.match(/^event:\s*(.+)$/m) || [])[1];
          const dataLine = (frame.match(/^data:\s*([\s\S]+)$/m) || [])[1];
          if (!ev || !dataLine) continue;
          let payload; try { payload = JSON.parse(dataLine); } catch (_) { continue; }

          if (ev === "tool") {
            const chip = document.createElement("span");
            chip.className = "ask-tool";
            const where = payload.args && (payload.args.scope || payload.args.region);
            chip.textContent = (TOOL_LABEL[payload.name] || payload.name) + (where ? " · " + where : "");
            tools.appendChild(chip); scroll();
          } else if (ev === "delta") {
            text += payload.text;
            reply.innerHTML = md(text); scroll();
          } else if (ev === "error") {
            failed = true;
            reply.className = "ask-msg err";
            reply.textContent = payload.message;
            scroll();
          }
        }
      }
      if (!text && !failed) {
        reply.className = "ask-msg err";
        reply.textContent = "No answer came back. Try again.";
        failed = true;
      }
    } catch (e) {
      failed = true;
      reply.className = "ask-msg err";
      reply.textContent = "Could not reach the consultant: " + e.message;
    }

    if (!tools.childElementCount) tools.remove();
    if (!failed) history.push({ role: "assistant", content: text });
    else history.pop();
    busy = false; send.disabled = false; input.focus();
  }

  /* ---------- input ---------- */
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value;
    input.value = ""; input.style.height = "auto";
    ask(q);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  });
  if (seeds) seeds.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) ask(b.textContent.trim());
  });

  /* ---------- reveal ---------- */
  fetch(API + "/api/consult")
    .then((r) => r.json())
    .then((s) => {
      openBtn.hidden = false;
      if (!s.configured) console.warn("[consultant] no OLLAMA_API_KEY — set it in backend/.env");
    })
    .catch(() => { openBtn.hidden = false; });
})();
