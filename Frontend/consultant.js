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

  const openBtn = $("ask-open"), panel = $("ask-panel"),
        closeBtn = $("ask-close"), log = $("ask-log"), form = $("ask-form"),
        input = $("ask-input"), send = $("ask-send"), seeds = $("ask-seeds");
  if (!openBtn || !panel) return;

  let history = [];       // {role, content} sent back to the model
  let busy = false;
  let lastFocus = null;

  /* ---------- mascot ---------- */
  let bots = [];
  (function mountBots() {
    const tpl = $("ask-bot-tpl");
    if (!tpl || !tpl.content || !tpl.content.firstElementChild) return;
    for (const id of ["ask-bot-head", "ask-bot-intro", "ask-open-mark"]) {
      const slot = $(id);
      if (!slot) continue;
      const bot = tpl.content.firstElementChild.cloneNode(true);
      slot.appendChild(bot);
      bots.push(bot);
      if (id !== "ask-open-mark") slot.addEventListener("click", () => press(bot));
    }
  })();

  function setBots(state) {
    bots = bots.filter((b) => b.isConnected);
    bots.forEach((b) => { b.dataset.state = state; });
  }
  function press(only) {
    (only ? [only] : bots.filter((b) => b.isConnected)).forEach((b) => {
      b.classList.remove("is-press");
      void b.offsetWidth;                 // force a reflow so it replays
      b.classList.add("is-press");
      setTimeout(() => b.classList.remove("is-press"), 520);
    });
  }

  /* ---------- open / close ---------- */
  function open() {
    panel.hidden = false;
    openBtn.setAttribute("aria-expanded", "true");
    lastFocus = document.activeElement;
    setTimeout(() => input.focus(), 60);
  }
  function close() {
    panel.hidden = true;
    openBtn.setAttribute("aria-expanded", "false");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  openBtn.addEventListener("click", () => (panel.hidden ? open() : close()));
  closeBtn.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) close();
  });

  /* ---------- what the user is looking at ---------- */
  const val = (id) => { const el = $(id); return el && el.value ? el.value : null; };
  function pageContext() {
    const page = (location.hash.replace(/^#\/?/, "").split("?")[0] || "home");
    const ctx = { page: { home: "overview", explore: "dashboard" }[page] || page };
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

  async function streamConsult(messages, context, onEvent, signal) {
    const res = await fetch(API + "/api/consult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, context }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop();
      for (const frame of frames) {
        const event = frame.match(/^event:\s*(.+)$/m)?.[1];
        const data = frame.match(/^data:\s*([\s\S]+)$/m)?.[1];
        if (!event || !data) continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }
        onEvent(event, payload);
      }
    }
  }

  const briefButton = $("watch-ai-generate"), briefStatus = $("watch-ai-status"), briefResult = $("watch-ai-result");
  let briefController;
  if (briefButton) {
    const briefPrompt = "Ask Ziro about the selected place and forecast month.";
    const resetBrief = () => {
      briefController?.abort();
      briefController = null;
      briefButton.disabled = !briefButton.dataset.question;
      briefResult.replaceChildren();
      if (!briefButton.hidden) briefStatus.textContent = briefPrompt;
    };
    briefButton.addEventListener("placechange", resetBrief);
    briefButton.addEventListener("click", async () => {
      resetBrief();
      const { question, scope, year, enso } = briefButton.dataset;
      if (!question) return;
      const controller = new AbortController();
      briefController = controller;
      briefButton.disabled = true;
      briefStatus.textContent = "Generating briefing…";
      let text = "";
      try {
        await streamConsult([{ role: "user", content: question }], {
          page: "explorer", area_selected: scope, forecast_year_selected: year, el_nino_scenario: enso,
        }, (event, payload) => {
          if (event === "error") throw new Error(payload.message);
          if (event !== "delta" || briefController !== controller) return;
          text += payload.text;
          briefResult.innerHTML = md(text);
        }, controller.signal);
        if (briefController === controller) briefStatus.textContent = text ? "Briefing ready." : "No briefing was returned. Try again.";
      } catch {
        if (briefController === controller) briefStatus.textContent = "The consultant could not generate a briefing. Try again.";
      } finally {
        if (briefController === controller) briefButton.disabled = false;
      }
    });
  }

  /* ---------- ask ---------- */
  async function ask(question) {
    if (busy || !question.trim()) return;
    busy = true; send.disabled = true;
    press();                    // it reacts to being asked
    setBots("thinking");        // ...then works: ball -> triangle, rings spinning
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
      await streamConsult(history, pageContext(), (event, payload) => {
        if (event === "tool") {
          const chip = document.createElement("span");
          chip.className = "ask-tool";
          const where = payload.args && (payload.args.scope || payload.args.region);
          chip.textContent = (TOOL_LABEL[payload.name] || payload.name) + (where ? " · " + where : "");
          tools.appendChild(chip); scroll();
        } else if (event === "delta") {
          text += payload.text;
          reply.innerHTML = md(text); scroll();
        } else if (event === "error") {
          failed = true;
          reply.className = "ask-msg err";
          reply.textContent = payload.message;
          scroll();
        }
      });
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
    setBots("idle"); press();   // settles back to the resting cloud
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

  /* ---------- page greeting: a short speech bubble above "Ask Ziro" ----------
     Shown only after the visitor picks a page from the left menu, then fades away. */
  const toast = $("ask-toast");
  const GREETING = {
    home: "Hi! Here's today's fire watch.",
    explorer: "Spin the globe, then pick a place to watch.",
    dashboard: "Pick a year to see its burning calendar.",
    forecast: "Here's what the coming months may bring.",
    haze: "Haze on the way? I've got tips.",
    data: "Curious how it's made? It's all here.",
    docs: "The full method and files live here.",
  };
  let navClicked = false, toastTimer, lastPage = null;
  const pageOf = () => (location.hash.replace(/^#\/?/, "").split("?")[0] || "home");
  function hideToast() {
    clearTimeout(toastTimer);
    if (!toast || toast.hidden) return;
    toast.classList.remove("is-in");
    toastTimer = setTimeout(() => { toast.hidden = true; }, 220);
  }
  function showToast(text) {
    if (!toast || openBtn.hidden || !panel.hidden) return;
    clearTimeout(toastTimer);
    toast.textContent = text;
    toast.hidden = false;
    void toast.offsetWidth;               // restart the pop-in
    toast.classList.add("is-in");
    press();
    toastTimer = setTimeout(hideToast, 3800);
  }
  if (toast) {
    document.querySelectorAll("[data-nav]").forEach((link) =>
      link.addEventListener("click", () => { navClicked = true; }));
    lastPage = pageOf();
    window.addEventListener("hashchange", () => {
      const page = pageOf();
      const changed = page !== lastPage;
      lastPage = page;
      if (!navClicked) return;
      navClicked = false;
      if (changed && GREETING[page]) setTimeout(() => showToast(GREETING[page]), 350);
    });
    toast.addEventListener("click", () => { hideToast(); open(); });
    openBtn.addEventListener("click", hideToast);
  }

  /* ---------- reveal ---------- */
  fetch(API + "/api/consult")
    .then((r) => r.json())
    .then((s) => {
      openBtn.hidden = false;
      if (s.configured && briefButton) {
        briefButton.hidden = false;
        briefButton.dispatchEvent(new Event("placechange"));
      }
      if (!s.configured) console.warn("[consultant] no OLLAMA_API_KEY — set it in backend/.env");
    })
    .catch(() => { openBtn.hidden = false; });
})();
