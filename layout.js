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

  const P = new Float64Array(m * 2);
  if (opts.init) {
    for (let a = 0; a < m; ++a) { P[2 * a] = opts.init[a][0]; P[2 * a + 1] = opts.init[a][1]; }
  } else {
  // classical MDS start (power iteration on the double-centred squared distances)
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
      for (const [u] of eig) {
        let dot = 0;
        for (let i = 0; i < m; ++i) dot += u[i] * v[i];
        for (let i = 0; i < m; ++i) v[i] -= dot * u[i];
      }
      const w = new Float64Array(m);
      for (let a = 0; a < m; ++a) {
        let s = 0;
        for (let b = 0; b < m; ++b) s += B[a * m + b] * v[b];
        w[a] = s;
      }
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

  // stress majorization (SMACOF), weights 1/d^2
  for (let it = 0; it < 120; ++it) {
    const N = new Float64Array(m * 2);
    for (let a = 0; a < m; ++a) {
      let sx = 0, sy = 0, sw = 0;
      for (let b = 0; b < m; ++b) {
        if (a === b) continue;
        const d0 = D[a * m + b];
        const w = 1 / (d0 * d0);
        const dx = P[2 * a] - P[2 * b], dy = P[2 * a + 1] - P[2 * b + 1];
        const d = Math.hypot(dx, dy) || 1e-9;
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
  // constraint projection: links overlap a little, non-links keep apart
  const inv = r.map(x => 1 / (x * x));
  const iters = opts.iterations ?? 600;
  const order = Array.from({length: m}, (_, i) => i);
  const segs = [];
  for (let a = 0; a < m; ++a) for (let b = a + 1; b < m; ++b) if (L[a * m + b]) segs.push([a, b]);
  for (let it = 0; it < iters; ++it) {
    const stiff = 0.6;
    // a weak pull to the centre keeps the continent compact
    let cx = 0, cy = 0, tw = 0;
    for (let a = 0; a < m; ++a) { cx += P[2 * a] * r[a] * r[a]; cy += P[2 * a + 1] * r[a] * r[a]; tw += r[a] * r[a]; }
    cx /= tw; cy /= tw;
    const g = (opts.centerPull ?? 0.002) * (1 - it / iters);
    for (let a = 0; a < m; ++a) { P[2 * a] += (cx - P[2 * a]) * g; P[2 * a + 1] += (cy - P[2 * a + 1]) * g; }
    // a warm start: each country is pulled back toward where it was, so a change fades with distance
    if (opts.anchors) for (let a = 0; a < m; ++a) {
      const q = opts.anchors[a];
      if (q) { P[2 * a] += (q[0] - P[2 * a]) * opts.anchorPull; P[2 * a + 1] += (q[1] - P[2 * a + 1]) * opts.anchorPull; }
    }
    for (let k = m - 1; k > 0; --k) { const j = Math.floor(rng() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
    for (const a of order) for (let b = 0; b < m; ++b) {
      if (a === b) continue;
      const dx = P[2 * b] - P[2 * a], dy = P[2 * b + 1] - P[2 * a + 1];
      const d = Math.hypot(dx, dy) || 1e-9;
      let target;
      if (L[a * m + b]) {
        target = cl * (r[a] + r[b]);
        if (globalThis.INEQ && d < target) {
          target = (globalThis.INEQ) * (r[a] + r[b]);
          if (d >= target) continue;
        }
      } else {
        target = cs * (r[a] + r[b]);
        if (d >= target) continue;
      }
      const c = (d - target) / d * stiff * 0.5;   // half: every pair is visited twice
      const wa = inv[a] / (inv[a] + inv[b]), wb = 1 - wa;
      P[2 * a] += dx * c * wa; P[2 * a + 1] += dy * c * wa;
      P[2 * b] -= dx * c * wb; P[2 * b + 1] -= dy * c * wb;
    }
    if (it % 2 === 0 && it < iters * 0.9) uncross(P, segs, r, inv);
  }
  const out = [];
  for (let a = 0; a < m; ++a) out.push([P[2 * a], P[2 * a + 1]]);
  return out;
}

// two links drawn as crossing segments can't both be borders: push the cheapest endpoint
// (light and close to the other segment) back across
function uncross(P, segs, r, inv) {
  const side = (px, py, ax, ay, bx, by) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  for (let x = 0; x < segs.length; ++x) {
    const [a, b] = segs[x];
    for (let y = x + 1; y < segs.length; ++y) {
      const [c, d] = segs[y];
      if (a === c || a === d || b === c || b === d) continue;
      const ax = P[2 * a], ay = P[2 * a + 1], bx = P[2 * b], by = P[2 * b + 1];
      const cx = P[2 * c], cy = P[2 * c + 1], dx = P[2 * d], dy = P[2 * d + 1];
      const s1 = side(ax, ay, cx, cy, dx, dy), s2 = side(bx, by, cx, cy, dx, dy);
      if ((s1 > 0) === (s2 > 0)) continue;
      const s3 = side(cx, cy, ax, ay, bx, by), s4 = side(dx, dy, ax, ay, bx, by);
      if ((s3 > 0) === (s4 > 0)) continue;
      const lcd = Math.hypot(dx - cx, dy - cy) || 1e-9, lab = Math.hypot(bx - ax, by - ay) || 1e-9;
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
  const stretch = pairs.map(([a, b]) => Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1]) / (rad[a] + rad[b]));
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
    const d = Math.hypot(pos[a][0] - pos[b][0], pos[a][1] - pos[b][1]);
    const s = rad[ids[a]] + rad[ids[b]];
    if (linked(ids[a], ids[b])) { links++; if (d < s) linkOk++; else missing.push([ids[a], ids[b], d / s]); }
    else if (d < s) bad++;
  }
  return {links, linkOk, bad, missing};
}
