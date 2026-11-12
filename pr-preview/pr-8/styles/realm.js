// The realm: a painted world map, as the best strategy-game and illustrated-atlas maps paint theirs.
// The land and sea are painted by WebGL under the SVG (styles/realm-terrain.js); the countries are
// SVG paths filled with a light political tint that multiplies over the painted land, each one's
// colour runs as a band along the inside of its borders, and the names are lettered over all of it.
// The page calls these hooks (window.mapStyles.realm) when html has data-style="realm":
//   ripples   none: the water is painted
//   markerPx  the radius of the ring round a country too small to see
//   render    once per drawn world: the countries' colours, the world fields, the name plans
//   view      after every redraw: the painted layer for this view, names, the chosen country
// Without WebGL2 (or if its context is lost) html gets the class realm-flat and the countries are
// filled with flat painted colours instead.
import {createTerrain} from './realm-terrain.js';

const NS = 'http://www.w3.org/2000/svg';
const html = typeof document === 'undefined' ? null : document.documentElement;
const active = () => html && html.dataset.style === 'realm';

// ---------------------------------------------------------------------------------------------
// Colours: eight political colours, for the bands (painted) and the tints (SVG, multiplied)
// No blues or cyans among them: a coloured rim inside a border must never read as a shore
const PAL_DAY = [
  [0.8, 0.15, 0.15], [0.38, 0.24, 0.76], [0.92, 0.66, 0.0], [0.62, 0.2, 0.66],
  [0.05, 0.56, 0.34], [0.95, 0.45, 0.06], [0.88, 0.22, 0.55], [0.58, 0.32, 0.12],
];
const PAL_NIGHT = [
  [1.0, 0.38, 0.34], [0.62, 0.52, 1.0], [1.0, 0.82, 0.3], [0.86, 0.46, 0.95],
  [0.3, 0.9, 0.6], [1.0, 0.62, 0.25], [1.0, 0.45, 0.75], [0.85, 0.58, 0.32],
];
const SLOTS = 8;
const night = () => html.dataset.theme === 'dark' || (html.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);

