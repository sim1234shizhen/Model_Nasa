/* Timeline skin: a glass tube filled with glowing molten liquid, with the Earth as the handle.
   Purely visual. The real control is still <input type="range" id="f-timeline">: drag it,
   click the tube, or use the arrow keys. This file only draws underneath that control,
   and gives the Explorer toolbar its dark brown background. */
(function () {
  const input = document.getElementById("f-timeline"), track = document.getElementById("f-track");
  if (!input || !track) return;
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const KNOB = 30, R = 10, TOP = 22, H = TOP + 30 + 4;   // drawing is taller than the track so the flame can rise above it

  const css = `
/* dark brown toolbar */
.explorer-workspace > .map-toolbar {
  color-scheme: dark; background: #2b1a12; border-bottom-color: #4a2f22; color: #f5e9df;
  --surface: #33211a; --ink: #f5e9df; --ink-2: #e2cfc0; --muted: #c4ac9a; --border: rgba(255,255,255,.16);
  --empty: rgba(255,255,255,.1); --axis: rgba(255,255,255,.3); --band: rgba(255,255,255,.06);
  --s1: #9ccdf5; --s2: #ffb07a; --select: rgba(120,175,230,.22); --tint: rgba(255,150,80,.2); --focus: #9ccdf5;
}
.explorer-workspace > .map-toolbar #f-scope { background-color: #3a261d; color: #f5e9df; border-color: rgba(255,255,255,.22); }
.explorer-workspace > .map-toolbar .timeline-date { color: #ffd27a !important; }
.timeline:has(.tl-fx) .timeline-date { margin-right: 30px; position: relative; z-index: 3; padding: 0 6px; border-radius: 6px; background: #2b1a12; }   /* the flame passes behind the date */
/* the range input stays on top and keeps working; only its own drawing is hidden */
#f-track.tl-fx { height: 30px !important; }
#f-track.tl-fx::before { display: none; }
#f-track.tl-fx input { height: 30px !important; position: relative; z-index: 2; }
#f-track.tl-fx input::-webkit-slider-runnable-track { height: 30px !important; }
#f-track.tl-fx input::-moz-range-track { height: 30px !important; }
#f-track.tl-fx input::-webkit-slider-thumb { width: ${KNOB}px; height: ${KNOB}px; margin-top: 0 !important; opacity: 0; }
#f-track.tl-fx input::-moz-range-thumb { width: ${KNOB}px; height: ${KNOB}px; opacity: 0; border: 0; }
#f-track.tl-fx input:focus-visible { outline: none; }
.tl-art { position: absolute; z-index: 1; left: 0; top: -${TOP}px; width: 100%; height: ${H}px; pointer-events: none; overflow: visible; }
#f-track.tl-fx input:focus-visible ~ .tl-art .tl-ring { opacity: 1; }
#f-track.tl-fx input:disabled ~ .tl-art { opacity: .45; }
.tl-ring { opacity: 0; }
.tl-flame { transform-box: fill-box; transform-origin: 50% 100%; animation: tl-flicker .85s ease-in-out infinite alternate; }
.tl-flame.b { animation-duration: .6s; animation-delay: -.3s; }
@keyframes tl-flicker { from { transform: scale(.88, .8) rotate(-4deg); } to { transform: scale(1.06, 1.14) rotate(4deg); } }
.tl-land { animation: tl-spin 10s linear infinite; }
@keyframes tl-spin { to { transform: translateX(-40px); } }
.tl-flow { animation: tl-dash 2.6s linear infinite; }
.tl-flow.slow { animation-duration: 4.2s; }
@keyframes tl-dash { to { stroke-dashoffset: -160; } }
.tl-bub { animation: tl-rise 2.4s ease-in-out infinite alternate; }
@keyframes tl-rise { from { transform: translateY(2px); } to { transform: translateY(-3px); } }
.timeline-key .k-past { background: linear-gradient(90deg, #ff6a14, #ffe26a) !important; }
.timeline-key .k-future { background: repeating-linear-gradient(115deg, #4a352a 0 3px, #7a5f50 3px 6px) !important; }
@media (prefers-reduced-motion: reduce) { .tl-flame, .tl-land, .tl-flow, .tl-bub { animation: none; } }
`;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg"); svg.setAttribute("class", "tl-art"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
  track.classList.add("tl-fx"); track.appendChild(svg);

  // fixed pseudo-random bubbles: [position along the liquid 0..1, height -1..1, radius, opacity, animation delay]
  let seed = 7; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const BUBBLES = Array.from({ length: 34 }, () => [rnd(), rnd() * 2 - 1, 0.7 + rnd() * 1.9, 0.45 + rnd() * 0.5, -(rnd() * 2.4)]);

  let W = 0, pos = 0, split = 1, liquid, glowA, glowB, core, menis, hatch, knob, bubs = [], flows = [];
  const cy = TOP + 15;

  function build() {
    W = Math.max(60, Math.round(track.clientWidth));
    const x0 = 5, x1 = W - 5, L = x1 - x0;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = `
<defs>
  <clipPath id="tlxTube"><rect x="${x0}" y="${cy - R}" width="${L}" height="${2 * R}" rx="${R}"/></clipPath>
  <linearGradient id="tlxLava" x1="0" x2="1"><stop offset="0" stop-color="#ff5a14"/><stop offset=".3" stop-color="#ff8a1c"/><stop offset=".65" stop-color="#ffb82e"/><stop offset=".9" stop-color="#ffe26a"/><stop offset="1" stop-color="#fffbe0"/></linearGradient>
  <linearGradient id="tlxDepth" x1="0" y1="0" x2="0" y2="1"><stop offset=".5" stop-color="#c22a00" stop-opacity="0"/><stop offset="1" stop-color="#c22a00" stop-opacity=".4"/></linearGradient>
  <linearGradient id="tlxGlass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".6"/><stop offset=".24" stop-color="#fff" stop-opacity=".1"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".2"/></linearGradient>
  <filter id="tlxGlow" x="-10%" y="-200%" width="120%" height="500%"><feGaussianBlur stdDeviation="6"/></filter>
  <filter id="tlxSoft" x="-5%" y="-300%" width="110%" height="700%"><feGaussianBlur stdDeviation="2.2"/></filter>
  <filter id="tlxSwirl" x="-5%" width="110%"><feTurbulence type="fractalNoise" baseFrequency="0.014 0.1" numOctaves="2" seed="4" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="12" xChannelSelector="R" yChannelSelector="G"/></filter>
  <pattern id="tlxHatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(28)"><rect width="9" height="9" fill="#3a2a22"/><rect width="4" height="9" fill="#5a4337"/></pattern>
  <radialGradient id="tlxOcean" cx="36%" cy="30%" r="78%"><stop offset="0" stop-color="#8fd4ff"/><stop offset=".5" stop-color="#2377c9"/><stop offset="1" stop-color="#082a5e"/></radialGradient>
  <radialGradient id="tlxShade" cx="34%" cy="28%" r="80%"><stop offset=".5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".6"/></radialGradient>
  <linearGradient id="tlxFire" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#e2501c"/><stop offset=".5" stop-color="#ff9a2e"/><stop offset="1" stop-color="#fff0a8"/></linearGradient>
  <clipPath id="tlxGlobe"><circle r="13"/></clipPath>
</defs>
<rect id="tlxGlowA" x="${x0 - 3}" y="${cy - 11}" height="22" rx="11" fill="#ffa21e" filter="url(#tlxGlow)"/>
<rect id="tlxGlowB" x="${x0}" y="${cy - 8}" height="16" rx="8" fill="#ffd24a" opacity=".8" filter="url(#tlxGlow)"/>
<rect x="${x0}" y="${cy - R}" width="${L}" height="${2 * R}" rx="${R}" fill="#170f0b"/>
<g clip-path="url(#tlxTube)">
  <rect id="tlxHatchR" y="${cy - R}" height="${2 * R}" fill="url(#tlxHatch)"/>
  <path id="tlxLiquid" fill="url(#tlxLava)"/>
  <g filter="url(#tlxSwirl)" opacity=".6">
    <path class="tl-flow" id="tlxF1" fill="none" stroke="#ff6a12" stroke-width="4.5" stroke-dasharray="90 70" opacity=".75"/>
    <path class="tl-flow slow" id="tlxF2" fill="none" stroke="#fffbe0" stroke-width="2.6" stroke-dasharray="46 114" opacity=".95"/>
  </g>
  <path id="tlxDepthP" fill="url(#tlxDepth)"/>
  <path id="tlxCore" stroke="#fffbe0" stroke-width="4" stroke-linecap="round" opacity=".55" fill="none" filter="url(#tlxSoft)"/>
  <g id="tlxBubs"></g>
  <ellipse id="tlxMenis" cy="${cy}" rx="4" ry="${R - 2}" fill="#fff6c8" opacity=".9"/>
</g>
<rect x="${x0}" y="${cy - R}" width="${L}" height="${2 * R}" rx="${R}" fill="url(#tlxGlass)"/>
<rect x="${x0 + 8}" y="${cy - R + 2.5}" width="${Math.max(0, L - 16)}" height="2.4" rx="1.2" fill="#fff" opacity=".35"/>
<rect x="${x0}" y="${cy - R}" width="${L}" height="${2 * R}" rx="${R}" fill="none" stroke="#9a7c69" stroke-width="1.4"/>
<rect x="${x0 - 5}" y="${cy - R - 2}" width="8" height="${2 * R + 4}" rx="3.500" fill="#6b5345"/>
<rect x="${x1 - 3}" y="${cy - R - 2}" width="8" height="${2 * R + 4}" rx="3.500" fill="#6b5345"/>
<g id="tlxKnob">
  <g transform="translate(0 -3.500) scale(.78)"><path class="tl-flame" fill="url(#tlxFire)" d="M0 -32c5.500 6.300 9.500 10.300 9.500 15.800 0 5.500-4.300 9.500-9.500 9.500s-9.500-4-9.500-9.500c0-3.600 1.800-6.200 4.100-8.600.4 2.400 1.700 3.900 3.100 4.500-.6-4.500.4-8.100 2.300-11.700z"/>
  <path class="tl-flame b" fill="#fff6cf" d="M0 -21.500c2.400 2.800 4 4.500 4 7.100 0 2.500-1.800 4.400-4 4.400s-4-1.900-4-4.400c0-2.600 1.600-4.300 4-7.100z"/></g>
  <circle r="15.200" fill="#9bdcff" opacity=".4"/>
  <circle r="13" fill="url(#tlxOcean)"/>
  <g clip-path="url(#tlxGlobe)"><g class="tl-land" fill="#45a862">
    <path d="M-11.500 -7c2.500-1.800 5.600-1.500 7.400.2 1.500 1.500.8 3.500-1 4.200-1.500.6-1.800 2.300-.5 3.500 1.200 1.200.8 3.200-1 3.700-2 .5-4.200-.8-5.200-2.800-1.200-2.400-1.500-6.800.3-8.800z"/>
    <path d="M1.500 2.300c1.800-1 4-.5 5 1 1 1.600.2 3.700-1.200 5-1.100 1-2.800.8-3.800-.4-1.200-1.500-1.500-4.400 0-5.600z"/>
    <path d="M5.400 -9.200c1.800-.8 4.200-.2 5.200 1.200.8 1.200-.2 2.500-1.800 2.800-1.800.2-3.700-.5-4.200-2-.2-.8 0-1.600.8-2z"/>
    <path d="M28.500 -7c2.500-1.800 5.600-1.500 7.400.2 1.500 1.500.8 3.500-1 4.200-1.500.6-1.800 2.300-.5 3.500 1.200 1.200.8 3.200-1 3.700-2 .5-4.200-.8-5.200-2.800-1.200-2.400-1.500-6.800.3-8.800z"/>
    <path d="M41.500 2.300c1.800-1 4-.5 5 1 1 1.600.2 3.700-1.200 5-1.100 1-2.800.8-3.800-.4-1.200-1.500-1.500-4.400 0-5.600z"/>
    <path d="M45.400 -9.200c1.800-.8 4.200-.2 5.200 1.200.8 1.200-.2 2.500-1.800 2.800-1.800.2-3.700-.5-4.200-2-.2-.8 0-1.600.8-2z"/>
  </g></g>
  <circle r="13" fill="url(#tlxShade)"/>
  <ellipse cx="-4.600" cy="-6.100" rx="4.600" ry="2.700" fill="#fff" opacity=".45" transform="rotate(-30 -4.600 -6.100)"/>
  <circle r="13" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="1.200"/>
  <circle class="tl-ring" r="17" fill="none" stroke="#9ccdf5" stroke-width="2"/>
</g>`;
    const $ = (id) => svg.querySelector("#" + id);
    liquid = $("tlxLiquid"); glowA = $("tlxGlowA"); glowB = $("tlxGlowB"); core = $("tlxCore"); menis = $("tlxMenis"); hatch = $("tlxHatchR"); knob = $("tlxKnob");
    flows = [$("tlxF1"), $("tlxF2"), $("tlxDepthP")];
    const g = $("tlxBubs"); bubs = BUBBLES.map((b) => {
      const c = document.createElementNS(NS, "circle"); c.setAttribute("class", "tl-bub"); c.setAttribute("r", b[2].toFixed(1));
      c.setAttribute("fill", "#fff"); c.setAttribute("opacity", b[3].toFixed(2)); c.style.animationDelay = b[4].toFixed(2) + "s"; g.appendChild(c); return c;
    });
    draw(0);
  }

  // The liquid: flat bottom, a rippling surface, and a bulge where it meets the globe.
  function draw(t) {
    if (!liquid) return;
    const x0 = 5, x1 = W - 5, L = x1 - x0;
    const px = KNOB / 2 + pos * (W - KNOB);             // same place as the native handle
    const sx = x0 + L * split;
    hatch.setAttribute("x", sx); hatch.setAttribute("width", Math.max(0, x1 - sx));
    const end = Math.max(x0 + 2, px);
    let d = `M${x0} ${cy + R} L${x0} ${cy - 5}`;
    for (let x = x0; x <= end; x += 7)
      d += ` L${x.toFixed(1)} ${(cy - 5.5 + Math.sin(x / 15 + t * 1.7) * 1.7 + Math.sin(x / 6.3 - t * 2.6) * 0.9).toFixed(2)}`;
    d += ` Q${end + 8} ${cy - 5} ${end + 6} ${cy} Q${end + 9} ${cy + 6} ${end} ${cy + R} Z`;
    liquid.setAttribute("d", d); flows[2].setAttribute("d", d);
    flows[0].setAttribute("d", `M${x0} ${cy + 3} H${Math.max(x0, end - 5)}`);
    flows[1].setAttribute("d", `M${x0} ${cy - 2} H${Math.max(x0, end - 8)}`);
    core.setAttribute("d", `M${x0 + 6} ${cy + 1} H${Math.max(x0 + 6, end - 4)}`);
    glowA.setAttribute("width", Math.max(0, end - x0 + 6)); glowB.setAttribute("width", Math.max(0, end - x0));
    menis.setAttribute("cx", end + 2);
    const span = end - x0 - 12;
    bubs.forEach((c, i) => {
      const b = BUBBLES[i];
      c.setAttribute("cx", (x0 + 6 + b[0] * Math.max(0, span)).toFixed(1)); c.setAttribute("cy", (cy + b[1] * (R - 3)).toFixed(1));
      c.style.display = span > 10 ? "" : "none";
    });
    knob.setAttribute("transform", `translate(${px.toFixed(1)} ${cy})`);
  }

  function read() {
    const min = +input.min, max = +input.max, v = +input.value;
    const p = max > min ? Math.min(1, Math.max(0, (v - min) / (max - min))) : 0;
    const s = parseFloat(getComputedStyle(track).getPropertyValue("--split"));
    const sp = isFinite(s) ? Math.min(1, Math.max(0, s / 100)) : 1;
    const changed = p !== pos || sp !== split; pos = p; split = sp; return changed;
  }

  new ResizeObserver(() => { if (Math.round(track.clientWidth) !== W && track.clientWidth > 0) { read(); build(); } }).observe(track);
  input.addEventListener("input", () => { read(); draw(performance.now() / 1000); });
  read(); build();

  // gentle motion: about 24 frames a second, and only while the timeline is on screen
  let last = 0;
  (function loop(now) {
    requestAnimationFrame(loop);
    if (!W || !track.offsetParent) return;
    const moved = read();
    if (REDUCED) { if (moved) draw(0); return; }
    if (now - last < 42 && !moved) return; last = now;
    draw(now / 1000);
  })(0);
})();
