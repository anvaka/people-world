// Steps on the boundary graph. Each vertex move goes through Geo.tryMove, so none of them can
// create a crossing or close a gap between labels that must stay apart.
import {fbm2, segmentsIntersect, segSegDist2} from './util.js';

function isClosed(c) { return c.v[0] === c.v[c.v.length - 1]; }

// Taubin smoothing of chains (a shrinking Laplacian step, then an inflating one, so small
// blobs keep their size); junctions follow more slowly
export function smooth(geo, iterations, lambda0 = 0.5, skip = () => false, taubin = true) {
  const {vx, vy, chains} = geo;
  for (let it = 0; it < (taubin ? 2 : 1) * iterations; ++it) {
    const lambda = !taubin || it % 2 === 0 ? lambda0 : -1.06 * lambda0;
    if (it % 4 === 0) geo.budgets(v => 1.5 * geo.localLen(v));
    for (const c of chains) {
      if (skip(c)) continue;
      const v = c.v, n = v.length;
      const closed = isClosed(c);
      const from = closed ? 0 : 1, to = n - 1;
      for (let i = from; i < to; ++i) {
        const p = v[i];
        const a = i === 0 ? v[n - 2] : v[i - 1], b = v[i + 1];
        const tx = (vx[a] + vx[b]) / 2, ty = (vy[a] + vy[b]) / 2;
        geo.tryMove(p, vx[p] + lambda * (tx - vx[p]), vy[p] + lambda * (ty - vy[p]));
      }
    }
    // junctions: toward the mean of their neighbours
    for (let p = 0; p < vx.length; ++p) {
      const segs = geo.vSegs[p];
      if (segs.length < 3) continue;
      let sx = 0, sy = 0, skipIt = false, cs = 0, cx = 0, cy = 0;
      for (const s of segs) {
        const c = chains[geo.segC[s]];
        if (skip(c)) skipIt = true;
        const o = geo.segA[s] === p ? geo.segB[s] : geo.segA[s];
        sx += vx[o]; sy += vy[o];
        if (c.L < 0 || c.R < 0) { cs++; cx += vx[o]; cy += vy[o]; }
      }
      if (skipIt) continue;
      if (cs === 2) {
        // where a border reaches the sea, the coast runs on straight: follow the two coast
        // neighbours only (the border's end slides along)
        cx /= 2; cy /= 2;
        geo.tryMove(p, vx[p] + lambda * (cx - vx[p]), vy[p] + lambda * (cy - vy[p]));
        continue;
      }
      sx /= segs.length; sy /= segs.length;
      geo.tryMove(p, vx[p] + 0.5 * lambda * (sx - vx[p]), vy[p] + 0.5 * lambda * (sy - vy[p]));
    }
  }
}

// split segments longer than maxLen(chain, x, y)
export function subdivide(geo, maxLen) {
  const {vx, vy} = geo;
  for (const c of geo.chains) {
    const out = [c.v[0]];
    for (let i = 0; i + 1 < c.v.length; ++i) {
      const a = c.v[i], b = c.v[i + 1];
      const L = Math.hypot(vx[b] - vx[a], vy[b] - vy[a]);
      const m = maxLen(c, (vx[a] + vx[b]) / 2, (vy[a] + vy[b]) / 2);
      const k = Math.min(64, Math.ceil(L / m));
      for (let j = 1; j < k; ++j) {
        const t = j / k;
        out.push(vx.length);
        vx.push(vx[a] + t * (vx[b] - vx[a]));
        vy.push(vy[a] + t * (vy[b] - vy[a]));
      }
      out.push(b);
    }
    c.v = out;
  }
  geo.rebuild();
}

