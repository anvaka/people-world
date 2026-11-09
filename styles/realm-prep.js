// The realm style's preparation of a world, done once per world, in a worker when the browser has
// module workers (styles/realm-worker.js) and on the page otherwise. Plain arithmetic, no canvas: it
// runs the same in every browser (OffscreenCanvas is missing from older Safari) and in Node.
//
//   fields    a grid over the world (640 wide), two RGBA8 layers:
//             1: distance inland from the coast, distance out to sea, the shelf (the land blurred:
//                wide shallows off big land, almost none round a tiny island), mountain ranges along
//                some borders (on one side of the border, parallel to it, never on the line)
//             2: distance to the nearest border (ridges stop short of borders, never cross them)
//   rivers    rain run downhill to the sea, as segments for the GPU (see makeRivers)
//   triangles every country triangulated (earcut), exactly the land of the SVG
// Input: plain data from the page's world (see realm.js, worldData). Output: typed arrays only, so
// the worker hands them over without copying.
import earcut from '../vendor/earcut.js';

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

// Rivers. Rain falls evenly on the land and runs downhill to the sea: the "hill" is the distance
// inland, raised along the mountain belts and roughened by noise, so rivers rise in the mountains and
// the heart of each land and wind to the nearest coast. A priority flood from the sea gives every
// cell a way down without pits; the flow gathered on the way picks the rivers, and their width grows
// with it. Polylines in world coordinates (SVG orientation), smoothed, each with its flow.
function makeRivers(inside, mask, belt, nx, ny, x0, y0, s, seed) {
  let n = nx * ny;
  let vh = (x, y, k) => { let h = Math.imul(x * 374761393 + y * 668265263 + k * 2246822519 + Math.floor(seed * 1e9), 1274126177); h ^= h >>> 13; h = Math.imul(h, 1103515245); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  let vnoise = (x, y, k) => {
    let xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    let a = vh(xi, yi, k), b = vh(xi + 1, yi, k), c = vh(xi, yi + 1, k), d = vh(xi + 1, yi + 1, k);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  let elev = new Float32Array(n);
  for (let y = 0; y < ny; ++y) for (let x = 0; x < nx; ++x) {
    let i = y * nx + x;
    if (mask[i] < 0.5) { elev[i] = -1; continue; }
    elev[i] = Math.sqrt(inside[i]) * 2 + 8 * belt[i] + 9 * vnoise(x / 26, y / 26, 1) + 4 * vnoise(x / 9, y / 9, 2) + 1.5 * vnoise(x / 3.5, y / 3.5, 3);
  }
  // priority flood (binary heap on elevation) from the sea cells next to land
  let down = new Int32Array(n).fill(-2), fill = new Float32Array(n), heap = [], hv = [];
  let push = (i, v) => { heap.push(i); hv.push(v); let k = heap.length - 1; while (k > 0) { let p = (k - 1) >> 1; if (hv[p] <= hv[k]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; [hv[p], hv[k]] = [hv[k], hv[p]]; k = p; } };
  let pop = () => { let top = heap[0], last = heap.pop(), lv = hv.pop(); if (heap.length) { heap[0] = last; hv[0] = lv; let k = 0; for (;;) { let l = 2 * k + 1, r = l + 1, m = k; if (l < heap.length && hv[l] < hv[m]) m = l; if (r < heap.length && hv[r] < hv[m]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; [hv[m], hv[k]] = [hv[k], hv[m]]; k = m; } } return top; };
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let y = 1; y < ny - 1; ++y) for (let x = 1; x < nx - 1; ++x) {
    let i = y * nx + x;
    if (elev[i] >= 0) continue;
    if (NB.some(([dx, dy]) => elev[i + dy * nx + dx] >= 0)) { down[i] = -1; fill[i] = -1; push(i, -1); }
  }
  let order = [];
  while (heap.length) {
    let i = pop(), x = i % nx, y = (i - x) / nx;
    order.push(i);
    for (let [dx, dy] of NB) {
      let xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
      let j = yy * nx + xx;
      if (down[j] !== -2 || elev[j] < 0) continue;
      down[j] = i;
      fill[j] = Math.max(elev[j], fill[i] + 1e-3);
      push(j, fill[j]);
    }
  }
  // flow: each land cell's rain, gathered downstream (from the highest cells down)
  let flow = new Float32Array(n);
  for (let k = order.length - 1; k >= 0; --k) {
    let i = order[k];
    if (elev[i] < 0) continue;
    flow[i] += 1;
    if (down[i] >= 0) flow[down[i]] += flow[i];
  }
  // rivers: cells gathering enough flow, traced downstream from each head
  const MIN = 180;
  let isRiver = i => elev[i] >= 0 && flow[i] >= MIN;
  let hasUp = new Uint8Array(n);
  for (let i = 0; i < n; ++i) if (isRiver(i) && down[i] >= 0) hasUp[down[i]] = 1;
  let taken = new Uint8Array(n), rivers = [];
  let toWorld = i => { let x = i % nx, y = (i - x) / nx; return [x0 + (x + 0.5) / s, y0 + (y + 0.5) / s]; };
  let heads = [];
  for (let i = 0; i < n; ++i) if (isRiver(i) && !hasUp[i]) heads.push(i);
  heads.sort((a, b) => flow[b] - flow[a] || a - b);
  for (let head of heads) {
    let path = [head], f = [flow[head]];
    let i = head;
    taken[i] = 1;
    while (down[i] >= 0) {
      let j = down[i];
      path.push(j); f.push(flow[j]);
      if (taken[j] || elev[j] < 0) break;
      taken[j] = 1;
      i = j;
    }
    if (path.length < 6) continue;
    // meanders: resampled at half a cell, pushed sideways by a slow and a quick wave of noise along
    // the course (less where the river is young), then smoothed (Chaikin, twice)
    let raw = path.map(toWorld), pts = [], fl = [];
    for (let k = 0; k + 1 < raw.length; ++k) for (let t = 0; t < 1; t += 0.5) {
      pts.push([raw[k][0] + (raw[k + 1][0] - raw[k][0]) * t, raw[k][1] + (raw[k + 1][1] - raw[k][1]) * t]);
      fl.push(f[k] + (f[k + 1] - f[k]) * t);
    }
    pts.push(raw[raw.length - 1]); fl.push(f[f.length - 1]);
    let along = 0;
    let shifted = pts.map((p, k) => {
      let a = pts[Math.max(0, k - 2)], b = pts[Math.min(pts.length - 1, k + 2)];
      let dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      if (k) along += Math.hypot(p[0] - pts[k - 1][0], p[1] - pts[k - 1][1]) * s;
      let ends = Math.min(1, k / 4, (pts.length - 1 - k) / 4);
      let off = ((vnoise(along / 7, head * 0.001, 4) - 0.5) * 2.2 + (vnoise(along / 2.5, head * 0.001, 5) - 0.5) * 0.9) * ends / s;
      return [p[0] - dy / l * off, p[1] + dx / l * off];
    });
    pts = shifted;
    for (let it = 0; it < 2; ++it) {
      let np = [pts[0]], nf = [fl[0]];
      for (let k = 0; k + 1 < pts.length; ++k) {
        let [ax, ay] = pts[k], [bx, by] = pts[k + 1];
        np.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by], [0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by]);
        nf.push(0.75 * fl[k] + 0.25 * fl[k + 1], 0.25 * fl[k] + 0.75 * fl[k + 1]);
      }
      np.push(pts[pts.length - 1]); nf.push(fl[fl.length - 1]);
      pts = np; fl = nf;
    }
    rivers.push({points: pts, flow: fl});
  }
  return rivers;
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


// data: {seed, box, items: [{index, id, size, rings}], lines: [{kind, a, b, points}]} (world coordinates,
// y up, as the generator gives them)
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
  let mask = new Float32Array(n);
  for (let i = 0; i < n; ++i) mask[i] = ids[i] >= 0 ? 1 : 0;
  let byIndex = new Map(data.items.map(it => [it.index, it]));
  // mountain ranges along some long borders, on one side of each (picked by the pair's codes), their
  // crest some 4 cells in from the line and nothing on the line itself; and the distance to any border
  let belt = new Float32Array(n), borderD = new Float64Array(n).fill(1e20);
  data.lines.forEach(line => {
    if (line.kind !== 'border') return;
    let pts = svg(line.points);
    markLine(borderD, nx, ny, x0, y0, s, pts);
    let a = byIndex.get(line.a), b = byIndex.get(line.b);
    if (!a || !b) return;
    let pair = [a.id, b.id].sort().join('-');
    let len = 0;
    for (let k = 1; k < pts.length; ++k) len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    if (hashStr(pair) > 0.3 || len < 0.02 * span) return;
    let side = hashStr(pair + '|side') < 0.5 ? a.index : b.index;
    // the distance to this border, in a box round it only
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    pts.forEach(([x, y]) => { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y); });
    let i0 = Math.max(0, Math.floor((bx0 - x0) * s) - 9), i1 = Math.min(nx - 1, Math.ceil((bx1 - x0) * s) + 9);
    let j0 = Math.max(0, Math.floor((by0 - y0) * s) - 9), j1 = Math.min(ny - 1, Math.ceil((by1 - y0) * s) + 9);
    let bw = i1 - i0 + 1, bh = j1 - j0 + 1;
    let d = new Float64Array(bw * bh).fill(1e20);
    markLine(d, bw, bh, x0 + i0 / s, y0 + j0 / s, s, pts);
    edt(d, bw, bh);
    for (let j = 0; j < bh; ++j) for (let i = 0; i < bw; ++i) {
      let k = (j + j0) * nx + i + i0, dd = d[j * bw + i];
      if (ids[k] === side && dd < 8) belt[k] = Math.max(belt[k], Math.max(0, 1 - Math.abs(dd - 4) / 3.5));
    }
  });
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
  let rivers = makeRivers(inside, mask, belt, nx, ny, x0, y0, s, hashStr('rivers' + seed));
  // rivers as GPU segments (ax, ay, bx, by, half width, -1, -1), coordinates normalised to the world
  let rv = [];
  rivers.forEach(r => {
    let pts = r.points.map(([X, Y]) => [(X - cx) / span, (Y - cy) / span]);
    for (let k = 0; k + 1 < pts.length; ++k) {
      let hw = (0.04 + 0.012 * Math.sqrt(0.5 * (r.flow[k] + r.flow[k + 1]))) / s / span;
      rv.push(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], hw, -1, -1);
    }
  });
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
