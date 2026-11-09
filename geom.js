// Continuous phase: the labelled cells become a planar graph of boundary chains (between
// junctions where three labels meet). Every later change moves vertices of that graph, and
// every move is checked: no two segments may cross, and boundaries of labels that must not
// touch keep a minimum clearance. So the topology settled in the mesh phase (which borders
// exist, which do not) survives smoothing, roughening and exact area fitting unchanged.
import {segmentsIntersect, segSegDist2, segSegDist2NoCross, hypot} from './util.js';

export const WATER = -1;

// does the corner at (px, py) between rays to (ax, ay) and (bx, by) fold to (almost) zero width?
const THIN = 2e-6;
const MINSEP2 = 1e-5 * 1e-5;
function thin(px, py, ax, ay, bx, by) {
  const ux = ax - px, uy = ay - py, wx = bx - px, wy = by - py;
  const dt = ux * wx + uy * wy;
  if (dt <= 0) return false;
  const lu = hypot(ux, uy), lw = hypot(wx, wy);
  const cr = Math.abs(ux * wy - uy * wx);
  // distance of the shorter ray's tip from the longer ray's line
  return cr / Math.max(lu, lw, 1e-300) < THIN;
}

// segSegDist2 (util.js) written out in one function, the same arithmetic step by step: small and
// self-contained, so it is inlined where it is hot (a call would box the result)
function segDist2(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx), d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax), d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(ptSeg2(ax, ay, cx, cy, dx, dy), ptSeg2(bx, by, cx, cy, dx, dy), ptSeg2(cx, cy, ax, ay, bx, by), ptSeg2(dx, dy, ax, ay, bx, by));
}
function ptSeg2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l = dx * dx + dy * dy;
  let t = l > 0 ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return ex * ex + ey * ey;
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
  const NV = vx.length;
  const key = (a, b) => a < b ? a * NV + b : b * NV + a;
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
    // every field the methods set, here first and in this order: the object keeps one shape,
    // so the compiled code made for it stays valid
    this._q = new Float64Array(2);
    this.segA = this.segB = this.segC = null; this.vSegs = null;
    this.cell = 1; this.bud = null; this.bx = this.by = null;
    this.gi0 = this.gj0 = this.gW = this.gH = 0; this.cells = null; this.grid = null; this.bigList = null;
    this.segRange = null; this.track = null; this.sbox = null;
    this._r = new Int32Array(4); this._r2 = new Int32Array(4); this._tmp = []; this._tmp2 = [];
    this.stamp = null; this.mark = 0;
    this._need = null; this._needN = 0; this._needCache = null; this._push = {pad: 0, best: 0, bx: 0, by: 0};
    this.rebuild();
  }

  rebuild() {
    const {chains, vx, vy} = this;
    let nSeg = 0;
    for (const c of chains) nSeg += Math.max(0, c.v.length - 1);
    const segA = new Int32Array(nSeg), segB = new Int32Array(nSeg), segC = new Int32Array(nSeg);
    const vSegs = Array.from({length: vx.length}, () => []);
    let s = 0;
    chains.forEach((c, ci) => {
      for (let i = 0; i + 1 < c.v.length; ++i, ++s) {
        segA[s] = c.v[i]; segB[s] = c.v[i + 1]; segC[s] = ci;
        vSegs[c.v[i]].push(s); vSegs[c.v[i + 1]].push(s);
      }
    });
    this.segA = segA; this.segB = segB; this.segC = segC; this.vSegs = vSegs;
    // grid
    const lens = [];
    for (let s = 0; s < segA.length; s += 7) lens.push(this.segLen(s));
    lens.sort((a, b) => a - b);
    const cell = this.cell = Math.max(1e-6, 3 * (lens[lens.length >> 1] || 1));
    this.bud = null;
    // the grid is a dense array of cell lists over the box of the segments (with a margin); a cell
    // outside it (a vertex moved far) goes to a map
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let s = 0; s < segA.length; ++s) for (const p of [segA[s], segB[s]]) {
      if (vx[p] < x0) x0 = vx[p]; if (vx[p] > x1) x1 = vx[p];
      if (vy[p] < y0) y0 = vy[p]; if (vy[p] > y1) y1 = vy[p];
    }
    if (!(x1 >= x0)) { x0 = y0 = 0; x1 = y1 = 0; }
    const M = 16;
    this.gi0 = Math.floor(x0 / cell) - M; this.gj0 = Math.floor(y0 / cell) - M;
    this.gW = Math.floor(x1 / cell) + M - this.gi0 + 1; this.gH = Math.floor(y1 / cell) + M - this.gj0 + 1;
    if (this.gW * this.gH > 4e6) { this.gW = this.gH = 0; }
    this.cells = new Array(this.gW * this.gH).fill(null);
    this.grid = new Map();
    this.bigList = [];
    this.segRange = new Int32Array(4 * segA.length);
    for (let s = 0; s < segA.length; ++s) this.register(s);
    this.track = null;
    // box of every segment [x0, x1, y0, y1], kept current by move()
    this.sbox = new Float64Array(4 * segA.length);
    for (let s = 0; s < segA.length; ++s) this.setBox(s);
  }

  setBox(s) {
    const a = this.segA[s], b = this.segB[s], vx = this.vx, vy = this.vy, B = this.sbox;
    const ax = vx[a], bx = vx[b], ay = vy[a], by = vy[b];
    if (ax < bx) { B[4 * s] = ax; B[4 * s + 1] = bx; } else { B[4 * s] = bx; B[4 * s + 1] = ax; }
    if (ay < by) { B[4 * s + 2] = ay; B[4 * s + 3] = by; } else { B[4 * s + 2] = by; B[4 * s + 3] = ay; }
  }

  // the list of grid cell (i, j), created if `make`
  cellList(i, j, make) {
    const di = i - this.gi0, dj = j - this.gj0;
    if (di >= 0 && di < this.gW && dj >= 0 && dj < this.gH) {
      const k = di * this.gH + dj;
      let list = this.cells[k];
      if (!list && make) list = this.cells[k] = [];
      return list;
    }
    const k = i * 73856093 ^ j * 19349663;
    let list = this.grid.get(k);
    if (!list && make) { list = []; this.grid.set(k, list); }
    return list;
  }

  // mean length of the segments at vertex v
  localLen(v) {
    const segs = this.vSegs[v];
    if (!segs.length) return 0;
    let t = 0;
    for (const s of segs) t += this.segLen(s);
    return t / segs.length;
  }

  segLen(s) { const a = this.segA[s], b = this.segB[s]; return hypot(this.vx[b] - this.vx[a], this.vy[b] - this.vy[a]); }

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
    for (let i = r[0]; i <= r[1]; ++i) for (let j = r[2]; j <= r[3]; ++j) this.cellList(i, j, true).push(s);
  }

  unregister(s) {
    const R = this.segRange;
    const i0 = R[4 * s], i1 = R[4 * s + 1], j0 = R[4 * s + 2], j1 = R[4 * s + 3];
    const drop = list => { const k = list.indexOf(s); if (k >= 0) { list[k] = list[list.length - 1]; list.pop(); } };
    if (i0 === 0x7fffffff) { drop(this.bigList); return; }
    for (let i = i0; i <= i1; ++i) for (let j = j0; j <= j1; ++j) drop(this.cellList(i, j, false));
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
    const di0 = i0 - this.gi0, di1 = i1 - this.gi0, dj0 = j0 - this.gj0, dj1 = j1 - this.gj0;
    if (di0 >= 0 && di1 < this.gW && dj0 >= 0 && dj1 < this.gH) {
      const cells = this.cells, H = this.gH;
      for (let i = di0; i <= di1; ++i) for (let j = dj0; j <= dj1; ++j) {
        const l = cells[i * H + j];
        if (l) for (let k = 0; k < l.length; ++k) { const s = l[k]; if (stamp[s] !== mark) { stamp[s] = mark; out.push(s); } }
      }
    } else {
      for (let i = i0; i <= i1; ++i) for (let j = j0; j <= j1; ++j) {
        const l = this.cellList(i, j, false);
        if (l) for (let k = 0; k < l.length; ++k) { const s = l[k]; if (stamp[s] !== mark) { stamp[s] = mark; out.push(s); } }
      }
    }
    const big = this.bigList;
    for (let k = 0; k < big.length; ++k) { const s = big[k]; if (stamp[s] !== mark) { stamp[s] = mark; out.push(s); } }
    return out;
  }

  // clearance two chains need (0 if none)
  chainNeed(i, j) {
    const nc = this.chains.length;
    if (nc > 4000) return this.chainNeedMap(i, j);
    if (!this._need || this._needN !== nc) { this._need = new Float64Array(nc * nc).fill(-1); this._needN = nc; }
    const k = i * nc + j;
    let g = this._need[k];
    if (g >= 0) return g;
    g = this.needOf(i, j);
    this._need[k] = this._need[j * nc + i] = g;
    return g;
  }

  chainNeedMap(i, j) {
    const key = i < j ? i * 1e6 + j : j * 1e6 + i;
    const cache = this._needCache || (this._needCache = new Map());
    let g = cache.get(key);
    if (g === undefined) { g = this.needOf(i, j); cache.set(key, g); }
    return g;
  }

  needOf(i, j) {
    let g;
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
    return g;
  }

  // Displacement budget of every vertex for the next phase: a vertex may move at most half of
  // what separates its segments from the nearest boundary of a label it must stay clear of
  // (minus that clearance), and at most `cap(v)`.
  // (Each budget is a minimum over segment pairs, so pairs that cannot lower any of the four
  // budgets involved are skipped: first by block boxes, then by segment boxes.)
  // `mobile(chain)`, if given: only vertices of those chains will move before the next call, so
  // only their budgets are worked out exactly (pairs of two other blocks are skipped)
  budgets(cap, mobile = null) {
    const {vx, vy, segA, segB, segC} = this;
    const N = vx.length;
    // (the arrays of the last call are reused)
    const bud = this.bud && this.bud.length === N ? this.bud : new Float64Array(N);
    let capMax = 0;
    for (let v = 0; v < N; ++v) { bud[v] = cap(v); if (bud[v] > capMax) capMax = bud[v]; }
    const nS = segA.length;
    // segment boxes [x0, x1, y0, y1] (kept current by move)
    const SB = this.sbox;
    // blocks of up to 16 consecutive segments of one chain, with their boxes and the largest
    // budget of their vertices (budgets only shrink, so it stays an upper bound)
    const B = 16;
    // (typed arrays big enough for the most blocks there can be: one per chain plus nS / B)
    const cap0 = this.chains.length + Math.ceil(nS / B) + 1;
    const bS0 = new Int32Array(cap0), bS1 = new Int32Array(cap0), bC = new Int32Array(cap0), bMob = new Uint8Array(cap0);
    const bX0 = new Float64Array(cap0), bY0 = new Float64Array(cap0), bX1 = new Float64Array(cap0), bY1 = new Float64Array(cap0), bMax = new Float64Array(cap0);
    let nB = 0;
    for (let s0 = 0; s0 < nS;) {
      const c = segC[s0];
      let s1 = s0;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, m = 0;
      while (s1 < nS && segC[s1] === c && s1 - s0 < B) {
        if (SB[4 * s1] < x0) x0 = SB[4 * s1]; if (SB[4 * s1 + 1] > x1) x1 = SB[4 * s1 + 1];
        if (SB[4 * s1 + 2] < y0) y0 = SB[4 * s1 + 2]; if (SB[4 * s1 + 3] > y1) y1 = SB[4 * s1 + 3];
        const ba = bud[segA[s1]], bb = bud[segB[s1]];
        if (ba > m) m = ba; if (bb > m) m = bb;
        s1++;
      }
      bS0[nB] = s0; bS1[nB] = s1; bC[nB] = c; bX0[nB] = x0; bY0[nB] = y0; bX1[nB] = x1; bY1[nB] = y1; bMax[nB] = m;
      bMob[nB] = !mobile || mobile(this.chains[c]) ? 1 : 0;
      nB++;
      s0 = s1;
    }
    const reachMax = this.info.maxClearance + 2 * capMax;
    const ncN = this.chains.length;
    if (ncN <= 4000 && (!this._need || this._needN !== ncN)) this.chainNeed(0, 0);
    const needTab = ncN <= 4000 ? this._need : null;
    const order = Array.from({length: nB}, (_, i) => i).sort((a, b) => bX0[a] - bX0[b]);   // (stable: as before)
    const EPS = 1e-9;
    for (let x = 0; x < nB; ++x) {
      const A = order[x];
      const ax0 = bX0[A], ax1 = bX1[A], ay0 = bY0[A], ay1 = bY1[A], cA = bC[A];
      for (let y = x + 1; y < nB; ++y) {
        const Bk = order[y];
        if (bX0[Bk] > ax1 + reachMax) break;
        if (!bMob[A] && !bMob[Bk]) continue;
        if (bY0[Bk] > ay1 + reachMax || ay0 > bY1[Bk] + reachMax) continue;
        // (the cached value read here directly: a call would box the number it returns)
        let g = needTab !== null ? needTab[cA * ncN + bC[Bk]] : -1;
        if (!(g >= 0)) g = this.chainNeed(cA, bC[Bk]);
        if (g <= 0) continue;
        const gap = Math.max(bX0[Bk] - ax1, ax0 - bX1[Bk], bY0[Bk] - ay1, ay0 - bY1[Bk], 0);
        if (gap > g + 2 * capMax) continue;
        // no pair of these blocks can come closer than gap: no budget here can shrink
        if ((gap - g) / 2 > Math.max(bMax[A], bMax[Bk]) + EPS) continue;
        for (let s = bS0[A]; s < bS1[A]; ++s) {
          const a = segA[s], b = segB[s];
          const px0 = SB[4 * s], px1 = SB[4 * s + 1], py0 = SB[4 * s + 2], py1 = SB[4 * s + 3];
          for (let t = bS0[Bk]; t < bS1[Bk]; ++t) {
            const c = segA[t], d = segB[t];
            if (c === a || c === b || d === a || d === b) continue;
            // the two segments' boxes are at least lb apart, so dist >= lb
            const lb = Math.max(SB[4 * t] - px1, px0 - SB[4 * t + 1], SB[4 * t + 2] - py1, py0 - SB[4 * t + 3]);
            if (lb > 0) {
              const lim = (lb - g) / 2 - EPS;
              if (lim >= bud[a] && lim >= bud[b] && lim >= bud[c] && lim >= bud[d]) continue;
            }
            const dist = Math.sqrt(segDist2(vx[a], vy[a], vx[b], vy[b], vx[c], vy[c], vx[d], vy[d]));
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
    if (!this.bx || this.bx.length !== N) { this.bx = new Float64Array(N); this.by = new Float64Array(N); }
    this.bx.set(vx); this.by.set(vy);
  }

  // vertices closer than their clearance to a boundary they must keep clear of: for each, the
  // push (dx, dy) that would restore the clearance (half of it: the other side moves too).
  // With a `cache` (an object kept between calls while only tryMove changes the geometry), a
  // vertex is looked at again only if it moved, its chains' partners changed, or a segment in
  // one of the grid cells it looks at moved: the others' answers cannot have changed.
  gapPushes(factor = 1.05, cache = null) {
    const {vx, vy, segC, chains} = this;
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
    const N = vx.length;
    const warm = cache && cache.n === N && cache.partners && this.track && !this.track.all;
    let chainChanged = null;
    if (warm) {
      chainChanged = new Uint8Array(chains.length);
      for (let ci = 0; ci < chains.length; ++ci) {
        const a = partners[ci], b = cache.partners[ci];
        if (!a !== !b || (a && (a.length !== b.length || a.some((x, k) => x !== b[k])))) chainChanged[ci] = 1;
      }
    }
    if (cache && !warm) {
      cache.n = N;
      cache.has = new Uint8Array(N); cache.rx = new Float64Array(N); cache.ry = new Float64Array(N); cache.pad = new Float64Array(N);
    }
    const tmp = [];
    // chains that are partners of the current vertex's chains: marked with the vertex
    const mark = new Int32Array(chains.length).fill(-1);
    const track = this.track;
    const out = this._push || (this._push = {pad: 0, best: 0, bx: 0, by: 0});
    const redo = p => {
      const r = this.pushAt(p, partners, mark, tmp, factor, out);
      if (cache) {
        cache.pad[p] = r ? out.pad : 0;
        cache.has[p] = r && out.best > 0 ? 1 : 0;
        if (cache.has[p]) { cache.rx[p] = out.bx; cache.ry[p] = out.by; }
      }
      return r;
    };
    if (warm) {
      // looked at again: vertices that moved, those of chains whose partners changed, and those
      // near a grid cell where a segment moved (a vertex looks at most `reach` cells away)
      const again = cache.again || (cache.again = new Uint32Array(N)), stamp = (cache.stamp = (cache.stamp || 0) + 1);
      const sure = [], maybe = [];
      const add = p => { if (again[p] !== stamp && this.vSegs[p].length) { again[p] = stamp; sure.push(p); } };
      for (const v of track.vList) add(v);
      for (let ci = 0; ci < chains.length; ++ci) if (chainChanged[ci]) for (const p of chains[ci].v) add(p);
      const near = p => { if (again[p] !== stamp && this.vSegs[p].length) { again[p] = stamp; maybe.push(p); } };
      const W = this.gW, H = this.gH, reach = Math.ceil(factor * gmax / this.cell) + 1;
      const seen = cache.cellSeen && cache.cellSeen.length === W * H ? cache.cellSeen : (cache.cellSeen = new Uint32Array(W * H));
      for (const k of track.cList) {
        const ci = Math.floor(k / H), cj = k - ci * H;
        for (let i = Math.max(0, ci - reach); i <= Math.min(W - 1, ci + reach); ++i) for (let j = Math.max(0, cj - reach); j <= Math.min(H - 1, cj + reach); ++j) {
          const q = i * H + j;
          if (seen[q] === stamp) continue;
          seen[q] = stamp;
          const l = this.cells[q];
          if (l) for (const sg of l) { near(this.segA[sg]); near(this.segB[sg]); }
        }
      }
      for (const p of sure) redo(p);
      // a vertex near a moved segment: again only if a cell it looks at saw a move
      const c = this.cell, gi0 = this.gi0, gj0 = this.gj0, dirty = track.cells;
      for (const p of maybe) {
        const pad = cache.pad[p];
        if (!(pad > 0)) continue;
        const i0 = Math.floor((vx[p] - pad) / c) - gi0, i1 = Math.floor((vx[p] + pad) / c) - gi0;
        const j0 = Math.floor((vy[p] - pad) / c) - gj0, j1 = Math.floor((vy[p] + pad) / c) - gj0;
        let hit = !(i0 >= 0 && i1 < W && j0 >= 0 && j1 < H) || (i1 - i0 + 1) * (j1 - j0 + 1) > 4096;
        for (let i = i0; i <= i1 && !hit; ++i) for (let j = j0; j <= j1; ++j) if (dirty[i * H + j]) { hit = true; break; }
        if (hit) redo(p);
      }
      for (let p = 0; p < N; ++p) if (cache.has[p]) push.set(p, [cache.rx[p], cache.ry[p]]);
    } else {
      for (let p = 0; p < N; ++p) {
        if (!this.vSegs[p].length) continue;
        if (redo(p) && out.best > 0) push.set(p, [out.bx, out.by]);
      }
    }
    if (cache) {
      cache.partners = partners;
      if (!this.track) this.startTracking();
      else this.clearTracking();
    }
    return push;
  }

  // the gap push of vertex p, into out {pad, best, bx, by} (false if none of its chains has
  // partners)
  pushAt(p, partners, mark, tmp, factor, out) {
    const {vx, vy, segA, segB, segC} = this;
    const segs = this.vSegs[p];
    let any = false;
    for (const s of segs) { const q = partners[segC[s]]; if (q) { any = true; for (const cj of q) mark[cj] = p; } }
    if (!any) return false;
    let pad = 0;
    for (const s of segs) {
      const q = partners[segC[s]];
      if (q) for (const s2 of segs) for (const cj of q) pad = Math.max(pad, this.chainNeed(segC[s2], cj));
    }
    pad *= factor;
    const px = vx[p], py = vy[p];
    this.near(px - pad, py - pad, px + pad, py + pad, tmp);
    // a segment whose box lies farther than pad from p has no deficit
    const lx = px - pad - 1e-9, hx = px + pad + 1e-9, ly = py - pad - 1e-9, hy = py + pad + 1e-9;
    let best = 0, bx = 0, by = 0;
    for (let k = 0; k < tmp.length; ++k) {
      const t = tmp[k];
      const cj = segC[t];
      if (mark[cj] !== p) continue;
      const a = segA[t], b = segB[t];
      if (a === p || b === p) continue;
      const ax = vx[a], ay = vy[a], bx2 = vx[b], by2 = vy[b];
      if ((ax < lx && bx2 < lx) || (ax > hx && bx2 > hx) || (ay < ly && by2 < ly) || (ay > hy && by2 > hy)) continue;
      let g = 0;
      for (const s of segs) g = Math.max(g, this.chainNeed(segC[s], cj));
      if (g <= 0) continue;
      // closest point on t
      const dx = bx2 - ax, dy = by2 - ay;
      const L2 = dx * dx + dy * dy;
      let u = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
      u = Math.max(0, Math.min(1, u));
      const qx = ax + u * dx, qy = ay + u * dy;
      const d = hypot(px - qx, py - qy);
      const deficit = g * factor - d;
      if (deficit <= best || d === 0) continue;
      best = deficit;
      bx = (px - qx) / d * deficit / 2;
      by = (py - qy) / d * deficit / 2;
    }
    out.pad = pad; out.best = best; out.bx = bx; out.by = by;
    return true;
  }

  // tracking of what moves (for gapPushes' cache): moved vertices, and grid cells whose
  // segments moved
  startTracking() {
    this.track = {movedV: new Uint8Array(this.vx.length), vList: [], cells: new Uint8Array(this.gW * this.gH), cList: [], all: false};
  }
  clearTracking() {
    const t = this.track;
    for (const v of t.vList) t.movedV[v] = 0;
    for (const k of t.cList) t.cells[k] = 0;
    t.vList.length = 0; t.cList.length = 0; t.all = false;
  }
  stopTracking() { this.track = null; }
  markRange(s) {
    const t = this.track, R = this.segRange;
    const i0 = R[4 * s], i1 = R[4 * s + 1], j0 = R[4 * s + 2], j1 = R[4 * s + 3];
    if (i0 === 0x7fffffff) { t.all = true; return; }
    for (let i = i0; i <= i1; ++i) for (let j = j0; j <= j1; ++j) {
      const di = i - this.gi0, dj = j - this.gj0;
      if (di < 0 || di >= this.gW || dj < 0 || dj >= this.gH) { t.all = true; continue; }
      const k = di * this.gH + dj;
      if (!t.cells[k]) { t.cells[k] = 1; t.cList.push(k); }
    }
  }

  // Thin places of one label (necks, slivers at a border, ribbons): where two boundary pieces of
  // the same label face each other across its inside closer than thick(label), push them apart.
  thickPushes(thick, push = new Map()) {
    const {vx, vy, segA, segB, segC, chains} = this;
    // nothing to do when no label asks for a thickness
    if (!chains.some(c => (c.L >= 0 && thick(c.L) > 0) || (c.R >= 0 && thick(c.R) > 0))) return push;
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
          pos += hypot(vx[j] - vx[ids[i]], vy[j] - vy[ids[i]]);
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
      const dx = vx[b] - vx[a], dy = vy[b] - vy[a], L = hypot(dx, dy) || 1;
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
          const d = hypot(wx, wy);
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
  // (the small wrappers take the coordinates and pass them on in a scratch array: a call with
  // numbers that are not small integers would box them)
  canMove(v, x, y) { const q = this._q; q[0] = x; q[1] = y; return this.canMoveQ(v); }
  tryMove(v, x, y) { const q = this._q; q[0] = x; q[1] = y; if (!this.canMoveQ(v)) return false; this.moveQ(v); return true; }
  move(v, x, y) { const q = this._q; q[0] = x; q[1] = y; this.moveQ(v); }

  canMoveQ(v) {
    const x = this._q[0], y = this._q[1];
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
    // every segment in the grid cells around each moved segment is tested (a segment in two
    // cells is tested twice, which does not change the answer)
    const c = this.cell, cells = this.cells, H = this.gH, W = this.gW, gi0 = this.gi0, gj0 = this.gj0, big = this.bigList, sb = this.sbox;
    for (let m = 0; m < mine.length; ++m) {
      const s = mine[m];
      const o = segA[s] === v ? segB[s] : segA[s];
      const px = vx[o], py = vy[o];
      const x0 = Math.min(px, x), y0 = Math.min(py, y), x1 = Math.max(px, x), y1 = Math.max(py, y);
      const i0 = Math.floor((x0 - 1e-5) / c), i1 = Math.floor((x1 + 1e-5) / c);
      const j0 = Math.floor((y0 - 1e-5) / c), j1 = Math.floor((y1 + 1e-5) / c);
      // a segment whose box is clear of the moved segment's by more than the pinch distance can
      // neither cross it nor pinch it
      const lx = x0 - 2e-5, hx = x1 + 2e-5, ly = y0 - 2e-5, hy = y1 + 2e-5;
      // (segments at o always pass the box test: their box holds o)
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 4096) {
        for (let t = 0; t < segA.length; ++t) {
          if (sb[4 * t] > hx || sb[4 * t + 1] < lx || sb[4 * t + 2] > hy || sb[4 * t + 3] < ly) continue;
          if (this.blocks(t, mine, o, px, py, x, y)) return false;
        }
        continue;
      }
      const inGrid = i0 - gi0 >= 0 && i1 - gi0 < W && j0 - gj0 >= 0 && j1 - gj0 < H;
      for (let i = i0; i <= i1; ++i) for (let j = j0; j <= j1; ++j) {
        const l = inGrid ? cells[(i - gi0) * H + (j - gj0)] : this.cellList(i, j, false);
        if (l) for (let k = 0; k < l.length; ++k) {
          const t = l[k];
          if (sb[4 * t] > hx || sb[4 * t + 1] < lx || sb[4 * t + 2] > hy || sb[4 * t + 3] < ly) continue;
          if (this.blocks(t, mine, o, px, py, x, y)) return false;
        }
      }
      for (let k = 0; k < big.length; ++k) {
        const t = big[k];
        if (sb[4 * t] > hx || sb[4 * t + 1] < lx || sb[4 * t + 2] > hy || sb[4 * t + 3] < ly) continue;
        if (this.blocks(t, mine, o, px, py, x, y)) return false;
      }
    }
    return true;
  }

  // does segment t stop the segment o -> (x, y) of a moving vertex (whose segments are `mine`)?
  // (its box is known to come near the moved segment's)
  blocks(t, mine, o, px, py, x, y) {
    if (mine.includes(t)) return false;
    const vx = this.vx, vy = this.vy;
    const a = this.segA[t], b = this.segB[t];
    if (a === o || b === o) {
      // segments sharing the far vertex must not fold onto each other
      const q = a === o ? b : a;
      return thin(px, py, x, y, vx[q], vy[q]);
    }
    const ax = vx[a], ay = vy[a], bx = vx[b], by = vy[b];
    if (segmentsIntersect(px, py, x, y, ax, ay, bx, by)) return true;
    // nearly touching without crossing: a pinch the checkers would see
    return segSegDist2NoCross(px, py, x, y, ax, ay, bx, by) < MINSEP2;
  }

  moveQ(v) {
    const x = this._q[0], y = this._q[1];
    const segs = this.vSegs[v];
    const ox = this.vx[v], oy = this.vy[v];
    this.vx[v] = x; this.vy[v] = y;
    const r = this._r2 || (this._r2 = new Int32Array(4));
    const R = this.segRange;
    const track = this.track;
    if (track && !track.movedV[v]) { track.movedV[v] = 1; track.vList.push(v); }
    for (const s of segs) {
      if (track) this.markRange(s);
      this.setBox(s);
      this.rangeOf(s, r);
      if (r[0] === R[4 * s] && r[1] === R[4 * s + 1] && r[2] === R[4 * s + 2] && r[3] === R[4 * s + 3]) continue;
      this.vx[v] = ox; this.vy[v] = oy;
      this.unregister(s);
      this.vx[v] = x; this.vy[v] = y;
      this.register(s);
      if (track) this.markRange(s);
    }
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
    // a chain side taken (2 ci + rev), marked with the label's turn
    const used = new Uint32Array(2 * chains.length);
    let turn = 0;
    const key = it => 2 * it[0] + (it[1] ? 1 : 0);
    for (const [l, m] of byStart) {
      const rings = [];
      ++turn;
      for (const [, items] of m) for (const it of items) {
        if (used[key(it)] === turn) continue;
        const ring = [];
        let cur = it;
        for (let guard = 0; guard < 1e6; ++guard) {
          const kk = key(cur);
          if (used[kk] === turn) break;
          used[kk] = turn;
          ring.push(cur);
          const c = chains[cur[0]];
          const end = cur[1] ? c.v[0] : c.v[c.v.length - 1];
          const nexts = m.get(end);
          if (!nexts) break;
          cur = nexts.find(x => used[key(x)] !== turn) || nexts[0];
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

  // the same sums into arrays indexed by label (no allocation)
  labelAreasInto(ringsMap, areaOf, perimOf) {
    const {vx, vy, chains} = this;
    for (const [l, rings] of ringsMap) {
      let A = 0, P = 0;
      for (const ring of rings) {
        let last = -1;
        for (let r = ring.length - 1; r >= 0 && last < 0; --r) {
          const it = ring[r], v = chains[it[0]].v, n = v.length;
          if (n >= 2) last = it[1] ? v[1] : v[n - 2];
        }
        if (last < 0) continue;
        let a = last;
        for (let r = 0; r < ring.length; ++r) {
          const rev = ring[r][1], v = chains[ring[r][0]].v, n = v.length;
          for (let i = 0; i < n - 1; ++i) {
            const b = rev ? v[n - 1 - i] : v[i];
            A += vx[a] * vy[b] - vx[b] * vy[a];
            P += hypot(vx[b] - vx[a], vy[b] - vy[a]);
            a = b;
          }
        }
      }
      areaOf[l] = A / 2;
      perimOf[l] = P;
    }
  }

  // area and perimeter of every label (summed in the same order as over ringPoints)
  labelAreas(ringsMap) {
    const areas = new Map(), perims = new Map();
    const {vx, vy, chains} = this;
    for (const [l, rings] of ringsMap) {
      let A = 0, P = 0;
      for (const ring of rings) {
        // the last point of the ring closes it
        let last = -1;
        for (let r = ring.length - 1; r >= 0 && last < 0; --r) {
          const [ci, rev] = ring[r];
          const v = chains[ci].v, n = v.length;
          if (n >= 2) last = rev ? v[1] : v[n - 2];
        }
        if (last < 0) continue;
        let a = last;
        for (const [ci, rev] of ring) {
          const v = chains[ci].v;
          const n = v.length;
          for (let i = 0; i < n - 1; ++i) {
            const b = rev ? v[n - 1 - i] : v[i];
            A += vx[a] * vy[b] - vx[b] * vy[a];
            P += hypot(vx[b] - vx[a], vy[b] - vy[a]);
            a = b;
          }
        }
      }
      areas.set(l, A / 2);
      perims.set(l, P);
    }
    return {areas, perims};
  }
}