// A colour per country, neighbours never alike: DSATUR (the most constrained country first), each
// country preferring the slot its code hashes to, so a country keeps its colour through most edits
function slotsFor(world) {
  let items = world.items, near = world.neighbours;
  let slot = new Map(), sat = new Map();
  let pref = id => { let h = 0; for (let ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % SLOTS; };
  let left = new Set(items.map(it => it.index));
  let byIndex = world.byIndex;
  while (left.size) {
    let best = null, bs = -1, bd = -1;
    for (let i of left) {
      let s = sat.get(i) ? sat.get(i).size : 0, d = near[i].length;
      if (s > bs || (s === bs && d > bd) || (s === bs && d === bd && byIndex.get(i).country.id < byIndex.get(best).country.id)) { best = i; bs = s; bd = d; }
    }
    left.delete(best);
    let used = new Set(near[best].map(j => slot.get(j)).filter(v => v !== undefined));
    let p = pref(byIndex.get(best).country.id), pick = p;
    for (let k = 0; k < SLOTS; ++k) { let c = (p + k * 3) % SLOTS; if (!used.has(c)) { pick = c; break; } }
    slot.set(best, pick);
    near[best].forEach(j => { if (!sat.has(j)) sat.set(j, new Set()); sat.get(j).add(pick); });
  }
  return slot;
}

// ---------------------------------------------------------------------------------------------
// Names. Advance widths of Alegreya SC (500 and 700) and Alegreya Italic (em), so names are fitted
// before the fonts have loaded and the same way on every device.
const CHARS = " ,-.'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SC500 = [0.187, 0.282, 0.368, 0.291, 0.176, 0.603, 0.611, 0.621, 0.699, 0.593, 0.521, 0.661, 0.751, 0.363, 0.329, 0.641, 0.517, 0.844, 0.723, 0.684, 0.562, 0.689, 0.625, 0.534, 0.556, 0.67, 0.616, 0.946, 0.667, 0.564, 0.573, 0.526, 0.529, 0.529, 0.592, 0.51, 0.453, 0.561, 0.636, 0.32, 0.293, 0.554, 0.45, 0.713, 0.617, 0.579, 0.488, 0.583, 0.54, 0.462, 0.482, 0.565, 0.53, 0.805, 0.575, 0.496, 0.494];
const SC700 = [0.174, 0.269, 0.355, 0.275, 0.176, 0.625, 0.627, 0.616, 0.694, 0.596, 0.531, 0.654, 0.747, 0.365, 0.332, 0.657, 0.53, 0.841, 0.728, 0.675, 0.576, 0.68, 0.641, 0.539, 0.567, 0.657, 0.624, 0.962, 0.681, 0.594, 0.58, 0.544, 0.542, 0.524, 0.588, 0.512, 0.46, 0.555, 0.633, 0.32, 0.294, 0.567, 0.46, 0.71, 0.621, 0.571, 0.499, 0.575, 0.554, 0.465, 0.491, 0.554, 0.536, 0.819, 0.586, 0.521, 0.499];
const IT500 = [0.161, 0.229, 0.312, 0.289, 0.176, 0.577, 0.586, 0.598, 0.672, 0.571, 0.5, 0.636, 0.722, 0.349, 0.316, 0.616, 0.497, 0.812, 0.695, 0.659, 0.541, 0.663, 0.6, 0.513, 0.534, 0.645, 0.592, 0.909, 0.64, 0.54, 0.551, 0.474, 0.467, 0.354, 0.476, 0.373, 0.271, 0.455, 0.497, 0.272, 0.256, 0.457, 0.258, 0.748, 0.506, 0.422, 0.487, 0.455, 0.36, 0.352, 0.294, 0.497, 0.433, 0.659, 0.47, 0.446, 0.409];
const advance = (text, table) => {
  let w = 0;
  for (let ch of text) { let i = CHARS.indexOf(ch); w += i >= 0 ? table[i] : 0.6; }
  return w;
};
// The hierarchy by people, as a game map letters its realms: the great powers in heavy spaced
// capitals, then capitals, then small capitals, then italic for the smallest.
// rel: largest size as a share of the country's width; px: largest size on screen; spacing in em
const TIERS = [
  {min: 1e8, upper: true, table: SC700, rel: 0.21, px: 42, spacing: [0.22, 0.6]},
  {min: 3e7, upper: true, table: SC700, rel: 0.2, px: 30, spacing: [0.16, 0.42]},
  {min: 5e6, upper: false, table: SC500, rel: 0.2, px: 23, spacing: [0.08, 0.22]},
  {min: 5e5, upper: false, table: SC500, rel: 0.19, px: 18, spacing: [0.04, 0.1]},
  {min: 0, upper: false, italic: true, table: IT500, rel: 0.18, px: 15, spacing: [0.02, 0.05]},
];

// ---- label fitting, after the engraved atlas's (styles/atlas.js), with this style's letters
function simplify(ring, tol) {
  let n = ring.length;
  if (n < 8) return ring;
  let keep = new Uint8Array(n);
  let far = 0, at = 0;
  for (let i = 1; i < n; ++i) { let d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2; if (d > far) { far = d; at = i; } }
  keep[0] = keep[at] = 1;
  let stack = [0, at, at, n - 1], t2 = tol * tol;
  keep[n - 1] = 1;
  while (stack.length) {
    let j = stack.pop(), i = stack.pop();
    let [ax, ay] = ring[i], [bx, by] = ring[j];
    let dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy, worst = -1, w = -1;
    for (let m = i + 1; m < j; ++m) {
      let [px, py] = ring[m];
      let t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
      let d = (ax + t * dx - px) ** 2 + (ay + t * dy - py) ** 2;
      if (d > worst) { worst = d; w = m; }
    }
    if (worst > t2) { keep[w] = 1; stack.push(i, w, w, j); }
  }
  return ring.filter((p, m) => keep[m]);
}
function inside(ring, x, y) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    let [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
function clear(ring, x, y, r) {
  let r2 = r * r;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    let ax = ring[j][0], ay = ring[j][1], dx = ring[i][0] - ax, dy = ring[i][1] - ay;
    let len = dx * dx + dy * dy;
    let t = len ? ((x - ax) * dx + (y - ay) * dy) / len : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    let ex = ax + t * dx - x, ey = ay + t * dy - y;
    if (ex * ex + ey * ey < r2) return false;
  }
  return true;
}
function axis(ring) {
  let A = 0, cx = 0, cy = 0, ixx = 0, iyy = 0, ixy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    let [x0, y0] = ring[j], [x1, y1] = ring[i];
    let c = x0 * y1 - x1 * y0;
    A += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
    iyy += (x0 * x0 + x0 * x1 + x1 * x1) * c; ixx += (y0 * y0 + y0 * y1 + y1 * y1) * c;
    ixy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * c;
  }
  A /= 2; cx /= 6 * A; cy /= 6 * A;
  let sxx = iyy / 12 / A - cx * cx, syy = ixx / 12 / A - cy * cy, sxy = ixy / 24 / A - cx * cy;
  let mid = (sxx + syy) / 2, r = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
  return {angle: 0.5 * Math.atan2(2 * sxy, sxx - syy), elong: Math.sqrt((mid + r) / Math.max(mid - r, 1e-12))};
}
function fitFont(ring, x, y, ux, uy, w, h, limit) {
  let ok = f => {
    let half = h * f / 2 + f * 0.14;
    for (let k of [0, 6, 3, 1, 5, 2, 4]) {
      let t = (k / 6 - 0.5) * w * f;
      let px = x + t * ux, py = y + t * uy;
      if (!clear(ring, px, py, half) || !inside(ring, px, py)) return false;
    }
    return true;
  };
  if (ok(limit)) return limit;
  let lo = 0, hi = limit;
  for (let it = 0; it < 10; ++it) { let m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
  return lo;
}
function area(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}
function placeName(item) {
  let c = item.country, name = c.name.trim();
  let tier = TIERS.find(t => c.population >= t.min);
  let text = tier.upper ? name.toUpperCase() : name;
  let table = tier.table;
  let main = c.rings.reduce((best, r) => Math.abs(area(r)) > Math.abs(area(best)) ? r : best);
  let ring = simplify(main, item.size * 0.015);
  let {angle, elong} = axis(ring);
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle <= -Math.PI / 2) angle += Math.PI;
  let angles = [0];
  if (elong > 1.25 && Math.abs(angle) > 0.12 && Math.abs(angle) < 1.2) angles.push(angle);
  let layouts = [[text]];
  let words = text.split(' ');
  if (words.length > 1 && text.length > 10) {
    let best = null;
    for (let k = 1; k < words.length; ++k) {
      let a = words.slice(0, k).join(' '), b = words.slice(k).join(' ');
      let d = Math.abs(advance(a, table) - advance(b, table));
      if (!best || d < best.d) best = {d, lines: [a, b]};
    }
    layouts.push(best.lines);
  }
  // the page's short form (Switz., C.A.R.) where the full name would come out much smaller
  let abbr = item.abbr && item.abbr !== name ? (tier.upper ? item.abbr.toUpperCase() : item.abbr) : null;
  if (abbr) layouts.push([abbr]);
  let s0 = tier.spacing[0];
  let width = lines => Math.max(...lines.map(l => advance(l, table) + s0 * Math.max(0, l.length - 1)));
  // a name never covers much of its land: its letters (and their halo) take some 0.36 of the box
  // they are set in, and that stays under 7% of the country's area
  let inkLimit = lines => Math.sqrt(0.07 * Math.abs(item.area) / (0.36 * lines.reduce((t, l) => t + advance(l, table) + s0 * l.length, 0)));
  let pick = null;
  for (let lines of layouts) for (let a of angles) {
    let ux = Math.cos(a), uy = Math.sin(a);
    let w = width(lines), h = lines.length === 1 ? 0.78 : 2.0;
    let limit = Math.min(tier.rel * item.size, inkLimit(lines));
    for (let shift of a === 0 && elong < 1.25 ? [0] : [0, -0.3, 0.3]) {
      let x = item.pole.x + shift * item.pole.r * ux, y = item.pole.y + shift * item.pole.r * uy;
      let f = fitFont(ring, x, y, ux, uy, w, h, limit);
      let score = f * (a === 0 ? 1 : 0.86) * (lines.length === 1 ? 1 : 0.9) * (lines[0] === abbr ? 0.62 : 1);
      if (!pick || score > pick.score) pick = {score, f, a, x, y, lines, w, h, ux, uy};
    }
  }
  pick.curve = null;
  if (pick.f > 0 && pick.lines.length === 1 && elong > 1.45) pick.curve = bend(ring, pick);
  let spacing = s0;
  if (pick.f > 0 && tier.spacing[1] > s0 && pick.lines.length === 1) {
    let n = Math.max(1, pick.lines[0].length - 1), base = advance(pick.lines[0], table);
    let lo = s0, hi = tier.spacing[1];
    let fits = s => pick.curve ? curveFits(ring, pick, pick.curve, base + s * n, pick.f)
      : fitFont(ring, pick.x, pick.y, pick.ux, pick.uy, base + s * n, pick.h, pick.f) >= pick.f * 0.999;
    if (fits(hi)) lo = hi;
    else for (let it = 0; it < 6; ++it) { let m = (lo + hi) / 2; if (fits(m)) lo = m; else hi = m; }
    spacing = lo;
    pick.w = base + spacing * n;
  }
  return {tier, ...pick, spacing};
}
function middle(ring, pick, t) {
  let cx = pick.x + t * pick.ux, cy = pick.y + t * pick.uy, nx = -pick.uy, ny = pick.ux;
  let lo = -Infinity, hi = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    let ax = ring[j][0] - cx, ay = ring[j][1] - cy, bx = ring[i][0] - cx, by = ring[i][1] - cy;
    let da = ax * pick.ux + ay * pick.uy, db = bx * pick.ux + by * pick.uy;
    if ((da > 0) === (db > 0)) continue;
    let u = da / (da - db);
    let sv = (ax + u * (bx - ax)) * nx + (ay + u * (by - ay)) * ny;
    if (sv <= 0 && sv > lo) lo = sv;
    if (sv > 0 && sv < hi) hi = sv;
  }
  return lo > -Infinity && hi < Infinity ? (lo + hi) / 2 : null;
}
function bend(ring, pick) {
  let half = pick.w * pick.f / 2, pts = [];
  for (let k = -6; k <= 6; ++k) {
    let t = k / 6 * half * 1.1, m = middle(ring, pick, t);
    if (m !== null) pts.push([t, m]);
  }
  if (pts.length < 9) return null;
  let S = [0, 0, 0, 0, 0], T = [0, 0, 0];
  for (let [t, m] of pts) { let p = 1; for (let e = 0; e < 5; ++e) { S[e] += p; if (e < 3) T[e] += p * m; p *= t; } }
  let M = [[S[4], S[3], S[2]], [S[3], S[2], S[1]], [S[2], S[1], S[0]]], R = [T[2], T[1], T[0]];
  let det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  let D = det(M);
  if (!D) return null;
  let col = c => M.map((row, r) => row.map((v, q) => q === c ? R[r] : v));
  let A = det(col(0)) / D, B = det(col(1)) / D, C = det(col(2)) / D;
  let sag = Math.abs(A) * half * half;
  if (sag < 0.22 * pick.f) return null;
  if (sag > half / 6) { A *= half / 6 / sag; }
  for (let scale of [1, 0.6]) {
    let c = {A: A * scale, B: B * scale, C: C * scale};
    if (curveFits(ring, pick, c, pick.w, pick.f)) return c;
  }
  return null;
}
function curveFits(ring, pick, c, w, f) {
  let half = w * f / 2, r = pick.h * f / 2 + f * 0.14, nx = -pick.uy, ny = pick.ux;
  for (let k = -4; k <= 4; ++k) {
    let t = k / 4 * half, sv = c.A * t * t + c.B * t + c.C;
    let x = pick.x + t * pick.ux + sv * nx, y = pick.y + t * pick.uy + sv * ny;
    if (!clear(ring, x, y, r) || !inside(ring, x, y)) return false;
  }
  return true;
}

