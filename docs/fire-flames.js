/* Fire on top of the MapLibre globe.
   Each fire cell is drawn as one wispy, volumetric-looking flame: a translucent body, thin bright filaments that
   stream upward, a soft halo and a few embers. A dark backing sits behind each one so the glow reads on bright ground.
   The colour and the size follow the fire level:
     Light (1–2 days)    yellow, small
     Moderate (3–7 days) orange, medium
     Heavy (8+ days)     red, large
   Drawn with plain WebGL on its own canvas layered over the map, so it works with globe view, pitch and terrain.
   The flame is computed per pixel in the fragment shader; the CPU only places one anchor per cell each frame. */

const NOISE = `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) { return noise(p) * 0.55 + noise(p * 2.1 + 7.3) * 0.3 + noise(p * 4.3 + 2.9) * 0.15; }
`;

// ---- flame body: one quad per cell ----
const VS = `
attribute vec4 aDyn;    // anchor x, anchor y (CSS px), width, height (px)
attribute vec4 aQ;      // corner x -1..1, corner y 0..1, level, seed
uniform vec2 uView;
varying vec2 vUv;
varying vec2 vQ;
varying float vK;
varying float vSeed;
void main() {
  // the quad is larger than the flame so the wisps and the halo have room
  vec2 p = vec2(aDyn.x + aQ.x * aDyn.z * 1.25, aDyn.y + aDyn.w * 0.3 - aQ.y * aDyn.w * 1.8);
  vUv = vec2(aQ.x * 2.0, aQ.y * 1.8 - 0.3);
  vQ = aQ.xy; vK = aQ.z; vSeed = aQ.w;
  vec2 clip = p / uView * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

// Wispy volumetric fire: a translucent body, bright filaments that stream upward, and a soft halo.
const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform float uTime;
varying vec2 vUv;
varying vec2 vQ;
varying float vK;
varying float vSeed;
${NOISE}
void main() {
  float t = uTime, off = vSeed * 37.0;
  vec2 p = vUv;
  float yc = clamp(p.y, 0.0, 1.0);

  // bend the whole flame with slow rising turbulence: this gives the torn, curling outline
  vec2 q = vec2(p.x * 1.7 + off, p.y * 1.5 - t * 1.0);
  vec2 wv = vec2(fbm(q + vec2(3.1, 0.0)), fbm(q + vec2(0.0, 5.7))) - 0.5;
  vec2 p2 = p + wv * (0.22 + 0.62 * yc);
  p2.x += sin(t * 1.6 + off) * 0.07 * yc;

  // envelope: rounded at the bottom, drawn to a point at the top
  float y2 = clamp(p2.y, 0.0, 1.0);
  float r = 0.72 * sin(3.14159 * pow(y2, 0.6)) + 0.001;
  float E = 1.0 - abs(p2.x) / r;
  E = mix(-1.0, E, step(-0.05, p2.y) * step(p2.y, 1.0));
  float n = fbm(vec2(p2.x * 3.0 - off, p2.y * 2.6 - t * 2.0));
  float D = smoothstep(-0.05, 0.8, E + (n - 0.5) * 1.0);       // how much fire is here
  D *= smoothstep(-0.02, 0.14, p2.y + (n - 0.5) * 0.12);       // ragged, soft underside instead of a straight cut

  // filaments: thin bright ridges of noise, streaming up faster than the body
  // (stretched along the flame, so the strands run upward and curl with the turbulence)
  vec2 fq = vec2(p2.x * 6.0 + off, p2.y * 3.0 - t * 2.6) + wv * 1.6;
  float r1 = 1.0 - abs(2.0 * noise(fq) - 1.0);
  float r2 = 1.0 - abs(2.0 * noise(fq * 2.1 + 4.0) - 1.0);
  float r3 = 1.0 - abs(2.0 * noise(fq * 4.3 + 9.0) - 1.0);
  float F = pow(r1, 9.0) * 1.0 + pow(r2, 10.0) * 0.6 + pow(r3, 10.0) * 0.3;
  float core = exp(-(p.x * p.x * 9.0 + (p.y - 0.26) * (p.y - 0.26) * 12.0));
  float I = D * (0.13 + F * 1.15 + pow(r1 * r2, 2.0) * 0.25) + core * D * 0.45;

  vec3 deep, mid, hot;   // colour = fire level
  if (vK < 0.5)      { deep = vec3(0.80, 0.50, 0.04); mid = vec3(1.00, 0.82, 0.16); hot = vec3(1.00, 0.99, 0.82); }
  else if (vK < 1.5) { deep = vec3(0.72, 0.20, 0.02); mid = vec3(1.00, 0.46, 0.05); hot = vec3(1.00, 0.86, 0.50); }
  else               { deep = vec3(0.50, 0.02, 0.02); mid = vec3(1.00, 0.10, 0.04); hot = vec3(1.00, 0.56, 0.36); }
  vec3 col = mix(deep, mid, smoothstep(0.1, 0.7, I));
  col = mix(col, hot, smoothstep(1.0, 1.7, I));
  vec3 rgb = col * clamp(I * 1.5, 0.0, 1.2);

  // halo in the level colour, and a dark backing so the glow reads on bright ground the way it does on black
  float fade = smoothstep(0.0, 0.3, 1.0 - abs(vQ.x)) * smoothstep(0.0, 0.14, vQ.y) * smoothstep(0.0, 0.25, 1.0 - vQ.y);
  float halo = exp(-(p.x * p.x * 1.5 + (p.y - 0.4) * (p.y - 0.4) * 2.2)) * fade;
  rgb += mix(deep, mid, 0.5) * halo * 0.22;
  float alpha = clamp(halo * 0.85 + D * 0.3, 0.0, 0.9);
  gl_FragColor = vec4(rgb, alpha);
}`;

