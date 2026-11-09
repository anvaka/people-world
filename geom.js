// Continuous phase: the labelled cells become a planar graph of boundary chains (between
// junctions where three labels meet). Every later change moves vertices of that graph, and
// every move is checked: no two segments may cross, and boundaries of labels that must not
// touch keep a minimum clearance. So the topology settled in the mesh phase (which borders
// exist, which do not) survives smoothing, roughening and exact area fitting unchanged.
import {segmentsIntersect, segSegDist2} from './util.js';

export const WATER = -1;

// does the corner at (px, py) between rays to (ax, ay) and (bx, by) fold to (almost) zero width?
const THIN = 2e-6;
const MINSEP2 = 1e-5 * 1e-5;
function thin(px, py, ax, ay, bx, by) {
  const ux = ax - px, uy = ay - py, wx = bx - px, wy = by - py;
  const dt = ux * wx + uy * wy;
  if (dt <= 0) return false;
  const lu = Math.hypot(ux, uy), lw = Math.hypot(wx, wy);
  const cr = Math.abs(ux * wy - uy * wx);
  // distance of the shorter ray's tip from the longer ray's line
  return cr / Math.max(lu, lw, 1e-300) < THIN;
}

// ---------------------------------------------------------------------------------------------
// boundary chains of the labelled barycentric dual
export function extractBoundary(mesh, lab) {
  const {tris, half, coords, gx, gy} = mesh;
  const vx = [], vy = [];
  const centroidV = new Map(), midV = new Map();
  const cv = t => {
    let v = centroidV.get(t);
    if (v === undefined) { v = vx.length; vx.push(gx[t]); vy.push(gy[t]); centroidV.set(t, v); }
    return v;
  };
  const mv = e => {
    const key = Math.min(e, half[e]);
    let v = midV.get(key);
    if (v === undefined) {
      const p = tris[e], q = tris[e % 3 === 2 ? e - 2 : e + 1];
      v = vx.length;
      vx.push((coords[2 * p] + coords[2 * q]) / 2);
      vy.push((coords[2 * p + 1] + coords[2 * q + 1]) / 2);
      midV.set(key, v);
    }
    return v;
  };
  // adjacency of the boundary graph: vertex -> list of [neighbour vertex, left label, right label]
  const adj = new Map();
  const addEdge = (a, b, L, R) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push([b, L, R]);
    adj.get(b).push([a, R, L]);
  };
  for (let e = 0; e < tris.length; ++e) {
    const o = half[e];
    if (o < 0 || o < e) continue;
    const p = tris[e], q = tris[e % 3 === 2 ? e - 2 : e + 1];
    if (lab[p] === lab[q]) continue;
    const t1 = Math.floor(e / 3), t2 = Math.floor(o / 3);
    const a = cv(t1), m = mv(e), b = cv(t2);
    // which label is on the left of a -> b?
    const dx = vx[b] - vx[a], dy = vy[b] - vy[a];
    const side = dx * (coords[2 * p + 1] - vy[m]) - dy * (coords[2 * p] - vx[m]);
    const L = side > 0 ? lab[p] : lab[q], R = side > 0 ? lab[q] : lab[p];
    addEdge(a, m, L, R);
    addEdge(m, b, L, R);
  }
  // walk chains from junctions (degree != 2), then the closed loops
  const chains = [];
  const used = new Set();
  const key = (a, b) => a < b ? a + ',' + b : b + ',' + a;
  const walk = (start, first) => {
    const [n1, L, R] = first;
    const v = [start];
    let prev = start, cur = n1;
    used.add(key(start, n1));
    v.push(cur);
    while (adj.get(cur).length === 2 && cur !== start) {
      const nx = adj.get(cur).find(([w]) => !used.has(key(cur, w)));
      if (!nx) break;
      used.add(key(cur, nx[0]));
      prev = cur;
      cur = nx[0];
      v.push(cur);
    }
    chains.push({v, L, R});
  };
  for (const [a, list] of adj) {
    if (list.length === 2) continue;
    for (const item of list) if (!used.has(key(a, item[0]))) walk(a, item);
  }
  for (const [a, list] of adj) {
    for (const item of list) if (!used.has(key(a, item[0]))) walk(a, item);
  }
  return {vx, vy, chains};
}

// ---------------------------------------------------------------------------------------------
export class Geo {
  constructor(vx, vy, chains, info) {
    this.vx = vx; this.vy = vy; this.chains = chains;
    // info: {linked(a, b), clearance(a, b), frozenLabel(l)}
    this.info = info;
    this.rebuild();
  }