// drop vertices that carry no shape (nearly straight runs), keeping spacing below maxLen
export function simplify(geo, tol, maxLen) {
  const {vx, vy} = geo;
  for (const c of geo.chains) {
    if (c.v.length < 4) continue;
    const out = [c.v[0]];
    let last = c.v[0];
    for (let i = 1; i + 1 < c.v.length; ++i) {
      const p = c.v[i], q = c.v[i + 1];
      // distance of p from the line last -> q
      const dx = vx[q] - vx[last], dy = vy[q] - vy[last];
      const L = Math.hypot(dx, dy) || 1e-30;
      const dev = Math.abs((vx[p] - vx[last]) * dy - (vy[p] - vy[last]) * dx) / L;
      if (dev > tol(c) || L > maxLen(c)) { out.push(p); last = p; }
    }
    out.push(c.v[c.v.length - 1]);
    if (out.length >= (isClosed(c) ? 4 : 2)) c.v = out;
  }
  geo.rebuild();
}

// fractal displacement along the chain normal: coasts get capes and coves, borders a wobble
export function roughen(geo, amp, seed) {
  const {vx, vy, chains} = geo;
  geo.budgets(v => { const c = chains[geo.segC[geo.vSegs[v][0]]]; return c ? 1.2 * amp(c) : 0; });
  const isCoast = c => c.L < 0 || c.R < 0;
  // coasts: one 2D noise field over the whole map, displacing along the normal toward the sea, so
  // the coast runs on continuously through the ends of borders (no taper, no notch)
  const coastAmp = new Float64Array(vx.length), coastNx = new Float64Array(vx.length), coastNy = new Float64Array(vx.length);
  const coastCnt = new Uint8Array(vx.length);
  for (const c of chains) {
    if (!isCoast(c)) continue;
    const a0 = amp(c);
    const v = c.v, n = v.length;
    const sgn = c.R < 0 ? 1 : -1;          // right-hand normal points to R
    for (let i = 0; i + 1 < n; ++i) {
      const a = v[i], b = v[i + 1];
      const nx = (vy[b] - vy[a]) * sgn, ny = -(vx[b] - vx[a]) * sgn;
      for (const p of [a, b]) { coastNx[p] += nx; coastNy[p] += ny; }
    }
    for (const p of v) { coastAmp[p] += a0; coastCnt[p]++; }
  }
  const base = Float64Array.from(vx), baseY = Float64Array.from(vy);
  for (let p = 0; p < vx.length; ++p) {
    if (!coastCnt[p]) continue;
    // a junction where two countries' coasts meet a border moves too, but only if exactly two coast
    // segments meet there (else it is an inland triple point)
    let coastSegs = 0;
    for (const sg of geo.vSegs[p]) if (isCoast(chains[geo.segC[sg]])) coastSegs++;
    if (coastSegs !== 2) continue;
    const a0 = coastAmp[p] / coastCnt[p];
    const nl = Math.hypot(coastNx[p], coastNy[p]);
    if (!nl) continue;
    const wl = a0 * 9;
    const d = a0 * fbm2(base[p] / wl, baseY[p] / wl, seed, 3, 0.5);
    geo.tryMove(p, base[p] + coastNx[p] / nl * d, baseY[p] + coastNy[p] / nl * d);
  }
  // borders: a gentle wobble along the chain, tapered to zero at both ends
  chains.forEach((c, ci) => {
    if (isCoast(c)) return;
    const a0 = amp(c);
    if (!(a0 > 0)) return;
    const v = c.v, n = v.length;
    if (n < 3) return;
    const closed = isClosed(c);
    const s = [0];
    for (let i = 1; i < n; ++i) s.push(s[i - 1] + Math.hypot(vx[v[i]] - vx[v[i - 1]], vy[v[i]] - vy[v[i - 1]]));
    const total = s[n - 1];
    const wl = a0 * 9;
    const pts = [];
    for (let i = 0; i < n; ++i) pts.push([vx[v[i]], vy[v[i]]]);
    for (let i = closed ? 0 : 1; i < n - 1; ++i) {
      const p = v[i];
      const a = pts[i === 0 ? n - 2 : i - 1], b = pts[i + 1];
      let nx = b[1] - a[1], ny = -(b[0] - a[0]);
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl; ny /= nl;
      const taper = closed ? 1 : Math.min(1, Math.min(s[i], total - s[i]) / (1.5 * a0 + 1e-30));
      const d = a0 * taper * fbm2(s[i] / wl, ci * 0.37 + 0.5, seed, 3, 0.5);
      geo.tryMove(p, pts[i][0] + nx * d, pts[i][1] + ny * d);
    }
  });
}

