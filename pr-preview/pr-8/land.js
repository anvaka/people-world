// The ground the generator's addons work on: one grid over the world, with which country each of
// its cells lies in and how far each is from the sea. It is worked out once for a world and shared:
// the terrain, the climate and whatever else is added all lie on the same cells, and a style reads
// any of their fields with valueAt.
//
// The cells sit on a fixed lattice (a size from a series a quarter of a doubling apart, through
// the origin), so a map that grows or shrinks a little keeps its cells where they were: where an
// edit leaves the map alone, it leaves what stands on it alone.
//
//   landOf({countries, lines}) -> {
//     grid    {w, h, cell, x0, y0}: cell (i, j) has its middle at (x0 + (i + 0.5) cell,
//             y0 - (j + 0.5) cell), map coordinates with y up (row 0 is the northmost)
//     ids     Int16Array, w * h: the country (its index) each cell's middle lies in, -1 the sea
//     inland  Float64Array, w * h: how far each land cell is from the sea (0 at sea), in the
//             units below
//     K       map units to the units the addons count in: lengths in the world of countries'
//             own map units, where a cell is CELL across. A world of another size (a graph of your
//             own) is worked out as that one is, whatever its cells measure on the map
//     span    the larger of the land's width and height, map units
//     box     {minX, maxX, minY, maxY}: the land's extent, map units
//   }
import {hypot} from './util.js';

const CELLS_ACROSS = 720;          // about so many cells across the world and its margin
export const CELL = 0.3;

// Exact Euclidean distance transform (Felzenszwalb and Huttenlocher), in place: 0 where set, 1e20
// elsewhere, becomes the distance in cells
function edt1(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; ++q) {
    let s;
    do { const p = v[k]; s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p); if (s <= z[k]) --k; else break; } while (k >= 0);
    ++k; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; ++q) { while (z[k + 1] < q) ++k; const p = v[k]; d[q] = (q - p) * (q - p) + f[p]; }
}
export function edt(grid, w, h) {
  const m = Math.max(w, h), f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  for (let x = 0; x < w; ++x) {
    for (let y = 0; y < h; ++y) f[y] = grid[y * w + x];
    edt1(f, h, d, v, z);
    for (let y = 0; y < h; ++y) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) f[x] = grid[y * w + x];
    edt1(f, w, d, v, z);
    for (let x = 0; x < w; ++x) grid[y * w + x] = Math.sqrt(d[x]);
  }
  return grid;
}

// Distance (in cells) from every cell to the nearest of `sources`, for cells within `radius` cells
// of one (1e20 beyond): each source stamps a disc. Cheaper than a transform of the whole grid for
// a field that is only read near its sources.
export function spread(sources, radius, w, h) {
  const out = new Float32Array(w * h).fill(1e20), R = Math.ceil(radius), disc = [];
  for (let dy = -R; dy <= R; ++dy) for (let dx = -R; dx <= R; ++dx) { const d = Math.sqrt(dx * dx + dy * dy); if (d <= radius) disc.push(dx, dy, d); }
  for (const i of sources) {
    const x = i % w, y = (i - x) / w;
    for (let k = 0; k < disc.length; k += 3) {
      const xx = x + disc[k], yy = y + disc[k + 1];
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (disc[k + 2] < out[j]) out[j] = disc[k + 2];
    }
  }
  return out;
}

