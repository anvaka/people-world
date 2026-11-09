// Graded cell mesh: jittered quadtree points (finer where small countries sit), Delaunay
// triangulation, and its barycentric dual (cell = the triangle thirds around a point), which is
// always a valid planar subdivision.
import Delaunator from './vendor/delaunator.js';
import {hash2} from './util.js';

// disks: [{x, y, r}] (r = radius of the country's mesh area)
export function buildMesh(disks, rng, opts) {
  const {h0, hmin, cellsAcross = 0.2, grade = 0.3, domainPad = 2.1, domainExtra = 6, seed = 1} = opts;
  // spatial grid over disks for fast sizing queries
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of disks) {
    const R = d.r * domainPad + domainExtra * h0 + 8 * h0;
    minX = Math.min(minX, d.x - R); maxX = Math.max(maxX, d.x + R);
    minY = Math.min(minY, d.y - R); maxY = Math.max(maxY, d.y + R);
  }
  const G = 8 * h0;
  const gw = Math.ceil((maxX - minX) / G) + 1, gh = Math.ceil((maxY - minY) / G) + 1;
  // each disk is registered in every grid cell within its influence radius
  const grid = Array.from({length: gw * gh}, () => []);
  disks.forEach((d, i) => {
    const R = d.r * domainPad + domainExtra * h0 + G;
    const x0 = Math.max(0, Math.floor((d.x - R - minX) / G)), x1 = Math.min(gw - 1, Math.floor((d.x + R - minX) / G));
    const y0 = Math.max(0, Math.floor((d.y - R - minY) / G)), y1 = Math.min(gh - 1, Math.floor((d.y + R - minY) / G));
    for (let gx = x0; gx <= x1; ++gx) for (let gy = y0; gy <= y1; ++gy) grid[gy * gw + gx].push(i);
  });
  const small = disks.map(d => Math.max(hmin, cellsAcross * d.r));
  // local target spacing at (x, y), for a square of half-diagonal `slack`
  function sizing(x, y, slack) {
    const gx = Math.min(gw - 1, Math.max(0, Math.floor((x - minX) / G)));
    const gy = Math.min(gh - 1, Math.max(0, Math.floor((y - minY) / G)));
    let h = 4 * h0, inside = false;
    for (const i of grid[gy * gw + gx]) {
      const d = disks[i];
      const dist = Math.hypot(x - d.x, y - d.y) - slack;
      if (dist < d.r * domainPad + domainExtra * h0) inside = true;
      const hi = small[i] + grade * Math.max(0, dist - 1.3 * d.r);
      if (hi < h) h = hi;
    }
    if (inside && h > h0) h = h0;
    return {h, inside};
  }
  // quadtree subdivision of tiles on a fixed lattice; each point's jitter comes from a hash of
  // where it is, not from a running random sequence. Where the countries are the same, so is
  // the mesh, whatever moved elsewhere: a map rebuilt after a small edit changes only near it.
  const T = 8 * h0;
  const xs = [], ys = [], inDomain = [];
  const stack = [];
  for (let tx = Math.floor(minX / T); tx * T < maxX; ++tx) for (let ty = Math.floor(minY / T); ty * T < maxY; ++ty) stack.push([tx * T, ty * T, T]);
  while (stack.length) {
    const [x, y, L] = stack.pop();
    const cx = x + L / 2, cy = y + L / 2;
    const {h} = sizing(cx, cy, L * 0.71);
    if (L > h * 1.4) {
      const H = L / 2;
      stack.push([x, y, H], [x + H, y, H], [x, y + H, H], [x + H, y + H, H]);
      continue;
    }
    const qx = Math.round(cx / hmin * 64), qy = Math.round(cy / hmin * 64);
    const px = cx + (hash2(qx, qy, seed) - 0.5) * L * 0.75, py = cy + (hash2(qy, qx, seed + 1) - 0.5) * L * 0.75;
    const s = sizing(px, py, 0);
    xs.push(px); ys.push(py); inDomain.push(s.inside ? 1 : 0);
  }
  // points numbered by position (row by row), so two meshes that agree somewhere number those
  // points in the same order: whatever walks the cells in order does the same there
  const N = xs.length;
  const perm = Array.from({length: N}, (_, i) => i).sort((a, b) => ys[a] - ys[b] || xs[a] - xs[b]);
  const coords = new Float64Array(2 * N);
  const dom = new Uint8Array(N);
  perm.forEach((i, k) => { coords[2 * k] = xs[i]; coords[2 * k + 1] = ys[i]; dom[k] = inDomain[i]; });
  const td = Date.now();
  const del = new Delaunator(coords);
  if (globalThis.MESHLOG) console.log("delaunator", N, Date.now() - td, "ms");
  return dualOf(coords, del, dom);
}

