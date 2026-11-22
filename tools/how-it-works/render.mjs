// SVG pieces for the walkthrough's figures, drawn from data/*.json. Colours are CSS classes
// (c0..c4 for countries, and a few named ones) so the page's tokens theme them.
// A figure works in its own integer grid: `px` steps across its box (about one step per pixel at
// the width it is shown), with relative path commands, and shapes clipped to the box.
import {readFileSync} from 'node:fs';

export const load = name => JSON.parse(readFileSync(new URL(`./data/${name}.json`, import.meta.url), 'utf8'));
export const W = load('world');
const n = W.nodes.length;
export const nameOf = i => W.nodes[i].name;
export const indexOf = id => W.nodes.findIndex(r => r.id === id);
const nb = W.nodes.map(() => []);
for (const [a, b] of W.world.links) { nb[a].push(b); nb[b].push(a); }
export const degree = i => nb[i].length;

// five colours, greedy over the border graph, largest degree first: neighbours differ
export const colour = (() => {
  const order = W.nodes.map((_, i) => i).sort((a, b) => nb[b].length - nb[a].length || a - b);
  const c = new Array(n).fill(-1);
  for (const i of order) {
    const used = new Set(nb[i].map(j => c[j]));
    let k = (i * 7) % 5;
    for (let t = 0; t < 5 && used.has(k); ++t) k = (k + 1) % 5;
    c[i] = k;
  }
  return c;
})();
export const finalPolys = Object.fromEntries(W.world.countries.map((c, i) => [i, c.rings]).filter(([, r]) => r.length));

// centroid of the largest ring
export function centre(rings) {
  let best = null, bestA = -1;
  for (const r of rings) {
    let A = 0, cx = 0, cy = 0;
    for (let k = 0; k < r.length; ++k) {
      const [x0, y0] = r[k], [x1, y1] = r[(k + 1) % r.length];
      const c = x0 * y1 - x1 * y0;
      A += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
    }
    if (Math.abs(A) > bestA && A !== 0) { bestA = Math.abs(A); best = [cx / (3 * A), cy / (3 * A)]; }
  }
  return best;
}

// the centre of the largest part of a country inside a box, so a label stays in the picture
export function clippedCentre(rings, box) {
  if (!rings) return null;
  return centre(rings.map(r => clipRing(r, box)).filter(r => r.length > 2));
}

// Sutherland–Hodgman against an axis-aligned box
export function clipRing(ring, b) {
  let pts = ring;
  const edges = [[p => p[0] >= b[0], (p, q) => { const t = (b[0] - p[0]) / (q[0] - p[0]); return [b[0], p[1] + t * (q[1] - p[1])]; }],
    [p => p[0] <= b[2], (p, q) => { const t = (b[2] - p[0]) / (q[0] - p[0]); return [b[2], p[1] + t * (q[1] - p[1])]; }],
    [p => p[1] >= b[1], (p, q) => { const t = (b[1] - p[1]) / (q[1] - p[1]); return [p[0] + t * (q[0] - p[0]), b[1]]; }],
    [p => p[1] <= b[3], (p, q) => { const t = (b[3] - p[1]) / (q[1] - p[1]); return [p[0] + t * (q[0] - p[0]), b[3]]; }]];
  for (const [inside, cut] of edges) {
    if (!pts.length) break;
    const out = [];
    for (let k = 0; k < pts.length; ++k) {
      const p = pts[k], q = pts[(k + 1) % pts.length];
      const ip = inside(p), iq = inside(q);
      if (ip) out.push(p);
      if (ip !== iq) out.push(cut(p, q));
    }
    pts = out;
  }
  return pts;
}
// the runs of a polyline inside the box (one point beyond it at each end)
function clipLine(pts, b) {
  const runs = [];
  let run = null;
  const ins = p => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
  for (let k = 0; k < pts.length; ++k) {
    const here = ins(pts[k]) || (k + 1 < pts.length && ins(pts[k + 1])) || (k > 0 && ins(pts[k - 1]));
    if (here) { if (!run) runs.push(run = []); run.push(pts[k]); } else run = null;
  }
  return runs.filter(r => r.length > 1);
}