// ---- embers: small points that fly up out of the ball ----
const VS_E = `
attribute vec4 aDyn;    // anchor x, anchor y, width, height
attribute vec4 aE;      // lateral -1..1, level, seed, speed
uniform float uTime;
uniform vec2 uView;
uniform float uDpr;
varying vec3 vCol;
varying float vA;
void main() {
  float life = fract(aE.z * 13.7 + uTime * aE.w);
  float w = aDyn.z, h = aDyn.w;
  float x = aE.x * w * (0.15 + 0.4 * life) + sin(uTime * 4.0 + aE.z * 50.0) * 0.05 * w;
  float y = h * (0.3 + life * 1.25);
  vec2 clip = vec2(aDyn.x + x, aDyn.y - y) / uView * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = clamp(w * 0.06, 2.0, 6.0) * (1.0 - life * 0.5) * uDpr;
  vCol = aE.y < 0.5 ? vec3(1.0, 0.92, 0.45) : (aE.y < 1.5 ? vec3(1.0, 0.62, 0.15) : vec3(1.0, 0.30, 0.10));
  vA = smoothstep(0.0, 0.1, life) * (1.0 - smoothstep(0.55, 1.0, life));
}`;
const FS_E = `
precision mediump float;
varying vec3 vCol;
varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float a = smoothstep(1.0, 0.2, d) * vA;
  gl_FragColor = vec4(vCol * a, a * 0.4);
}`;

const CORNERS = [[-1, 0], [1, 0], [1, 1], [-1, 0], [1, 1], [-1, 1]];
const EMBERS = [3, 5, 8];                  // per ball, by level
const rand = (a, b) => { const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return v - Math.floor(v); };