let curves = 0;
function letter(item, world) {
  let label = item.label;
  let p = item.realmPlan || placeName(item);
  let deg = -p.a * 180 / Math.PI;
  label.setAttribute('class', 'label realm-name realm-t' + TIERS.indexOf(p.tier));
  label.setAttribute('x', p.x);
  label.setAttribute('y', -p.y);
  label.setAttribute('font-size', p.f);
  label.setAttribute('letter-spacing', p.spacing + 'em');
  label.removeAttribute('transform');
  label.textContent = '';
  let dx = p.spacing / 2 + 'em';
  if (p.curve) {
    let {A, B, C} = p.curve, half = p.w * p.f / 2 * 1.5, nx = -p.uy, ny = p.ux;
    let at = t => { let sv = A * t * t + B * t + C; return [p.x + t * p.ux + sv * nx, -(p.y + t * p.uy + sv * ny)]; };
    let s0 = A * half * half - B * half + C, slope = -2 * A * half + B;
    let ctrl = [p.x + (s0 + slope * half) * nx, -(p.y + (s0 + slope * half) * ny)];
    let [a0, a1] = [at(-half), at(half)];
    let path = document.createElementNS(NS, 'path');
    let id = 'realm-curve-' + (++curves);
    path.setAttribute('id', id);
    path.setAttribute('d', `M ${a0[0]} ${a0[1]} Q ${ctrl[0]} ${ctrl[1]} ${a1[0]} ${a1[1]}`);
    world.realm.defs.appendChild(path);
    let tp = document.createElementNS(NS, 'textPath');
    tp.setAttribute('href', '#' + id);
    tp.setAttribute('startOffset', '50%');
    let t = document.createElementNS(NS, 'tspan');
    t.setAttribute('dx', dx);
    t.textContent = p.lines[0];
    tp.appendChild(t);
    label.appendChild(tp);
    label.removeAttribute('x');
    label.removeAttribute('y');
  } else if (p.lines.length === 1) {
    if (deg) label.setAttribute('transform', `rotate(${deg} ${p.x} ${-p.y})`);
    let t = document.createElementNS(NS, 'tspan');
    t.setAttribute('dx', dx);
    t.textContent = p.lines[0];
    label.appendChild(t);
  } else {
    if (deg) label.setAttribute('transform', `rotate(${deg} ${p.x} ${-p.y})`);
    p.lines.forEach((line, k) => {
      let t = document.createElementNS(NS, 'tspan');
      t.setAttribute('x', p.x);
      t.setAttribute('dx', dx);
      t.setAttribute('dy', k === 0 ? '-0.58em' : '1.16em');
      t.textContent = line;
      label.appendChild(t);
    });
  }
  item.font = p.f * (p.tier.upper ? 1.12 : 1);
  item.labelFits = p.w * p.f;
  item.realm = {font: p.f, px: p.tier.px, shown: p.f, p};
  label.classList.toggle('realm-dim', item.path.classList.contains('dim'));
}
function plan(world) {
  let queue = world.items.slice().sort((p, q) => q.size - p.size);
  let later = window.requestIdleCallback || (f => setTimeout(() => f({timeRemaining: () => 10}), 30));
  let step = deadline => {
    if (!active()) return;     // another style was chosen: stop
    while (queue.length && deadline.timeRemaining() > 1) {
      let item = queue.shift();
      if (!item.realm && !item.realmPlan) item.realmPlan = placeName(item);
    }
    if (queue.length) later(step);
  };
  later(step);
}
function place(item, world, k, selected) {
  letter(item, world);
  let show = (item.font * k >= 9 && item.labelFits * k >= 18) || item === selected;
  item.label.classList.toggle('hidden', !show);
}

