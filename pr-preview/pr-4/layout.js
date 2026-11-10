import {hypot} from './util.js';
// Size-aware layout of country seeds: each country is a disk of its (mesh) area; neighbours
// are pulled until their disks overlap a little, non-neighbours pushed apart. Stress
// majorization on graph distances gives the global arrangement, position-based constraint
// projection the local packing.

export function layoutComponent(ids, rad, linked, rng, opts = {}) {
  const m = ids.length;
  if (m === 1) return [[0, 0]];
  const cl = opts.linkFactor ?? (globalThis.CL || 0.86);    // linked disks: centre distance = cl * (ri + rj)
  const cs = opts.sepFactor ?? (globalThis.CS || 1.12);     // others: at least cs * (ri + rj)
  const r = ids.map(i => rad[i]);
  const L = new Uint8Array(m * m);
  for (let a = 0; a < m; ++a) for (let b = 0; b < m; ++b) if (a !== b && linked(ids[a], ids[b])) L[a * m + b] = 1;

  // graph distances, edge length = ri + rj
  const D = graphDistances(L, r, m, cl);
  const P = new Float64Array(m * 2);
  if (opts.init) {
    for (let a = 0; a < m; ++a) { P[2 * a] = opts.init[a][0]; P[2 * a + 1] = opts.init[a][1]; }
  } else {
    // classical MDS start, then stress majorization
    mdsStart(D, m, r, rng, P);
    smacof(P, D, m);
  }
  // constraint projection: links overlap a little, non-links keep apart
  const inv = r.map(x => 1 / (x * x));
  const iters = opts.iterations ?? 600;
  const order = Array.from({length: m}, (_, i) => i);
  const segs = [];
  for (let a = 0; a < m; ++a) for (let b = a + 1; b < m; ++b) if (L[a * m + b]) segs.push([a, b]);
  // Every pair is visited in the same order as a full scan would, but an unlinked pair that
  // cannot be closer than its separation is skipped. Each country keeps a list of the others that
  // were within reach when the lists were made (separation + 2 K (ra + rb), with room for the pull
  // to the centre, which shrinks the whole continent about a point: positions are compared in
  // that shrinking frame). A country that has moved more than K times its radius since is "hot"
  // and is always visited; a pair of two countries that are not hot and not on each other's list
  // is still apart.
  const K = opts.listMargin ?? 1, SMIN = 0.98;
  const lists = Array.from({length: m}, () => []);
  const lx = new Float64Array(m), ly = new Float64Array(m);
  let fs = 1, ftx = 0, fty = 0;           // the frame: p -> fs * p + (ftx, fty) since the lists
  const hot = new Uint8Array(m), inList = new Int32Array(m).fill(-1);
  let nHot = 0, listed = false;
  const makeLists = () => {
    for (let a = 0; a < m; ++a) { lists[a].length = 0; lx[a] = P[2 * a]; ly[a] = P[2 * a + 1]; }
    fs = 1; ftx = fty = 0;
    hot.fill(0); nHot = 0;
    for (let a = 0; a < m; ++a) for (let b = 0; b < m; ++b) {
      if (a === b) continue;
      if (!L[a * m + b]) {
        const t = (cs * (r[a] + r[b]) + 2 * K * (r[a] + r[b])) / SMIN;
        const dx = P[2 * b] - P[2 * a], dy = P[2 * b + 1] - P[2 * a + 1];
        if (dx * dx + dy * dy > t * t * (1 + 1e-9)) continue;
      }
      lists[a].push(b);
    }
    listed = true;
  };
  // has a moved more than K r[a] in the frame? (then it is hot from now on)
  const heat = a => {
    if (hot[a]) return true;
    const dx = P[2 * a] - (fs * lx[a] + ftx), dy = P[2 * a + 1] - (fs * ly[a] + fty), k = K * r[a];
    if (dx * dx + dy * dy > k * k * (1 - 1e-9)) { hot[a] = 1; nHot++; return true; }
    return false;
  };
  // the constraint between a and b; returns whether a or b moved
  const relax = (a, b, stiff) => {
    const dx = P[2 * b] - P[2 * a], dy = P[2 * b + 1] - P[2 * a + 1];
    // unlinked and clearly apart: nothing to do (the same test as below, without the root)
    if (!L[a * m + b]) {
      const t = cs * (r[a] + r[b]);
      if (dx * dx + dy * dy > t * t * (1 + 1e-9)) return false;
    }
    const d = hypot(dx, dy) || 1e-9;
    let target;
    if (L[a * m + b]) {
      target = cl * (r[a] + r[b]);
      if (globalThis.INEQ && d < target) {
        target = (globalThis.INEQ) * (r[a] + r[b]);
        if (d >= target) return false;
      }
    } else {
      target = cs * (r[a] + r[b]);
      if (d >= target) return false;
    }
    const c = (d - target) / d * stiff * 0.5;   // half: every pair is visited twice
    const wa = inv[a] / (inv[a] + inv[b]), wb = 1 - wa;
    P[2 * a] += dx * c * wa; P[2 * a + 1] += dy * c * wa;
    P[2 * b] -= dx * c * wb; P[2 * b + 1] -= dy * c * wb;
    return true;
  };
  for (let it = 0; it < iters; ++it) {
    const stiff = 0.6;
    // a weak pull to the centre keeps the continent compact
    let cx = 0, cy = 0, tw = 0;
    for (let a = 0; a < m; ++a) { cx += P[2 * a] * r[a] * r[a]; cy += P[2 * a + 1] * r[a] * r[a]; tw += r[a] * r[a]; }
    cx /= tw; cy /= tw;
    const g = (opts.centerPull ?? 0.002) * (1 - it / iters);
    for (let a = 0; a < m; ++a) { P[2 * a] += (cx - P[2 * a]) * g; P[2 * a + 1] += (cy - P[2 * a + 1]) * g; }
    fs *= 1 - g; ftx = (1 - g) * ftx + g * cx; fty = (1 - g) * fty + g * cy;
    // a warm start: each country is pulled back toward where it was, so a change fades with distance
    if (opts.anchors) for (let a = 0; a < m; ++a) {
      const q = opts.anchors[a];
      if (q) { P[2 * a] += (q[0] - P[2 * a]) * opts.anchorPull; P[2 * a + 1] += (q[1] - P[2 * a + 1]) * opts.anchorPull; }
    }
    for (let k = m - 1; k > 0; --k) { const j = Math.floor(rng() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
    // lists still good? (made again when the frame has shrunk too far or many are hot)
    if (!listed || fs < SMIN + 1e-9 || nHot > m >> 3) makeLists();
    for (let a = 0; a < m; ++a) heat(a);
    for (const a of order) {
      if (hot[a]) { for (let b = 0; b < m; ++b) if (a !== b && relax(a, b, stiff)) heat(b); continue; }
      const list = lists[a];
      for (let k = 0; k < list.length; ++k) inList[list[k]] = a;
      for (let b = 0; b < m; ++b) {
        if (inList[b] !== a && !hot[b]) continue;
        if (a === b || !relax(a, b, stiff)) continue;
        heat(b);
        if (heat(a)) {
          // a is hot now: the rest of its row is visited in full
          for (let b2 = b + 1; b2 < m; ++b2) if (a !== b2 && relax(a, b2, stiff)) heat(b2);
          break;
        }
      }
    }
    if (it % 2 === 0 && it < iters * 0.9) uncross(P, segs, r, inv);
  }
  const out = [];
  for (let a = 0; a < m; ++a) out.push([P[2 * a], P[2 * a + 1]]);
  return out;
}

// (the stages are separate functions so that each is compiled on its own)
function graphDistances(L, r, m, cl) {
  const D = new Float64Array(m * m).fill(Infinity);
  for (let a = 0; a < m; ++a) {
    D[a * m + a] = 0;
    for (let b = 0; b < m; ++b) if (L[a * m + b]) D[a * m + b] = (r[a] + r[b]) * cl;
  }
  for (let k = 0; k < m; ++k) for (let a = 0; a < m; ++a) {
    const dak = D[a * m + k];
    if (dak === Infinity) continue;
    for (let b = 0; b < m; ++b) {
      const v = dak + D[k * m + b];
      if (v < D[a * m + b]) D[a * m + b] = v;
    }
  }
  let maxD = 0;
  for (let i = 0; i < m * m; ++i) if (D[i] < Infinity && D[i] > maxD) maxD = D[i];
  for (let i = 0; i < m * m; ++i) if (D[i] === Infinity) D[i] = maxD * 1.2;
  return D;
}

// classical MDS start (power iteration on the double-centred squared distances)
function mdsStart(D, m, r, rng, P) {
  const B = new Float64Array(m * m);
  const rowMean = new Float64Array(m);
  let allMean = 0;
  for (let a = 0; a < m; ++a) for (let b = 0; b < m; ++b) {
    const d2 = D[a * m + b] ** 2;
    rowMean[a] += d2 / m;
    allMean += d2 / (m * m);
  }
  for (let a = 0; a < m; ++a) for (let b = 0; b < m; ++b)
    B[a * m + b] = -0.5 * (D[a * m + b] ** 2 - rowMean[a] - rowMean[b] + allMean);
  const eig = [];
  for (let e = 0; e < 2; ++e) {
    let v = new Float64Array(m).map(() => rng() - 0.5);
    let lambda = 0;
    for (let it = 0; it < 200; ++it) {
      // deflate the earlier eigenvectors
      for (const [u] of eig) deflate(u, v, m);
      const w = matVec(B, v, m);
      let norm = Math.hypot(...w) || 1;
      lambda = norm;
      v = w.map(x => x / norm);
    }
    eig.push([v, lambda]);
  }
  for (let a = 0; a < m; ++a) {
    P[2 * a] = eig[0][0][a] * Math.sqrt(eig[0][1]) + (rng() - 0.5) * r[a] * 0.5;
    P[2 * a + 1] = eig[1][0][a] * Math.sqrt(eig[1][1]) + (rng() - 0.5) * r[a] * 0.5;
  }
}
function deflate(u, v, m) {
  let dot = 0;
  for (let i = 0; i < m; ++i) dot += u[i] * v[i];
  for (let i = 0; i < m; ++i) v[i] -= dot * u[i];
}
function matVec(B, v, m) {
  const w = new Float64Array(m);
  for (let a = 0; a < m; ++a) {
    let s = 0;
    for (let b = 0; b < m; ++b) s += B[a * m + b] * v[b];
    w[a] = s;
  }
  return w;
}

// stress majorization (SMACOF), weights 1/d^2
function smacof(P, D, m) {
  const N = new Float64Array(m * 2);
  for (let it = 0; it < 120; ++it) {
    for (let a = 0; a < m; ++a) {
      let sx = 0, sy = 0, sw = 0;
      for (let b = 0; b < m; ++b) {
        if (a === b) continue;
        const d0 = D[a * m + b];
        const w = 1 / (d0 * d0);
        const dx = P[2 * a] - P[2 * b], dy = P[2 * a + 1] - P[2 * b + 1];
        const d = hypot(dx, dy) || 1e-9;
        sx += w * (P[2 * b] + d0 * dx / d);
        sy += w * (P[2 * b + 1] + d0 * dy / d);
        sw += w;
      }
      N[2 * a] = sx / sw;
      N[2 * a + 1] = sy / sw;
    }
    P.set(N);
  }
}

// two links drawn as crossing segments can't both be borders: push the cheapest endpoint
// (light and close to the other segment) back across
function uncross(P, segs, r, inv) {
  const side = (px, py, ax, ay, bx, by) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  // boxes of the segments (kept current: a fix moves one point), so pairs far apart are skipped
  // without the orientation tests; the margin keeps the skip exact
  const ns = segs.length, M = 1e-6;
  const sa = segs.ends || (segs.ends = Int32Array.from(segs.flat()));
  const box = new Float64Array(4 * ns);
  const setBox = x => {
    const a = sa[2 * x], b = sa[2 * x + 1];
    const ax = P[2 * a], ay = P[2 * a + 1], bx = P[2 * b], by = P[2 * b + 1];
    box[4 * x] = (ax < bx ? ax : bx) - M; box[4 * x + 1] = (ax < bx ? bx : ax) + M;
    box[4 * x + 2] = (ay < by ? ay : by) - M; box[4 * x + 3] = (ay < by ? by : ay) + M;
  };
  for (let x = 0; x < ns; ++x) setBox(x);
  const apart = (x, y) => box[4 * y] > box[4 * x + 1] || box[4 * x] > box[4 * y + 1] || box[4 * y + 2] > box[4 * x + 3] || box[4 * x + 2] > box[4 * y + 3];
  // pair (x, y), x < y: if the two links cross, push one endpoint back across; returns the
  // point moved (or -1)
  const fix = (x, y) => {
    if (apart(x, y)) return -1;
    const a = sa[2 * x], b = sa[2 * x + 1], c = sa[2 * y], d = sa[2 * y + 1];
    if (a === c || a === d || b === c || b === d) return -1;
    const ax = P[2 * a], ay = P[2 * a + 1], bx = P[2 * b], by = P[2 * b + 1];
    const cx = P[2 * c], cy = P[2 * c + 1], dx = P[2 * d], dy = P[2 * d + 1];
    const s1 = side(ax, ay, cx, cy, dx, dy), s2 = side(bx, by, cx, cy, dx, dy);
    if ((s1 > 0) === (s2 > 0)) return -1;
    const s3 = side(cx, cy, ax, ay, bx, by), s4 = side(dx, dy, ax, ay, bx, by);
    if ((s3 > 0) === (s4 > 0)) return -1;
    const lcd = hypot(dx - cx, dy - cy) || 1e-9, lab = hypot(bx - ax, by - ay) || 1e-9;
    // candidate moves: endpoint, its distance to the other line, the line's unit normal
    const cand = [
      [a, s1 / lcd, -(dy - cy) / lcd, (dx - cx) / lcd],
      [b, s2 / lcd, -(dy - cy) / lcd, (dx - cx) / lcd],
      [c, s3 / lab, -(by - ay) / lab, (bx - ax) / lab],
      [d, s4 / lab, -(by - ay) / lab, (bx - ax) / lab],
    ];
    let best = null, bestCost = Infinity;
    for (const q of cand) {
      const cost = Math.abs(q[1]) / inv[q[0]];
      if (cost < bestCost) { bestCost = cost; best = q; }
    }
    const [p, dist, nx, ny] = best;
    // move p to the other side, a little past the line
    const push = -(dist + Math.sign(dist) * 0.15 * r[p]);
    P[2 * p] += nx * push * 0.5;
    P[2 * p + 1] += ny * push * 0.5;
    for (let z = 0; z < ns; ++z) if (sa[2 * z] === p || sa[2 * z + 1] === p) setBox(z);
    return p;
  };
  // The pairs whose boxes overlap (a sweep along x), as codes x * ns + y in the order of a full
  // scan (x, then y > x): the pairs a full scan would not skip. A fix moves one point, so the
  // pairs of its segments are looked at again, and those that overlap now and that the scan has
  // not passed are merged into the rest of the list.
  // (segments by the left side of their box: the order of the last call, mended by insertion)
  const byX = segs.byX || (segs.byX = Int32Array.from({length: ns}, (_, i) => i));
  for (let i = 1; i < ns; ++i) {
    const q = byX[i], k = box[4 * q];
    let j = i - 1;
    while (j >= 0 && box[4 * byX[j]] > k) { byX[j + 1] = byX[j]; --j; }
    byX[j + 1] = q;
  }
  const codes = [];
  for (let i = 0; i < ns; ++i) {
    const p = byX[i];
    for (let j = i + 1; j < ns; ++j) {
      const q = byX[j];
      if (box[4 * q] > box[4 * p + 1]) break;
      if (box[4 * q + 2] > box[4 * p + 3] || box[4 * p + 2] > box[4 * q + 3]) continue;
      codes.push(p < q ? p * ns + q : q * ns + p);
    }
  }
  // boxes' left sides as they were at the start, the widest box, and the segments moved since
  const x0i = new Float64Array(ns);
  let maxW = 0;
  for (let x = 0; x < ns; ++x) { x0i[x] = box[4 * x]; maxW = Math.max(maxW, box[4 * x + 1] - box[4 * x]); }
  maxW += 1e-9 * (1 + maxW);
  const movedMark = new Uint8Array(ns), moved = [];
  // the sorted codes, merged on the fly with a small min-heap of codes added by fixes
  const list = Int32Array.from(codes).sort();
  let heap = new Int32Array(64), size = 0, next = 0;
  const push = c => {
    if (size === heap.length) { const h = new Int32Array(2 * size); h.set(heap); heap = h; }
    let i = size++;
    while (i > 0) { const q = (i - 1) >> 1; if (heap[q] <= c) break; heap[i] = heap[q]; i = q; }
    heap[i] = c;
  };
  const pop = () => {
    if (size === 0 || (next < list.length && list[next] <= heap[0])) return list[next++];
    const top = heap[0], last = heap[--size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= size) break;
      if (c + 1 < size && heap[c + 1] < heap[c]) c++;
      if (heap[c] >= last) break;
      heap[i] = heap[c]; i = c;
    }
    heap[i] = last;
    return top;
  };
  const atNode = segs.atNode || (segs.atNode = (() => {
    const lists = new Map();
    for (let z = 0; z < ns; ++z) for (const q of [sa[2 * z], sa[2 * z + 1]]) { if (!lists.has(q)) lists.set(q, []); lists.get(q).push(z); }
    return lists;
  })());
  let done = -1;     // the last pair visited: copies and passed pairs are skipped
  // (a graph that no arrangement can draw flat has crossings left however many are mended, and
  // each one mended brings its neighbours up again: a call mends so many and leaves the rest to
  // the next. Far more than the countries ever need, where a call mends some fifty at most.)
  let left = 64 + (ns >> 3);
  while (size > 0 || next < list.length) {
    const code = pop();
    if (code <= done) continue;
    done = code;
    const x = Math.floor(code / ns), y = code - x * ns;
    const p = fix(x, y);
    if (p < 0) continue;
    if (--left === 0) break;
    const zs = atNode.get(p);
    for (const z of zs) if (movedMark[z] !== 1) { movedMark[z] = 1; moved.push(z); }
    // the segments whose boxes overlap a moved one now: among those not moved yet in this call,
    // a window of the sweep order (their boxes are as they were); and the moved ones
    const add = (z, w) => {
      if (w === z) return;
      const lo = w < z ? w : z, hi = w < z ? z : w;
      if (lo * ns + hi > code && !apart(lo, hi)) push(lo * ns + hi);
    };
    for (const z of zs) {
      const zx0 = box[4 * z], zx1 = box[4 * z + 1];
      let a = 0, b = ns;
      while (a < b) { const mid = (a + b) >> 1; if (x0i[byX[mid]] < zx0 - maxW) a = mid + 1; else b = mid; }
      for (let i = a; i < ns && x0i[byX[i]] <= zx1; ++i) { const w = byX[i]; if (movedMark[w] !== 1) add(z, w); }
      for (const w of moved) add(z, w);
    }
  }
}

// for every link (a, b) in `pairs`: how many other links its segment crosses, and its stretch
export function linkGeometry(pairs, P, rad) {
  const cross = new Array(pairs.length).fill(0);
  for (let x = 0; x < pairs.length; ++x) {
    const [a, b] = pairs[x];
    for (let y = x + 1; y < pairs.length; ++y) {
      const [c, d] = pairs[y];
      if (a === c || a === d || b === c || b === d) continue;
      if (segX(P[a], P[b], P[c], P[d])) { cross[x]++; cross[y]++; }
    }
  }
  const stretch = pairs.map(([a, b]) => hypot(P[a][0] - P[b][0], P[a][1] - P[b][1]) / (rad[a] + rad[b]));
  return {cross, stretch};
}
function segX(p, q, r, s) {
  const o = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = o(r, s, p), d2 = o(r, s, q), d3 = o(p, q, r), d4 = o(p, q, s);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

export function layoutStats(ids, pos, rad, linked) {
  let linkOk = 0, links = 0, bad = 0, missing = [];
  for (let a = 0; a < ids.length; ++a) for (let b = a + 1; b < ids.length; ++b) {
    const d = hypot(pos[a][0] - pos[b][0], pos[a][1] - pos[b][1]);
    const s = rad[ids[a]] + rad[ids[b]];
    if (linked(ids[a], ids[b])) { links++; if (d < s) linkOk++; else missing.push([ids[a], ids[b], d / s]); }
    else if (d < s) bad++;
  }
  return {links, linkOk, bad, missing};
}