// Move boundaries until every label has its target area. Each chain is pushed toward the side
// with too much area; water absorbs whatever is needed.
export function fitAreas(geo, target, opts = {}) {
  const {vx, vy, chains} = geo;
  const frozen = opts.frozen || (() => false);
  const iterations = opts.iterations ?? 200;
  const tol = opts.tol ?? 2e-4;
  const rings = geo.rings();
  let worst = Infinity;
  const accX = new Float64Array(vx.length), accY = new Float64Array(vx.length), accW = new Float64Array(vx.length);
  const fixed = new Uint8Array(vx.length);
  chains.forEach(c => {
    if (frozen(c.L) || frozen(c.R)) for (const p of c.v) fixed[p] = 1;
  });
  if (opts.pinJunctions) for (let p = 0; p < vx.length; ++p) if (geo.vSegs[p].length >= 3) fixed[p] = 1;
  // moves too small to matter are skipped
  const gain = new Map(), lastErr = new Map();
  // junctions where a border meets the sea: [junction, coast neighbour, coast neighbour]
  const coastJunctions = [];
  for (let p = 0; p < vx.length; ++p) {
    const segs = geo.vSegs[p];
    if (segs.length !== 3) continue;
    const nb = [];
    for (const sg of segs) {
      const c = chains[geo.segC[sg]];
      if (c.L < 0 || c.R < 0) nb.push(geo.segA[sg] === p ? geo.segB[sg] : geo.segA[sg]);
    }
    if (nb.length === 2) coastJunctions.push([p, nb[0], nb[1]]);
  }
  // room to move per budget period: a share of the size of the smaller label at the vertex
  const capOf = new Float64Array(vx.length);
  for (const c of chains) {
    const tl = c.L >= 0 ? target(c.L) : Infinity, tr = c.R >= 0 ? target(c.R) : Infinity;
    const cap = Math.min(0.25, 0.08 * Math.sqrt(Math.min(tl, tr)));
    for (const p of c.v) capOf[p] = Math.max(capOf[p], cap);
  }
  const minMove = new Float64Array(vx.length);
  for (let p = 0; p < vx.length; ++p) minMove[p] = 1e-4 * geo.localLen(p);
  for (let it = 0; it < iterations; ++it) {
    if (it % 8 === 0) geo.budgets(v => Math.max(2 * geo.localLen(v), capOf[v]));
    const {areas, perims} = geo.labelAreas(rings);
    const delta = new Map();
    worst = 0;
    for (const [l, A] of areas) {
      const T = target(l);
      if (!(T > 0)) continue;
      const err = A / T - 1;
      if (!frozen(l)) worst = Math.max(worst, Math.abs(err));
      // adaptive gain: keep pushing harder while the error keeps its sign and shrinks slowly
      let g = gain.get(l) || 1;
      const prev = lastErr.get(l);
      if (prev !== undefined) {
        if (Math.sign(prev) !== Math.sign(err)) g = Math.max(0.5, g * 0.5);
        else if (Math.abs(err) > 0.5 * Math.abs(prev)) g = Math.min(2.5, g * 1.3);
      }
      gain.set(l, g);
      lastErr.set(l, err);
      delta.set(l, g * (T - A) / perims.get(l));
    }
    if (globalThis.FITLOG && it % 10 === 0) { let wl = null, we = 0; for (const [l, A] of areas) { const T = target(l); if (T > 0 && !frozen(l) && Math.abs(A / T - 1) > we) { we = Math.abs(A / T - 1); wl = l; } } console.log('fit it', it, 'worst', we.toFixed(5), 'label', wl, Date.now()); }
    if (worst < tol) break;
    accX.fill(0); accY.fill(0); accW.fill(0);
    // only chains of labels still off target move (the others are done)
    for (const c of chains) {
      const dL = c.L >= 0 ? (delta.get(c.L) || 0) : 0, dR = c.R >= 0 ? (delta.get(c.R) || 0) : 0;
      const f = c.L >= 0 && c.R >= 0 ? (dL - dR) / 2 : c.L >= 0 ? dL : -dR;
      const v = c.v;
      for (let i = 0; i + 1 < v.length; ++i) {
        const a = v[i], b = v[i + 1];
        const dx = vx[b] - vx[a], dy = vy[b] - vy[a];
        const len = Math.hypot(dx, dy);
        if (len === 0) continue;
        // right-hand normal: toward R
        const nx = dy / len, ny = -dx / len;
        const w = len / 2;
        accX[a] += nx * f * w; accY[a] += ny * f * w; accW[a] += w;
        accX[b] += nx * f * w; accY[b] += ny * f * w; accW[b] += w;
      }
    }
    // smooth the displacement field along each chain, so offsets do not pile up into cusps
    for (let p = 0; p < vx.length; ++p) if (accW[p] > 0) { accX[p] /= accW[p]; accY[p] /= accW[p]; accW[p] = 1; }
    for (let pass = 0; pass < (opts.smoothPasses ?? 2); ++pass) {
      // a coast junction moves with the coast on both sides of it
      for (const [p, a, b] of coastJunctions) {
        accX[p] = 0.25 * accX[a] + 0.5 * accX[p] + 0.25 * accX[b];
        accY[p] = 0.25 * accY[a] + 0.5 * accY[p] + 0.25 * accY[b];
      }
      for (const c of chains) {
        const v = c.v, n = v.length;
        if (n < 3) continue;
        let px = accX[v[0]], py = accY[v[0]];
        for (let i = 1; i < n - 1; ++i) {
          const p = v[i], q = v[i + 1];
          const nx = 0.5 * accX[p] + 0.25 * (px + accX[q]), ny = 0.5 * accY[p] + 0.25 * (py + accY[q]);
          px = accX[p]; py = accY[p];
          accX[p] = nx; accY[p] = ny;
        }
      }
    }
    const omega = opts.omega ?? 0.9;
    for (let p = 0; p < vx.length; ++p) {
      if (fixed[p] || accW[p] === 0) continue;
      const mx = accX[p] / accW[p] * omega, my = accY[p] / accW[p] * omega;
      if (Math.abs(mx) + Math.abs(my) < minMove[p]) continue;
      if (!geo.tryMove(p, vx[p] + mx, vy[p] + my)) geo.tryMove(p, vx[p] + mx * 0.3, vy[p] + my * 0.3);
    }
  }
  return worst;
}