// ---------------------------------------------------------------------------------------------
// The painted layer. Made when the style is mounted, if the browser paints with a GPU (WebGL2 on a
// hardware renderer; a software renderer such as SwiftShader or llvmpipe would take most of a second
// per view, so the style keeps its flat colours there). In the address, ?realm-gl paints even on a
// software renderer (for tests) and ?realm-flat never paints. Each world is prepared (fields, rivers,
// triangles) in a worker, off the page's thread; the page waits for the first painting (settled).
let terrain = null, flat = false, mounted = false, software = '';
let screenSize = typeof window === 'undefined' ? [0, 0] : [innerWidth, innerHeight];
const onResize = () => { screenSize = [innerWidth, innerHeight]; };
// numbers for the harness: the mode, draws so far, CPU ms of the last one, the world's preparation,
// and (with ?realm-gpu in the address) the GPU ms of a paint, forced to finish (that stalls the page:
// for measuring only); __realm.redraw(fresh) paints the same view again
const stats = {mode: 'none', draws: 0, redraw(fresh) {
  if (!current) return null;
  if (fresh && terrain) terrain.forget();
  current.realm.key = '';
  paint(current, currentSelected);
  return {lastMs: stats.lastMs, gpuMs: stats.gpuMs, gl: stats.gl};
}};
if (typeof window !== 'undefined') window.__realm = stats;
const query = () => typeof location === 'undefined' ? '' : location.search;
const seedOf = () => { let m = /world-(\d+)/.exec(decodeURIComponent(location.hash)); return m ? +m[1] : 1; };

