// Kinpeki (金碧, "gold and blue-green"): the world as a gold-leaf folding screen of the Momoyama and
// early Edo periods, the kind once painted with a world map and paired with a screen of the
// peoples of the world. By night the same screen in black lacquer and gold (maki-e).
//
// The page calls these hooks (window.mapStyles.kinpeki) when html has data-style="kinpeki":
//   ripples   none: the water is drawn in the canvas under the map
//   markerPx  the radius of the ring round a country too small to see
//   render    once per drawn world: mineral colours, names, and the sea worked out (in a worker)
//   view      after every redraw: names for the zoom, the chosen country, the sea redrawn
//   settled   a promise the page waits for before it calls the map ready: the sea is drawn
// and it dresses the title card, the seal and the scale once at load.
import {createSea} from './kinpeki-gl.js';
import {buildSea, lineVertices} from './kinpeki-sea.js';

const NS = 'http://www.w3.org/2000/svg';
const html = typeof document === 'undefined' ? null : document.documentElement;
const active = () => html && html.dataset.style === 'kinpeki';

// ---------------------------------------------------------------------------------------------
// Names. Advance widths (em) of Shippori Mincho B1, so names are fitted before the font has
// loaded and the same way on every device. CAPS: weight 600, used for capitals; TEXT: weight 500.
const CHARS = " ,-.'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const TEXT = [0.256, 0.243, 0.286, 0.259, 0.21, 0.774, 0.731, 0.723, 0.789, 0.733, 0.697, 0.755, 0.887, 0.416, 0.454, 0.821, 0.722, 1.003, 0.818, 0.781, 0.673, 0.805, 0.77, 0.655, 0.757, 0.818, 0.774, 1.038, 0.76, 0.758, 0.609, 0.557, 0.592, 0.515, 0.593, 0.547, 0.37, 0.601, 0.635, 0.325, 0.255, 0.6, 0.327, 0.957, 0.637, 0.579, 0.614, 0.581, 0.447, 0.502, 0.344, 0.616, 0.56, 0.797, 0.583, 0.563, 0.488];
const CAPS = [0.254, 0.236, 0.3, 0.268, 0.222, 0.785, 0.745, 0.73, 0.796, 0.745, 0.708, 0.765, 0.885, 0.424, 0.471, 0.83, 0.732, 0.993, 0.811, 0.79, 0.691, 0.809, 0.782, 0.659, 0.77, 0.821, 0.778, 1.054, 0.775, 0.761, 0.625, 0.563, 0.604, 0.521, 0.608, 0.551, 0.385, 0.61, 0.641, 0.333, 0.271, 0.613, 0.336, 0.957, 0.641, 0.582, 0.621, 0.592, 0.457, 0.505, 0.361, 0.627, 0.562, 0.811, 0.59, 0.568, 0.495];
const advance = (text, table) => {
  let w = 0;
  for (let ch of text) { let i = CHARS.indexOf(ch); w += i >= 0 ? table[i] : 0.6; }
  return w;
};