// Shrink an over-sized label (a tiny country drawn larger in the mesh phase) radially toward a
// centre from which it is star-shaped. The strips it gives up go to whatever lay beyond each of
// its edges; borders between its neighbours are extended along the rays. Topology is unchanged.
export function collapse(geo, label, factor) {
  const {vx, vy, chains} = geo;
  const ringsMap = geo.rings();
  const rings = ringsMap.get(label);
  if (!rings || rings.length !== 1) return false;
  const ids = geo.ringPoints(rings[0]);
  // candidate centres: area centroid, vertex mean, and points pulled toward each
  let A = 0, cx = 0, cy = 0, mx = 0, my = 0;
  for (let i = 0, j = ids.length - 1; i < ids.length; j = i++) {
    const a = ids[j], b = ids[i];
    const cr = vx[a] * vy[b] - vx[b] * vy[a];
    A += cr; cx += (vx[a] + vx[b]) * cr; cy += (vy[a] + vy[b]) * cr;
    mx += vx[b]; my += vy[b];
  }
  A /= 2; cx /= 6 * A; cy /= 6 * A; mx /= ids.length; my /= ids.length;
  const star = (x, y) => {
    let worst = Infinity;
    for (let i = 0, j = ids.length - 1; i < ids.length; j = i++) {
      const a = ids[j], b = ids[i];
      const o = (vx[a] - x) * (vy[b] - y) - (vy[a] - y) * (vx[b] - x);
      worst = Math.min(worst, o);
    }
    return worst;
  };
  // the point deepest inside the kernel (where every edge is seen from the inside): grid search
  // over the bounding box, then refinement around the best cell
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of ids) { x0 = Math.min(x0, vx[p]); x1 = Math.max(x1, vx[p]); y0 = Math.min(y0, vy[p]); y1 = Math.max(y1, vy[p]); }
  // normalise by edge length so the score is a distance
  const starN = (x, y) => {
    let worst = Infinity;
    for (let i = 0, j = ids.length - 1; i < ids.length; j = i++) {
      const a = ids[j], b = ids[i];
      const L = Math.hypot(vx[b] - vx[a], vy[b] - vy[a]);
      if (L === 0) continue;
      const o = ((vx[a] - x) * (vy[b] - y) - (vy[a] - y) * (vx[b] - x)) / L;
      if (o < worst) worst = o;
    }
    return worst;
  };
  let best = [cx, cy], bestScore = starN(cx, cy);
  for (const [x, y] of [[mx, my]]) { const sc = starN(x, y); if (sc > bestScore) { bestScore = sc; best = [x, y]; } }
  let step = Math.max(x1 - x0, y1 - y0) / 24;
  for (let gx = x0; gx <= x1; gx += step) for (let gy = y0; gy <= y1; gy += step) {
    const sc = starN(gx, gy);
    if (sc > bestScore) { bestScore = sc; best = [gx, gy]; }
  }
  for (let r = 0; r < 4; ++r) {
    const [bx, by] = best;
    for (let i = -3; i <= 3; ++i) for (let j = -3; j <= 3; ++j) {
      const sc = starN(bx + i * step / 3, by + j * step / 3);
      if (sc > bestScore) { bestScore = sc; best = [bx + i * step / 3, by + j * step / 3]; }
    }
    step /= 3;
  }
  if (!(bestScore > 0)) return false;
  const [ox, oy] = best;
  const s = factor;
  const scale = p => [ox + s * (vx[p] - ox), oy + s * (vy[p] - oy)];
  // vertices of this label's chains
  const mine = new Set();
  const myChains = [];
  chains.forEach((c, ci) => { if (c.L === label || c.R === label) { myChains.push(ci); for (const p of c.v) mine.add(p); } });
  // junctions on the ring: a new vertex J' for this label's chains; other chains keep J and
  // get J' appended
  const jmap = new Map();
  for (const p of mine) {
    const others = geo.vSegs[p].filter(sg => { const c = chains[geo.segC[sg]]; return c.L !== label && c.R !== label; });
    if (!others.length) continue;
    const [x, y] = scale(p);
    const q = vx.length;
    vx.push(x); vy.push(y);
    jmap.set(p, q);
  }
  for (const c of chains) {
    if (c.L === label || c.R === label) {
      c.v = c.v.map(p => jmap.has(p) ? jmap.get(p) : p);
    } else {
      if (jmap.has(c.v[0])) c.v.unshift(jmap.get(c.v[0]));
      if (jmap.has(c.v[c.v.length - 1])) c.v.push(jmap.get(c.v[c.v.length - 1]));
    }
  }
  for (const p of mine) {
    if (jmap.has(p)) continue;
    const [x, y] = scale(p);
    vx[p] = x; vy[p] = y;
  }
  geo.rebuild();
  return true;
}