// ---- preparation, in a worker when module workers work, else on the page (a moment later)
let worker = null, workerFailed = false, jobs = new Map(), jobSerial = 0;
function worldData(world) {
  let result = world.result || {};
  return {seed: seedOf(), box: world.box, terrain: result.terrain, climate: result.climate, valleys: result.valleys,
    items: world.items.map(it => ({index: it.index, id: it.country.id, size: it.size, rings: it.country.rings})),
    lines: world.lineItems.map(l => ({kind: l.kind, a: l.a, b: l.b, points: l.points}))};
}
function onPage(data) {
  return import('./realm-prep.js').then(m => new Promise(resolve => setTimeout(() => resolve(m.prepareWorld(data)), 0)));
}
function prepareAsync(world) {
  let data = worldData(world);
  if (!worker && !workerFailed) {
    try {
      worker = new Worker(new URL('./realm-worker.js', import.meta.url), {type: 'module'});
      worker.onmessage = ({data: msg}) => {
        let job = jobs.get(msg.job);
        if (!job) return;
        jobs.delete(msg.job);
        if (msg.error) job.reject(new Error(msg.error)); else job.resolve(msg.out);
      };
      worker.onerror = event => {
        // no module workers here (or the worker failed to load): prepare on the page instead
        event.preventDefault();
        workerFailed = true;
        worker.terminate();
        worker = null;
        jobs.forEach(job => onPage(job.data).then(job.resolve, job.reject));
        jobs.clear();
      };
    } catch (e) { workerFailed = true; worker = null; }
  }
  if (!worker) return onPage(data);
  return new Promise((resolve, reject) => {
    let id = ++jobSerial;
    jobs.set(id, {resolve, reject, data});
    worker.postMessage({job: id, world: data});
  });
}

function render(world) {
  if (!mounted) mount();
  let root = world.root;
  let defs = document.createElementNS(NS, 'defs');
  root.insertBefore(defs, root.firstChild);
  let ribbons = document.createElementNS(NS, 'g');
  ribbons.setAttribute('class', 'realm-ribbons');
  root.insertBefore(ribbons, root.querySelector('#lines'));
  let marks = document.createElementNS(NS, 'g');
  marks.setAttribute('class', 'realm-marks');
  root.appendChild(marks);
  let slots = slotsFor(world);
  let done;
  world.realm = {defs, ribbons, marks, slots, chosen: undefined, level: null, people: 0, land: 0, key: '',
    painted: new Promise(resolve => { done = resolve; })};
  world.realm.done = done;
  plan(world);
  world.items.forEach(item => {
    let slot = slots.get(item.index);
    item.path.setAttribute('class', item.path.getAttribute('class').replace(/\b(land|realm-c)-?\d\b/, 'realm-c' + slot));
    item.realm = null;
    item.font = 0;
    item.label.classList.add('hidden');
    world.realm.people += item.country.population;
    world.realm.land += item.area;
  });
  if (!terrain) { done(); return; }
  let t = performance.now();
  // the preparation is kept on the build result, which stays the same object when the page draws
  // the world again (a style switch, before and after an edit): coming back to this style reuses it
  let result = world.result, seed = seedOf();
  let cached = result && result.realmPrep && result.realmPrep.seed === seed ? Promise.resolve(result.realmPrep.prep) : null;
  (cached || prepareAsync(world)).then(prep => {
    if (result && !cached) result.realmPrep = {seed, prep};
    if (!active() || !terrain) { done(); return; }
    terrain.addWorld(world, prep, seed);
    stats.prepare = Object.assign({}, prep.ms, {wallMs: Math.round(performance.now() - t), cached: !!cached});
    if (current === world) { world.realm.key = ''; paint(world, currentSelected); }
  }, error => { if (mounted) { console.warn('realm: no painted terrain', error); goFlat(); } done(); });
}
function goFlat() {
  if (!mounted) return;
  flat = true;
  stats.mode = 'flat';
  html.classList.add('realm-flat');
  if (terrain) terrain.destroy();
  terrain = null;
  // whatever waited for a painting waits no more
  if (current && current.realm) current.realm.done();
}