export function createFlames(map, opts = {}) {
  const reduced = !!opts.reduced;
  const canvas = document.createElement("canvas");
  canvas.className = "fire-flames";
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, { position: "absolute", left: "0", top: "0", width: "100%", height: "100%", pointerEvents: "none" });
  map.getCanvas().after(canvas);   // above the map, below city markers and controls

  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false });
  if (!gl) { canvas.remove(); return null; }

  function program(vs, fs) {
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  const pBody = program(VS, FS), pEmber = program(VS_E, FS_E);
  const L = {
    dyn: gl.getAttribLocation(pBody, "aDyn"), q: gl.getAttribLocation(pBody, "aQ"),
    time: gl.getUniformLocation(pBody, "uTime"), view: gl.getUniformLocation(pBody, "uView"),
    eDyn: gl.getAttribLocation(pEmber, "aDyn"), e: gl.getAttribLocation(pEmber, "aE"),
    eTime: gl.getUniformLocation(pEmber, "uTime"), eView: gl.getUniformLocation(pEmber, "uView"), eDpr: gl.getUniformLocation(pEmber, "uDpr"),
  };
  const bufBody = gl.createBuffer(), bufEmber = gl.createBuffer();

  let cells = [], cellDeg = 0.1, hidden = [false, false, false], on = true;
  let body = new Float32Array(0), ember = new Float32Array(0), vis = [];
  let raf = 0, inView = true;
  const t0 = performance.now();

  // ---- is a point on the far side of the globe? ----
  const tr = map.transform;
  function occluded(lng, lat) {
    try { if (tr && typeof tr.isLocationOccluded === "function") return tr.isLocationOccluded({ lng, lat }); } catch (e) { /* fall through */ }
    const c = map.getCenter(), r = Math.PI / 180;
    const cosd = Math.sin(lat * r) * Math.sin(c.lat * r) + Math.cos(lat * r) * Math.cos(c.lat * r) * Math.cos((lng - c.lng) * r);
    return cosd < 0.15;
  }

  // ---- one frame: place every fireball on screen, then draw far ones first ----
  function frame(now) {
    raf = 0;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    gl.clearColor(0, 0, 0, 0);
    if (!on || !W || !H || !cells.length) { gl.clear(gl.COLOR_BUFFER_BIT); return; }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }

    // looking straight down, "up the screen" is north, so the balls stay squat; tilting the map raises them
    const pitchK = 0.7 + 0.3 * Math.sin(Math.min(map.getPitch(), 70) * Math.PI / 180) / Math.sin(70 * Math.PI / 180);
    vis.length = 0;
    for (const c of cells) {
      if (hidden[c.k] || occluded(c.lo, c.la)) continue;
      const p = map.project([c.lo, c.la]), q = map.project([c.lo + cellDeg, c.la]);
      const cellPx = Math.hypot(q.x - p.x, q.y - p.y);
      // heavier fire = bigger ball, and a little taller with more days
      const w = Math.min(Math.max(cellPx * [0.6, 0.78, 0.95][c.k], [9, 13, 18][c.k]), [130, 170, 210][c.k]);
      const h = w * (1.0 + Math.min(c.days, 20) * 0.025) * pitchK;
      if (p.x < -w * 1.3 || p.x > W + w * 1.3 || p.y < -h * 0.3 || p.y > H + h * 1.6) continue;
      c.ax = p.x; c.ay = p.y; c.w = w; c.h = h;
      vis.push(c);
    }
    vis.sort((a, b) => a.ay - b.ay);   // nearer balls (lower on screen) cover farther ones

    let nb = 0, ne = 0;
    for (const c of vis) {
      for (const [cx, cy] of CORNERS) {
        body[nb++] = c.ax; body[nb++] = c.ay; body[nb++] = c.w; body[nb++] = c.h;
        body[nb++] = cx; body[nb++] = cy; body[nb++] = c.k; body[nb++] = c.seed;
      }
      if (c.w < 16) continue;          // embers only once a ball is big enough to see them
      for (let j = 0; j < EMBERS[c.k]; j++) {
        ember[ne++] = c.ax; ember[ne++] = c.ay; ember[ne++] = c.w; ember[ne++] = c.h;
        ember[ne++] = rand(c.i, j) * 2 - 1; ember[ne++] = c.k; ember[ne++] = rand(j, c.i + 0.5); ember[ne++] = 0.35 + rand(c.i + 3, j) * 0.3;
      }
    }

    const time = reduced ? 0.9 : ((now - t0) / 1000) % 900;   // wrapped so the noise keeps its precision
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(pBody);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufBody); gl.bufferData(gl.ARRAY_BUFFER, body.subarray(0, nb), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(L.dyn); gl.vertexAttribPointer(L.dyn, 4, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(L.q); gl.vertexAttribPointer(L.q, 4, gl.FLOAT, false, 32, 16);
    gl.uniform1f(L.time, time); gl.uniform2f(L.view, W, H);
    gl.drawArrays(gl.TRIANGLES, 0, nb / 8);
    gl.disableVertexAttribArray(L.dyn); gl.disableVertexAttribArray(L.q);

    if (ne) {
      gl.useProgram(pEmber);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufEmber); gl.bufferData(gl.ARRAY_BUFFER, ember.subarray(0, ne), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(L.eDyn); gl.vertexAttribPointer(L.eDyn, 4, gl.FLOAT, false, 32, 0);
      gl.enableVertexAttribArray(L.e); gl.vertexAttribPointer(L.e, 4, gl.FLOAT, false, 32, 16);
      gl.uniform1f(L.eTime, time); gl.uniform2f(L.eView, W, H); gl.uniform1f(L.eDpr, dpr);
      gl.drawArrays(gl.POINTS, 0, ne / 8);
      gl.disableVertexAttribArray(L.eDyn); gl.disableVertexAttribArray(L.e);
    }

    if (!reduced && inView) raf = requestAnimationFrame(frame);
  }

  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
  // with reduced motion there is no loop: redraw a still frame whenever the map moves
  map.on("render", () => { if (reduced) kick(); });
  map.on("resize", kick);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((es) => { inView = es.some((e) => e.isIntersecting); if (inView) kick(); }).observe(canvas);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) kick(); });

  return {
    setCells(list, deg) {
      cellDeg = deg;
      cells = list.map(([lo, la, days], i) => ({ lo: lo + deg / 2, la: la + deg / 2, days, k: days >= 8 ? 2 : days >= 3 ? 1 : 0, i, seed: rand(lo, la) }));
      body = new Float32Array(cells.length * 6 * 8);
      ember = new Float32Array(cells.length * 8 * 8);
      kick();
    },
    setHidden(h) { hidden = h.slice(); kick(); },
    setVisible(v) { on = !!v; canvas.style.display = on ? "" : "none"; kick(); },
  };
}