// push apart boundaries of labels that must not look touching, until each pair keeps its
// clearance (moves still may not cross anything)
export function openGaps(geo, iterations = 6, fixed = () => false, thick = null) {
  let left = 0;
  const pinned = new Set();
  for (const c of geo.chains) if (fixed(c.L) || fixed(c.R)) for (const p of c.v) pinned.add(p);
  for (let it = 0; it < iterations; ++it) {
    const push = geo.gapPushes();
    if (thick) geo.thickPushes(thick, push);
    left = push.size;
    if (!push.size) break;
    geo.bud = null;
    // spread the pushes along each chain into gentle bulges (a single pushed vertex is a spike)
    const n = geo.vx.length;
    const px = new Float64Array(n), py = new Float64Array(n);
    for (const [p, [dx, dy]] of push) { px[p] = dx; py[p] = dy; }
    for (let pass = 0; pass < 4; ++pass) {
      for (const c of geo.chains) {
        const v = c.v, m = v.length;
        if (m < 3) continue;
        let ox = px[v[0]], oy = py[v[0]];
        for (let i = 1; i < m - 1; ++i) {
          const q = v[i], r = v[i + 1];
          const nx = Math.abs(px[q]) + Math.abs(py[q]) > 0 ? 0.6 * px[q] + 0.2 * (ox + px[r]) : 0.5 * (ox + px[r]);
          const ny = Math.abs(px[q]) + Math.abs(py[q]) > 0 ? 0.6 * py[q] + 0.2 * (oy + py[r]) : 0.5 * (oy + py[r]);
          ox = px[q]; oy = py[q];
          px[q] = nx; py[q] = ny;
        }
      }
    }
    for (let p = 0; p < n; ++p) {
      if (pinned.has(p) || (px[p] === 0 && py[p] === 0)) continue;
      if (!geo.tryMove(p, geo.vx[p] + px[p], geo.vy[p] + py[p])) geo.tryMove(p, geo.vx[p] + px[p] * 0.4, geo.vy[p] + py[p] * 0.4);
    }
  }
  return left;
}


