import {cloudBand, lineVertices, STRIDE} from './kinpeki-sea.js';
// Kinpeki: draws the sea of the screen (pigment ground, gold waves, gold-leaf clouds) into a canvas
// under the map. WebGL when the browser has it, else a plain 2D canvas with the same lines and clouds.
//
//   let sea = createSea(canvas)
//   sea.set(data)            the output of buildSea (once per world)
//   sea.draw(view, look)     view {k, x, y} as the page's (screen = x + k * X, y + k * Y),
//                            look: colours and the light, from the theme
//
// Costs: set() uploads the lines once (about 2 MB of vertices for a world); draw() is one call for
// the ground, one per level and tile of waves on screen, one per cloud on screen: 1-2 ms of CPU.
// The GPU side is one full-screen pass for the ground, about 55,000 line vertices and the clouds'
// quads.

const SEA_VS = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

// The ground: pigment laid in a deep wash, paler where it pools along the coasts, with a slow
// mottle and a fine grain, as mineral blue is when it is brushed on paper. At night, lacquer.
const SEA_FS = `
precision highp float;
uniform vec3 u_view;      // k, tx, ty (css px)
uniform vec2 u_size;      // css px
uniform float u_dpr;
uniform vec4 u_dom;       // x0, y0, side, span
uniform sampler2D u_near;
uniform sampler2D u_mot;  // the slow mottle of the wash, baked over the same square
uniform vec3 u_deep, u_shallow;
uniform float u_mottle, u_grain;
uniform vec3 u_fleck;     // gold dust colour (night): rgb; strength in u_flecks
uniform float u_flecks;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
void main() {
  vec2 css = vec2(gl_FragCoord.x, u_size.y * u_dpr - gl_FragCoord.y) / u_dpr;
  vec2 w = (css - u_view.yz) / u_view.x;
  vec2 uv = (w - u_dom.xy) / u_dom.z;
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  float d = mix(1.0, texture2D(u_near, uv).r, inside);
  float pool = (1.0 - d) * (1.0 - d);
  vec3 col = mix(u_deep, u_shallow, pool);
  float m = texture2D(u_mot, uv).r - 0.5;
  col *= 1.0 + u_mottle * m * inside;
  // grain: tied to the paper, at the size of a pigment crystal on screen
  float g = hash(floor(css * 1.0) + floor(u_view.yz)) - 0.5;
  col += u_grain * g;
  // gold dust, sparse, far from the coasts (nashiji on lacquer)
  if (u_flecks > 0.0) {
    vec2 wc = floor(w * u_view.x / 7.0);
    float h = hash(wc);
    if (h > 0.985) {
      vec2 c = (wc + 0.5 + (vec2(hash(wc + 3.1), hash(wc + 9.7)) - 0.5) * 0.6) * 7.0 / u_view.x;
      float r = length((w - c) * u_view.x);
      col = mix(col, u_fleck, u_flecks * smoothstep(1.1, 0.3, r) * smoothstep(0.1, 0.5, d));
    }
  }
  gl_FragColor = vec4(col, 1.0);
}`;

