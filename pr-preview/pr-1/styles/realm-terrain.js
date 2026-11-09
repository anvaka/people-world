// The painted land and sea of the `realm` style: one WebGL2 canvas under the map's SVG, inside #plate,
// so a gesture moves it with the SVG as one picture; it is painted again when the view rests.
//
// What is made once per world (CPU, a fraction of a second):
//   fields  a grid over the world: distance inland from the coast, distance out to sea, the land
//           blurred (the shelf: wide shallows off big land, almost none round a tiny island) and
//           mountain belts along some borders (as the Pyrenees or the Andes follow theirs)
//   meshes  every country triangulated (earcut: exactly the SVG's land), and every border and coast
//           as segments, per level of detail
// What is painted per view (GPU), in four draws whatever the number of countries:
//   ids     which country each pixel belongs to (and so the land), exact to the pixel
//   edges   the distance in pixels to the nearest border inside each country (a border's segments
//           are drawn round it, and each pixel keeps them only if it lies in one of the border's two
//           countries) and to the nearest coast on both sides (MAX blending)
//   paint   one full-screen pass: height from the fields and a derivative-damped fBm (IQ's
//           "erosion-like" noise; octaves follow the zoom, so relief keeps its grain at any scale),
//           Whittaker biomes from temperature and moisture, NW light with warm lit slopes and cool
//           shadows (Imhof), snow, rock, forest canopies, beaches and cliffs; water by depth with
//           a foam edge; the countries' colours as a band inside each border (as strategy games do)
// All noise is hashed from the world's number and positions on the map: the same world always
// looks the same, and an edit changes only what it moves.

const MAX_PR = 2;             // canvas pixels per CSS pixel, at most (see 'resolution' below)
const MAX_OCT = 12;
const MACRO = [3, 6, 12, 24, 48];   // noise octaves that shape the land (cycles across the world)
// octave amplitudes fall as f^-1.25: the big forms carry the relief, the finer octaves only grain it.
// Their slopes are divided by their expected size at the zoom, so the relief's grain shades with the
// same strength at every scale: a painter's contrast, not a physical one.
const AMP_EXP = 1.15;


// ------------------------------------------------------------------------------------------------
// Shaders
const ID_VS = `#version 300 es
in vec2 a_pos; in float a_id;
uniform vec2 u_scale, u_off;
flat out float v_id;
void main() { v_id = a_id; gl_Position = vec4(a_pos * u_scale + u_off, 0.0, 1.0); }`;
const ID_FS = `#version 300 es
precision highp float;
flat in float v_id; out vec4 o;
void main() { o = vec4((v_id + 1.0) / 255.0, 0.0, 0.0, 1.0); }`;
// a segment of a border or coast: a quad round it, and in each pixel the exact distance to it, so the
// union of segments (MAX blending) is a distance field with round joins and no mitre spikes
const SEG_VS = `#version 300 es
in vec2 a_corner; in vec2 a_a; in vec2 a_b; in float a_size; in float a_ca; in float a_cb;
uniform vec2 u_scale, u_off; uniform float u_hw, u_kpr, u_sizeFrac;
out vec2 v_p; flat out vec2 v_a, v_b; flat out float v_hw, v_ca, v_cb;
uniform int u_mode;
flat out float v_fade;
void main() {
  float hw = min(u_hw, a_size * u_kpr * u_sizeFrac) / u_kpr;
  v_fade = 1.0;
  if (u_mode == 2) { float px = a_size * u_kpr; v_fade = clamp(px / 0.9, 0.0, 1.0); hw = min(u_hw, max(px, 0.9)) / u_kpr; }
  vec2 d = a_b - a_a; float l = length(d);
  vec2 t = l > 0.0 ? d / l : vec2(1.0, 0.0), n = vec2(-t.y, t.x);
  vec2 p = mix(a_a, a_b, a_corner.x) + t * (a_corner.x * 2.0 - 1.0) * hw + n * a_corner.y * hw;
  v_p = p; v_a = a_a; v_b = a_b; v_hw = hw; v_ca = a_ca; v_cb = a_cb;
  gl_Position = vec4(p * u_scale + u_off, 0.0, 1.0);
}`;
const SEG_FS = `#version 300 es
precision highp float; precision highp int;
uniform vec4 u_color; uniform int u_mode; uniform sampler2D u_ids;
in vec2 v_p; flat in vec2 v_a, v_b; flat in float v_hw, v_ca, v_cb, v_fade; out vec4 o;
void main() {
  if (u_mode == 1) {   // a border: only inside its two countries
    float id = floor(texelFetch(u_ids, ivec2(gl_FragCoord.xy), 0).r * 255.0 + 0.5) - 1.0;
    if (id != v_ca && id != v_cb) discard;
  }
  vec2 pa = v_p - v_a, ba = v_b - v_a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-30), 0.0, 1.0);
  o = u_color * clamp(1.0 - length(pa - ba * h) / v_hw, 0.0, 1.0) * v_fade;
}`;

// a cached tile drawn into the view
const COMP_VS = `#version 300 es
in vec2 a_pos;
uniform vec4 u_rect, u_uv; uniform vec2 u_canvas;
out vec2 v_uv;
void main() {
  vec2 css = u_rect.xy + a_pos * u_rect.zw;
  v_uv = mix(u_uv.xy, u_uv.zw, a_pos);
  gl_Position = vec4(css.x / u_canvas.x * 2.0 - 1.0, 1.0 - css.y / u_canvas.y * 2.0, 0.0, 1.0);
}`;
const COMP_FS = `#version 300 es
precision highp float;
uniform sampler2D u_tile; in vec2 v_uv; out vec4 o;
void main() { o = texture(u_tile, v_uv); }`;

const PAINT_VS = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const PAINT_FS = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D u_edges, u_fields, u_lut, u_ids, u_codes, u_fields2;
uniform vec2 u_res, u_center, u_P0, u_fieldA, u_fieldB, u_fieldN, u_lat;
uniform float u_pr, u_invK, u_kpr, u_bandPx, u_foamPx, u_night, u_formW, u_gradNorm;
uniform vec2 u_oct[${MAX_OCT}], u_rot[${MAX_OCT}]; uniform float u_freq[${MAX_OCT}], u_amp[${MAX_OCT}], u_shadeW[${MAX_OCT}];
uniform int u_nOct;
uniform vec3 u_pal[8];
uniform uvec2 u_seed;
uniform vec3 u_crown;      // crown cells: offset (mod 256) and cells per unit
uniform vec3 u_lights;     // night lights: the same
uniform vec3 u_ripple;     // sea surface grain: the same
out vec4 o;