// Which country each cell's middle lies in (-1: the sea): an even-odd scanline fill of the rings
function rasterize(countries, G) {
  const {w, h, cell, x0, y0} = G;
  const ids = new Int16Array(w * h).fill(-1);
  const rows = Array.from({length: h}, () => []);
  for (const c of countries) for (const r of c.rings) {
    for (let k = 0, m = r.length - 1; k < r.length; m = k++) {
      // (rows run down the map: a row's y is y0 - (j + 0.5) cell)
      const ax = r[m][0], ay = y0 - r[m][1], bx = r[k][0], by = y0 - r[k][1];
      if (ay === by) continue;
      const lo = Math.min(ay, by), hi = Math.max(ay, by);
      const j0 = Math.max(0, Math.ceil(lo / cell - 0.5)), j1 = Math.min(h - 1, Math.ceil(hi / cell - 0.5) - 1);
      for (let j = j0; j <= j1; ++j) rows[j].push(c.index, ax + ((j + 0.5) * cell - ay) * (bx - ax) / (by - ay));
    }
  }
  for (let j = 0; j < h; ++j) {
    const row = rows[j];
    if (!row.length) continue;
    const list = [];
    for (let k = 0; k < row.length; k += 2) list.push([row[k], row[k + 1]]);
    list.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    for (let k = 0; k + 1 < list.length; k += 2) {
      if (list[k][0] !== list[k + 1][0]) { k -= 1; continue; }   // (an odd count: skip one)
      const i0 = Math.max(0, Math.ceil((list[k][1] - x0) / cell - 0.5)), i1 = Math.min(w - 1, Math.ceil((list[k + 1][1] - x0) / cell - 0.5) - 1);
      for (let i = i0; i <= i1; ++i) ids[j * w + i] = list[k][0];
    }
  }
  return ids;
}
// A few cells of no country inside the land, where borders meet (a cell whose middle fell in a
// sliver between two shapes): left as sea, rivers would end there. Pockets of up to `most` cells
// not joined to the open sea go to the country most round them
function fillPockets(ids, w, h, most) {
  const seen = new Uint8Array(w * h);
  for (let i = 0; i < w * h; ++i) {
    if (ids[i] !== -1 || seen[i]) continue;
    const stack = [i], cells = [];
    let open = false;
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(), x = j % w, y = (j - x) / w;
      cells.push(j);
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) open = true;
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) {
        if (k >= 0 && ids[k] === -1 && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    if (open || cells.length > most) continue;
    const count = new Map();
    let best = -1, top = 0;
    for (const j of cells) for (const k of [j - 1, j + 1, j - w, j + w]) {
      const o = ids[k];
      if (o >= 0) { const c = (count.get(o) || 0) + 1; count.set(o, c); if (c > top) { top = c; best = o; } }
    }
    for (const j of cells) ids[j] = best;
  }
}
// The cells a line passes through (steps of a third of a cell), set to `value` in `out`
export function markLine(out, G, pts, value = 0) {
  const {w, h, cell, x0, y0} = G;
  for (let k = 1; k < pts.length; ++k) {
    const ax = pts[k - 1][0], ay = pts[k - 1][1], bx = pts[k][0], by = pts[k][1];
    const n = Math.max(1, Math.ceil(hypot(bx - ax, by - ay) / cell * 3));
    for (let t = 0; t <= n; ++t) {
      const x = Math.floor((ax + (bx - ax) * t / n - x0) / cell), y = Math.floor((y0 - (ay + (by - ay) * t / n)) / cell);
      if (x >= 0 && y >= 0 && x < w && y < h) out[y * w + x] = value;
    }
  }
}

// A soft dab on a field: `value` at the point (x, y) of the map, falling smoothly to nothing
// `radius` (map units) away. The field keeps the larger of what it had and the dab
export function dab(out, G, x, y, radius, value) {
  const {w, h, cell, x0, y0} = G;
  const fx = (x - x0) / cell - 0.5, fy = (y0 - y) / cell - 0.5, r = radius / cell;
  const i0 = Math.max(0, Math.ceil(fx - r)), i1 = Math.min(w - 1, Math.floor(fx + r));
  const j0 = Math.max(0, Math.ceil(fy - r)), j1 = Math.min(h - 1, Math.floor(fy + r));
  for (let j = j0; j <= j1; ++j) for (let i = i0; i <= i1; ++i) {
    const d = ((i - fx) * (i - fx) + (j - fy) * (j - fy)) / (r * r);
    if (d >= 1) continue;
    const v = value * (1 - d) * (1 - d);
    if (v > out[j * w + i]) out[j * w + i] = v;
  }
}

// The land of a world (see the top of the file); null for a world with no land at all. Kept for
// as long as the world's list of countries is: every addon gets the same one.
const lands = new WeakMap();
export function landOf(world) {
  if (lands.has(world.countries)) return lands.get(world.countries);
  const countries = world.countries.filter(c => c.rings && c.rings.length);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of countries) for (const r of c.rings) for (const p of r) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }
  let land = null;
  if (maxX > minX) {
    const span = Math.max(maxX - minX, maxY - minY), pad = 0.12 * span;
    const cell = 2 ** (Math.round(4 * Math.log2((span + 2 * pad) / CELLS_ACROSS)) / 4);
    const x0 = Math.floor((minX - pad) / cell) * cell, y0 = Math.ceil((maxY + pad) / cell) * cell;
    const w = Math.ceil((maxX + pad - x0) / cell), h = Math.ceil((y0 - (minY - pad)) / cell), N = w * h;
    const grid = {w, h, cell, x0, y0};
    const ids = rasterize(countries, grid);
    fillPockets(ids, w, h, 8);
    const inland = new Float64Array(N);
    for (let i = 0; i < N; ++i) inland[i] = ids[i] >= 0 ? 1e20 : 0;
    edt(inland, w, h);
    for (let i = 0; i < N; ++i) inland[i] *= CELL;
    land = {grid, ids, inland, K: CELL / cell, span, box: {minX, maxX, minY, maxY}};
  }
  lands.set(world.countries, land);
  return land;
}

// The value of a field at a point of the map (between the cells' middles). `part` is anything
// with the grid: a terrain, a climate
export function valueAt(part, field, x, y) {
  const {w, h, cell, x0, y0} = part.grid;
  const fx = (x - x0) / cell - 0.5, fy = (y0 - y) / cell - 0.5;
  const cx = Math.floor(fx), cy = Math.floor(fy);
  if (cx < 0 || cy < 0 || cx >= w - 1 || cy >= h - 1) return 0;
  const tx = fx - cx, ty = fy - cy, i = cy * w + cx;
  const a = field[i], b = field[i + 1], c = field[i + w], d = field[i + w + 1];
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}