function dualOf(coords, del, inDomain) {
  const N = coords.length / 2;
  const tris = del.triangles, half = del.halfedges;
  const T = tris.length / 3;
  const gx = new Float64Array(T), gy = new Float64Array(T), tArea = new Float64Array(T);
  for (let t = 0; t < T; ++t) {
    const a = tris[3 * t], b = tris[3 * t + 1], c = tris[3 * t + 2];
    const ax = coords[2 * a], ay = coords[2 * a + 1], bx = coords[2 * b], by = coords[2 * b + 1], cx = coords[2 * c], cy = coords[2 * c + 1];
    gx[t] = (ax + bx + cx) / 3; gy[t] = (ay + by + cy) / 3;
    tArea[t] = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
  }
  const area = new Float64Array(N);
  for (let t = 0; t < T; ++t) for (let k = 0; k < 3; ++k) area[tris[3 * t + k]] += tArea[t] / 3;
  // an incoming half-edge for every point; hull points start where the fan is open
  const inc = new Int32Array(N).fill(-1);
  const frozen = new Uint8Array(N);
  for (let e = 0; e < tris.length; ++e) {
    const p = tris[e % 3 === 2 ? e - 2 : e + 1];
    if (half[e] === -1) { inc[p] = e; frozen[p] = 1; }
    else if (inc[p] === -1) inc[p] = e;
  }
  for (let e = 0; e < tris.length; ++e) if (half[e] === -1) frozen[tris[e]] = 1;
  // rings: neighbours of each point in cyclic order, with the half-edge to each
  const start = new Int32Array(N + 1);
  const nbr = [], edge = [];
  for (let p = 0; p < N; ++p) {
    start[p] = nbr.length;
    let e0 = inc[p];
    if (e0 < 0) continue;
    let e = e0;
    do {
      nbr.push(tris[e]);
      edge.push(e);
      const out = e % 3 === 2 ? e - 2 : e + 1;
      e = half[out];
    } while (e !== -1 && e !== e0);
    if (e === -1) frozen[p] = 1;
    else {
      // a closed ring starts at its westmost-then-southmost neighbour, not wherever the
      // triangulation happened to start it
      const s = start[p], len = nbr.length - s;
      let best = 0;
      for (let k = 1; k < len; ++k) {
        const q = nbr[s + k], b = nbr[s + best];
        if (coords[2 * q] < coords[2 * b] || (coords[2 * q] === coords[2 * b] && coords[2 * q + 1] < coords[2 * b + 1])) best = k;
      }
      if (best) {
        const rn = nbr.splice(s, len), re = edge.splice(s, len);
        nbr.push(...rn.slice(best), ...rn.slice(0, best));
        edge.push(...re.slice(best), ...re.slice(0, best));
      }
    }
  }
  start[N] = nbr.length;
  const ringNbr = Int32Array.from(nbr), ringEdge = Int32Array.from(edge);
  // dual edge length for each ring entry: centroid - midpoint - centroid
  const ringLen = new Float64Array(ringNbr.length);
  for (let k = 0; k < ringNbr.length; ++k) {
    const e = ringEdge[k], o = half[e];
    const p = tris[e], q = tris[e % 3 === 2 ? e - 2 : e + 1];
    const mx = (coords[2 * p] + coords[2 * q]) / 2, my = (coords[2 * p + 1] + coords[2 * q + 1]) / 2;
    const t1 = Math.floor(e / 3);
    let len = Math.hypot(gx[t1] - mx, gy[t1] - my);
    if (o >= 0) { const t2 = Math.floor(o / 3); len += Math.hypot(gx[t2] - mx, gy[t2] - my); }
    ringLen[k] = len;
  }
  for (let p = 0; p < N; ++p) if (!inDomain[p]) frozen[p] = 1;
  const hloc = new Float64Array(N);
  for (let p = 0; p < N; ++p) hloc[p] = Math.sqrt(area[p]);
  return {N, coords, tris, half, T, gx, gy, area, hloc, start, ringNbr, ringEdge, ringLen, frozen};
}