uint hsh(ivec2 c, int s) {
  uvec2 q = uvec2((c + ivec2(s * 57, s * 113)) & 255) + u_seed;
  q *= uvec2(1597334677u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334677u;
  return n ^ (n >> 16);
}
float h1(ivec2 c, int s) { return float(hsh(c, s) >> 8) * (1.0 / 16777216.0); }
// value noise with its derivative (quintic): x in lattice units, returns (value 0..1, d/dx, d/dy)
vec3 noised(vec2 x, int s) {
  vec2 i = floor(x), f = x - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  ivec2 c = ivec2(i);
  float a = h1(c, s), b = h1(c + ivec2(1, 0), s), cc = h1(c + ivec2(0, 1), s), d = h1(c + ivec2(1, 1), s);
  float k1 = b - a, k2 = cc - a, k4 = a - b - cc + d;
  return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * (vec2(k1, k2) + k4 * u.yx));
}
// noise on octave i's turned lattice, offset by o: (value, d/dPx, d/dPy) in map units
vec3 noiseAt(int i, vec2 local, vec2 o, int s) {
  vec2 cs = u_rot[i], lp = local * u_freq[i];
  vec3 n = noised(u_oct[i] + o + vec2(cs.x * lp.x - cs.y * lp.y, cs.y * lp.x + cs.x * lp.y), s);
  return vec3(n.x, vec2(cs.x * n.y + cs.y * n.z, -cs.y * n.y + cs.x * n.z) * u_freq[i]);
}
// bicubic B-spline sample from four bilinear ones: the fields stay smooth (and so does their
// shading) however far the map is zoomed in
vec4 cubic(sampler2D t, vec2 uv) {
  vec2 p = uv * u_fieldN - 0.5, fp = fract(p), ip = p - fp;
  vec2 w0 = (1.0 - fp) * (1.0 - fp) * (1.0 - fp) / 6.0;
  vec2 w1 = (4.0 - 6.0 * fp * fp + 3.0 * fp * fp * fp) / 6.0;
  vec2 w2 = (1.0 + 3.0 * fp + 3.0 * fp * fp - 3.0 * fp * fp * fp) / 6.0;
  vec2 w3 = fp * fp * fp / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (ip + 0.5 - 1.0 + w1 / g0) / u_fieldN, h1 = (ip + 0.5 + 1.0 + w3 / g1) / u_fieldN;
  return g0.y * (g0.x * texture(t, h0) + g1.x * texture(t, vec2(h1.x, h0.y)))
       + g1.y * (g0.x * texture(t, vec2(h0.x, h1.y)) + g1.x * texture(t, h1));
}
// dual numbers (value, d/dPx, d/dPy)
vec3 dmul(vec3 a, vec3 b) { return vec3(a.x * b.x, a.x * b.yz + b.x * a.yz); }
vec3 dsmooth(float e0, float e1, vec3 x) {
  float t = clamp((x.x - e0) / (e1 - e0), 0.0, 1.0);
  return vec3(t * t * (3.0 - 2.0 * t), (6.0 * t * (1.0 - t) / (e1 - e0)) * x.yz);
}
float lum(vec3 c) { return dot(c, vec3(0.3, 0.55, 0.15)); }

// a cell of round crowns (trees) or points (lights) near q: returns (distance to the nearest
// in its own radius, offset from its centre), only cells whose hash passes 'keep'
vec4 cells(vec2 q, float keep, int s) {
  vec2 i = floor(q), f = q - i;
  ivec2 c = ivec2(i);
  vec4 best = vec4(9.0, 0.0, 0.0, 0.0);
  for (int y = -1; y <= 1; ++y) for (int x = -1; x <= 1; ++x) {
    ivec2 cc = c + ivec2(x, y);
    float h = h1(cc, s);
    if (h > keep) continue;
    vec2 pt = vec2(h1(cc, s + 1), h1(cc, s + 2)) * 0.7 + 0.15;
    float r = 0.36 + 0.46 * h1(cc, s + 3);
    vec2 v = (f - vec2(x, y) - pt) / r;
    float d = length(v);
    if (d < best.x) best = vec4(d, v, h1(cc, s + 4));
  }
  return best;
}