// hairpins (a vertex where the outline folds back on itself at a sharp angle) are drawn as hairline
// spurs: move each to the middle of its neighbours
export function despike(geo, maxDeg = 35, passes = 6, fixed = () => false) {
  const {vx, vy} = geo;
  const cmax = Math.cos(maxDeg * Math.PI / 180);
  geo.budgets(v => 2 * geo.localLen(v));
  let left = 0;
  for (let pass = 0; pass < passes; ++pass) {
    left = 0;
    for (const c of geo.chains) {
      if (fixed(c.L) || fixed(c.R)) continue;
      const v = c.v, m = v.length;
      const closed = v[0] === v[m - 1];
      for (let i = closed ? 0 : 1; i < m - 1; ++i) {
        const a = v[i === 0 ? m - 2 : i - 1], p = v[i], b = v[i + 1];
        const ux = vx[a] - vx[p], uy = vy[a] - vy[p], wx = vx[b] - vx[p], wy = vy[b] - vy[p];
        const nu = Math.hypot(ux, uy), nw = Math.hypot(wx, wy);
        if (!nu || !nw) continue;
        if ((ux * wx + uy * wy) / (nu * nw) < cmax) continue;
        left++;
        const mx = (vx[a] + vx[b]) / 2, my = (vy[a] + vy[b]) / 2;
        if (!geo.tryMove(p, mx, my)) geo.tryMove(p, vx[p] + 0.5 * (mx - vx[p]), vy[p] + 0.5 * (my - vy[p]));
      }
    }
    if (!left) break;
  }
  // junctions: a junction whose chains fold onto each other is also a spur
  return left;
}

// Hairline spurs: a coast that runs into a squeezed inlet (or out along a squeezed spit) and back
// draws a hairline. Cut such loops off with a straight segment where nothing else is in the way.
export function cutSpurs(geo, maxLen, fixed = () => false) {
  const {vx, vy} = geo;
  let cut = 0;
  for (const c of geo.chains) {
    if (!(c.L < 0 || c.R < 0) || fixed(c.L) || fixed(c.R)) continue;
    const v = c.v;
    const closed = v[0] === v[v.length - 1];
    let changed = true;
    while (changed) {
      changed = false;
      const n = v.length;
      const s = [0];
      for (let i = 1; i < n; ++i) s.push(s[i - 1] + Math.hypot(vx[v[i]] - vx[v[i - 1]], vy[v[i]] - vy[v[i - 1]]));
      outer: for (let i = 0; i < n - 3; ++i) {
        for (let j = i + 3; j < n && s[j] - s[i] <= maxLen; ++j) {
          if (closed && i === 0 && j === n - 1) break;
          const arc = s[j] - s[i];
          const d = Math.hypot(vx[v[j]] - vx[v[i]], vy[v[j]] - vy[v[i]]);
          if (d > 0.06 * arc || d > 0.05) continue;
          // thin loop: small area for its length
          let A = 0;
          for (let k = i; k < j; ++k) A += vx[v[k]] * vy[v[k + 1]] - vx[v[k + 1]] * vy[v[k]];
          A += vx[v[j]] * vy[v[i]] - vx[v[i]] * vy[v[j]];
          if (Math.abs(A / 2) > 0.04 * arc * arc) continue;
          // the shortcut must not cross or touch anything else
          const ax = vx[v[i]], ay = vy[v[i]], bx = vx[v[j]], by = vy[v[j]];
          const tmp = geo._tmp2 || (geo._tmp2 = []);
          geo.near(Math.min(ax, bx) - 1e-4, Math.min(ay, by) - 1e-4, Math.max(ax, bx) + 1e-4, Math.max(ay, by) + 1e-4, tmp);
          const inLoop = new Set(v.slice(i, j + 1));
          let ok = true;
          for (const t of tmp) {
            const p = geo.segA[t], q = geo.segB[t];
            if (inLoop.has(p) && inLoop.has(q)) continue;
            if (p === v[i] || q === v[i] || p === v[j] || q === v[j]) continue;
            if (segmentsIntersect(ax, ay, bx, by, vx[p], vy[p], vx[q], vy[q]) || segSegDist2(ax, ay, bx, by, vx[p], vy[p], vx[q], vy[q]) < 1e-10) { ok = false; break; }
          }
          if (!ok) continue;
          v.splice(i + 1, j - i - 1);
          cut++;
          changed = true;
          break outer;
        }
      }
    }
  }
  geo.rebuild();
  return cut;
}