// The waves: each streamline a brush stroke of gold, tapered at both ends. Lines along the light
// catch it (gold leaf is brushed metal: its shine depends on the stroke's direction).
const LINE_VS = `
attribute vec2 a_pos;
attribute vec2 a_tan;
attribute vec2 a_sl;      // arc length, total length (world)
attribute vec2 a_aux;     // side (-1, 1), level + random / 2
attribute float a_near;   // distance to the nearest coast (world units)
uniform vec3 u_view;
uniform vec2 u_size;
uniform vec4 u_alpha, u_width, u_taper;
uniform vec4 u_dom;
uniform float u_gap;      // css px of clear water kept along the coast
varying float v_edge, v_w, v_a, v_shine;
varying vec2 v_tan;
void main() {
  float lev = floor(a_aux.y);
  float rnd = fract(a_aux.y) * 2.0;
  vec4 sel = vec4(1.0 - step(0.5, lev), step(0.5, lev) * (1.0 - step(1.5, lev)), step(1.5, lev) * (1.0 - step(2.5, lev)), step(2.5, lev));
  float alpha = dot(sel, u_alpha), wpx = dot(sel, u_width), tl = dot(sel, u_taper);
  float s = a_sl.x, L = a_sl.y;
  float T = min(tl, L * 0.5);
  float taper = smoothstep(0.0, T, s) * smoothstep(0.0, T, L - s);
  float w = wpx * mix(0.25, 1.0, taper) * (0.85 + 0.3 * rnd);
  vec2 scr = u_view.yz + u_view.x * a_pos;
  vec2 nrm = vec2(-a_tan.y, a_tan.x);
  float hw = max(w, 1.0) * 0.5 + 0.7;
  scr += nrm * a_aux.x * hw;
  // fade out near the coast (clear water there) and at the edge of the computed sea
  vec2 uv = (a_pos - u_dom.xy) / u_dom.z;
  float dpx = a_near * u_view.x;
  float edge = smoothstep(0.0, 0.04, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
  v_a = alpha * smoothstep(u_gap, u_gap * 2.2, dpx) * edge * min(w, 1.0) * (0.8 + 0.4 * rnd);
  v_edge = a_aux.x * hw;
  v_w = max(w, 1.0);
  v_tan = a_tan;
  v_shine = rnd;
  gl_Position = vec4(scr.x / u_size.x * 2.0 - 1.0, 1.0 - scr.y / u_size.y * 2.0, 0.0, 1.0);
}`;
const LINE_FS = `
precision mediump float;
uniform vec3 u_gold, u_goldHi;
uniform vec2 u_light;     // direction of the light along the screen
varying float v_edge, v_w, v_a, v_shine;
varying vec2 v_tan;
void main() {
  float cover = clamp(v_w * 0.5 + 0.5 - abs(v_edge), 0.0, 1.0);
  float sh = pow(abs(dot(normalize(v_tan), u_light)), 6.0);
  vec3 col = mix(u_gold, u_goldHi, sh * 0.85 + v_shine * 0.1);
  float a = cover * v_a;
  gl_FragColor = vec4(col * a, a);
}`;