void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  vec4 E = texelFetch(u_edges, fc, 0), I = texelFetch(u_ids, fc, 0);
  bool land = I.a > 0.5;
  vec2 css = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y) / u_pr;
  vec2 local = (css - u_center) * u_invK;
  vec2 P = u_P0 + local;
  vec3 L = normalize(vec3(-0.62, -0.78, 0.95));   // the light: from the north-west, as on every relief map

  vec2 uv = P * u_fieldA + u_fieldB;
  vec4 F = cubic(u_fields, uv);
  if (!land) {
    // ---- water: bright shallows over the shelf, dark deeps, a foam edge at the coast. The sea is
    // most of the picture: it is painted with a handful of noise lookups, the land with the rest
    float dOut = F.g, shelf = F.b;
    float v1 = noiseAt(2, local, vec2(0.0), 2).x - 0.5, v2 = noiseAt(3, local, vec2(0.0), 3).x - 0.5;
    float shallow = smoothstep(-0.04, 0.62, shelf + 0.08 * (v1 + 0.5 * v2));
    float deep = smoothstep(0.0, 1.0, dOut);
    vec3 cDeep = vec3(0.1, 0.27, 0.45), cMid = vec3(0.16, 0.42, 0.6), cShallow = vec3(0.35, 0.68, 0.72);
    vec3 w = mix(cMid, cDeep, deep);
    w = mix(w, cShallow, shallow * shallow);
    w *= 1.0 + 0.1 * (v1 + 0.5 * v2);                          // currents and deeps
    vec3 rp = noised(u_ripple.xy + local * u_ripple.z * vec2(1.0, 3.2), 30);
    w *= 0.985 + 0.03 * rp.x;                                  // a faint surface grain
    if (E.g > 0.0) {
      float d = (1.0 - E.g) * u_foamPx / u_pr;
      float glow = exp(-d / 5.0);
      w = mix(w, vec3(0.55, 0.85, 0.82), glow * 0.35);
      float brk = smoothstep(0.42, 0.62, noised(u_ripple.xy + local * u_ripple.z * 0.5, 31).x);
      float surf = exp(-pow((d - 4.2) / 0.8, 2.0)) * brk * 0.45;
      float edge = 1.0 - smoothstep(0.7, 1.9, d);
      w = mix(w, vec3(0.93, 0.98, 0.97), max(edge * 0.85, surf));
    }
    w *= 1.06 - 0.16 * smoothstep(0.0, 0.9, length(P - vec2(-0.35, -0.3)));
    if (u_night > 0.5) w = w * vec3(0.32, 0.4, 0.55) + vec3(0.0, 0.01, 0.03);
    o = vec4(w + (h1(fc, 90) - 0.5) / 255.0, 1.0);
    return;
  }

  // ---- the land. The fields, smooth, with their slopes
  vec2 tx = 1.0 / u_fieldN;
  vec4 Fx = cubic(u_fields, uv + vec2(tx.x, 0.0)), Fy = cubic(u_fields, uv + vec2(0.0, tx.y));
  vec2 stp = tx / u_fieldA;
  vec4 Gx = (Fx - F) / stp.x, Gy = (Fy - F) / stp.y;
  vec3 dIn = vec3(F.r, Gx.r, Gy.r), belt = vec3(F.a, Gx.a, Gy.a);

  // which country, its colour slot and state, and its size
  int idx = int(I.r * 255.0 + 0.5) - 1;
  vec4 C = texelFetch(u_codes, ivec2(max(idx, 0), 0), 0);
  int code = int(C.r * 255.0 + 0.5) - 1;
  int slot = code & 7, state = code >> 3;
  float csize = C.g;          // the country's width, 1 at 8% of the world's
  float bdist = texture(u_fields2, uv).r * 16.0;   // cells to the nearest border

  // ---- noise: smooth and ridged sums over the octaves the zoom needs
  vec3 sm = vec3(0.0), rg = vec3(0.0), low = vec3(0.0), macroS = vec3(0.0), macroR = vec3(0.0);
  vec2 acc = vec2(0.0);
  for (int i = 0; i < ${MAX_OCT}; ++i) {
    if (i >= u_nOct) break;
    float f = u_freq[i], a = u_amp[i];
    // each octave on its own turned lattice: no octave's grid lines up with another's
    vec2 cs = u_rot[i], lp = local * f;
    vec3 n = noised(u_oct[i] + vec2(cs.x * lp.x - cs.y * lp.y, cs.y * lp.x + cs.x * lp.y), i);
    float v = n.x * 2.0 - 1.0; vec2 g = vec2(cs.x * n.y + cs.y * n.z, -cs.y * n.y + cs.x * n.z) * 2.0 * f;
    float r = 1.0 - abs(v); vec2 gr = -sign(v) * g;
    float r2 = r * r; vec2 gr2 = 2.0 * r * gr;
    acc += gr2 * a;
    float damp = 1.0 / (1.0 + 0.012 * dot(acc, acc));
    // forms far larger than the screen only tilt it: they keep their height, not their shading
    float sw = u_shadeW[i];
    sm += a * vec3(v, g * sw);
    rg += a * damp * vec3(r2, gr2 * sw);
    if (i == 1) low = sm;
    if (i == 4) { macroS = sm; macroR = rg; }
  }
  if (u_nOct < 5) { macroS = sm; macroR = rg; }
  // moisture and warmth: two more low octaves, hashed apart
  vec3 m1 = noiseAt(0, local, vec2(17.3, 41.9), 21);
  vec3 m2 = noiseAt(1, local, vec2(5.1, 77.2), 22);
  vec3 m3 = noiseAt(2, local, vec2(9.7, 23.4), 23);
  float wet = (m1.x - 0.5) * 1.2 + (m2.x - 0.5) * 0.7 + (m3.x - 0.5) * 0.5;

  // ---- height. Mountains are tents: a sharp crest along chains (where a low noise crosses its
  // middle, broken up by another) and along some borders (as the Pyrenees follow theirs), roughened
  // by the ridged noise. A tent's own flanks shade only while they are narrow on screen; closer in
  // the ridged detail carries the relief. Hills are a mask on the smooth noise.
  vec3 rise = dsmooth(0.0, 0.6, dIn);
  vec3 c1 = noiseAt(1, local, vec2(31.7, 3.3), 24);
  vec3 c2 = noiseAt(2, local, vec2(2.9, 57.1), 25);
  vec3 cv = vec3(c1.x * 2.0 - 1.0, c1.yz * 2.0) + 0.35 * vec3(c2.x * 2.0 - 1.0, c2.yz * 2.0);
  // a rounded crest (no straight knife edge), broken along its length into peaks and saddles
  vec3 q = cv / 0.17;
  vec3 chain = vec3(max(0.0, 1.0 - q.x * q.x), -2.0 * q.x * q.yz);
  if (chain.x <= 0.0) chain = vec3(0.0);
  chain = dmul(chain, chain);
  vec3 peaks = noiseAt(3, local, vec2(44.1, 7.7), 27);
  chain = dmul(chain, dsmooth(0.25, 0.7, peaks) * 0.6 + vec3(0.4, 0.0, 0.0));
  chain = dmul(chain, dsmooth(0.36, 0.56, m1));
  // smaller ranges in the hill country
  vec3 c3 = noiseAt(2, local, vec2(61.3, 12.9), 26);
  vec3 cw = vec3(c3.x * 2.0 - 1.0, c3.yz * 2.0);
  vec3 q2 = cw / 0.22;
  vec3 chain2 = vec3(max(0.0, 1.0 - q2.x * q2.x), -2.0 * q2.x * q2.yz);
  if (chain2.x <= 0.0) chain2 = vec3(0.0);
  chain2 = dmul(chain2, chain2);
  chain2 = dmul(chain2, dsmooth(0.5, 0.7, m2)) * 0.7;
  if (chain2.x > chain.x) chain = chain2;
  // a chain stops short of a border: it never runs across one (ranges along borders are the belts,
  // which keep to one side)
  chain *= smoothstep(1.5, 5.0, bdist);
  vec3 mount = chain.x > belt.x ? chain : belt;
  mount = dmul(mount, dsmooth(0.0, 0.08, dIn));
  vec3 hills = dsmooth(0.45, 0.75, m2);
  mount.yz *= u_formW; hills.yz *= 0.1;
  float hb = rise.x * 0.18 + macroS.x * 0.05 + mount.x * (0.35 + macroR.x * 0.65) * 0.6;   // for the climate
  // shading as designed slopes: the mountains' flanks (while narrow on screen), their ridged detail,
  // the lowlands' gentle grain; the noise's slope is divided by its expected size at this zoom
  vec2 sl = mount.yz * (0.22 / 75.0)
    + rg.yz * u_gradNorm * (0.1 + 1.7 * mount.x)
    + sm.yz * u_gradNorm * (0.12 + 0.35 * hills.x);
  vec3 N = normalize(vec3(-sl, 1.0));
  float slope = length(sl);
  float diff = dot(N, L), rel = diff - L.z;

  // ---- climate: cold north, warm south, cooler up high; wet by the sea and where the winds bring it
  float lat = P.y * u_lat.x + u_lat.y;
  float T = clamp(0.02 + 1.12 * lat + 0.2 * (m2.x - 0.5) - 1.35 * max(hb - 0.24, 0.0), 0.0, 1.0);
  float W = clamp(0.46 + 0.55 * wet + 0.22 * (1.0 - smoothstep(0.0, 0.25, dIn.x)) - 0.32 * smoothstep(0.3, 0.9, dIn.x), 0.0, 1.0);
  vec4 B = texture(u_lut, vec2(T, W));
  vec3 col = B.rgb;
  // snow on the peaks: where the crest is high and the ridged detail rises, so it lies in patches
  float snow = smoothstep(0.66, 0.78, hb + 0.35 * (rg.x - macroR.x) + 0.25 * (0.3 - T)) * smoothstep(0.6, 0.85, mount.x)
    * smoothstep(-0.12, 0.12, macroS.x - low.x) * smoothstep(0.3, 0.6, csize);
  float rock = smoothstep(0.35, 0.9, length(rg.yz * u_gradNorm) * (0.1 + 1.7 * mount.x)) * smoothstep(0.25, 0.55, mount.x) * (1.0 - snow);

  // ground: biome, bare rock on steep high ground, snow on the peaks and in the far north
  // the ground's own grain: meadows, fallow and scrub in drifts of colour
  col *= 1.0 + 0.09 * (sm.x - macroS.x) + 0.06 * (m3.x - 0.5);
  col = mix(col, col * vec3(1.06, 1.04, 0.86), smoothstep(0.1, 0.5, m2.x - 0.3) * 0.5);
  col = mix(col, vec3(0.68, 0.62, 0.54) + 0.08 * (macroS.x), rock * 0.8);
  col = mix(col, vec3(0.95, 0.96, 0.98), snow);
  // forest: clumps of round crowns, lit from the north-west, in shadow between them
  // forest in woods and copses: a country-sized patch noise, broken by a finer one into stands and
  // clearings, so no country is one green carpet
  float stands = smoothstep(-0.06, 0.16, sm.x - macroS.x + 0.35 * (macroS.x - low.x) + 0.04);
  float forest = B.a * smoothstep(0.5, 0.7, m3.x + 0.22 * (macroS.x - low.x)) * stands * (1.0 - rock) * (1.0 - snow) * (1.0 - smoothstep(0.3, 0.7, mount.x));
  if (forest > 0.02) {
    float glade = noised(u_ripple.xy + local * u_ripple.z * 2.5, 34).x;
    vec4 t = cells(u_crown.xy + local * u_crown.z, (0.2 + forest * 0.75) * (0.55 + 0.6 * glade), 40);
    float cov = (1.0 - smoothstep(0.78, 1.0, t.x)) * smoothstep(0.05, 0.3, forest);
    vec3 cn = normalize(vec3(t.yz, sqrt(max(1.0 - t.x * t.x, 0.0)) + 0.35));
    float lit = clamp(0.72 + 0.45 * dot(cn, L), 0.45, 1.25);
    // crowns of several greens: darker firs, lighter broadleaves, a few yellowing
    vec3 leaf = mix(vec3(0.13, 0.28, 0.12), vec3(0.26, 0.4, 0.14), t.w);
    leaf = mix(leaf, vec3(0.42, 0.44, 0.16), smoothstep(0.86, 0.98, t.w));
    vec3 canopy = mix(col, leaf + 0.3 * col, 0.5) * (0.86 + 0.24 * glade);
    col = mix(col, col * vec3(0.7, 0.8, 0.68), smoothstep(0.05, 0.5, forest));   // the forest floor, in shade
    col = mix(col, canopy * lit, cov);
  }
  // light: warm on the lit slopes, cool in the shade, more contrast up high (aerial perspective)
  float k = 1.0 + 0.5 * smoothstep(0.15, 0.6, hb);
  col *= clamp(1.0 + 0.8 * rel * k, 0.6, 1.3);
  col = mix(col, col * vec3(0.84, 0.86, 1.06), clamp(-rel * 1.6, 0.0, 1.0) * 0.45);
  col = mix(col, col * vec3(1.07, 1.03, 0.9), clamp(rel * 2.5, 0.0, 1.0) * 0.5);
  // a painter's vibrance and light: the countries' tints, multiplied over it, grey and darken it
  col = max(vec3(0.0), mix(vec3(lum(col)), col, 1.3)) * 1.1;
  // rivers: clear water with a darker bank, never a line like a border
  if (E.b > 0.0) {
    float water = smoothstep(0.08, 0.42, E.b);
    col = mix(col, col * vec3(0.78, 0.84, 0.74), smoothstep(0.0, 0.15, E.b) * (1.0 - water) * 0.6);
    col = mix(col, vec3(0.27, 0.56, 0.7) + 0.08 * (snow), water * 0.92);
  }
  // coast: a strip of sand on low shores, dark rock where the land stands high
  if (E.g > 0.0) {
    float d = (1.0 - E.g) * u_foamPx / u_pr;     // CSS px from the coast
    float beach = 1.0 - smoothstep(1.2, 3.0, d);
    float cliff = smoothstep(0.2, 0.34, hb);
    col = mix(col, mix(vec3(0.89, 0.83, 0.64), vec3(0.42, 0.38, 0.34), cliff), beach * (0.75 - 0.25 * cliff));
  }
  vec3 outc = col;
  // a soft light over the whole world from the north-west
  outc *= 1.06 - 0.16 * smoothstep(0.0, 0.9, length(P - vec2(-0.35, -0.3)));

  if (u_night > 0.5) {
    // night: moonlight, cool and dim; the sea dark; the people's lights on the land
    float l = lum(outc);
    vec3 moon = mix(vec3(l), outc, 0.35) * vec3(0.42, 0.5, 0.68) * 0.9;
    {
      // the people's lights: gathered into towns (a mid-scale noise), along the coasts and the
      // rivers, thin on the heights; a few burn bright, most are hamlets; a warm haze over the towns
      float town = smoothstep(0.42, 0.72, m3.x + 0.4 * (macroS.x - low.x));
      float shore = land && E.g > 0.0 ? smoothstep(0.2, 0.9, E.g) : 0.0;
      float keep = (0.06 + 0.62 * town + 0.35 * shore + 0.45 * smoothstep(0.0, 0.3, E.b)) * (1.0 - 0.8 * snow) * (1.0 - 0.5 * rock);
      keep = min(keep, 0.8);
      moon += vec3(0.11, 0.07, 0.03) * town * (0.6 + 0.4 * m1.x);
      vec4 c = cells(u_lights.xy + local * u_lights.z, keep, 60);
      if (c.x < 9.0) {
        float b = c.w;
        float bright = 0.3 + 1.5 * b * b * b * b;
        float glow = exp(-c.x * c.x * 26.0) * 1.2 + exp(-c.x * c.x * 3.0) * 0.2 * (0.4 + b);
        moon += vec3(1.0, 0.74, 0.4) * glow * bright;
      }
      moon += vec3(0.05, 0.034, 0.014);
    }
    outc = moon;
  }
  // (after the night: the countries' ribbons keep their colours under the moon)
  vec3 col2 = outc;
  // the countries: each one's colour as a ribbon along the inside of its borders, strong at the
  // line and fading inland
  if (E.r > 0.0 && state > 0) {
    float d = (1.0 - E.r) * u_bandPx;           // canvas px from the border
    float s = (0.62 * (1.0 - smoothstep(0.22 * u_bandPx, 0.42 * u_bandPx, d)) + 0.38 * exp(-d / (0.45 * u_bandPx))) * (state == 2 ? 1.0 : 0.9);
    vec3 pc = state == 2 ? vec3(0.95, 0.72, 0.2) : u_pal[slot];
    // by day the ribbon takes the ground's light; by night it glows a little of its own
    float shade = u_night > 0.5 ? 0.3 + 1.2 * lum(col2) : 0.42 + 0.85 * lum(col2);
    col2 = mix(col2, pc * shade, s * (u_night > 0.5 ? 0.7 : 0.85));
    float casing = 1.0 - smoothstep(0.8 * u_pr, 2.2 * u_pr, d);
    col2 = mix(col2, u_night > 0.5 ? vec3(0.75, 0.78, 0.85) : vec3(1.0, 0.97, 0.9), casing * (u_night > 0.5 ? 0.25 : 0.45));
  }
  if (state == 0) col2 = mix(col2, vec3(lum(col2)) * 0.6 + (u_night > 0.5 ? 0.12 : 0.36), 0.72);   // other countries under a mist
  outc = col2;
  // dither: no banding in the gradients
  outc += (h1(fc, 90) - 0.5) / 255.0;
  o = vec4(outc, 1.0);
}`;

// ------------------------------------------------------------------------------------------------
// Biomes: a Whittaker table, warmth across, moisture up; rgb ground colour and alpha forest cover.
// The far north is tundra, not ice: on this map no land may look like water
const BIOMES = [
  // arid, dry, moist, wet
  [[0.76, 0.74, 0.62, 0], [0.7, 0.71, 0.57, 0], [0.64, 0.68, 0.54, 0.05], [0.6, 0.66, 0.53, 0.1]],    // polar (tundra)
  [[0.76, 0.72, 0.54, 0], [0.66, 0.68, 0.48, 0.15], [0.47, 0.57, 0.38, 0.55], [0.38, 0.52, 0.38, 0.7]],// boreal
  [[0.84, 0.77, 0.52, 0], [0.7, 0.75, 0.42, 0.06], [0.52, 0.68, 0.33, 0.45], [0.38, 0.6, 0.3, 0.72]],  // temperate
  [[0.93, 0.82, 0.58, 0], [0.86, 0.78, 0.47, 0.03], [0.64, 0.71, 0.33, 0.28], [0.42, 0.62, 0.28, 0.65]],// warm
  [[0.95, 0.83, 0.58, 0], [0.87, 0.76, 0.42, 0.06], [0.58, 0.69, 0.28, 0.4], [0.28, 0.53, 0.24, 0.85]], // tropical
];
function biomeTable(n = 32) {
  let data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; ++j) for (let i = 0; i < n; ++i) {
    let t = i / (n - 1) * (BIOMES.length - 1), w = j / (n - 1) * 3;
    let t0 = Math.min(BIOMES.length - 2, Math.floor(t)), w0 = Math.min(2, Math.floor(w));
    let ft = t - t0, fw = w - w0;
    for (let c = 0; c < 4; ++c) {
      let v = (BIOMES[t0][w0][c] * (1 - fw) + BIOMES[t0][w0 + 1][c] * fw) * (1 - ft)
        + (BIOMES[t0 + 1][w0][c] * (1 - fw) + BIOMES[t0 + 1][w0 + 1][c] * fw) * ft;
      data[4 * (j * n + i) + c] = Math.round(Math.max(0, Math.min(1, v)) * 255);
    }
  }
  return {data, n};
}

export const hashStr = s => { let h = 2166136261; for (let i = 0; i < s.length; ++i) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };

// ------------------------------------------------------------------------------------------------
// Borders and coasts as segments: (ax, ay, bx, by, size, country a, country b) per instance,
// coordinates normalised to the world (see norm in addWorld)
function simplify(points, tol) {
  let n = points.length;
  if (n <= 2 || tol <= 0) return points;
  let keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  let stack = [0, n - 1], tol2 = tol * tol;
  while (stack.length) {
    let j = stack.pop(), i = stack.pop();
    let [ax, ay] = points[i], [bx, by] = points[j];
    let dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy, worst = -1, at = -1;
    for (let m = i + 1; m < j; ++m) {
      let [px, py] = points[m];
      let t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
      let ex = ax + t * dx - px, ey = ay + t * dy - py, d = ex * ex + ey * ey;
      if (d > worst) { worst = d; at = m; }
    }
    if (worst > tol2) { keep[at] = 1; stack.push(i, at, at, j); }
  }
  return points.filter((p, m) => keep[m]);
}
function pushSegments(out, pts, size, ca, cb) {
  for (let i = 0; i + 1 < pts.length; ++i) out.push(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], size, ca, cb);
}

// ------------------------------------------------------------------------------------------------
function compile(gl, vs, fs) {
  let prog = gl.createProgram();
  for (let [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    let sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(sh));
    gl.attachShader(prog, sh);
  }
  ['a_pos', 'a_corner', 'a_a', 'a_b', 'a_size', 'a_id', 'a_ca', 'a_cb'].forEach((name, i) => gl.bindAttribLocation(prog, i, name));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
  let u = {}, count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; ++i) {
    let info = gl.getActiveUniform(prog, i), name = info.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(prog, info.name);
  }
  return {prog, u};
}

// A software renderer (no GPU): SwiftShader, llvmpipe, Microsoft's Basic Render Driver. Painting the
// terrain there costs most of a second per view, so the style keeps its flat colours instead.
export function softwareRenderer(gl) {
  let info = gl.getExtension('WEBGL_debug_renderer_info');
  let name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name) ? name : '';
}

// opts: {force} paints even on a software renderer (for tests)
export function createTerrain(plate, svg, opts = {}) {
  let canvas = document.createElement('canvas');
  canvas.id = 'realm-terrain';
  canvas.setAttribute('aria-hidden', 'true');
  // never seen until it has painted a world: an undrawn canvas would be black
  canvas.style.visibility = 'hidden';
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', {antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'default'});
  } catch (e) { gl = null; }
  if (!gl) return null;
  let software = softwareRenderer(gl);
  let lose = () => { let ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); };
  if (software && !opts.force) { lose(); return {software}; }
  let ids, seg, paint, composite;
  try {
    ids = compile(gl, ID_VS, ID_FS);
    seg = compile(gl, SEG_VS, SEG_FS);
    paint = compile(gl, PAINT_VS, PAINT_FS);
    composite = compile(gl, COMP_VS, COMP_FS);
  } catch (e) {
    console.warn('realm: no painted terrain', e);
    lose();
    return null;
  }
  plate.insertBefore(canvas, svg);
  let lost = false;
  let destroyed = false;
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; if (!destroyed && opts.onLost) opts.onLost(); });

  // full-screen triangle
  let quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  let quadVao = gl.createVertexArray();
  gl.bindVertexArray(quadVao);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  let corners = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

  let lut = biomeTable();
  let lutTex = texture(gl, lut.n, lut.n, lut.data, gl.LINEAR);

  // the offscreen passes, at the canvas's size: which country, and the distances to edges
  let edges = {w: 0, h: 0, tex: null, fb: null, ids: null, idFb: null};
  function sizeEdges(w, h) {
    if (edges.w === w && edges.h === h) return;
    if (edges.tex) { gl.deleteTexture(edges.tex); gl.deleteFramebuffer(edges.fb); gl.deleteTexture(edges.ids); gl.deleteFramebuffer(edges.idFb); }
    edges.tex = texture(gl, w, h, null, gl.NEAREST);
    edges.fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, edges.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, edges.tex, 0);
    edges.ids = texture(gl, w, h, null, gl.NEAREST);
    edges.idFb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, edges.idFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, edges.ids, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    edges.w = w; edges.h = h;
  }
  // each country by its index: colour slot and state (normal, chosen, under the mist), and its size
  // (small countries get no snow: a white land inside a coloured one would read as a lake)
  let codeTex = texture(gl, 256, 1, null, gl.NEAREST), codeKey = '';
  function setCodes(W, look) {
    let key = W.id + '|' + look.selected;
    if (key === codeKey) return;
    codeKey = key;
    let data = new Uint8Array(256 * 4), sel = look.selected, near = look.near;
    W.world.items.forEach(it => {
      let i = it.index;
      let state = sel == null ? 1 : i === sel ? 2 : near.has(i) ? 1 : 0;
      data[4 * i] = ((look.slots.get(i) || 0) & 7) + 8 * state + 1;
      data[4 * i + 1] = Math.round(Math.min(1, it.size / W.span / 0.08) * 255);
    });
    gl.bindTexture(gl.TEXTURE_2D, codeTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  // per world: what the worker prepared, on the GPU; kept for the two worlds the page may flip between
  let worlds = new Map(), order = [], serial = 0;
  function instanceVao(buf) {
    let vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    [2, 3, 4, 6, 7].forEach(loc => { gl.enableVertexAttribArray(loc); gl.vertexAttribDivisor(loc, 1); });
    gl.bindVertexArray(null);
    return vao;
  }
  function addWorld(world, prep, seed) {
    if (worlds.has(world)) return worlds.get(world);
    let t0 = performance.now();
    let {span, cx, cy} = prep;
    let norm = (x, y) => [(x - cx) / span, (-y - cy) / span];
    let F = prep.fields;
    let fieldTex = texture(gl, F.nx, F.ny, F.f1, gl.LINEAR), fieldTex2 = texture(gl, F.nx, F.ny, F.f2, gl.LINEAR);
    let fanBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, fanBuf);
    gl.bufferData(gl.ARRAY_BUFFER, prep.tris, gl.STATIC_DRAW);
    let fanVao = gl.createVertexArray();
    gl.bindVertexArray(fanVao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, 12, 8);
    gl.bindVertexArray(null);
    let riverBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, riverBuf);
    gl.bufferData(gl.ARRAY_BUFFER, prep.rivers, gl.STATIC_DRAW);
    let riversS = {buf: riverBuf, vao: instanceVao(riverBuf), count: prep.riverCount};
    let W = {id: ++serial, world, span, cx, cy, F, fieldTex, fieldTex2, fanBuf, fanVao, triCount: prep.tris.length / 3, riversS,
      strips: new Map(), norm, seed: [Math.floor(hashStr('realm' + seed) * 65536), Math.floor(hashStr('world' + seed) * 65536)],
      uploadMs: performance.now() - t0};
    worlds.set(world, W);
    order.push(world);
    while (order.length > 2) {
      let old = order.shift(), Wo = worlds.get(old);
      if (Wo) dispose(Wo);
      worlds.delete(old);
    }
    return W;
  }
  function dispose(W) {
    if (snap && snap.key.startsWith(W.id + '|')) snap = null;
    gl.deleteTexture(W.fieldTex); gl.deleteTexture(W.fieldTex2); gl.deleteBuffer(W.fanBuf); gl.deleteVertexArray(W.fanVao);
    W.strips.forEach(s => { gl.deleteBuffer(s.buf); gl.deleteVertexArray(s.vao); });
    gl.deleteBuffer(W.riversS.buf); gl.deleteVertexArray(W.riversS.vao);
  }
  // segments at a level of detail: all borders, then all coasts
  function stripsAt(W, level) {
    if (W.strips.has(level)) return W.strips.get(level);
    let world = W.world;
    // twice the SVG's tolerance (under a pixel): the bands are soft, and every point saved is a
    // quad less to fill
    let tol = world.lodBase * 2 ** (level + 1);
    let borders = [], coast = [];
    world.lineItems.forEach(line => {
      let pts = simplify(line.points, tol).map(([x, y]) => W.norm(x, y));
      let size = line.size / W.span;
      if (line.kind === 'coast') pushSegments(coast, pts, size, -1, -1);
      else pushSegments(borders, pts, size, line.a, line.b);
    });
    let all = borders.concat(coast);
    let buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(all), gl.STATIC_DRAW);
    let S = {buf, vao: instanceVao(buf), borderRange: [0, borders.length / 7], coastRange: [borders.length / 7, coast.length / 7], segments: all.length / 7};
    W.strips.set(level, S);
    return S;
  }
  // draw instances [start, start + count) of the segments
  function segments(S, start, count) {
    gl.bindVertexArray(S.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, S.buf);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 28, start * 28);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 28, start * 28 + 8);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 28, start * 28 + 16);
    gl.vertexAttribPointer(6, 1, gl.FLOAT, false, 28, start * 28 + 20);
    gl.vertexAttribPointer(7, 1, gl.FLOAT, false, 28, start * 28 + 24);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
  }

  // ---- the view is painted into a snapshot (a texture the canvas's size) and copied to the canvas.
  // A pan (same zoom, same look) shifts the snapshot by whole pixels and paints only the strips it
  // uncovers; any other change paints the whole view. The snapshot's own offset is kept in whole
  // canvas pixels, so shifts never blur it; the copy to the canvas makes up the sub-pixel rest.
  let cornerVao = gl.createVertexArray();
  gl.bindVertexArray(cornerVao);
  let cornerBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  let snaps = [null, null], snap = null;
  function snapTarget(w, h) {
    let k = snap === snaps[0] ? 1 : 0, s = snaps[k];
    if (!s || s.w !== w || s.h !== h) {
      if (s) { gl.deleteTexture(s.tex); gl.deleteFramebuffer(s.fb); }
      s = snaps[k] = {w, h, tex: texture(gl, w, h, null, gl.LINEAR), fb: gl.createFramebuffer()};
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, s.tex, 0);
    }
    return s;
  }
  function copy(src, fb, w, h, cssW, cssH, dx, dy) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, h);
    gl.useProgram(composite.prog);
    gl.bindVertexArray(cornerVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(composite.u.u_tile, 0);
    gl.uniform2f(composite.u.u_canvas, cssW, cssH);
    gl.uniform4f(composite.u.u_rect, dx, dy, cssW, cssH);
    gl.uniform4f(composite.u.u_uv, 0, 1, 1, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  // ---- resolution. On a phone the canvas starts at 2 pixels per CSS pixel (the names and lines
  // over it are SVG at the screen's full sharpness). After a full paint a fence tells when the GPU
  // is done; a GPU that needs over ~50 ms gets a coarser canvas from the next paint on (down to 1).
  // Not when forced onto a software renderer (tests want what a real GPU would show), unless
  // ?realm-adapt asks for it too.
  // (?realm-pr=1.5 in the address caps it, for measuring)
  let prCap = Math.min(MAX_PR, +((/realm-pr=([\d.]+)/.exec(location.search) || [])[1] || MAX_PR)), fence = null;
  function watch() {
    if (fence || (opts.force && !opts.adapt) || !gl.fenceSync) return;
    let sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), t = performance.now();
    if (!sync) return;
    gl.flush();
    fence = sync;
    let poll = () => {
      if (lost || !fence) return;
      if (gl.getSyncParameter(sync, gl.SYNC_STATUS) !== gl.SIGNALED) { requestAnimationFrame(poll); return; }
      let ms = performance.now() - t;
      gl.deleteSync(sync);
      fence = null;
      gpu.last = ms;
      if (ms > 50 && prCap > 1) prCap = Math.max(1, prCap - 0.5);
    };
    requestAnimationFrame(poll);
  }
  let gpu = {last: null};

  let last = null, shownOnce = false;
  // view: {k, x, y} (the SVG's translate and scale); look: {night, pal: [[r,g,b] x8], slots, selected, near}
  // Returns null when the world is not prepared yet.
  function draw(world, view, look) {
    if (lost || !world) return null;
    let W = worlds.get(world);
    if (!W) return null;
    let t1 = performance.now();
    let pr = Math.min(prCap, window.devicePixelRatio || 1);
    let cssW = canvas.clientWidth || plate.clientWidth, cssH = canvas.clientHeight || plate.clientHeight;
    let w = Math.max(1, Math.round(cssW * pr)), h = Math.max(1, Math.round(cssH * pr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    pr = w / cssW;
    sizeEdges(w, h);
    let K = W.span * view.k;                     // CSS px per normalised unit
    let Tx = W.cx * view.k + view.x, Ty = W.cy * view.k + view.y;   // CSS px of the world's centre
    let screen = Math.max(cssW, cssH);
    let key = W.id + '|' + (look.night ? 'n' : 'd') + '|' + (look.selected == null ? '' : look.selected) + '|' + w + 'x' + h;
    let painted = 'all', px = 0;
    let next = snapTarget(w, h);
    let qx, qy;
    if (snap && snap.key === key && snap.K === K && Math.abs(Tx - snap.Tx) < cssW * 0.75 && Math.abs(Ty - snap.Ty) < cssH * 0.75) {
      let sx = Math.round((Tx - snap.Tx) * pr), sy = Math.round((Ty - snap.Ty) * pr);   // canvas px
      qx = snap.Tx + sx / pr; qy = snap.Ty + sy / pr;
      if (sx || sy) {
        copy(snap, next.fb, w, h, cssW, cssH, sx / pr, sy / pr);
        // the uncovered strips, in GL's bottom-up pixels
        let rects = [];
        if (sx > 0) rects.push([0, 0, sx, h]); else if (sx < 0) rects.push([w + sx, 0, -sx, h]);
        if (sy > 0) rects.push([0, h - sy, w, sy]); else if (sy < 0) rects.push([0, 0, w, -sy]);
        renderInto(next.fb, W, look, w, h, pr, K, qx, qy, screen, rects);
        rects.forEach(r => { px += r[2] * r[3]; });
        painted = 'strips';
      } else { next = snap; painted = 'none'; }
    } else {
      qx = Tx; qy = Ty;
      renderInto(next.fb, W, look, w, h, pr, K, qx, qy, screen, null);
      px = w * h;
    }
    next.key = key; next.K = K; next.Tx = qx; next.Ty = qy;
    snap = next;
    // to the canvas, with the sub-pixel rest
    let sea = look.night ? [0.03, 0.08, 0.14] : [0.11, 0.29, 0.46];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(sea[0], sea[1], sea[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    copy(snap, null, w, h, cssW, cssH, Tx - qx, Ty - qy);
    if (painted === 'all') watch();
    if (!shownOnce) { shownOnce = true; canvas.style.visibility = ''; }
    last = {drawMs: performance.now() - t1, w, h, pr: +pr.toFixed(2), painted, paintedPx: px, gpuMs: gpu.last};
    return last;
  }

  function renderInto(target, W, look, w, h, pr, K, Tx, Ty, screen, rects) {
    let world = W.world;
    let cssW = w / pr, cssH = h / pr;
    let kpr = K * pr;
    let scale = [2 * kpr / w, -2 * kpr / h], off = [2 * Tx * pr / w - 1, 1 - 2 * Ty * pr / h];
    let bandPx = Math.min(12, 7 + 0.003 * K) * pr, foamPx = 8 * pr;
    let kWorld = K / W.span;
    let level = Math.max(-1, Math.min(14, Math.floor(Math.log2(0.4 / kWorld / world.lodBase))));

    // ---- which country each pixel shows: one draw of every country's triangles. When only strips
    // are painted, the offscreen passes are limited to them (and a band's width round them)
    let S = stripsAt(W, level);
    setCodes(W, look);
    let reach = Math.ceil(Math.max(bandPx, foamPx)) + 2;
    if (rects) {
      let x0 = w, y0 = h, x1 = 0, y1 = 0;
      rects.forEach(r => { x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1]); x1 = Math.max(x1, r[0] + r[2]); y1 = Math.max(y1, r[1] + r[3]); });
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(Math.max(0, x0 - reach), Math.max(0, y0 - reach), Math.min(w, x1 + reach) - Math.max(0, x0 - reach), Math.min(h, y1 + reach) - Math.max(0, y0 - reach));
    }
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, edges.idFb);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(ids.prog);
    gl.uniform2f(ids.u.u_scale, scale[0], scale[1]);
    gl.uniform2f(ids.u.u_off, off[0], off[1]);
    gl.bindVertexArray(W.fanVao);
    gl.drawArrays(gl.TRIANGLES, 0, W.triCount);
    // ---- distances to borders (inside their two countries) and to coasts (both sides)
    gl.bindFramebuffer(gl.FRAMEBUFFER, edges.fb);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(seg.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, edges.ids);
    gl.uniform1i(seg.u.u_ids, 0);
    gl.uniform2f(seg.u.u_scale, scale[0], scale[1]);
    gl.uniform2f(seg.u.u_off, off[0], off[1]);
    gl.uniform1f(seg.u.u_kpr, kpr);
    gl.uniform1i(seg.u.u_mode, 1);
    gl.uniform4f(seg.u.u_color, 1, 0, 0, 0);
    gl.uniform1f(seg.u.u_hw, bandPx);
    gl.uniform1f(seg.u.u_sizeFrac, 0.22);
    segments(S, S.borderRange[0], S.borderRange[1]);
    gl.uniform1i(seg.u.u_mode, 0);
    gl.uniform4f(seg.u.u_color, 0, 1, 0, 0);
    gl.uniform1f(seg.u.u_hw, foamPx);
    gl.uniform1f(seg.u.u_sizeFrac, 0.35);
    segments(S, S.coastRange[0], S.coastRange[1]);
    if (W.riversS.count) {
      gl.uniform1i(seg.u.u_mode, 2);
      gl.uniform4f(seg.u.u_color, 0, 0, 1, 0);
      gl.uniform1f(seg.u.u_hw, 5 * pr);
      gl.uniform1f(seg.u.u_sizeFrac, 1);
      segments(W.riversS, 0, W.riversS.count);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.SCISSOR_TEST);

    // ---- paint
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, w, h);
    gl.useProgram(paint.prog);
    let u = paint.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, edges.tex); gl.uniform1i(u.u_edges, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, W.fieldTex); gl.uniform1i(u.u_fields, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, lutTex); gl.uniform1i(u.u_lut, 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, edges.ids); gl.uniform1i(u.u_ids, 3);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, codeTex); gl.uniform1i(u.u_codes, 4);
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, W.fieldTex2); gl.uniform1i(u.u_fields2, 5);
    let cxCss = cssW / 2, cyCss = cssH / 2;
    let P0 = [(cxCss - Tx) / K, (cyCss - Ty) / K];
    gl.uniform2f(u.u_res, w, h);
    gl.uniform1f(u.u_pr, pr);
    gl.uniform2f(u.u_center, cxCss, cyCss);
    gl.uniform1f(u.u_invK, 1 / K);
    gl.uniform1f(u.u_kpr, kpr);
    gl.uniform2f(u.u_P0, P0[0], P0[1]);
    // fields: normalised P -> texture uv
    let F = W.F, fw = F.nx / F.s, fh = F.ny / F.s;   // (fields grid in SVG orientation)
    gl.uniform2f(u.u_fieldA, W.span / fw, W.span / fh);
    gl.uniform2f(u.u_fieldB, (W.cx - F.x0) / fw, (W.cy - F.y0) / fh);
    gl.uniform2f(u.u_fieldN, F.nx, F.ny);
    let {box} = world;
    gl.uniform2f(u.u_lat, W.span / (box.maxY - box.minY), (W.cy - box.minY) / (box.maxY - box.minY));
    // octaves: the five that shape the land, then the finest the screen can show (at most seven)
    let fmax = kpr / 2.2;
    let freqs = MACRO.slice();
    let detail = [];
    for (let f = 96; f <= fmax; f *= 2) detail.push(f);
    freqs = freqs.concat(detail.slice(-(MAX_OCT - MACRO.length)));
    let oct = new Float32Array(MAX_OCT * 2), rot = new Float32Array(MAX_OCT * 2), fr = new Float32Array(MAX_OCT), amp = new Float32Array(MAX_OCT), sw = new Float32Array(MAX_OCT);
    freqs.forEach((f, i) => {
      let wl = K / f;   // CSS px per cycle
      sw[i] = 1 - smoothstep(0.8 * screen, 3 * screen, wl);
      // the octave's lattice is turned by an angle of its own (by its frequency, so a zoom that drops
      // or adds octaves keeps the others where they were)
      // (chosen so no octave lies within 14 degrees of the screen's axes or of its neighbours)
      let th = Math.log2(f) * 0.524 + 0.48, c = Math.cos(th), sn = Math.sin(th);
      rot[2 * i] = c; rot[2 * i + 1] = sn;
      oct[2 * i] = mod256((c * P0[0] - sn * P0[1]) * f); oct[2 * i + 1] = mod256((sn * P0[0] + c * P0[1]) * f);
      fr[i] = f; amp[i] = Math.pow(3 / f, AMP_EXP);
    });
    gl.uniform2fv(u.u_oct, oct);
    gl.uniform2fv(u.u_rot, rot);
    gl.uniform1fv(u.u_freq, fr);
    gl.uniform1fv(u.u_amp, amp);
    gl.uniform1fv(u.u_shadeW, sw);
    gl.uniform1i(u.u_nOct, freqs.length);
    let e2 = 0;
    freqs.forEach((f, i) => { e2 += (2 * amp[i] * f * sw[i]) ** 2; });
    gl.uniform1f(u.u_gradNorm, 1 / Math.sqrt(Math.max(e2, 1e-9)));
    gl.uniform1f(u.u_formW, 1 - smoothstep(40, 320, 0.012 * K));
    gl.uniform1f(u.u_bandPx, bandPx);
    gl.uniform1f(u.u_foamPx, foamPx);
    gl.uniform1f(u.u_night, look.night ? 1 : 0);
    gl.uniform3fv(u.u_pal, new Float32Array(look.pal.flat()));
    gl.uniform2ui(u.u_seed, W.seed[0], W.seed[1]);
    // crowns some 3.4 CSS px across, lights some 5.5, ripples some 60: cell levels in powers of two
    let cellsAt = px => { let f = 2 ** Math.round(Math.log2(K / px)); return [mod256(P0[0] * f), mod256(P0[1] * f), f]; };
    // crowns some 3.4 CSS px across at whole-world zoom, growing a little closer in (to some 7 px)
    gl.uniform3fv(u.u_crown, cellsAt(3.4 * Math.min(2.2, Math.max(1, Math.pow(K / 1200, 0.28)))));
    gl.uniform3fv(u.u_lights, cellsAt(5.5));
    gl.uniform3fv(u.u_ripple, cellsAt(60));
    gl.bindVertexArray(quadVao);
    if (rects) {
      gl.enable(gl.SCISSOR_TEST);
      for (let r of rects) { gl.scissor(r[0], r[1], r[2], r[3]); gl.drawArrays(gl.TRIANGLES, 0, 3); }
      gl.disable(gl.SCISSOR_TEST);
    } else gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  // GPU time of a draw, forced to finish: only for measuring (?realm-gpu), it stalls the page
  function finish() { let t = performance.now(); gl.finish(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); return performance.now() - t; }
  function destroy() {
    destroyed = true;
    lost = true;
    worlds.forEach(W => dispose(W));
    worlds.clear();
    canvas.remove();
    lose();
  }
  return {canvas, draw, addWorld, has: world => worlds.has(world), finish, destroy, forget: () => { snap = null; }, stats: () => last, renderer: software};
}
const smoothstep = (a, b, x) => { let t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mod256 = v => { let m = v % 256; return m < 0 ? m + 256 : m; };

function texture(gl, w, h, data, filter) {
  let t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