// what the SVG shows now: the viewport's translate and scale
function viewOf() {
  let t = document.getElementById('viewport').getAttribute('transform') || '';
  let m = /translate\(([-\d.e+]+)[ ,]+([-\d.e+]+)\)\s*scale\(([-\d.e+]+)\)/.exec(t);
  return m ? {x: +m[1], y: +m[2], k: +m[3]} : null;
}
let current = null, currentSelected = null;
function paint(world, selected) {
  if (!world || !world.realm) return;
  if (!terrain) { world.realm.done(); return; }
  let v = viewOf();
  if (!v) return;
  let dark = night();
  let near = new Set(selected ? world.neighbours[selected.index] : []);
  let key = [v.x, v.y, v.k, world.level, dark, selected ? selected.index : -1, innerWidth, innerHeight, devicePixelRatio].join(',');
  if (world.realm.key === key) return;
  // The terrain keeps what it prepared for two worlds only (GPU memory). A world shown again after it
  // was let go (Undo or Back to an earlier map, Show before) gets it back from its build result,
  // where the preparation stays: unpainted, the canvas would go on showing its last picture, of
  // another world at another zoom, under this one
  let prep = world.result && world.result.realmPrep;
  if (!terrain.has(world) && prep) terrain.addWorld(world, prep.prep, prep.seed);
  let t = performance.now(), result;
  try {
    result = terrain.draw(world, v, {night: dark, pal: dark ? PAL_NIGHT : PAL_DAY, slots: world.realm.slots, selected: selected ? selected.index : null, near});
  } catch (e) { console.warn('realm: terrain failed', e); goFlat(); return; }
  // (and while it cannot paint this view, no picture at all rather than one of something else)
  terrain.canvas.style.visibility = result ? '' : 'hidden';
  if (!result) return;           // not prepared yet: painted when it is
  world.realm.key = key;
  stats.draws++;
  stats.lastMs = performance.now() - t;
  stats.gl = terrain.stats();
  if (/realm-gpu/.test(query())) stats.gpuMs = terrain.finish();
  world.realm.done();
}
function settled(world) {
  if (!world || !world.realm) return Promise.resolve();
  // (never wait for ever: a lost context or a slow device still gets its map)
  return Promise.race([world.realm.painted, new Promise(resolve => setTimeout(resolve, 10000))]);
}

function view(world, state, selected) {
  let k = state.k, a = world.realm;
  if (!a || !active()) return;
  current = world;
  currentSelected = selected;
  paint(world, selected);
  let [W, H] = screenSize;
  world.items.forEach(item => {
    if (item.realm || (item.size * k < 40 && item !== selected)) return;
    let x = state.x + k * item.pole.x, y = state.y - k * item.pole.y, r = 1.5 * item.size * k;
    if (item !== selected && (x + r < 0 || x - r > W || y + r < 0 || y - r > H)) return;
    place(item, world, k, selected);
  });
  world.items.forEach(item => {
    let s = item.realm;
    if (!s || item.label.classList.contains('hidden')) return;
    let f = Math.min(s.font, s.px / k);
    if (Math.abs(f - s.shown) > 1e-9 * s.font) { item.label.setAttribute('font-size', f); s.shown = f; }
    if (item === selected) return;
    let b = screenBox(item, state);
    if (b[2] < -20 || b[0] > W + 20 || b[3] < -20 || b[1] > H + 20) item.label.classList.add('hidden');
  });
  // the chosen country: a gilt ribbon along its outline
  if (a.chosen !== selected || a.level !== world.level) {
    a.chosen = selected;
    a.level = world.level;
    a.ribbons.textContent = '';
    if (selected) {
      world.lineItems.forEach(line => {
        if (line.a !== selected.index && line.b !== selected.index) return;
        let r = document.createElementNS(NS, 'path');
        r.setAttribute('d', line.node.getAttribute('d'));
        r.setAttribute('class', 'realm-ribbon');
        r.__line = line;
        a.ribbons.appendChild(r);
      });
    }
    world.items.forEach(it => { if (it.realm) it.label.classList.toggle('realm-dim', it.path.classList.contains('dim')); });
  }
  for (let r of a.ribbons.children) r.classList.toggle('hidden', r.__line.node.classList.contains('hidden'));
  world.lineItems.forEach(line => line.node.classList.toggle('realm-fine', line.size * k < 32));
  markerNames(world, state, selected);
  scale(world, k);
}