  rebuild() {
    const {chains, vx} = this;
    const segA = [], segB = [], segC = [];
    const vSegs = Array.from({length: vx.length}, () => []);
    chains.forEach((c, ci) => {
      for (let i = 0; i + 1 < c.v.length; ++i) {
        const s = segA.length;
        segA.push(c.v[i]); segB.push(c.v[i + 1]); segC.push(ci);
        vSegs[c.v[i]].push(s); vSegs[c.v[i + 1]].push(s);
      }
    });
    this.segA = segA; this.segB = segB; this.segC = segC; this.vSegs = vSegs;
    // grid
    const lens = [];
    for (let s = 0; s < segA.length; s += 7) lens.push(this.segLen(s));
    lens.sort((a, b) => a - b);
    this.cell = Math.max(1e-6, 3 * (lens[lens.length >> 1] || 1));
    this.bud = null;
    this.grid = new Map();
    this.bigList = [];
    this.segRange = new Int32Array(4 * segA.length);
    for (let s = 0; s < segA.length; ++s) this.register(s);
  }

  // mean length of the segments at vertex v
  localLen(v) {
    const segs = this.vSegs[v];
    if (!segs.length) return 0;
    let t = 0;
    for (const s of segs) t += this.segLen(s);
    return t / segs.length;
  }

  segLen(s) { const a = this.segA[s], b = this.segB[s]; return Math.hypot(this.vx[b] - this.vx[a], this.vy[b] - this.vy[a]); }

  // grid cells covered by a segment: [i0, i1, j0, j1]
  rangeOf(s, out) {
    const c = this.cell, a = this.segA[s], b = this.segB[s];
    const vx = this.vx, vy = this.vy;
    out[0] = Math.floor(Math.min(vx[a], vx[b]) / c); out[1] = Math.floor(Math.max(vx[a], vx[b]) / c);
    out[2] = Math.floor(Math.min(vy[a], vy[b]) / c); out[3] = Math.floor(Math.max(vy[a], vy[b]) / c);
    if ((out[1] - out[0] + 1) * (out[3] - out[2] + 1) > 4096) out[0] = out[1] = out[2] = out[3] = 0x7fffffff;
    return out;
  }

  register(s) {
    const r = this.rangeOf(s, this._r || (this._r = new Int32Array(4)));
    const R = this.segRange;
    R[4 * s] = r[0]; R[4 * s + 1] = r[1]; R[4 * s + 2] = r[2]; R[4 * s + 3] = r[3];
    if (r[0] === 0x7fffffff) { this.bigList.push(s); return; }
    const grid = this.grid;
    for (let i = r[0]; i <= r[1]; ++i) for (let j = r[2]; j <= r[3]; ++j) {
      const k = i * 73856093 ^ j * 19349663;
      let list = grid.get(k);
      if (!list) { list = []; grid.set(k, list); }
      list.push(s);
    }
  }

  unregister(s) {
    const R = this.segRange;
    const i0 = R[4 * s], i1 = R[4 * s + 1], j0 = R[4 * s + 2], j1 = R[4 * s + 3];
    const drop = list => { const k = list.indexOf(s); if (k >= 0) { list[k] = list[list.length - 1]; list.pop(); } };
    if (i0 === 0x7fffffff) { drop(this.bigList); return; }
    for (let i = i0; i <= i1; ++i) for (let j = j0; j <= j1; ++j) drop(this.grid.get(i * 73856093 ^ j * 19349663));
  }