// The clouds: freehand bands of gold leaf (see cloudBand in kinpeki-sea.js). The leaf is not laid
// in squares here: it is a slow crinkle, a few flakes of a lighter leaf scattered over it, and a
// dust of brighter gold; lighter towards the top of the cloud, warmer at its foot. A raised rim
// catches the light, a fine dark line outlines it and a second line follows the edge inside, as
// the painters outlined their clouds. Clouds fade out under the legend and the credit (u_hole).
const CLOUD_VS = `
attribute vec2 a_pos;
uniform vec3 u_view;
uniform vec2 u_size;
varying vec2 v_w;
void main() {
  v_w = a_pos;
  vec2 scr = u_view.yz + u_view.x * a_pos;
  gl_Position = vec4(scr.x / u_size.x * 2.0 - 1.0, 1.0 - scr.y / u_size.y * 2.0, 0.0, 1.0);
}`;
const CLOUD_FS = `
precision highp float;
uniform vec3 u_view;
uniform vec2 u_size;
uniform float u_dpr;
uniform vec4 u_band[3];    // xa, xb, y, t
uniform vec4 u_shape[3];   // amp, freq, phase, arc
uniform float u_nband;
uniform vec4 u_box;        // y0, y1, t, seed
uniform vec3 u_gold, u_goldHi, u_goldLo, u_line;
uniform vec3 u_lightPos;   // css px, radius
uniform float u_lit, u_shadow;
uniform vec4 u_hole[4];          // css px rects the clouds keep out of
uniform sampler2D u_leaf;        // crinkle (luminance) and flakes (alpha), tiling
varying vec2 v_w;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
// distance-like value to one band (world units; negative inside), its scallops on top
float band(vec2 p, vec4 b, vec4 s, float seed, float scallop) {
  float x = clamp(p.x, b.x, b.y);
  float u = (x - b.x) / b.w;
  float cy = b.z + s.x * b.w * sin(s.y * u + s.z);
  float th = b.w * (0.82 + 0.18 * sin(0.7 * s.y * u + 2.0 * s.z));
  float dx = max(b.x - p.x, 0.0) + max(p.x - b.y, 0.0);
  float dy = p.y - cy;
  float r = th;
  if (dy < 0.0 && scallop > 0.0) {
    float q = u / s.w;
    q += 0.22 * sin(q * 1.9 + s.z);
    float j = floor(q), v = fract(q);
    float hj = (0.38 + 0.32 * hash(vec2(j, seed))) * b.w;
    float fade = smoothstep(0.0, 0.6, u) * smoothstep(0.0, 0.6, (b.y - x) / b.w);
    r += hj * sqrt(max(0.0, 1.0 - (2.0 * v - 1.0) * (2.0 * v - 1.0))) * fade;
  }
  return length(vec2(dx, dy)) - r;
}
float cloud(vec2 p, float scallop) {
  float d = band(p, u_band[0], u_shape[0], u_box.w, scallop);
  if (u_nband > 1.5) d = smin(d, band(p, u_band[1], u_shape[1], u_box.w + 1.0, scallop), u_box.z * 0.06);
  if (u_nband > 2.5) d = smin(d, band(p, u_band[2], u_shape[2], u_box.w + 2.0, scallop), u_box.z * 0.06);
  return d;
}
float rectDist(vec2 c, vec4 r) {   // > 0 outside the rect, css px
  vec2 d = max(r.xy - c, c - r.zw);
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
void main() {
  float k = u_view.x, t = u_box.z;
  vec2 css = vec2(gl_FragCoord.x, u_size.y * u_dpr - gl_FragCoord.y) / u_dpr;
  float keep = clamp(min(min(rectDist(css, u_hole[0]), rectDist(css, u_hole[1])), min(rectDist(css, u_hole[2]), rectDist(css, u_hole[3]))) / 18.0, 0.0, 1.0);
  if (keep <= 0.0) discard;
  float d = cloud(v_w, 1.0);
  // beyond the reach of the shadow: nothing to draw (most of the quad)
  if (d > t * 1.25) discard;
  float px = d * k;                  // in css px, negative inside
  if (px > 1.2) {
    // a soft shadow on the sea under the cloud, as if it floated a little above the water
    float shadow = u_shadow * (1.0 - smoothstep(-t * 0.2, t * 0.9, cloud(v_w - vec2(0.0, t * 0.3), 0.0)));
    if (shadow < 0.004) discard;
    gl_FragColor = vec4(0.0, 0.0, 0.0, shadow * keep);
    return;
  }
  // (at the very edge the shadow is under the antialiased rim: taken as at its darkest)
  float shadow = u_shadow;
  // the leaf: lighter at the top of the cloud; its crinkle and scattered flakes from a baked tile
  float up = clamp((v_w.y - u_box.x) / (u_box.y - u_box.x), 0.0, 1.0);
  vec3 col = mix(mix(u_goldHi, u_gold, 0.62), mix(u_gold, u_goldLo, 0.3), up);
  vec2 leaf = texture2D(u_leaf, v_w / (t * 6.0) + u_box.w * 0.173).ra;
  col *= 0.94 + 0.12 * leaf.x;
  col = mix(col, u_goldHi, 0.12 * leaf.y);
  // sunago: a sparse dust of brighter gold, round specks held to the cloud (not to the screen)
  vec2 sp = (css - u_view.yz) / 5.0, sc = floor(sp);
  vec2 so = vec2(hash(sc + 3.3), hash(sc + 7.7));
  float dust = step(0.9, hash(sc)) * (1.0 - smoothstep(0.06, 0.16, length(fract(sp) - so)));
  col = mix(col, u_goldHi * 1.06, 0.45 * dust);
  // broad sheen across the screen, and the pointer's light when there is one
  float sheen = 0.5 + 0.5 * sin((css.x * 0.7 + css.y) / max(u_size.x, u_size.y) * 5.0 + 0.6);
  float lamp = u_lit * exp(-pow(length(css - u_lightPos.xy) / u_lightPos.z, 2.0));
  col = mix(col, u_goldHi, 0.14 * sheen + 0.45 * lamp);
  // raised rim, the inner line, the outline
  float rim = smoothstep(-3.0, -1.8, px) * (1.0 - smoothstep(-1.5, -0.7, px));
  col = mix(col, u_goldHi, 0.55 * rim);
  float inset = clamp(t * k * 0.3, 3.0, 9.0);
  col = mix(col, u_goldLo, 0.38 * (1.0 - smoothstep(0.2, 0.75, abs(px + inset))));
  col = mix(col, u_line, 0.85 * (1.0 - smoothstep(0.0, 0.8, abs(px + 0.15))));
  float a = 1.0 - smoothstep(0.1, 1.0, px);
  a *= keep;
  float sa = shadow * keep * (1.0 - a);
  gl_FragColor = vec4(col * a, a + sa);
}`;