// ---------------------------------------------------------------------------------------------
// Names beside the rings of countries too small to see (after the atlas)
const MARK_PX = 11;
let panels = [], panelsDue = false;
function screenBox(item, state) {
  let s = item.realm, p = s.p, k = state.k;
  let cx = state.x + k * p.x, cy = state.y - k * p.y;
  let hw = p.w * s.shown * k / 2, hh = (p.lines.length === 1 ? 0.75 : 1.9) * s.shown * k / 2;
  let c = Math.abs(Math.cos(p.a)), sn = Math.abs(Math.sin(p.a));
  let ex = hw * c + hh * sn, ey = hw * sn + hh * c;
  if (p.curve) ey += Math.abs(p.curve.A) * (p.w * s.font / 2) ** 2 * k;
  return [cx - ex, cy - ey, cx + ex, cy + ey];
}
function markerNames(world, state, selected) {
  let a = world.realm, k = state.k;
  let [W, H] = screenSize;
  let box = world.box, wide = (box.maxX - box.minX) * k / W;
  let rings = world.items.filter(item => !item.marker.classList.contains('hidden') && (wide > 2.4 || item === selected));
  if (!rings.length && !a.marked) return;
  a.marked = rings.length > 0;
  let taken = panels.slice();
  if (!panelsDue) {
    panelsDue = true;
    requestAnimationFrame(() => setTimeout(() => {
      panelsDue = false;
      if (!active()) return;
      panels = [];
      for (let sel of ['header.cartouche', '#info', '#realm-scale', '#credit']) {
        let el = document.querySelector(sel), r = el && !el.hidden && el.getBoundingClientRect();
        if (r && r.width) panels.push([r.left - 4, r.top - 4, r.right + 4, r.bottom + 4]);
      }
    }, 0));
  }
  world.items.forEach(item => {
    if (item.realm && !item.label.classList.contains('hidden')) taken.push(screenBox(item, state));
  });
  let at = item => [state.x + k * item.pole.x, state.y - k * item.pole.y];
  rings.forEach(item => { let [x, y] = at(item); taken.push([x - 7, y - 7, x + 7, y + 7]); });
  rings.sort((p, q) => (q === selected) - (p === selected) || q.country.population - p.country.population);
  let onScreen = rings.filter(item => { let [x, y] = at(item); return x > 0 && y > 0 && x < W && y < H; });
  if (onScreen.length > 12) rings = rings.filter(item => item === selected);
  let shownSet = new Set();
  let free = r => r[0] >= 12 && r[1] >= 12 && r[2] <= W - 12 && r[3] <= H - 12 &&
    !taken.some(t => r[0] < t[2] && r[2] > t[0] && r[1] < t[3] && r[3] > t[1]);
  for (let item of rings) {
    let [x, y] = at(item);
    if (x < 0 || y < 0 || x > W || y > H) continue;
    let name = item.country.name.trim();
    let w = advance(name, IT500) * MARK_PX + 2, h = MARK_PX * 0.9, g = 8;
    let options = [
      ['start', x + g, y, [x + g, y - h / 2, x + g + w, y + h / 2]],
      ['end', x - g, y, [x - g - w, y - h / 2, x - g, y + h / 2]],
      ['middle', x, y - g - h / 2, [x - w / 2, y - g - h, x + w / 2, y - g]],
      ['middle', x, y + g + h / 2, [x - w / 2, y + g, x + w / 2, y + g + h]],
    ];
    let pick = options.find(o => free(o[3]));
    if (!pick) continue;
    taken.push(pick[3]);
    shownSet.add(item);
    let t = item.realmMark;
    if (!t) {
      t = item.realmMark = document.createElementNS(NS, 'text');
      t.setAttribute('class', 'label realm-mark');
      t.textContent = name;
      a.marks.appendChild(t);
    }
    t.setAttribute('x', (pick[1] - state.x) / k);
    t.setAttribute('y', (pick[2] - state.y) / k);
    t.setAttribute('font-size', MARK_PX / k);
    t.style.textAnchor = pick[0];
    t.classList.toggle('lit', item === selected);
    t.classList.remove('hidden');
  }
  world.items.forEach(item => { if (item.realmMark && !shownSet.has(item)) item.realmMark.classList.add('hidden'); });
}