  // segments near a box (an array reused between calls; duplicates removed by a stamp)
  near(x0, y0, x1, y1, out) {
    out.length = 0;
    const c = this.cell;
    const i0 = Math.floor(x0 / c), i1 = Math.floor(x1 / c);
    const j0 = Math.floor(y0 / c), j1 = Math.floor(y1 / c);
    if (!this.stamp || this.stamp.length < this.segA.length) this.stamp = new Uint32Array(this.segA.length * 2 + 16);
    const stamp = this.stamp;
    const mark = this.mark = (this.mark || 0) + 1;
    if (mark > 4e9) { stamp.fill(0); this.mark = 1; }
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 4096) { for (let s = 0; s < this.segA.length; ++s) out.push(s); return out; }
    const grid = this.grid;
    for (let i = i0; i <= i1; ++i) for (let j = j0; j <= j1; ++j) {
      const l = grid.get(i * 73856093 ^ j * 19349663);
      if (l) for (const s of l) if (stamp[s] !== this.mark) { stamp[s] = this.mark; out.push(s); }
    }
    for (const s of this.bigList) if (stamp[s] !== this.mark) { stamp[s] = this.mark; out.push(s); }
    return out;
  }

  // clearance two chains need (0 if none)
  chainNeed(i, j) {
    const key = i < j ? i * 1e6 + j : j * 1e6 + i;
    const cache = this._needCache || (this._needCache = new Map());
    let g = cache.get(key);
    if (g !== undefined) return g;
    const c1 = this.chains[i], c2 = this.chains[j];
    g = 0;
    for (const A of [c1.L, c1.R]) {
      if (A < 0) continue;
      for (const C of [c2.L, c2.R]) {
        if (C < 0 || C === A || this.info.linked(A, C)) continue;
        const gc = this.info.clearance(A, C);
        if (gc > g) g = gc;
      }
    }
    cache.set(key, g);
    return g;
  }

  // Displacement budget of every vertex for the next phase: a vertex may move at most half of
  // what separates its segments from the nearest boundary of a label it must stay clear of
  // (minus that clearance), and at most `cap(v)`.
  budgets(cap) {
    const {vx, vy, segA, segB, segC} = this;
    const N = vx.length;
    const bud = new Float64Array(N);
    let capMax = 0;
    for (let v = 0; v < N; ++v) { bud[v] = cap(v); if (bud[v] > capMax) capMax = bud[v]; }
    // blocks of up to 16 consecutive segments of one chain, with their boxes
    const B = 16;
    const blocks = [];
    for (let s0 = 0; s0 < segA.length;) {
      const c = segC[s0];
      let s1 = s0;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      while (s1 < segA.length && segC[s1] === c && s1 - s0 < B) {
        for (const p of [segA[s1], segB[s1]]) {
          if (vx[p] < x0) x0 = vx[p]; if (vx[p] > x1) x1 = vx[p];
          if (vy[p] < y0) y0 = vy[p]; if (vy[p] > y1) y1 = vy[p];
        }
        s1++;
      }
      blocks.push({s0, s1, c, x0, y0, x1, y1});
      s0 = s1;
    }
    const reachMax = this.info.maxClearance + 2 * capMax;
    const order = blocks.map((b, i) => i).sort((a, b) => blocks[a].x0 - blocks[b].x0);
    for (let x = 0; x < order.length; ++x) {
      const A = blocks[order[x]];
      for (let y = x + 1; y < order.length; ++y) {
        const Bk = blocks[order[y]];
        if (Bk.x0 > A.x1 + reachMax) break;
        if (Bk.y0 > A.y1 + reachMax || A.y0 > Bk.y1 + reachMax) continue;
        const g = this.chainNeed(A.c, Bk.c);
        if (g <= 0) continue;
        const gap = Math.max(Bk.x0 - A.x1, A.x0 - Bk.x1, Bk.y0 - A.y1, A.y0 - Bk.y1, 0);
        if (gap > g + 2 * capMax) continue;
        for (let s = A.s0; s < A.s1; ++s) {
          const a = segA[s], b = segB[s];
          for (let t = Bk.s0; t < Bk.s1; ++t) {
            const c = segA[t], d = segB[t];
            if (c === a || c === b || d === a || d === b) continue;
            const dist = Math.sqrt(segSegDist2(vx[a], vy[a], vx[b], vy[b], vx[c], vy[c], vx[d], vy[d]));
            const room = Math.max(0, (dist - g) / 2);
            if (room < bud[a]) bud[a] = room;
            if (room < bud[b]) bud[b] = room;
            if (room < bud[c]) bud[c] = room;
            if (room < bud[d]) bud[d] = room;
          }
        }
      }
    }
    this.bud = bud;
    this.bx = Float64Array.from(vx);
    this.by = Float64Array.from(vy);
  }

  // vertices closer than their clearance to a boundary they must keep clear of: for each, the
  // push (dx, dy) that would restore the clearance (half of it: the other side moves too)
  gapPushes(factor = 1.05) {
    const {vx, vy, segA, segB, segC, chains} = this;
    const gmax = this.info.maxClearance;
    const push = new Map();
    const box = chains.map(c => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of c.v) { x0 = Math.min(x0, vx[p]); x1 = Math.max(x1, vx[p]); y0 = Math.min(y0, vy[p]); y1 = Math.max(y1, vy[p]); }
      return [x0, y0, x1, y1];
    });
    const order = chains.map((c, i) => i).sort((a, b) => box[a][0] - box[b][0]);
    const partners = chains.map(() => null);
    for (let x = 0; x < order.length; ++x) {
      const i = order[x];
      for (let y = x; y < order.length; ++y) {
        const j = order[y];
        if (box[j][0] > box[i][2] + gmax) break;
        if (box[j][1] > box[i][3] + gmax || box[i][1] > box[j][3] + gmax) continue;
        const g = this.chainNeed(i, j);
        if (g <= 0) continue;
        (partners[i] || (partners[i] = [])).push(j);
        if (i !== j) (partners[j] || (partners[j] = [])).push(i);
      }
    }
    const tmp = [];
    for (let p = 0; p < vx.length; ++p) {
      const segs = this.vSegs[p];
      if (!segs.length) continue;
      const ci = segC[segs[0]];
      let ps = null;
      for (const s of segs) { const q = partners[segC[s]]; if (q) ps = ps ? ps.concat(q) : q; }
      if (!ps) continue;
      let pad = 0;
      for (const s of segs) for (const cj of ps) pad = Math.max(pad, this.chainNeed(segC[s], cj));
      pad *= factor;
      this.near(vx[p] - pad, vy[p] - pad, vx[p] + pad, vy[p] + pad, tmp);
      let best = 0, bx = 0, by = 0;
      for (const t of tmp) {
        const cj = segC[t];
        if (!ps.includes(cj)) continue;
        const a = segA[t], b = segB[t];
        if (a === p || b === p) continue;
        let g = 0;
        for (const s of segs) g = Math.max(g, this.chainNeed(segC[s], cj));
        if (g <= 0) continue;
        // closest point on t
        const dx = vx[b] - vx[a], dy = vy[b] - vy[a];
        const L2 = dx * dx + dy * dy;
        let u = L2 > 0 ? ((vx[p] - vx[a]) * dx + (vy[p] - vy[a]) * dy) / L2 : 0;
        u = Math.max(0, Math.min(1, u));
        const qx = vx[a] + u * dx, qy = vy[a] + u * dy;
        const d = Math.hypot(vx[p] - qx, vy[p] - qy);
        const deficit = g * factor - d;
        if (deficit <= best || d === 0) continue;
        best = deficit;
        bx = (vx[p] - qx) / d * deficit / 2;
        by = (vy[p] - qy) / d * deficit / 2;
      }
      if (best > 0) push.set(p, [bx, by]);
    }
    return push;
  }

  // Thin places of one label (necks, slivers at a border, ribbons): where two boundary pieces of
  // the same label face each other across its inside closer than thick(label), push them apart.
  thickPushes(thick, push = new Map()) {
    const {vx, vy, segA, segB, segC, chains} = this;
    // arc position of every vertex along each ring of each label, to tell a real neck (the two
    // sides are far apart along the outline) from a small cape (they are close)
    const arcPos = new Map();   // label -> Map(vertex -> [ring, pos, ringLen])
    for (const [l, rings] of this.rings()) {
      if (!(thick(l) > 0)) continue;
      const m = new Map();
      rings.forEach((ring, ri) => {
        const ids = this.ringPoints(ring);
        let pos = 0;
        const tmp = [];
        for (let i = 0; i < ids.length; ++i) {
          tmp.push([ids[i], pos]);
          const j = ids[(i + 1) % ids.length];
          pos += Math.hypot(vx[j] - vx[ids[i]], vy[j] - vy[ids[i]]);
        }
        for (const [v, ps] of tmp) m.set(v, [ri, ps, pos]);
      });
      arcPos.set(l, m);
    }
    const arcDist = (A, p, q) => {
      const m = arcPos.get(A);
      const a = m && m.get(p), b = m && m.get(q);
      if (!a || !b) return 0;
      if (a[0] !== b[0]) return Infinity;
      const d = Math.abs(a[1] - b[1]);
      return Math.min(d, a[2] - d);
    };
    const B = 16;
    const blocks = [];
    let tmax = 0;
    for (let s0 = 0; s0 < segA.length;) {
      const c = segC[s0];
      let s1 = s0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      while (s1 < segA.length && segC[s1] === c && s1 - s0 < B) {
        for (const p of [segA[s1], segB[s1]]) {
          if (vx[p] < x0) x0 = vx[p]; if (vx[p] > x1) x1 = vx[p];
          if (vy[p] < y0) y0 = vy[p]; if (vy[p] > y1) y1 = vy[p];
        }
        s1++;
      }
      const ch = chains[c];
      const t = Math.max(ch.L >= 0 ? thick(ch.L) : 0, ch.R >= 0 ? thick(ch.R) : 0);
      tmax = Math.max(tmax, t);
      blocks.push({s0, s1, c, x0, y0, x1, y1});
      s0 = s1;
    }
    // inward normal of label A at segment s (A on the left of the chain direction or on the right)
    const inward = (s, A) => {
      const a = segA[s], b = segB[s];
      const dx = vx[b] - vx[a], dy = vy[b] - vy[a], L = Math.hypot(dx, dy) || 1;
      const sgn = chains[segC[s]].L === A ? 1 : -1;
      return [-dy / L * sgn, dx / L * sgn];
    };
    const order = blocks.map((b, i) => i).sort((a, b) => blocks[a].x0 - blocks[b].x0);
    const visit = (P, Q, A, g) => {
      for (let s = P.s0; s < P.s1; ++s) {
        const p = segA[s];
        const [nx, ny] = inward(s, A);
        for (let t = Q.s0; t < Q.s1; ++t) {
          const a = segA[t], b = segB[t];
          if (a === p || b === p) continue;
          const dx = vx[b] - vx[a], dy = vy[b] - vy[a];
          const L2 = dx * dx + dy * dy;
          let u = L2 > 0 ? ((vx[p] - vx[a]) * dx + (vy[p] - vy[a]) * dy) / L2 : 0;
          u = Math.max(0, Math.min(1, u));
          const qx = vx[a] + u * dx, qy = vy[a] + u * dy;
          const wx = qx - vx[p], wy = qy - vy[p];
          const d = Math.hypot(wx, wy);
          if (d === 0 || d >= g) continue;
          // the other piece must lie across A's inside, and face back
          if (wx * nx + wy * ny < 0.6 * d) continue;
          const [mx, my] = inward(t, A);
          if (-(wx * mx + wy * my) < 0.6 * d) continue;
          if (arcDist(A, p, u < 0.5 ? a : b) < Math.max(3 * g, 6 * d)) continue;
          const deficit = g * 1.05 - d;
          const cur = push.get(p);
          const px = -wx / d * deficit / 2, py = -wy / d * deficit / 2;
          if (!cur || px * px + py * py > cur[0] * cur[0] + cur[1] * cur[1]) push.set(p, [px, py]);
        }
      }
    };
    for (let x = 0; x < order.length; ++x) {
      const P = blocks[order[x]];
      for (let y = x; y < order.length; ++y) {
        const Q = blocks[order[y]];
        if (Q.x0 > P.x1 + tmax) break;
        if (Q.y0 > P.y1 + tmax || P.y0 > Q.y1 + tmax) continue;
        const c1 = chains[P.c], c2 = chains[Q.c];
        for (const A of [c1.L, c1.R]) {
          if (A < 0 || (c2.L !== A && c2.R !== A)) continue;
          const g = thick(A);
          if (!(g > 0)) continue;
          const gap = Math.max(Q.x0 - P.x1, P.x0 - Q.x1, Q.y0 - P.y1, P.y0 - Q.y1, 0);
          if (gap > g) continue;
          visit(P, Q, A, g);
          if (P !== Q) visit(Q, P, A, g);
        }
      }
    }
    return push;
  }

  // may vertex v move to (x, y)?  (within its budget, and without crossing any segment)
  canMove(v, x, y) {
    const {vx, vy, segA, segB, vSegs} = this;
    if (this.bud) {
      const dx = x - this.bx[v], dy = y - this.by[v];
      if (dx * dx + dy * dy > this.bud[v] * this.bud[v]) return false;
    }
    const mine = vSegs[v];
    // the segments at v must not fold onto each other (a zero-width spike)
    for (let i = 0; i < mine.length; ++i) for (let j = i + 1; j < mine.length; ++j) {
      const o1 = segA[mine[i]] === v ? segB[mine[i]] : segA[mine[i]];
      const o2 = segA[mine[j]] === v ? segB[mine[j]] : segA[mine[j]];
      if (thin(x, y, vx[o1], vy[o1], vx[o2], vy[o2])) return false;
    }
    const tmp = this._tmp || (this._tmp = []);
    for (const s of mine) {
      const o = segA[s] === v ? segB[s] : segA[s];
      const px = vx[o], py = vy[o];
      this.near(Math.min(px, x) - 1e-5, Math.min(py, y) - 1e-5, Math.max(px, x) + 1e-5, Math.max(py, y) + 1e-5, tmp);
      for (const t of tmp) {
        if (mine.includes(t)) continue;
        const a = segA[t], b = segB[t];
        if (a === o || b === o) {
          // segments sharing the far vertex must not fold onto each other
          const q = a === o ? b : a;
          if (thin(px, py, x, y, vx[q], vy[q])) return false;
          continue;
        }
        if (segmentsIntersect(px, py, x, y, vx[a], vy[a], vx[b], vy[b])) return false;
        // nearly touching without crossing: a pinch the checkers would see
        if (segSegDist2(px, py, x, y, vx[a], vy[a], vx[b], vy[b]) < MINSEP2) return false;
      }
    }
    return true;
  }

  move(v, x, y) {
    const segs = this.vSegs[v];
    const ox = this.vx[v], oy = this.vy[v];
    this.vx[v] = x; this.vy[v] = y;
    const r = this._r2 || (this._r2 = new Int32Array(4));
    const R = this.segRange;
    for (const s of segs) {
      this.rangeOf(s, r);
      if (r[0] === R[4 * s] && r[1] === R[4 * s + 1] && r[2] === R[4 * s + 2] && r[3] === R[4 * s + 3]) continue;
      this.vx[v] = ox; this.vy[v] = oy;
      this.unregister(s);
      this.vx[v] = x; this.vy[v] = y;
      this.register(s);
    }
  }

  tryMove(v, x, y) {
    if (!this.canMove(v, x, y)) return false;
    this.move(v, x, y);
    return true;
  }

  // ---- rings of each label: lists of [chain index, reversed]
  rings() {
    const {chains} = this;
    const byStart = new Map();   // label -> Map(start vertex -> [ci, rev])
    const add = (l, start, item) => {
      if (l < 0) return;
      if (!byStart.has(l)) byStart.set(l, new Map());
      const m = byStart.get(l);
      if (!m.has(start)) m.set(start, []);
      m.get(start).push(item);
    };
    chains.forEach((c, ci) => {
      add(c.L, c.v[0], [ci, false]);
      add(c.R, c.v[c.v.length - 1], [ci, true]);
    });
    const out = new Map();
    for (const [l, m] of byStart) {
      const rings = [];
      const used = new Set();
      for (const [, items] of m) for (const it of items) {
        const k = it[0] + (it[1] ? 'r' : 'f');
        if (used.has(k)) continue;
        const ring = [];
        let cur = it;
        for (let guard = 0; guard < 1e6; ++guard) {
          const kk = cur[0] + (cur[1] ? 'r' : 'f');
          if (used.has(kk)) break;
          used.add(kk);
          ring.push(cur);
          const c = chains[cur[0]];
          const end = cur[1] ? c.v[0] : c.v[c.v.length - 1];
          const nexts = m.get(end);
          if (!nexts) break;
          cur = nexts.find(x => !used.has(x[0] + (x[1] ? 'r' : 'f'))) || nexts[0];
        }
        rings.push(ring);
      }
      out.set(l, rings);
    }
    return out;
  }

  ringPoints(ring) {
    const pts = [];
    for (const [ci, rev] of ring) {
      const v = this.chains[ci].v;
      const n = v.length;
      for (let i = 0; i < n - 1; ++i) {
        const id = rev ? v[n - 1 - i] : v[i];
        pts.push(id);
      }
    }
    return pts;
  }

  labelAreas(ringsMap) {
    const areas = new Map(), perims = new Map();
    for (const [l, rings] of ringsMap) {
      let A = 0, P = 0;
      for (const ring of rings) {
        const ids = this.ringPoints(ring);
        for (let i = 0, j = ids.length - 1; i < ids.length; j = i++) {
          const a = ids[j], b = ids[i];
          A += this.vx[a] * this.vy[b] - this.vx[b] * this.vy[a];
          P += Math.hypot(this.vx[b] - this.vx[a], this.vy[b] - this.vy[a]);
        }
      }
      areas.set(l, A / 2);
      perims.set(l, P);
    }
    return {areas, perims};
  }
}