// The gold leaf's tile: a slow crinkle (two octaves of periodic value noise) in the luminance, and
// a few cut flakes of a lighter leaf, square-ish and turned every way, in the alpha. It tiles.
function leafTile(N) {
  let out = new Uint8Array(N * N * 2);
  let seed = 9;
  let rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let lattice = P => { let g = new Float32Array(P * P); for (let i = 0; i < g.length; ++i) g[i] = rand(); return g; };
  let noise = (g, P, x, y) => {   // periodic, x and y in lattice units
    let ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    let sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    let at = (i, j) => g[((j % P) + P) % P * P + ((i % P) + P) % P];
    return (at(ix, iy) * (1 - sx) + at(ix + 1, iy) * sx) * (1 - sy) + (at(ix, iy + 1) * (1 - sx) + at(ix + 1, iy + 1) * sx) * sy;
  };
  let g1 = lattice(4), g2 = lattice(16);
  let flakes = [];
  for (let i = 0; i < 9; ++i) flakes.push({x: rand() * N, y: rand() * N, s: N * (0.06 + rand() * 0.06), a: rand() * Math.PI, sq: 0.7 + rand() * 0.6});
  for (let y = 0; y < N; ++y) for (let x = 0; x < N; ++x) {
    let v = 0.6 * noise(g1, 4, x / N * 4, y / N * 4) + 0.4 * noise(g2, 16, x / N * 16, y / N * 16);
    let f = 0;
    for (let fl of flakes) {
      // nearest copy of the flake on the torus
      let dx = ((x - fl.x + N * 1.5) % N) - N / 2, dy = ((y - fl.y + N * 1.5) % N) - N / 2;
      let c = Math.cos(fl.a), sn = Math.sin(fl.a);
      let u = Math.abs(dx * c - dy * sn), w = Math.abs(dx * sn + dy * c) * fl.sq;
      let e = Math.max(u, w) - fl.s;
      f = Math.max(f, Math.min(1, Math.max(0, 0.5 - e)));
    }
    out[2 * (y * N + x)] = Math.round(255 * Math.max(0, Math.min(1, v)));
    out[2 * (y * N + x) + 1] = Math.round(255 * f);
  }
  return out;
}