// A hierarchy by people: the great countries in widely spaced capitals, then closer capitals,
// then the smaller ones in upper and lower case.
// rel: largest size as a share of the country's width; px: largest size on screen; spacing in em
const TIERS = [
  {min: 1e8, caps: true, rel: 0.2, px: 40, spacing: [0.32, 0.8]},
  {min: 3e7, caps: true, rel: 0.19, px: 28, spacing: [0.22, 0.5]},
  {min: 5e6, caps: true, rel: 0.18, px: 21, spacing: [0.14, 0.3]},
  {min: 5e5, caps: false, rel: 0.17, px: 17, spacing: [0.03, 0.08]},
  {min: 0, caps: false, rel: 0.17, px: 15, spacing: [0.02, 0.04]},
];

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
    let half = h * f / 2 + f * 0.12;
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
// Where and how big a country's name goes: the best of horizontal and along the long axis, on one
// line or two; long bent countries get their name along the bend
function placeName(item, lower = false, abbr = false) {
  let c = item.country, name = (abbr ? item.abbr : c.name).trim();
  let tier = TIERS.find(t => c.population >= t.min);
  // a name in capitals that would be too small to read: in upper and lower case, a third narrower
  if (lower && tier.caps) tier = {...tier, caps: false, px: Math.round(tier.px * 0.85), spacing: [0.03, 0.08], lower: true};
  if (abbr) tier = {...tier, short: true};
  let text = tier.caps ? name.toUpperCase() : name;
  let table = tier.caps ? CAPS : TEXT;
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
  let s0 = tier.spacing[0];
  let width = lines => Math.max(...lines.map(l => advance(l, table) + s0 * Math.max(0, l.length - 1)));
  let limit = tier.rel * item.size;
  let pick = null;
  for (let lines of layouts) for (let a of angles) {
    let ux = Math.cos(a), uy = Math.sin(a);
    let w = width(lines), h = lines.length === 1 ? 0.78 : 2.0;
    for (let shift of a === 0 && elong < 1.25 ? [0] : [0, -0.3, 0.3]) {
      let x = item.pole.x + shift * item.pole.r * ux, y = item.pole.y + shift * item.pole.r * uy;
      let f = fitFont(ring, x, y, ux, uy, w, h, limit);
      let score = f * (a === 0 ? 1 : 0.86) * (lines.length === 1 ? 1 : 0.9);
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
  let half = w * f / 2, r = pick.h * f / 2 + f * 0.12, nx = -pick.uy, ny = pick.ux;
  for (let k = -4; k <= 4; ++k) {
    let t = k / 4 * half, sv = c.A * t * t + c.B * t + c.C;
    let x = pick.x + t * pick.ux + sv * nx, y = pick.y + t * pick.uy + sv * ny;
    if (!clear(ring, x, y, r) || !inside(ring, x, y)) return false;
  }
  return true;
}

let curves = 0;
// The plan a name is lettered with at zoom k: in capitals, or in upper and lower case where the
// capitals would be under 9 px and the other fits bigger
// Where names go depends only on the world's geometry: the fits are kept per build result, so a
// world drawn again from it (a style switch and back) letters its names straight away
const fits = new WeakMap();
function fitsOf(world) {
  let key = world.result || world;
  if (!fits.has(key)) fits.set(key, new Map());
  return fits.get(key);
}
function remember(world) {
  let f = fitsOf(world);
  for (let item of world.items) {
    let old = f.get(item.index);
    if (old) { item.kpPlan = item.kpPlan || old.plan; item.kpLower = item.kpLower || old.lower; item.kpAbbr = item.kpAbbr || old.abbr; }
  }
  world.kp.fits = f;
}
function keep(world, item) {
  if (world.kp && world.kp.fits) world.kp.fits.set(item.index, {plan: item.kpPlan, lower: item.kpLower, abbr: item.kpAbbr});
}
function planAt(item, k) {
  let p = item.kpPlan || (item.kpPlan = placeName(item));
  let size = q => q.f * (q.tier.caps ? 1.12 : 1);
  if (size(p) * k < 9 && p.tier.caps) {
    let q = item.kpLower || (item.kpLower = placeName(item, true));
    if (q.f > size(p)) p = q;
  }
  // still too small: the page's short form of the name (Switz., C.A.R.), where there is one
  if (size(p) * k < 9 && item.abbr && item.abbr !== item.country.name) {
    let q = item.kpAbbr || (item.kpAbbr = placeName(item, true, true));
    if (q.f > size(p)) p = q;
  }
  return p;
}
function letter(item, world, k) {
  let label = item.label;
  let p = planAt(item, k);
  keep(world, item);
  let deg = -p.a * 180 / Math.PI;
  label.setAttribute('class', 'label kp-name kp-t' + TIERS.indexOf(p.tier) + ' kp-on-' + item.kpSlot);
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
    let id = 'kp-curve-' + (++curves);
    path.setAttribute('id', id);
    path.setAttribute('d', `M ${a0[0]} ${a0[1]} Q ${ctrl[0]} ${ctrl[1]} ${a1[0]} ${a1[1]}`);
    world.kp.defs.appendChild(path);
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
  item.font = p.f * (p.tier.caps ? 1.12 : 1);
  item.labelFits = p.w * p.f;
  item.kp = {font: p.f, px: p.tier.px, shown: p.f, p, lower: !!p.tier.lower, short: !!p.tier.short};
  labelState(item, world);
}
function labelState(item, world) {
  let label = item.label, chosen = world.kp.chosen === item;
  label.classList.toggle('kp-dim', item.path.classList.contains('dim'));
  label.classList.toggle('kp-chosen-name', chosen);
}
function plan(world) {
  let queue = world.items.slice().sort((p, q) => q.size - p.size);
  let later = window.requestIdleCallback || (f => setTimeout(() => f({timeRemaining: () => 10}), 30));
  let step = deadline => {
    if (!active()) return;   // (another style is shown: stop)
    while (queue.length && deadline.timeRemaining() > 1) {
      let item = queue.shift();
      if (!item.kp && !item.kpPlan) { item.kpPlan = placeName(item); keep(world, item); }
    }
    if (queue.length) later(step);
  };
  later(step);
}
function place(item, world, k, selected) {
  letter(item, world, k);
  let show = (item.font * k >= 9 && item.labelFits * k >= 18) || item === selected;
  item.label.classList.toggle('hidden', !show);
}

// ---------------------------------------------------------------------------------------------
// Mineral colours. Eight pigments; neighbours never share one. The great countries take the quiet
// grounds (shell white, pale malachite, celadon, ibis pink), the rest any, so the small ones sit
// among them like the bright accents of a screen. A country's first choice comes from its code,
// so it keeps its colour through edits unless a new neighbour has it.
// Five mineral pigments (land-0 … land-4) and a sixth kept for a country whose neighbours already
// use all five (none needs it on this graph). Neighbours never share a pigment; each country takes
// the one farthest, by eye (CIELAB), from its neighbours' (DSatur order: the most constrained
// first), with a light hand towards using all five about equally. A country that had a pigment
// before an edit keeps it while no new neighbour has it.
const PIGMENTS = ['#efe7d3', '#b5d49a', '#f0b7a0', '#b0a4d6', '#8fc3bf'];
const RESERVE = 5;
function cielab(hex) {
  let f = u => { u /= 255; return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4; };
  let [r, g, b] = [1, 3, 5].map(i => f(parseInt(hex.slice(i, i + 2), 16)));
  let X = 0.4124 * r + 0.3576 * g + 0.1805 * b, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  let t = v => v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
  let fx = t(X / 0.9505), fy = t(Y), fz = t(Z / 1.089);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
const LAB = PIGMENTS.map(cielab);
const APART = LAB.map(a => LAB.map(b => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])));
function codeHash(id) {
  let h = 2166136261;
  for (let ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  h ^= h >>> 15; h = Math.imul(h, 2246822507); h ^= h >>> 13;
  return ((h >>> 0) + 0.5) / 4294967297;
}
// country id -> pigment in the world without edits, per world number. The page always draws that
// world first, so an edited map (by link or by hand) starts from the same colours.
const remembering = new Map();
const coloured = new WeakMap();   // build result -> its pigments: the same world, the same colours
function colourSlots(world) {
  let key = world.result;
  if (key && coloured.has(key)) return coloured.get(key);
  let slots = colourWorld(world);
  if (key) coloured.set(key, slots);
  return slots;
}
function colourWorld(world) {
  let seed = (/^#world-(\d+)/.exec(decodeURIComponent(location.hash)) || [0, '1'])[1];
  let remembered = remembering.get(seed) || new Map();
  let slots = new Map(), live = world.items.map(it => it.index), byIndex = world.byIndex;
  let near = i => (world.neighbours[i] || []).filter(j => byIndex.has(j));
  let count = new Array(PIGMENTS.length + 1).fill(0);
  let left = new Set(live);
  while (left.size) {
    // the country with the most different pigments around it, then the most neighbours
    let pick = null, ps = -1, pd = -1, ph = -1;
    for (let i of left) {
      let s = new Set(near(i).map(j => slots.get(j)).filter(c => c !== undefined)).size, d = near(i).length;
      let h = codeHash(byIndex.get(i).country.id);
      if (s > ps || (s === ps && (d > pd || (d === pd && h > ph)))) { pick = i; ps = s; pd = d; ph = h; }
    }
    left.delete(pick);
    let used = near(pick).map(j => slots.get(j)).filter(c => c !== undefined && c !== RESERVE);
    let id = byIndex.get(pick).country.id, before = remembered.get(id);
    let best = -1, bs = -Infinity;
    for (let c = 0; c < PIGMENTS.length; ++c) {
      if (used.includes(c)) continue;
      let apart = Math.min(40, used.length ? Math.min(...used.map(u => APART[c][u])) : 40);
      let s = apart - 12 * count[c] / live.length * PIGMENTS.length + 2 * codeHash(id + c) + (c === before ? 30 : 0);
      if (s > bs) { bs = s; best = c; }
    }
    if (best < 0) best = RESERVE;
    slots.set(pick, best);
    count[best]++;
  }
  if (!remembering.has(seed)) remembering.set(seed, new Map(world.items.map(it => [it.country.id, slots.get(it.index)])));
  return slots;
}

// ---------------------------------------------------------------------------------------------
// The sea: worked out in a worker (once per world), drawn into the canvas under the map
let canvas = null, sea = null, shownSea = null;
let worker = null, jobs = new Map(), jobId = 0;
function seaOf(world, onFine) {
  let countries = world.items.map(item => ({index: item.index, rings: item.country.rings.map(r => r.map(([x, y]) => [x, -y]))}));
  let input = {countries, box: world.box};
  return new Promise(resolve => {
    let here = () => {
      let sea = null;
      try { sea = buildSea(input); } catch (e) { console.error(e); }
      resolve(sea);
      if (sea && sea.refine) setTimeout(() => { try { onFine(sea.refine()); } catch (e) { console.error(e); } }, 50);
    };
    if (worker === null) {
      try { worker = new Worker(new URL('./kinpeki-worker.js', import.meta.url), {type: 'module'}); } catch (e) { worker = false; }
      if (worker) {
        worker.onmessage = ({data}) => {
          let job = jobs.get(data.id);
          if (!job) return;
          if (data.fine) { jobs.delete(data.id); job.fine(data.fine, data.fineVertices); }
          else { job.done(data.sea || null); if (!data.sea) jobs.delete(data.id); }
        };
        worker.onerror = e => {
          e.preventDefault();
          worker.terminate();
          worker = false;
          let waiting = Array.from(jobs.values());
          jobs.clear();
          waiting.forEach(job => job.done(undefined));
        };
      }
    }
    if (!worker) { setTimeout(here, 0); return; }
    let id = ++jobId;
    jobs.set(id, {done: result => { if (result === undefined) here(); else resolve(result); }, fine: onFine});
    worker.postMessage({id, ...input});
  });
}

// The colours the canvas paints with, read from the theme's custom properties
let look = null;
function readLook() {
  let cs = getComputedStyle(html);
  let rgb = name => {
    let v = cs.getPropertyValue(name).trim();
    let m = /^#([0-9a-f]{6})$/i.exec(v);
    if (!m) return [0.5, 0.5, 0.5];
    let n = parseInt(m[1], 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  };
  let num = (name, d) => { let v = parseFloat(cs.getPropertyValue(name)); return isNaN(v) ? d : v; };
  return {
    deep: rgb('--kp-deep'), shallow: rgb('--kp-shallow'),
    wave: rgb('--kp-wave'), waveHi: rgb('--kp-wave-hi'),
    gold: rgb('--kp-gold'), goldHi: rgb('--kp-gold-hi'), goldLo: rgb('--kp-gold-lo'), cloudLine: rgb('--kp-cloud-line'),
    mottle: num('--kp-mottle', 0.05), grain: num('--kp-grain', 0.02), flecks: num('--kp-flecks', 0),
    waveAlpha: [num('--kp-wave-a0', 0.9), num('--kp-wave-a1', 0.7), num('--kp-wave-a2', 0.5)],
    waveMax: num('--kp-wave-max', 1.4), gap: num('--kp-gap', 4), cloudShadow: num('--kp-cloud-shadow', 0.3),
    lightDir: [0.8, -0.6], lamp: null, maxDpr: num('--kp-max-dpr', 2), softwareDpr: num('--kp-software-dpr', 1),
  };
}
let lastView = null, lastWorld = null, draws = 0;
// where the legend, the credit, the title card and the country panel sit (css px): no cloud is
// drawn under them. Noted when they change
// size, never asked for during a redraw.
let holes = [];
function noteHoles() {
  let next = [];
  for (let sel of ['#kp-scale', '#credit', 'header.cartouche', '#info']) {
    let el = document.querySelector(sel);
    let r = el && !el.hidden && el.getBoundingClientRect();
    if (r && r.width) next.push([r.left - 6, r.top - 6, r.right + 6, r.bottom + 6]);
  }
  if (JSON.stringify(next) !== JSON.stringify(holes)) { holes = next; redrawSea(); }
}
function drawSea(world, view) {
  if (!sea || !active()) return;
  draws++;
  if (!look) look = readLook();
  look.holes = holes;
  // a world whose sea is still being worked out gets the bare ground, not another world's waves
  let data = (world && world.kp && world.kp.sea) || null;
  if (data !== shownSea) { sea.set(data); shownSea = data; }
  lastView = {k: view.k, x: view.x, y: view.y};
  lastWorld = world;
  sea.draw(lastView, look);
}
function redrawSea() {
  if (!active()) return;
  if (lastWorld && lastView) drawSea(lastWorld, lastView);
  else if (sea) { if (!look) look = readLook(); sea.draw({k: 1, x: 0, y: 0}, look); }   // the bare ground, while the world is drawn
}

// ---------------------------------------------------------------------------------------------
// Close views. Hills in the Rinpa manner: low rounded mounds in ranges of three to five, in a
// deeper tone of their country's pigment, outlined, with a light stroke along the lit shoulder.
// They are placed in the worker along noise ridges, well inside their country, and never under its
// name; a range shows while it is 30 to 260 px wide on screen. Each country's hills are a group of
// their own, so they fade with it when another country is chosen.
// And from reading zoom in, the land is washi: the pigment laid on paper whose fibres show.
const HILL_MIN = 30, HILL_MAX = 260;
function hill(cx, b, w, h) {
  let l = cx - w / 2, r = cx + w / 2, t = b - h;
  let curve = `M ${l} ${b} C ${l + w * 0.14} ${b - h * 0.72} ${cx - w * 0.17} ${t} ${cx} ${t} C ${cx + w * 0.17} ${t} ${r - w * 0.14} ${b - h * 0.72} ${r} ${b} `;
  let lit = `M ${l + w * 0.16} ${b - h * 0.45} C ${l + w * 0.24} ${b - h * 0.78} ${cx - w * 0.16} ${t + h * 0.14} ${cx - w * 0.03} ${t + h * 0.14} `;
  return {fill: curve + 'Z ', line: curve, lit};
}
// does a range (foot at x, y in screen orientation, about 1.7 s wide) touch the name's box?
function underName(p, x, y, s) {
  let hw = p.w * p.f / 2 + p.f * 0.6, hh = (p.lines.length === 1 ? 0.5 : 1.15) * p.f + p.f * 0.5;
  if (p.curve) hh += Math.abs(p.curve.A) * (p.w * p.f / 2) ** 2;
  for (let t of [-0.6, 0, 0.6]) {
    let px = x + t * s, py = -(y - s * 0.22);   // to world orientation, y up
    let dx = px - p.x, dy = py - p.y;
    let u = dx * p.ux + dy * p.uy, v = -dx * p.uy + dy * p.ux;
    if (Math.abs(u) < hw + s * 0.42 && Math.abs(v) < hh + s * 0.3) return true;
  }
  return false;
}
function hills(world, glyphs, levels) {
  let a = world.kp;
  if (a.hills) a.hills.remove();
  let g = document.createElementNS(NS, 'g');
  g.setAttribute('class', 'kp-terrain');
  world.root.insertBefore(g, world.root.querySelector('#waters'));
  a.hills = g;
  let byKey = new Map();
  for (let m of glyphs) {
    let item = world.byIndex.get(m.country);
    if (!item) continue;
    // no hills under the country's name (in either case it may be lettered in)
    let plans = [item.kpPlan || (item.kpPlan = placeName(item))];
    if (plans[0].tier.caps) plans.push(item.kpLower || (item.kpLower = placeName(item, true)));
    if (plans.some(p => p.f > 0 && underName(p, m.x, m.y, m.s))) continue;
    let key = m.country + ',' + m.level;
    if (!byKey.has(key)) byKey.set(key, {item, level: m.level, d: ['', '', '']});
    let o = byKey.get(key), {x, y, s} = m;
    let count = 3 + (m.v % 3);
    let peaks = [];
    for (let i = 0; i < count; ++i) {
      let t = i / (count - 1) - 0.5;
      let jitter = Math.sin((x + i * 7.3) * 12.9898 + y * 78.233) * 0.5;
      let tall = 1 - Math.abs(t) * 1.1 + 0.15 * jitter;
      peaks.push({cx: x + t * s * 1.2 + jitter * s * 0.05, b: y - s * 0.03 * (1 - Math.abs(t) * 2), w: s * (0.5 + 0.18 * tall), h: s * (0.22 + 0.24 * tall), front: Math.abs(t) < 0.2});
    }
    // the outer hills first, the middle one in front
    peaks.sort((p, q) => p.front - q.front);
    for (let p of peaks) { let q = hill(p.cx, p.b, p.w, p.h); o.d[0] += q.fill; o.d[1] += q.line; o.d[2] += q.lit; }
  }
  a.hillGroups = [];
  for (let o of byKey.values()) {
    let layer = document.createElementNS(NS, 'g');
    layer.setAttribute('class', 'kp-hills hidden kp-hill-' + o.item.kpSlot);
    for (let [cls, d] of [['kp-hf', o.d[0]], ['kp-hl', o.d[1]], ['kp-hs', o.d[2]]]) {
      let path = document.createElementNS(NS, 'path');
      path.setAttribute('class', cls);
      path.setAttribute('d', d);
      layer.appendChild(path);
    }
    g.appendChild(layer);
    a.hillGroups.push({layer, item: o.item, size: levels[o.level], shown: false});
  }
  a.hillsAt = null;
  if (lastView && lastWorld === world) showHills(world, lastView.k);
}
function showHills(world, k) {
  let a = world.kp;
  if (!a.hillGroups) return;
  for (let h of a.hillGroups) {
    let px = h.size * 1.7 * k, show = px >= HILL_MIN && px <= HILL_MAX && h.item.size * k > 60;
    let dim = h.item.path.classList.contains('dim');
    if (show !== h.shown) { h.layer.classList.toggle('hidden', !show); h.shown = show; }
    if (dim !== h.dim) { h.layer.classList.toggle('kp-hill-dim', dim); h.dim = dim; }
  }
}
// Washi: a tile of paper fibres, made once; each pigment a pattern of its colour with the fibres
// over it, sized to stay the same on screen. Countries take it from reading zoom in.
let fibreTile = null;
function fibres(night) {
  let N = 256, c = document.createElement('canvas');
  c.width = c.height = N;
  let g = c.getContext('2d', {willReadFrequently: true});
  if (!g) return null;
  let seed = night ? 5 : 3;
  let rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  // soft pooled blotches of pigment (tarashikomi), then long thin fibres, light and dark
  for (let i = 0; i < 26; ++i) {
    let x = rand() * N, y = rand() * N, r = 20 + rand() * 46, dark = rand() < 0.6;
    let a = (dark ? 0.03 : 0.05) + rand() * 0.03, sx = 0.6 + rand() * 0.8;
    for (let dx of [-N, 0, N]) for (let dy of [-N, 0, N]) {
      g.save();
      g.translate(x + dx, y + dy); g.rotate(rand() * Math.PI); g.scale(sx, 1);
      let gr = g.createRadialGradient(0, 0, 0, 0, 0, r);
      let c = dark ? '60,42,20' : '255,250,235';
      gr.addColorStop(0, `rgba(${c},${a.toFixed(3)})`); gr.addColorStop(0.6, `rgba(${c},${(a * 0.6).toFixed(3)})`); gr.addColorStop(1, `rgba(${c},0)`);
      g.fillStyle = gr; g.fillRect(-r, -r, 2 * r, 2 * r);
      g.restore();
    }
  }
  for (let i = 0; i < 150; ++i) {
    let x = rand() * N, y = rand() * N, len = 14 + rand() * 46, ang = rand() * Math.PI * 2, bend = (rand() - 0.5) * 0.9;
    let light = rand() < 0.7;
    g.strokeStyle = light ? `rgba(255,252,240,${(0.16 + rand() * 0.22).toFixed(2)})` : `rgba(70,50,30,${(0.05 + rand() * 0.06).toFixed(2)})`;
    g.lineWidth = 0.4 + rand() * 0.7;
    for (let dx of [-N, 0, N]) for (let dy of [-N, 0, N]) {
      g.beginPath();
      g.moveTo(x + dx, y + dy);
      g.quadraticCurveTo(x + dx + Math.cos(ang + bend) * len / 2, y + dy + Math.sin(ang + bend) * len / 2, x + dx + Math.cos(ang) * len, y + dy + Math.sin(ang) * len);
      g.stroke();
    }
  }
  return c.toDataURL('image/png');
}
function paperPatterns(world) {
  let a = world.kp;
  if (!fibreTile) {
    // made once, while the page is idle: only a close view shows it
    let day = null;
    idle(() => {
      day = fibres(false);
      idle(() => {
        if (!fibreTile) fibreTile = {day, night: fibres(true)};
        if (active() && world.kp && !world.kp.paper) { paperPatterns(world); if (lastWorld === world && lastView) showPaper(world, lastView.k); }
      });
    });
    return;
  }
  if (!fibreTile.day) return;
  let pats = [];
  for (let n = 0; n <= 5; ++n) {
    let p = document.createElementNS(NS, 'pattern');
    p.setAttribute('id', 'kp-washi-' + n + '-' + (++curves));
    p.setAttribute('patternUnits', 'userSpaceOnUse');
    let bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('class', 'land-' + n);
    bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%');
    let img = document.createElementNS(NS, 'image');
    img.setAttribute('class', 'kp-fibres');
    img.setAttribute('href', fibreTile.day);
    p.append(bg, img);
    a.defs.appendChild(p);
    pats.push({p, img});
  }
  a.paper = {pats, on: false, k: 0};
}
function showPaper(world, k) {
  let a = world.kp, pp = a.paper;
  if (!pp) return;
  let box = world.box, inside = (box.maxX - box.minX) * k / screenSize[0];
  let on = inside > 2.2;
  // (from the theme's settings, not from the computed style: asking for that here would make the
  // browser restyle the whole map in the middle of the redraw)
  let night = html.dataset.theme === 'dark' || (html.dataset.theme !== 'light' && !!window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  if (on && (Math.abs(pp.k / k - 1) > 1e-6 || pp.night !== night)) {
    // 256 css px a tile, at every zoom
    let side = 256 / k;
    for (let {p, img} of pp.pats) {
      p.setAttribute('width', side); p.setAttribute('height', side);
      img.setAttribute('width', side); img.setAttribute('height', side);
      if (pp.night !== night) img.setAttribute('href', night ? fibreTile.night : fibreTile.day);
    }
    pp.k = k; pp.night = night;
  }
  if (on !== pp.on) {
    pp.on = on;
    world.items.forEach(item => {
      if (on) item.path.style.setProperty('--kp-washi', `url(#${pp.pats[item.kpSlot].p.id})`);
      item.path.classList.toggle('kp-paper', on);
    });
  }
}

// The sea depends only on the world's geometry: it is worked out once per build result and kept
// with it, so a world drawn again from the same result (a style switch and back, an undo) reuses it.
// The finest waves arrive later and are added to the same sea.
const seas = new WeakMap();
function seaFor(world) {
  let key = world.result || world;
  let job = seas.get(key);
  if (!job) {
    let holder = {data: null};
    let fine = (strokes, vertices) => {
      let data = holder.data;
      if (!data || !strokes || !strokes.length) return;
      data.strokes = data.strokes.concat(strokes);
      data.fineVertices = vertices || lineVertices(strokes, data.grid, data.domain);
      if (shownSea === data) { shownSea = null; if (lastWorld && lastView && lastWorld.kp.sea === data) drawSea(lastWorld, lastView); }
    };
    job = seaOf(world, fine).then(data => {
      holder.data = data;
      if (!data) seas.delete(key);   // (cut short when the style was switched away: ask again next time)
      return data;
    });
    seas.set(key, job);
  }
  return job;
}

// ---------------------------------------------------------------------------------------------
function render(world) {
  mount();   // (again, after the page switched away and back)
  let root = world.root;
  let ribbons = document.createElementNS(NS, 'g');
  ribbons.setAttribute('class', 'kp-ribbons');
  root.insertBefore(ribbons, root.querySelector('#lines'));
  let defs = document.createElementNS(NS, 'defs');
  root.insertBefore(defs, root.firstChild);
  let marks = document.createElementNS(NS, 'g');
  marks.setAttribute('class', 'kp-marks');
  root.appendChild(marks);
  world.kp = {ribbons, defs, marks, chosen: undefined, level: null, people: 0, land: 0, sea: null};
  remember(world);
  plan(world);
  let slots = colourSlots(world);
  world.items.forEach(item => {
    let slot = slots.get(item.index);
    item.kpSlot = slot;
    item.path.setAttribute('class', item.path.getAttribute('class').replace(/\bland-\d\b/, 'land-' + slot));
    item.kp = null;
    item.font = 0;
    item.label.classList.add('hidden');
    world.kp.people += item.country.population;
    world.kp.land += item.area;
  });
  let started = performance.now();
  // the finest waves come later: add them to the sea and draw it again if it is shown
  paperPatterns(world);
  world.kp.ready = seaFor(world).then(data => {
    world.kp.sea = data;
    world.kp.seaMs = performance.now() - started;
    if (lastWorld === world && lastView) drawSea(world, lastView);
    // the hills only show from reading zoom in: placed when the page is idle, after it is ready
    if (data && data.terrain) {
      let later = window.requestIdleCallback || (f => setTimeout(f, 200));
      later(() => { if (active() && world.kp.sea === data) hills(world, data.terrain, data.terrainLevels); }, {timeout: 3000});
    }
  });
}
// The page waits for this before it says the map is ready: the sea of the world shown is drawn
function settled(world) {
  return (world.kp && world.kp.ready ? world.kp.ready : Promise.resolve()).then(() => {
    if (lastView && active()) drawSea(world, lastView);
  });
}

// ---------------------------------------------------------------------------------------------
let screenSize = typeof window === 'undefined' ? [0, 0] : [innerWidth, innerHeight];

// The names a view needs, biggest country first, within about 40 ms: fitting a name the first time
// is the costly part of a redraw, so what is left over is lettered in the next frames
function names(world, state, selected) {
  let a = world.kp, k = state.k;
  let [W, H] = screenSize;
  if (a.namesDue) { cancelAnimationFrame(a.namesDue); a.namesDue = 0; }
  let order = a.bySize || (a.bySize = world.items.slice().sort((p, q) => q.size - p.size));
  let budget = performance.now() + 40, more = false;
  for (let item of order) {
    if (item.size * k < 22 && item !== selected) continue;
    let x = state.x + k * item.pole.x, y = state.y - k * item.pole.y, r = 1.5 * item.size * k;
    if (item !== selected && (x + r < 0 || x - r > W || y + r < 0 || y - r > H)) continue;
    let fitted = item.kpPlan && (!item.kpPlan.tier.caps || item.kpLower) && (!item.abbr || item.kpAbbr);
    if (item !== selected && !fitted && performance.now() > budget) { more = true; continue; }
    // lettered already, and in the case this zoom wants
    if (item.kp) { let t = planAt(item, k).tier; if (item.kp.lower === !!t.lower && item.kp.short === !!t.short) continue; }
    place(item, world, k, selected);
  }
  world.items.forEach(item => {
    let s = item.kp;
    if (!s || item.label.classList.contains('hidden')) return;
    let f = Math.min(s.font, s.px / k);
    if (Math.abs(f - s.shown) > 1e-9 * s.font) { item.label.setAttribute('font-size', f); s.shown = f; }
    if (item === selected) return;
    let b = screenBox(item, state);
    if (b[2] < -20 || b[0] > W + 20 || b[3] < -20 || b[1] > H + 20) item.label.classList.add('hidden');
  });
  if (more) a.namesDue = requestAnimationFrame(() => {
    a.namesDue = 0;
    if (!active() || lastWorld !== world) return;
    names(world, state, selected);
    markerNames(world, state, selected);
  });
}
function view(world, state, selected) {
  let k = state.k, a = world.kp;
  if (!a || !active()) return;
  mount();
  drawSea(world, state);
  // the map is on the page: the loading card can go while the sea is still being worked out
  if (!html.dataset.kpDrawn) html.dataset.kpDrawn = '1';
  names(world, {k: state.k, x: state.x, y: state.y}, selected);
  // the chosen country: a band of gold along its outline
  if (a.chosen !== selected || a.level !== world.level) {
    if (a.chosen && a.chosen !== selected) a.chosen.path.classList.remove('kp-chosen');
    a.chosen = selected;
    a.level = world.level;
    a.ribbons.textContent = '';
    if (selected) {
      selected.path.classList.add('kp-chosen');
      world.lineItems.forEach(line => {
        if (line.a !== selected.index && line.b !== selected.index) return;
        let r = document.createElementNS(NS, 'path');
        r.setAttribute('d', line.node.getAttribute('d'));
        r.setAttribute('class', 'kp-ribbon');
        r.__line = line;
        a.ribbons.appendChild(r);
      });
    }
    world.items.forEach(it => { if (it.kp) labelState(it, world); });
  }
  markerNames(world, state, selected);
  for (let r of a.ribbons.children) r.classList.toggle('hidden', r.__line.node.classList.contains('hidden'));
  world.lineItems.forEach(line => line.node.classList.toggle('kp-fine', line.size * k < 32));
  showHills(world, k);
  showPaper(world, k);
  scale(world, k);
}

const MARK_PX = 11;
let panels = [], panelsDue = false;
function screenBox(item, state) {
  let s = item.kp, p = s.p, k = state.k;
  let cx = state.x + k * p.x, cy = state.y - k * p.y;
  let hw = p.w * s.shown * k / 2, hh = (p.lines.length === 1 ? 0.75 : 1.9) * s.shown * k / 2;
  let c = Math.abs(Math.cos(p.a)), sn = Math.abs(Math.sin(p.a));
  let ex = hw * c + hh * sn, ey = hw * sn + hh * c;
  if (p.curve) ey += Math.abs(p.curve.A) * (p.w * s.font / 2) ** 2 * k;
  return [cx - ex, cy - ey, cx + ex, cy + ey];
}
// Names beside the rings of countries too small to see, where they fit clear of other names
function markerNames(world, state, selected) {
  let a = world.kp, k = state.k;
  let [W, H] = screenSize;
  let box = world.box, inside = (box.maxX - box.minX) * k / W;
  // (a country big enough to see has its own name: its ring, shown while it is chosen, gets none)
  let rings = world.items.filter(item => !item.marker.classList.contains('hidden') && item.size * k < 3 &&
    (inside > 2.4 || item === selected));
  if (!rings.length && !a.marked) return;
  a.marked = rings.length > 0;
  let taken = panels.slice();
  if (!panelsDue) {
    panelsDue = true;
    requestAnimationFrame(() => setTimeout(() => {
      panelsDue = false;
      panels = [];
      for (let sel of ['header.cartouche', '#info', '#compass', '#kp-scale', '#credit']) {
        let el = document.querySelector(sel), r = el && !el.hidden && el.getBoundingClientRect();
        if (r && r.width) panels.push([r.left - 4, r.top - 4, r.right + 4, r.bottom + 4]);
      }
    }, 0));
  }
  world.items.forEach(item => {
    if (item.kp && !item.label.classList.contains('hidden')) taken.push(screenBox(item, state));
  });
  let at = item => [state.x + k * item.pole.x, state.y - k * item.pole.y];
  rings.forEach(item => { let [x, y] = at(item); taken.push([x - 7, y - 7, x + 7, y + 7]); });
  rings.sort((p, q) => (q === selected) - (p === selected) || q.country.population - p.country.population);
  let shown = new Set();
  let onScreen = rings.filter(item => { let [x, y] = at(item); return x > 0 && y > 0 && x < W && y < H; });
  if (onScreen.length > 12) rings = rings.filter(item => item === selected);
  let free = r => r[0] >= 12 && r[1] >= 12 && r[2] <= W - 12 && r[3] <= H - 12 &&
    !taken.some(t => r[0] < t[2] && r[2] > t[0] && r[1] < t[3] && r[3] > t[1]);
  for (let item of rings) {
    let [x, y] = at(item);
    if (x < 0 || y < 0 || x > W || y > H) continue;
    let name = item.country.name.trim();
    let w = advance(name, TEXT) * MARK_PX + 2, h = MARK_PX * 0.9, g = 8;
    let options = [
      ['start', x + g, y, [x + g, y - h / 2, x + g + w, y + h / 2]],
      ['end', x - g, y, [x - g - w, y - h / 2, x - g, y + h / 2]],
      ['middle', x, y - g - h / 2, [x - w / 2, y - g - h, x + w / 2, y - g]],
      ['middle', x, y + g + h / 2, [x - w / 2, y + g, x + w / 2, y + g + h]],
    ];
    let pick = options.find(o => free(o[3]));
    if (!pick) continue;
    taken.push(pick[3]);
    shown.add(item);
    let t = item.kpMark;
    if (!t) {
      t = item.kpMark = document.createElementNS(NS, 'text');
      t.setAttribute('class', 'label kp-mark');
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
  world.items.forEach(item => { if (item.kpMark && !shown.has(item)) item.kpMark.classList.add('hidden'); });
}

// ---------------------------------------------------------------------------------------------
// The scale: on this map area stands for people, so its scale is a square of gold leaf and how
// many live in one of that size
const NUMBERS = [];
for (let e = 2; e <= 9; ++e) for (let m of [1, 2.5, 5]) NUMBERS.push(m * 10 ** e);
const WORDS = n => {
  if (n >= 1e9) return (n / 1e9) + ' billion';
  if (n >= 1e6) return (n / 1e6) + ' million';
  if (n >= 1e3) return (n / 1e3).toLocaleString('en-US') + ' thousand';
  return String(n);
};
let scaleBox = null;
function scale(world, k) {
  if (!scaleBox) return;
  let perPerson = world.kp.land / world.kp.people;
  let best = null;
  for (let n of NUMBERS) {
    let side = k * Math.sqrt(n * perPerson);
    let fit = Math.abs(Math.log(side / 24));
    if (side <= 34 && (!best || fit < best.fit)) best = {n, side, fit};
  }
  if (!best) best = {n: NUMBERS[0], side: k * Math.sqrt(NUMBERS[0] * perPerson)};
  let s = Math.max(2, Math.min(34, best.side));
  scaleBox.square.style.width = scaleBox.square.style.height = s + 'px';
  scaleBox.box.hidden = false;
  let words = WORDS(best.n) + ' people';
  if (scaleBox.text.textContent !== words) scaleBox.text.textContent = words;
}

// ---------------------------------------------------------------------------------------------
// Decorated paper for the title and the panels, made once here so no image has to be fetched: by
// day a poem paper (ryōshi) with indigo cloud fibres along its top (uchigumori) and flakes and
// slivers of gold leaf scattered over it; by night black lacquer with gold dust (nashiji).
function decoratedPaper(night) {
  let W = 640, H = 440, c = document.createElement('canvas');
  c.width = W; c.height = H;
  // a canvas kept in memory, not on the GPU: turning it into an image then reads nothing back
  let g = c.getContext('2d', {willReadFrequently: true});
  if (!g) return 'none';
  let seed = night ? 11 : 7;
  let rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  if (!night) {
    // cloud fibres: short strokes of indigo, thick at the very top and thinning into wisps
    let edge = x => 20 + 10 * Math.sin(x / 70 + 1.3) + 7 * Math.sin(x / 23 + 0.4) + 6 * Math.sin(x / 151);
    for (let i = 0; i < 2600; ++i) {
      let x = rand() * W, e = edge(x), y = Math.pow(rand(), 1.6) * e * 1.5 - 4;
      let a = 0.05 + 0.22 * Math.max(0, 1 - y / (e * 1.3));
      g.strokeStyle = `rgba(52, 78, 132, ${a.toFixed(3)})`;
      g.lineWidth = 0.5 + rand() * 1.2;
      let len = 4 + rand() * 16, ang = (rand() - 0.5) * 0.9;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); g.stroke();
    }
  }
  // leaf: flakes (kirihaku) in drifts towards the edges, slivers (noge), and dust (sunago). Silver
  // on the day paper, gold on the lacquer.
  let drifts = night ? [[0.95, 0.08], [0.9, 0.95], [0.02, 0.98]] : [[0.97, 0.06], [0.93, 0.97]];
  let gold = night ? (a) => {
    let t = rand();
    return `rgba(${Math.round(196 + 50 * t)}, ${Math.round(158 + 60 * t)}, ${Math.round(70 + 70 * t)}, ${a})`;
  } : (a) => {
    let t = rand();
    return `rgba(${Math.round(168 + 40 * t)}, ${Math.round(176 + 40 * t)}, ${Math.round(188 + 40 * t)}, ${a})`;
  };
  for (let [dx, dy] of drifts) {
    let n = night ? 26 : 34;
    for (let i = 0; i < n; ++i) {
      let r = Math.pow(rand(), 0.7) * 120, th = rand() * Math.PI * 2;
      let x = dx * W + Math.cos(th) * r * 1.5, y = dy * H + Math.sin(th) * r * 0.7;
      let s = 1.5 + Math.pow(rand(), 2) * 7;
      g.save(); g.translate(x, y); g.rotate(rand() * Math.PI);
      g.fillStyle = gold(0.75 + rand() * 0.25);
      g.beginPath(); g.moveTo(-s / 2, -s / 2); g.lineTo(s / 2 + rand() * s * 0.4, -s / 2); g.lineTo(s / 2, s / 2); g.lineTo(-s / 2 - rand() * s * 0.3, s / 2 + rand() * s * 0.2); g.closePath(); g.fill();
      g.restore();
    }
    for (let i = 0; i < 12; ++i) {
      let x = dx * W + (rand() - 0.5) * 260, y = dy * H + (rand() - 0.5) * 110;
      g.save(); g.translate(x, y); g.rotate(rand() * Math.PI);
      g.fillStyle = gold(0.8); g.fillRect(-5 - rand() * 6, -0.4, 10 + rand() * 12, 0.9); g.restore();
    }
    for (let i = 0; i < (night ? 900 : 500); ++i) {
      let r = Math.pow(rand(), 0.5) * 170, th = rand() * Math.PI * 2;
      g.fillStyle = gold((0.35 + rand() * 0.5).toFixed(2));
      g.fillRect(dx * W + Math.cos(th) * r * 1.6, dy * H + Math.sin(th) * r * 0.75, 0.9, 0.9);
    }
  }
  if (night) {
    // sparse dust over the whole lacquer
    for (let i = 0; i < 1400; ++i) { g.fillStyle = gold((0.12 + rand() * 0.3).toFixed(2)); g.fillRect(rand() * W, rand() * H, 0.8, 0.8); }
  }
  return `url(${c.toDataURL('image/png')})`;
}

// ---------------------------------------------------------------------------------------------
// The furniture: the canvas under the map, the title on a decorated poem paper, the seal, the scale
let paperURLs = null;
const idle = f => (window.requestIdleCallback ? requestIdleCallback(f, {timeout: 2000}) : setTimeout(f, 200));
// Mounting: everything the style adds outside the world's svg, and every listener, observer and
// worker it starts, is made here and undone by unmount(), so the page can switch styles and back.
let mounted = null;
function mount() {
  if (mounted || !active()) return;
  let undo = [];
  let on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); undo.push(() => target.removeEventListener(type, fn, opts)); };
  let added = el => undo.push(() => el.remove());
  let plate = document.getElementById('plate'), svg = document.getElementById('map');
  if (plate && svg) {
    canvas = document.createElement('canvas');
    canvas.id = 'kp-sea';
    canvas.setAttribute('aria-hidden', 'true');
    plate.insertBefore(canvas, svg);
    added(canvas);
    try { sea = createSea(canvas); } catch (e) { console.warn('kinpeki: no sea canvas', e); sea = null; }
    // a phone may take the GPU back: draw the sea again when it returns it
    on(canvas, 'webglcontextlost', e => e.preventDefault());
    on(canvas, 'webglcontextrestored', () => {
      try { sea = createSea(canvas); shownSea = undefined; redrawSea(); } catch (e) { sea = null; }
    });
    if (sea) html.dataset.kpSea = sea.kind;
  }
  // the decorated paper of the card and panels: made once, while the page is idle (plain until then)
  let papered = () => {
    if (!active()) return;
    html.style.setProperty('--kp-paper-day', paperURLs.day);
    html.style.setProperty('--kp-paper-night', paperURLs.night);
  };
  if (paperURLs) papered();
  else {
    // (two short tasks, not one long one)
    let made = {};
    let make = night => idle(() => {
      try { made[night ? 'night' : 'day'] = decoratedPaper(night); } catch (e) { made[night ? 'night' : 'day'] = 'none'; }
      if (night) { paperURLs = paperURLs || made; if (mounted === undo) papered(); } else make(true);
    });
    make(false);
  }
  undo.push(() => { html.style.removeProperty('--kp-paper-day'); html.style.removeProperty('--kp-paper-night'); });
  // a new world is being built: the loading card shows again until it is drawn
  let mo = new MutationObserver(() => {
    if (active() && html.dataset.mapState === 'loading') delete html.dataset.kpDrawn;
  });
  mo.observe(html, {attributes: true, attributeFilter: ['data-map-state']});
  // the theme can change under the page: read the colours again then
  let again = () => { look = null; redrawSea(); };
  if (window.matchMedia) {
    let mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) { mq.addEventListener('change', again); undo.push(() => mq.removeEventListener('change', again)); }
  }
  let mt = new MutationObserver(again);
  mt.observe(html, {attributes: true, attributeFilter: ['data-theme']});
  undo.push(() => { mo.disconnect(); mt.disconnect(); });
  on(window, 'resize', () => { screenSize = [innerWidth, innerHeight]; requestAnimationFrame(redrawSea); });
  // the light on the gold follows the pointer (not for those who ask for less motion)
  let still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let due = false;
  let stage = document.getElementById('stage');
  if (!still && stage) {
    on(stage, 'pointermove', e => {
      if (e.pointerType !== 'mouse' || e.buttons || !look) return;
      look.lamp = [e.clientX, e.clientY, Math.max(innerWidth, innerHeight) * 0.22];
      let cx = innerWidth / 2, cy = innerHeight / 2, dx = e.clientX - cx, dy = e.clientY - cy, l = Math.hypot(dx, dy) || 1;
      look.lightDir = [0.8 * 0.6 + 0.4 * dx / l, -0.6 * 0.6 + 0.4 * dy / l];
      let n = Math.hypot(...look.lightDir) || 1;
      look.lightDir = look.lightDir.map(v => v / n);
      if (!due) { due = true; requestAnimationFrame(() => { due = false; redrawSea(); }); }
    });
    // (only for the mouse: a finger leaves the screen at the end of every gesture, and the page
    // redraws then anyway)
    on(stage, 'pointerleave', e => {
      if (e.pointerType === 'mouse' && look && look.lamp) { look.lamp = null; redrawSea(); }
    });
  }
  // the mount round the screen
  let frame = document.createElement('div');
  frame.id = 'kp-frame';
  frame.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(frame, stage ? stage.nextSibling : null);
  added(frame);
  // the seal, in place of the compass: north, in vermilion (the compass is given back on unmount)
  let compass = document.getElementById('compass');
  if (compass) {
    let before = {html: compass.innerHTML, viewBox: compass.getAttribute('viewBox')};
    compass.setAttribute('viewBox', '0 0 60 60');
    compass.innerHTML = `
      <rect class="kp-seal" x="3" y="3" width="54" height="54" rx="5"/>
      <rect class="kp-seal-line" x="7" y="7" width="46" height="46" rx="3"/>
      <path class="kp-seal-cut" d="M30 11 L36 23 L31.6 21.4 L31.6 27 L28.4 27 L28.4 21.4 L24 23 Z"/>
      <text class="kp-seal-cut" x="30" y="47" text-anchor="middle">N</text>`;
    undo.push(() => { compass.innerHTML = before.html; if (before.viewBox) compass.setAttribute('viewBox', before.viewBox); });
  }
  // the scale
  let box = document.createElement('div');
  box.id = 'kp-scale';
  box.setAttribute('aria-label', 'Scale: the area of the square holds this many people');
  box.hidden = true;
  box.innerHTML = `<div class="sq-wrap"><div class="sq"></div></div><div><div class="cap">Scale of people</div><div class="val">the square holds <span></span></div></div>`;
  document.body.insertBefore(box, document.getElementById('credit'));
  added(box);
  scaleBox = {box, square: box.querySelector('.sq'), text: box.querySelector('.val span')};
  undo.push(() => { scaleBox = null; });
  // the clouds keep out from under the legend and the credit: note where they are when they change
  if (window.ResizeObserver) {
    let ro = new ResizeObserver(() => { if (active()) noteHoles(); });
    for (let sel of ['#kp-scale', '#credit', 'header.cartouche', '#info']) { let el = document.querySelector(sel); if (el) ro.observe(el); }
    undo.push(() => ro.disconnect());
  }
  on(window, 'resize', () => requestAnimationFrame(() => { if (active()) noteHoles(); }));
  requestAnimationFrame(() => { if (active()) noteHoles(); });
  undo.push(() => {
    if (sea && sea.dispose) sea.dispose();
    canvas = null; sea = null; shownSea = null; look = null; lastView = null; lastWorld = null; holes = [];
    if (worker) { worker.terminate(); worker = null; }
    // seas still being worked out: their worlds are dropped with this style (the page draws them
    // again if it comes back), so their promises settle with no sea
    let waiting = Array.from(jobs.values());
    jobs.clear();
    waiting.forEach(job => job.done(null));
    delete html.dataset.kpSea;
    delete html.dataset.kpDrawn;
  });
  mounted = undo;
  redrawSea();
}
function unmount() {
  if (!mounted) return;
  let undo = mounted;
  mounted = null;
  for (let i = undo.length - 1; i >= 0; --i) { try { undo[i](); } catch (e) { console.warn('kinpeki unmount', e); } }
}

export {placeName, colourSlots};
if (typeof window !== 'undefined') {
  window.mapStyles = window.mapStyles || {};
  window.mapStyles.kinpeki = {ripples: [], markerPx: 5, render, view, settled, unmount,
    // for measuring: the time to draw the sea (CPU side; nothing is read back from the GPU)
    stats() {
      let t0 = performance.now();
      redrawSea();
      let t1 = performance.now();
      return {kind: sea && sea.kind, cpu: t1 - t0, draws, seaMs: lastWorld && lastWorld.kp && lastWorld.kp.seaMs,
        canvas: canvas && [canvas.width, canvas.height]};
    }};
}
if (active()) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once: true});
  else mount();
}