// Where a border reaches the sea the coast should run on, not dip into a V: near each such
// junction the coast (and the junction) is pulled onto the chord between the points a distance
// delta along the coast on either side, with a weight falling off away from the junction.
export function straightenJunctions(geo, deltaOf, fixed = () => false, strength = 1) {
  const {vx, vy, chains} = geo;
  // no clearance budget here: gaps this closes are opened again by openGaps afterwards
  geo.bud = null;
  let moved = 0;
  for (let p = 0; p < vx.length; ++p) {
    const segs = geo.vSegs[p];
    if (segs.length !== 3) continue;
    const coast = [], border = [];
    for (const sg of segs) { const c = chains[geo.segC[sg]]; (c.L < 0 || c.R < 0 ? coast : border).push(geo.segC[sg]); }
    if (coast.length !== 2 || border.length !== 1) continue;
    const bc = chains[border[0]];
    if (fixed(bc.L) || fixed(bc.R)) continue;
    const delta = deltaOf(bc.L, bc.R);
    // walk each coast chain away from p
    const sides = [];
    for (const ci of coast) {
      const v = chains[ci].v;
      const seq = v[0] === p ? v : v[v.length - 1] === p ? v.slice().reverse() : null;
      if (!seq) { sides.length = 0; break; }
      const pts = [];      // [vertex, arc]
      let arc = 0, end = null;
      for (let i = 1; i < seq.length; ++i) {
        const a = seq[i - 1], b = seq[i];
        const L = Math.hypot(vx[b] - vx[a], vy[b] - vy[a]);
        if (arc + L >= delta) {
          const t = (delta - arc) / (L || 1);
          end = [vx[a] + t * (vx[b] - vx[a]), vy[a] + t * (vy[b] - vy[a])];
          break;
        }
        arc += L;
        if (i === seq.length - 1) { end = [vx[b], vy[b]]; break; }
        pts.push([b, arc]);
      }
      sides.push({pts, end, len: Math.min(delta, arc + 1e-12)});
    }
    if (sides.length !== 2) continue;
    const [A, B] = sides;
    const dA = delta, dB = delta;
    const chord = (sigma) => {          // sigma in [-dA, dB]
      const t = (sigma + dA) / (dA + dB);
      return [A.end[0] + t * (B.end[0] - A.end[0]), A.end[1] + t * (B.end[1] - A.end[1])];
    };
    const move = (q, sigma) => {
      const w = strength * (1 - Math.abs(sigma) / delta);
      if (w <= 0) return;
      const [tx, ty] = chord(sigma);
      if (geo.tryMove(q, vx[q] + w * (tx - vx[q]), vy[q] + w * (ty - vy[q]))) moved++;
    };
    move(p, 0);
    for (const [q, arc] of A.pts) move(q, -arc);
    for (const [q, arc] of B.pts) move(q, arc);
  }
  return moved;
}