function compile(gl, vs, fs) {
  let p = gl.createProgram();
  for (let [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    let s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  let u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; ++i) { let name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
  let a = {}, m = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < m; ++i) { let name = gl.getActiveAttrib(p, i).name; a[name] = gl.getAttribLocation(p, name); }
  return {p, u, a};
}


// Stop watching a canvas that is going away
function releaseCanvas(canvas) {
  let s = sizes.get(canvas);
  if (s && s.ro) s.ro.disconnect();
  sizes.delete(canvas);
}
export function createSea(canvas) {
  let gl = null;
  try {
    gl = canvas.getContext('webgl', {alpha: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false});
  } catch (e) { gl = null; }
  return gl ? glSea(canvas, gl) : flatSea(canvas);
}

// The canvas's size in CSS px, noted when it changes: asking for it during a redraw would make the
// browser lay out the page there and then
const sizes = new WeakMap();
function cssSize(canvas) {
  let s = sizes.get(canvas);
  if (!s) {
    s = {w: innerWidth, h: innerHeight};
    sizes.set(canvas, s);
    if (window.ResizeObserver) {
      s.ro = new ResizeObserver(entries => {
        let r = entries[entries.length - 1].contentRect;
        s.w = r.width; s.h = r.height;
      });
      s.ro.observe(canvas);
    }
  }
  return s;
}
function sizeCanvas(canvas, maxDpr) {
  let dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  let {w, h} = cssSize(canvas);
  let W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  return {w, h, dpr: W / Math.max(1, w)};
}

// A GPU that is really the CPU (SwiftShader, llvmpipe, Microsoft's Basic Render Driver): every
// pixel of the sea is then computed on the processor, so the canvas is drawn at one pixel per CSS
// pixel there. A real GPU draws it at up to twice that.
function softwareRenderer(gl) {
  try {
    let e = gl.getExtension('WEBGL_debug_renderer_info');
    let name = String(e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return /swiftshader|llvmpipe|softpipe|basic render|software/i.test(name);
  } catch (err) { return false; }
}
function glSea(canvas, gl) {
  const software = softwareRenderer(gl);
  let sea = compile(gl, SEA_VS, SEA_FS), line = compile(gl, LINE_VS, LINE_FS), cloud = compile(gl, CLOUD_VS, CLOUD_FS);
  let quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  let lines = gl.createBuffer(), fineLines = gl.createBuffer(), clouds = gl.createBuffer();
  let tex = gl.createTexture(), motTex = gl.createTexture(), leafTex = gl.createTexture();
  {
    let N = 64, data = leafTile.cache || (leafTile.cache = leafTile(N));
    gl.bindTexture(gl.TEXTURE_2D, leafTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE_ALPHA, N, N, 0, gl.LUMINANCE_ALPHA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  }
  let data = null, groups = [], cloudList = [];
  let api = {
    kind: software ? 'webgl (software: 1x)' : 'webgl',
    dispose() {
      releaseCanvas(canvas);
      let lose = gl.getExtension('WEBGL_lose_context');   // give the GPU its memory back now
      if (lose) lose.loseContext();
    },
    set(d) {
      data = d;
      if (!d) return;
      // The vertices come made by the worker, with the sea (the finest waves in a second block)
      if (!d.vertices) d.vertices = lineVertices(d.strokes, d.grid, d.domain);
      groups = [];
      for (let [buffer, block] of [[lines, d.vertices], [fineLines, d.fineVertices]]) {
        if (!block) continue;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, block.v, gl.STATIC_DRAW);
        for (let gr of block.groups) groups.push({...gr, buffer});
      }
      let texture = (t, size, bytes) => {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, size, size, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, bytes);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      };
      texture(tex, d.grid.n, d.grid.near);
      texture(motTex, d.grid.mn, d.grid.mottle);
      // clouds: a quad round each (with room for the outline)
      let cv = [];
      cloudList = d.clouds.map((c, i) => {
        let m = c.t * 1.3;   // room for the outline and the shadow
        let x0 = c.x0 - m, x1 = c.x1 + m, y0 = c.y0 - m, y1 = c.y1 + m;
        cv.push(x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1);
        let bands = new Float32Array(12), shapes = new Float32Array(12);
        c.bands.forEach((b, j) => { bands.set([b.xa, b.xb, b.y, b.t], j * 4); shapes.set([b.amp, b.freq, b.phase, b.arc], j * 4); });
        return {c, first: i * 6, bands, shapes, box: [c.y0, c.y1, c.t, i * 7.31 + 1.7]};
      });
      gl.bindBuffer(gl.ARRAY_BUFFER, clouds);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cv), gl.STATIC_DRAW);
    },
    draw(view, look) {
      let {w, h, dpr} = sizeCanvas(canvas, software ? look.softwareDpr || 1 : look.maxDpr || 2);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.DEPTH_TEST);
      let deep = look.deep, shallow = look.shallow;
      if (!data) {
        gl.clearColor(deep[0], deep[1], deep[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return;
      }
      let dom = [data.domain.x0, data.domain.y0, data.domain.side, data.domain.span];
      // ground
      gl.useProgram(sea.p);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(sea.a.a_pos);
      gl.vertexAttribPointer(sea.a.a_pos, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(sea.u.u_near, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, motTex);
      gl.uniform1i(sea.u.u_mot, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform3f(sea.u.u_view, view.k, view.x, view.y);
      gl.uniform2f(sea.u.u_size, w, h);
      gl.uniform1f(sea.u.u_dpr, dpr);
      gl.uniform4f(sea.u.u_dom, ...dom);
      gl.uniform3f(sea.u.u_deep, ...deep);
      gl.uniform3f(sea.u.u_shallow, ...shallow);
      gl.uniform1f(sea.u.u_mottle, look.mottle);
      gl.uniform1f(sea.u.u_grain, look.grain);
      gl.uniform3f(sea.u.u_fleck, ...look.gold);
      gl.uniform1f(sea.u.u_flecks, look.flecks || 0);
      gl.disable(gl.BLEND);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disableVertexAttribArray(sea.a.a_pos);
      // waves
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(line.p);
      let A = line.a, stride = STRIDE * 4, bound = null;
      let bind = buffer => {
        if (buffer === bound) return;
        bound = buffer;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.vertexAttribPointer(A.a_pos, 2, gl.FLOAT, false, stride, 0);
        gl.vertexAttribPointer(A.a_tan, 2, gl.FLOAT, false, stride, 8);
        gl.vertexAttribPointer(A.a_sl, 2, gl.FLOAT, false, stride, 16);
        gl.vertexAttribPointer(A.a_aux, 2, gl.FLOAT, false, stride, 24);
        gl.vertexAttribPointer(A.a_near, 1, gl.FLOAT, false, stride, 32);
      };
      for (let k in A) gl.enableVertexAttribArray(A[k]);
      gl.uniform3f(line.u.u_view, view.k, view.x, view.y);
      gl.uniform2f(line.u.u_size, w, h);
      gl.uniform4f(line.u.u_dom, ...dom);
      let lv = levels(data.levels, view.k, look);
      gl.uniform4f(line.u.u_alpha, ...lv.alpha);
      gl.uniform4f(line.u.u_width, ...lv.width);
      gl.uniform4f(line.u.u_taper, ...[0, 1, 2, 3].map(i => (data.levels[i] || 1) * 2.5));
      gl.uniform1f(line.u.u_gap, look.gap);
      gl.uniform3f(line.u.u_gold, ...look.wave);
      gl.uniform3f(line.u.u_goldHi, ...look.waveHi);
      gl.uniform2f(line.u.u_light, ...look.lightDir);
      // only the levels that show at this zoom, and only the tiles on screen
      let vx0 = -view.x / view.k, vy0 = -view.y / view.k, vx1 = (w - view.x) / view.k, vy1 = (h - view.y) / view.k;
      for (let gr of groups) {
        if (lv.alpha[gr.level] < 0.01) continue;
        if (gr.x1 < vx0 || gr.x0 > vx1 || gr.y1 < vy0 || gr.y0 > vy1) continue;
        bind(gr.buffer);
        gl.drawArrays(gl.TRIANGLE_STRIP, gr.first, gr.count);
      }
      for (let k in A) gl.disableVertexAttribArray(A[k]);
      // clouds
      gl.useProgram(cloud.p);
      gl.bindBuffer(gl.ARRAY_BUFFER, clouds);
      gl.enableVertexAttribArray(cloud.a.a_pos);
      gl.vertexAttribPointer(cloud.a.a_pos, 2, gl.FLOAT, false, 0, 0);
      let U = cloud.u;
      gl.uniform3f(U.u_view, view.k, view.x, view.y);
      gl.uniform2f(U.u_size, w, h);
      gl.uniform1f(U.u_dpr, dpr);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, leafTex);
      gl.uniform1i(U.u_leaf, 2);
      gl.activeTexture(gl.TEXTURE0);
      let holes = look.holes || [];
      let holeArr = new Float32Array(16).fill(-9);
      holes.slice(0, 4).forEach((h, i) => holeArr.set(h, i * 4));
      gl.uniform4fv(U['u_hole[0]'], holeArr);
      gl.uniform3f(U.u_gold, ...look.gold);
      gl.uniform3f(U.u_goldHi, ...look.goldHi);
      gl.uniform3f(U.u_goldLo, ...look.goldLo);
      gl.uniform3f(U.u_line, ...look.cloudLine);
      gl.uniform3f(U.u_lightPos, ...(look.lamp || [0, 0, 1]));
      gl.uniform1f(U.u_lit, look.lamp ? 1 : 0);
      gl.uniform1f(U.u_shadow, look.cloudShadow || 0);
      for (let {c, first, bands, shapes, box} of cloudList) {
        let m = c.t * 1.6;
        if (c.x1 + m < vx0 || c.x0 - m > vx1 || c.y1 + m < vy0 || c.y0 - m > vy1) continue;
        gl.uniform4fv(U['u_band[0]'], bands);
        gl.uniform4fv(U['u_shape[0]'], shapes);
        gl.uniform1f(U.u_nband, c.bands.length);
        gl.uniform4f(U.u_box, ...box);
        gl.drawArrays(gl.TRIANGLES, first, 6);
      }
      gl.disableVertexAttribArray(cloud.a.a_pos);
    },
  };
  return api;
}

// How each level of waves shows at zoom k: a level fades in once its lines are far enough apart
// on screen to read as lines, not as a tint
function levels(dseps, k, look) {
  let alpha = [], width = [];
  // the broad waves a little heavier than the fine ones between them
  const WEIGHT = [1.25, 1.1, 0.95, 0.85];
  dseps.forEach((d, i) => {
    let px = d * k;
    // a level comes in once its lines are 9 px apart, fully at 15: the sea never gets denser than
    // that, so the waves stay strokes and never turn into a hatching
    let a = i === 0 ? Math.max(0.35, Math.min(1, (px - 3) / 6)) : Math.max(0, Math.min(1, (px - 9) / 6));
    alpha.push(a * look.waveAlpha[Math.min(i, look.waveAlpha.length - 1)]);
    width.push(Math.max(0.9, Math.min(look.waveMax * WEIGHT[i], px * 0.08)));
  });
  while (alpha.length < 4) { alpha.push(0); width.push(1); }
  return {alpha, width};
}

// Without WebGL: the same sea, flat, drawn with the 2D canvas
function flatSea(canvas) {
  let ctx = canvas.getContext('2d');
  let data = null;
  let css = c => `rgb(${c.map(v => Math.round(v * 255)).join(',')})`;
  return {
    kind: '2d',
    dispose() { releaseCanvas(canvas); },
    set(d) { data = d; },
    draw(view, look) {
      if (!ctx) return;
      let {w, h, dpr} = sizeCanvas(canvas, look.maxDpr || 2);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = css(look.deep);
      ctx.fillRect(0, 0, w, h);
      if (!data) return;
      ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);
      let lv = levels(data.levels, view.k, look);
      ctx.lineCap = 'round';
      ctx.strokeStyle = css(look.wave);
      let x0 = -view.x / view.k, y0 = -view.y / view.k, x1 = (w - view.x) / view.k, y1 = (h - view.y) / view.k;
      for (let level = 0; level < 4; ++level) {
        if (lv.alpha[level] < 0.02) continue;
        ctx.globalAlpha = lv.alpha[level];
        ctx.lineWidth = lv.width[level] / view.k;
        ctx.beginPath();
        for (let s of data.strokes) {
          if (s.level !== level) continue;
          let xy = s.xy;
          ctx.moveTo(xy[0], xy[1]);
          for (let i = 2; i < xy.length; i += 2) ctx.lineTo(xy[i], xy[i + 1]);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = css(look.gold);
      ctx.strokeStyle = css(look.cloudLine);
      ctx.lineWidth = 1 / view.k;
      for (let c of data.clouds) {
        if (c.x1 < x0 || c.x0 > x1 || c.y1 < y0 || c.y0 > y1) continue;
        ctx.beginPath();
        for (let b of c.bands) {
          // the band's outline: top edge left to right, round head, foot right to left, round head
          let n = 48, top = [], foot = [];
          for (let i = 0; i <= n; ++i) {
            let x = b.xa + (b.xb - b.xa) * i / n, {cy, th} = cloudBand(b, x);
            top.push([x, cy - th]); foot.push([x, cy + th]);
          }
          ctx.moveTo(top[0][0], top[0][1]);
          for (let [x, y] of top) ctx.lineTo(x, y);
          let e = cloudBand(b, b.xb);
          ctx.arc(b.xb, e.cy, e.th, -Math.PI / 2, Math.PI / 2);
          for (let i = foot.length - 1; i >= 0; --i) ctx.lineTo(foot[i][0], foot[i][1]);
          let f = cloudBand(b, b.xa);
          ctx.arc(b.xa, f.cy, f.th, Math.PI / 2, Math.PI * 1.5);
          ctx.closePath();
        }
        ctx.fill('nonzero');
      }
    },
  };
}