export class Fig {
  // box in map units [x0, y0, x1, y1] (y down, as the page draws it); px: grid steps across
  constructor(box, px = 900) {
    this.box = box;
    this.q = (box[2] - box[0]) / px;
    this.W = px;
    this.H = Math.round((box[3] - box[1]) / this.q);
    const m = 0.02 * (box[2] - box[0]);
    this.cbox = [box[0] - m, box[1] - m, box[2] + m, box[3] + m];
  }
  X(x) { return Math.round((x - this.box[0]) / this.q); }
  Y(y) { return Math.round((y - this.box[1]) / this.q); }
  len(v) { return +(v / this.q).toFixed(1); }
  // relative path of a list of point lists
  d(lists, close) {
    let s = '';
    for (const pts of lists) {
      let px = null, py = null, k = 0, body = '';
      for (const [x, y] of pts) {
        const X = this.X(x), Y = this.Y(y);
        if (px === null) { s += `M${X} ${Y}`; px = X; py = Y; continue; }
        const dx = X - px, dy = Y - py;
        if (!dx && !dy) continue;
        body += (k++ ? ' ' : 'l') + dx + (dy < 0 ? '' : ' ') + dy;
        px = X; py = Y;
      }
      if (k < (close ? 2 : 1)) { s = s.slice(0, s.lastIndexOf('M')); continue; }
      s += body.replace(/ -/g, '-') + (close ? 'z' : '');
    }
    return s;
  }
  // country fills: polys = {label: rings}; cls(label) gives the class
  fills(polys, cls = l => 'c' + colour[l]) {
    const groups = new Map();
    for (const [l, rings] of Object.entries(polys)) {
      const clipped = rings.map(r => clipRing(r, this.cbox)).filter(r => r.length > 2);
      if (!clipped.length) continue;
      const c = cls(+l);
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(...clipped);
    }
    return [...groups].map(([c, rs]) => { const d = this.d(rs, true); return d ? `<path class="${c}" d="${d}"/>` : ''; }).join('');
  }
  strokes(lines, {coast = 'coast', border = 'border'} = {}) {
    const c = [], b = [];
    for (const l of lines) {
      const isCoast = l.kind ? l.kind === 'coast' : (l.a < 0 || l.b < 0);
      if (!isCoast && l.a === l.b) continue;            // between an exclave and its owner
      (isCoast ? c : b).push(...clipLine(l.p, this.cbox));
    }
    return `<path class="${border}" d="${this.d(b, false)}"/><path class="${coast}" d="${this.d(c, false)}"/>`;
  }
  sea() { return `<rect class="sea" width="${this.W}" height="${this.H}"/>`; }
  // labels: ids or indices; at: {id: [x, y]} overrides; size in steps of the figure's grid;
  // cls: a class, or a function of the id; name: {id: text} overrides
  labels(list, polys, {size = 22, cls = 'lbl', at = {}, name = {}} = {}) {
    const inner = [this.box[0] + 0.04 * (this.box[2] - this.box[0]), this.box[1] + 0.04 * (this.box[3] - this.box[1]),
      this.box[2] - 0.04 * (this.box[2] - this.box[0]), this.box[3] - 0.04 * (this.box[3] - this.box[1])];
    return list.map(id => {
      const i = typeof id === 'number' ? id : indexOf(id);
      const p = at[id] || clippedCentre(polys[i] || finalPolys[i], inner);
      const c = typeof cls === 'function' ? cls(id) : cls;
      return p ? `<text class="${c}" x="${this.X(p[0])}" y="${this.Y(p[1])}" font-size="${size}" text-anchor="middle" dominant-baseline="central">${name[id] || nameOf(i)}</text>` : '';
    }).join('');
  }
  svg(body, {label = '', cls = 'fig'} = {}) {
    return `<svg class="${cls}" viewBox="0 0 ${this.W} ${this.H}" role="img" aria-label="${label.replace(/"/g, '&quot;')}">${body}</svg>`;
  }
}
