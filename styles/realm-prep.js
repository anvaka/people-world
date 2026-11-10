// The realm style's preparation of a world, done once per world, in a worker when the browser has
// module workers (styles/realm-worker.js) and on the page otherwise. Plain arithmetic, no canvas: it
// runs the same in every browser (OffscreenCanvas is missing from older Safari) and in Node.
//
//   fields    a grid over the world (640 wide), two RGBA8 layers:
//             1: distance inland from the coast, distance out to sea, the shelf (the land blurred:
//                wide shallows off big land, almost none round a tiny island), and the mountains:
//                how high the world's ranges stand (its terrain: see terrain.js)
//             2: distance to the nearest border
//   rivers    the world's rivers (its terrain), as segments for the GPU
//   triangles every country triangulated (earcut), exactly the land of the SVG
// Input: plain data from the page's world (see realm.js, worldData). Output: typed arrays only, so
// the worker hands them over without copying.
import earcut from '../vendor/earcut.js';
import {terrainAt} from '../terrain.js';

export const FIELD_W = 640;

// Exact Euclidean distance transform (Felzenszwalb and Huttenlocher), squared, in place
function edt1(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; ++q) {
    let s;
    do { let p = v[k]; s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p); if (s <= z[k]) --k; else break; } while (k >= 0);
    ++k; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; ++q) { while (z[k + 1] < q) ++k; let p = v[k]; d[q] = (q - p) * (q - p) + f[p]; }
}
function edt(grid, nx, ny) {
  let m = Math.max(nx, ny), f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  for (let x = 0; x < nx; ++x) {
    for (let y = 0; y < ny; ++y) f[y] = grid[y * nx + x];
    edt1(f, ny, d, v, z);
    for (let y = 0; y < ny; ++y) grid[y * nx + x] = d[y];
  }
  for (let y = 0; y < ny; ++y) {
    for (let x = 0; x < nx; ++x) f[x] = grid[y * nx + x];
    edt1(f, nx, d, v, z);
    for (let x = 0; x < nx; ++x) grid[y * nx + x] = Math.sqrt(d[x]);
  }
  return grid;
}
// three box blurs: close to a Gaussian
function blur(src, nx, ny, r) {
  let a = Float32Array.from(src), b = new Float32Array(a.length);
  for (let pass = 0; pass < 3; ++pass) {
    for (let y = 0; y < ny; ++y) {
      let s = 0, row = y * nx;
      for (let x = -r; x <= r; ++x) s += a[row + Math.max(0, Math.min(nx - 1, x))];
      for (let x = 0; x < nx; ++x) {
        b[row + x] = s / (2 * r + 1);
        s += a[row + Math.min(nx - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < nx; ++x) {
      let s = 0;
      for (let y = -r; y <= r; ++y) s += b[Math.max(0, Math.min(ny - 1, y)) * nx + x];
      for (let y = 0; y < ny; ++y) {
        a[y * nx + x] = s / (2 * r + 1);
        s += b[Math.min(ny - 1, y + r + 1) * nx + x] - b[Math.max(0, y - r) * nx + x];
      }
    }
  }
  return a;
}
export const hashStr = s => { let h = 2166136261; for (let i = 0; i < s.length; ++i) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };

// Even-odd scanline fill of every country's rings at texel centres: which country each texel is in
// (-1 for the sea). rings: [{id, rings: [[[x, y], ...], ...]}] in SVG coordinates (y down).
function rasterize(countries, nx, ny, x0, y0, s) {
  let ids = new Int16Array(nx * ny).fill(-1);
  let rows = Array.from({length: ny}, () => []);
  countries.forEach(c => c.rings.forEach(r => {
    for (let k = 0, m = r.length - 1; k < r.length; m = k++) {
      let ax = r[m][0], ay = r[m][1], bx = r[k][0], by = r[k][1];
      if (ay === by) continue;
      let lo = Math.min(ay, by), hi = Math.max(ay, by);
      let j0 = Math.max(0, Math.ceil((lo - y0) * s - 0.5)), j1 = Math.min(ny - 1, Math.ceil((hi - y0) * s - 0.5) - 1);
      for (let j = j0; j <= j1; ++j) {
        let yc = y0 + (j + 0.5) / s;
        rows[j].push(c.id, ax + (yc - ay) * (bx - ax) / (by - ay));
      }
    }
  }));
  for (let j = 0; j < ny; ++j) {
    let row = rows[j];
    if (!row.length) continue;
    let list = [];
    for (let k = 0; k < row.length; k += 2) list.push([row[k], row[k + 1]]);
    list.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    for (let k = 0; k + 1 < list.length; k += 2) {
      if (list[k][0] !== list[k + 1][0]) { k -= 1; continue; }   // (an odd count: skip one)
      let i0 = Math.max(0, Math.ceil((list[k][1] - x0) * s - 0.5)), i1 = Math.min(nx - 1, Math.ceil((list[k + 1][1] - x0) * s - 0.5) - 1);
      for (let i = i0; i <= i1; ++i) ids[j * nx + i] = list[k][0];
    }
  }
  return ids;
}
// Pockets of no country inside the land (see prepareWorld): each of up to 'most' cells, not joined
// to the grid's edge, takes the value fill(cells) gives it
function fillPockets(ids, w, h, most, fill) {
  const seen = new Uint8Array(w * h);
  for (let i = 0; i < w * h; ++i) {
    if (ids[i] !== -1 || seen[i]) continue;
    let stack = [i], cells = [], open = false;
    seen[i] = 1;
    while (stack.length) {
      let j = stack.pop(), x = j % w, y = (j - x) / w;
      cells.push(j);
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) open = true;
      for (let k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) {
        if (k >= 0 && ids[k] === -1 && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    if (!open && cells.length <= most) { let v = fill(cells); for (let j of cells) ids[j] = v; }
  }
}
// Marks the texels a polyline passes through (steps of a third of a texel)
function markLine(grid, nx, ny, x0, y0, s, pts) {
  for (let k = 1; k < pts.length; ++k) {
    let [ax, ay] = pts[k - 1], [bx, by] = pts[k];
    let n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * s * 3));
    for (let t = 0; t <= n; ++t) {
      let x = Math.floor((ax + (bx - ax) * t / n - x0) * s), y = Math.floor((ay + (by - ay) * t / n - y0) * s);
      if (x >= 0 && y >= 0 && x < nx && y < ny) grid[y * nx + x] = 0;
    }
  }
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}
function inRing(ring, x, y) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    let [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}


// data: {seed, box, terrain, items: [{index, id, size, rings}], lines: [{kind, a, b, points}]} (world
// coordinates, y up, as the generator gives them; terrain: the world's, see terrain.js)
export function prepareWorld(data) {
  let t0 = Date.now();
  let {box, seed} = data;
  let span = Math.max(box.maxX - box.minX, box.maxY - box.minY);
  let cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
  let margin = 0.16 * span;
  let x0 = box.minX - margin, y0 = box.minY - margin;
  let w = box.maxX - box.minX + 2 * margin, h = box.maxY - box.minY + 2 * margin;
  let nx = FIELD_W, s = nx / w, ny = Math.ceil(h * s), n = nx * ny;
  let svg = r => r.map(([x, y]) => [x, -y]);
  let ids = rasterize(data.items.map(it => ({id: it.index, rings: it.rings.map(svg)})), nx, ny, x0, y0, s);
  // a few cells of no country inside the land, where borders meet: lakes where rivers would end, at
  // a border. Pockets of up to eight cells not joined to the open sea go to the country most round them
  fillPockets(ids, nx, ny, 8, cells => {
    let count = new Map(), best = -1, most = 0;
    for (let j of cells) for (let k of [j - 1, j + 1, j - nx, j + nx]) {
      let o = ids[k];
      if (o >= 0) { let c = (count.get(o) || 0) + 1; count.set(o, c); if (c > most) { most = c; best = o; } }
    }
    return best;
  });
  let mask = new Float32Array(n);
  for (let i = 0; i < n; ++i) mask[i] = ids[i] >= 0 ? 1 : 0;
  // the mountains: how high the world's ranges stand, at every texel (the same ranges every style
  // draws); and the distance to any border
  let T = data.terrain;
  let belt = new Float32Array(n), borderD = new Float64Array(n).fill(1e20);
  if (T) for (let j = 0; j < ny; ++j) for (let i = 0; i < nx; ++i) {
    let k = j * nx + i;
    if (ids[k] >= 0) belt[k] = Math.min(1, terrainAt(T, T.mountain, x0 + (i + 0.5) / s, -(y0 + (j + 0.5) / s)));
  }
  data.lines.forEach(line => { if (line.kind === 'border') markLine(borderD, nx, ny, x0, y0, s, svg(line.points)); });
  edt(borderD, nx, ny);
  // distances inland and out to sea, in cells
  let inside = new Float64Array(n), outside = new Float64Array(n);
  for (let i = 0; i < n; ++i) { let l = mask[i] >= 0.5; inside[i] = l ? 1e20 : 0; outside[i] = l ? 0 : 1e20; }
  edt(inside, nx, ny); edt(outside, nx, ny);
  let shelf = blur(mask, nx, ny, 5);
  let f1 = new Uint8Array(n * 4), f2 = new Uint8Array(n * 4);
  for (let i = 0; i < n; ++i) {
    f1[4 * i] = Math.round(Math.min(1, inside[i] / 64) * 255);
    f1[4 * i + 1] = Math.round(Math.min(1, outside[i] / 80) * 255);
    f1[4 * i + 2] = Math.round(Math.min(1, shelf[i] * 1.6) * 255);
    f1[4 * i + 3] = Math.round(belt[i] * 255);
    f2[4 * i] = Math.round(Math.min(1, borderD[i] / 16) * 255);
    f2[4 * i + 3] = 255;
  }
  let tRivers = Date.now();
  // the world's rivers as GPU segments (ax, ay, bx, by, half width, -1, -1), coordinates normalised
  // to the world; the width grows with the flow (the land drained, here in texels)
  let rv = [];
  if (T) for (let r of T.rivers) {
    let m = r.flow.length;
    for (let k = 0; k + 1 < m; ++k) {
      let flow = 0.5 * (r.flow[k] + r.flow[k + 1]) * s * s;
      let hw = (0.04 + 0.012 * Math.sqrt(flow)) / s / span;
      rv.push((r.points[2 * k] - cx) / span, (-r.points[2 * k + 1] - cy) / span, (r.points[2 * k + 2] - cx) / span, (-r.points[2 * k + 3] - cy) / span, hw, -1, -1);
    }
  }
  let tTri = Date.now();
  // every country triangulated: rings sorted by size, each a hole of the ring it lies in when it lies
  // in an odd number of them (the SVG's even-odd); vertices (u, v, country index), normalised
  let verts = [];
  data.items.forEach(item => {
    let rings = item.rings.slice().sort((p, q) => Math.abs(ringArea(q)) - Math.abs(ringArea(p)));
    let depth = rings.map((r, i) => rings.filter((q, j) => j < i && inRing(q, r[0][0], r[0][1])).length);
    let polys = [];
    rings.forEach((r, i) => {
      if (depth[i] % 2 === 0) { polys.push({outer: r, holes: []}); return; }
      for (let j = i - 1; j >= 0; --j) if (depth[j] === depth[i] - 1 && inRing(rings[j], r[0][0], r[0][1])) {
        polys.find(p => p.outer === rings[j]).holes.push(r);
        break;
      }
    });
    for (let p of polys) {
      let flat = [], holes = [];
      p.outer.forEach(([x, y]) => flat.push(x, y));
      p.holes.forEach(hole => { holes.push(flat.length / 2); hole.forEach(([x, y]) => flat.push(x, y)); });
      let tri = earcut(flat, holes);
      for (let k of tri) verts.push((flat[2 * k] - cx) / span, (-flat[2 * k + 1] - cy) / span, item.index);
    }
  });
  let t1 = Date.now();
  return {
    fields: {f1, f2, nx, ny, x0, y0, s}, rivers: new Float32Array(rv.length ? rv : [0, 0, 0, 0, 0, -1, -1]),
    riverCount: rv.length / 7, tris: new Float32Array(verts), span, cx, cy,
    ms: {fields: tRivers - t0, rivers: tTri - tRivers, triangles: t1 - tTri, total: t1 - t0},
  };
}