// ---------------------------------------------------------------------------------------------
// The legend: on this map area stands for people, so its key is a square and how many live in it
const NUMBERS = [];
for (let e = 2; e <= 9; ++e) for (let m of [1, 2.5, 5]) NUMBERS.push(m * 10 ** e);
const SHARES = [];   // per cent
for (let e = -4; e <= 1; ++e) for (let m of [1, 2.5, 5]) SHARES.push(+(m * 10 ** e).toPrecision(2));
const WORDS = n => {
  if (n >= 1e9) return (n / 1e9) + ' billion';
  if (n >= 1e6) return (n / 1e6) + ' million';
  if (n >= 1e3) return (n / 1e3).toLocaleString('en-US') + ' thousand';
  return String(n);
};
let legend = null;
function scale(world, k) {
  if (!legend) return;
  let perPerson = world.realm.land / world.realm.people;
  // (a graph from a file is sized by something else than people: the square is a share of it)
  // (and the countries sized by land or GDP come with round amounts of that: result.legend)
  let measure = world.result.measure, given = world.result.legend;
  let sizes = given ? given.steps : measure ? SHARES.map(p => ({n: p / 100 * world.realm.people, words: p + '% of it'})) : NUMBERS.map(n => ({n, words: WORDS(n) + ' people'}));
  let best = null;
  for (let size of sizes) {
    let side = k * Math.sqrt(size.n * perPerson);
    let fit = Math.abs(Math.log(side / 24));
    if (side <= 34 && (!best || fit < best.fit)) best = {...size, side, fit};
  }
  if (!best) best = {...sizes[0], side: k * Math.sqrt(sizes[0].n * perPerson)};
  let s = Math.max(2, Math.min(34, best.side));
  legend.square.style.width = legend.square.style.height = s + 'px';
  legend.box.hidden = false;
  let cap = given ? given.cap : 'Land is ' + (measure || 'people');
  if (legend.cap.textContent !== cap) legend.cap.textContent = cap;
  if (legend.text.textContent !== best.words) legend.text.textContent = best.words;
}

// ---------------------------------------------------------------------------------------------
// ---- mounting: the painted layer, the legend, and what watches the page
let watchers = [];
function mount() {
  if (mounted || !active()) return;
  mounted = true;
  let plate = document.getElementById('plate'), svg = document.getElementById('map');
  software = '';
  flat = false;
  stats.mode = 'gl';
  if (/realm-flat/.test(query())) goFlat();
  else if (plate && svg) {
    let t = createTerrain(plate, svg, {force: /realm-gl/.test(query()), adapt: /realm-adapt/.test(query()), onLost: goFlat});
    if (t && !t.software) terrain = t;
    else { software = t ? t.software : ''; stats.software = software; goFlat(); }
  }
  if (!document.getElementById('realm-scale')) {
    let box = document.createElement('div');
    box.id = 'realm-scale';
    box.hidden = true;
    box.innerHTML = `<div class="sq-wrap" aria-hidden="true"><div class="sq"></div></div><div><div class="cap">Land is people</div><div class="val">this square holds <span></span></div></div>`;
    document.body.insertBefore(box, document.getElementById('credit'));
    legend = {box, square: box.querySelector('.sq'), cap: box.querySelector('.cap'), text: box.querySelector('.val span')};
  }
  // a theme change repaints the land; so does anything else moving the map by rewriting its
  // transform (a test harness, say)
  let repaint = () => { if (active() && current) { current.realm.key = ''; paint(current, currentSelected); } };
  let mql = matchMedia('(prefers-color-scheme: dark)');
  mql.addEventListener('change', repaint);
  let themeObs = new MutationObserver(repaint);
  themeObs.observe(html, {attributes: true, attributeFilter: ['data-theme']});
  let vp = document.getElementById('viewport'), vpObs = null;
  if (vp) {
    vpObs = new MutationObserver(() => requestAnimationFrame(() => { if (active() && current) paint(current, currentSelected); }));
    vpObs.observe(vp, {attributes: true, attributeFilter: ['transform']});
  }
  addEventListener('resize', onResize);
  watchers = [() => mql.removeEventListener('change', repaint), () => themeObs.disconnect(), () => vpObs && vpObs.disconnect(),
    () => removeEventListener('resize', onResize)];
}
// Leaves the page as if the style had never run: the canvas and its GL context go, the worker
// stops, the watchers stop, and the legend is as it was
function unmount() {
  if (!mounted) return;
  mounted = false;
  if (terrain) terrain.destroy();
  terrain = null;
  flat = false;
  html.classList.remove('realm-flat');
  watchers.forEach(stop => stop());
  watchers = [];
  if (worker) worker.terminate();
  worker = null;
  jobs.forEach(job => job.reject(new Error('the style was switched away')));
  jobs.clear();
  let box = document.getElementById('realm-scale');
  if (box) box.remove();
  legend = null;
  if (current && current.realm) current.realm.done();
  current = null;
  currentSelected = null;
  stats.mode = 'none';
}

if (typeof window !== 'undefined') {
  window.mapStyles = window.mapStyles || {};
  window.mapStyles.realm = {ripples: [], markerPx: 5, render, view, settled, unmount};
}
if (active()) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
