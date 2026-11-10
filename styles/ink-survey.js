// The inked map's survey: from a raster of the world (which country, or sea, in each cell) it
// measures how far every cell lies from the sea, from the land and from the nearest border or
// coast, samples the terrain fields (the world's own mountains, and this style's woods, downs,
// dry and wet ground), and finds the widest open water for the sea's furniture.
// Input {w, h, ids (Int16Array: country index, -1 sea, -2 an edge cell), cell (world units),
// x0, y0 (world position of cell 0, y up), seed, box, terrain (the world's: see terrain.js)}.
// Distances are in cells.
import {makeTerrain} from './ink-noise.js';
import {terrainAt} from '../terrain.js';

// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher) of one row, on squared distances
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; ++q) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { --k; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    ++k; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; ++q) {
    while (z[k + 1] < q) ++k;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}
// distance (in cells) from every cell to the nearest cell where `on` is set
function distance(on, w, h) {
  const INF = 1e20, n = Math.max(w, h);
  let g = new Float64Array(w * h);
  for (let i = 0; i < w * h; ++i) g[i] = on[i] ? 0 : INF;
  let f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; ++x) {
    for (let y = 0; y < h; ++y) f[y] = g[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; ++y) g[y * w + x] = d[y];
  }
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) f[x] = g[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; ++x) g[y * w + x] = d[x];
  }
  let out = new Float32Array(w * h);
  for (let i = 0; i < w * h; ++i) out[i] = Math.sqrt(g[i]);
  return out;
}

// A few cells of no country inside the land, where borders meet (a cell whose centre fell in a sliver
// between two shapes): taken for sea, they would be lakes where rivers end, at a border. Pockets of
// up to 'most' cells not joined to the open sea become border cells (-2); inland seas are far larger
export function fillPockets(ids, w, h, most = 8, fill = () => -2) {
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
  return ids;
}
export function survey({w, h, ids, cell, x0, y0, seed, box, terrain}) {
  const N = w * h;
  fillPockets(ids, w, h);
  const land = new Uint8Array(N), sea = new Uint8Array(N), edge = new Uint8Array(N);
  for (let i = 0; i < N; ++i) { land[i] = ids[i] !== -1 ? 1 : 0; sea[i] = 1 - land[i]; }
  for (let y = 0; y < h; ++y) for (let x = 0; x < w; ++x) {
    let i = y * w + x, id = ids[i];
    if (id === -2) { edge[i] = 1; continue; }
    if ((x > 0 && ids[i - 1] !== id) || (x < w - 1 && ids[i + 1] !== id) || (y > 0 && ids[i - w] !== id) || (y < h - 1 && ids[i + w] !== id)) edge[i] = 1;
  }
  const toSea = distance(sea, w, h);     // for land cells: how far inland
  const toLand = distance(land, w, h);   // for sea cells: how far out to sea
  const toEdge = distance(edge, w, h);   // to the nearest coast or border
  // The terrain fields, sampled once per cell over the land (the page reads them back, smoothly
  // interpolated, instead of computing noise for every mark). The mountains and the high ground
  // they stand on are the world's own (terrain.js): every style draws the same ranges, and the
  // world's rivers run off them. Woods, downs, dry and wet ground are this style's.
  const T = makeTerrain(seed);
  const fields = {mountain: new Float32Array(N), hill: new Float32Array(N), forest: new Float32Array(N), dry: new Float32Array(N), wet: new Float32Array(N)};
  for (let y = 0; y < h; ++y) for (let x = 0; x < w; ++x) {
    let i = y * w + x;
    // (sea cells next to land are sampled too, so interpolation at the coast is sound)
    if (!land[i] && toLand[i] > 1.5) continue;
    let wx = x0 + (x + 0.5) * cell, wy = y0 - (y + 0.5) * cell;
    fields.mountain[i] = terrain ? terrainAt(terrain, terrain.mountain, wx, wy) : 0;
    // foothills flank the ranges; a few downs and wolds stand on their own
    fields.hill[i] = Math.max(terrain ? Math.min(1, 1.3 * terrainAt(terrain, terrain.foot, wx, wy)) : 0, T.downs(wx, wy));
    fields.forest[i] = T.forest(wx, wy); fields.dry[i] = T.dry(wx, wy); fields.wet[i] = T.wet(wx, wy);
  }
  const shown = terrain ? terrain.shown : Infinity;
  return {toSea, toLand, toEdge, ids, fields, thr: thresholds(ids, fields, toSea, cell, shown), spots: seaSpots({w, h, ids, cell, x0, y0, toLand, box})};
}

// How much of each realm its hills and woods may take. The fields alone gave a big realm whole
// fields of woods and left mid-size ones bare; so each realm gets thresholds of its own: no more
// than a share of it under hills or woods (the highest of its fields), and a realm left nearly
// bare gets a few hills. A calmer, more even texture. Mountains stand where the world's terrain
// shows them (`shown`, the same in every realm: its share of them was settled there).
const SHARE = {hill: 0.1, forest: 0.2}, FLOOR = {hill: 0.36, forest: 0.04}, BARE = 0.07;
const smooth = (a, b, x) => { let t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function thresholds(ids, F, toSea, cell, shown) {
  let n = 0;
  for (let i = 0; i < ids.length; ++i) if (ids[i] > n) n = ids[i];
  n += 1;
  let vals = {mountain: Array.from({length: n}, () => []), hill: Array.from({length: n}, () => []), forest: Array.from({length: n}, () => [])}, count = new Int32Array(n);
  for (let i = 0; i < ids.length; ++i) {
    let id = ids[i];
    if (id < 0) continue;
    count[id]++;
    let inland = toSea[i] * cell, m = F.mountain[i];
    vals.mountain[id].push(m);
    if (m < shown) vals.hill[id].push(F.hill[i] * smooth(0.6, 2, inland));
    if (F.dry[i] <= 0.2 && F.hill[i] <= 0.36 && m <= 0.75 * shown) vals.forest[id].push(F.forest[i]);
  }
  let thr = {mountain: new Float32Array(n), hill: new Float32Array(n), forest: new Float32Array(n)};
  // the value above which a share of the realm's cells lies
  let top = (list, share, total, floor) => {
    let k = Math.floor(share * total);
    if (k <= 0 || !list.length) return Infinity;
    list.sort((a, b) => b - a);
    return Math.max(floor, list[Math.min(k, list.length) - 1]);
  };
  let above = (list, t) => { let c = 0; for (let v of list) if (v >= t) c++; return c; };
  for (let id = 0; id < n; ++id) {
    let total = count[id];
    if (!total) { thr.mountain[id] = thr.hill[id] = thr.forest[id] = Infinity; continue; }
    // (a big realm a smaller share: its patch of ranges is big enough as it is)
    let big = Math.min(1, Math.sqrt(9 / Math.max(1e-9, Math.sqrt(total) * cell)));
    thr.mountain[id] = shown;
    for (let kind in SHARE) thr[kind][id] = top(vals[kind][id], SHARE[kind] * big, total, FLOOR[kind]);
    let covered = ['mountain', 'hill', 'forest'].reduce((c, kind) => c + above(vals[kind][id], thr[kind][id]), 0);
    if (covered < BARE * total) thr.hill[id] = Math.min(thr.hill[id], top(vals.hill[id], BARE, total, 0.16));
  }
  return thr;
}

// Open water for the sea's furniture: the widest stretches inside the world's frame, each with how
// far the water runs left and right of it (room for a name)
function seaSpots({w, h, ids, cell, x0, y0, toLand, box}) {
  if (!box) return {names: []};
  let cand = [];
  let span = Math.max(box.x1 - box.x0, box.y1 - box.y0), mx = (box.x1 - box.x0) * 0.06, my = (box.y1 - box.y0) * 0.06;
  for (let c = 0; c < w * h; ++c) {
    if (ids[c] !== -1) continue;
    let d = toLand[c] * cell;
    if (d < 3.5) continue;
    let cx = c % w, cy = (c - cx) / w;
    let x = x0 + (cx + 0.5) * cell, y = y0 - (cy + 0.5) * cell;
    if (x < box.x0 + mx || x > box.x1 - mx || y < box.y0 + my || y > box.y1 - my) continue;
    // open water near the frame's edge is the outer ocean reaching in: worth less
    let edge = Math.min(x - box.x0, box.x1 - x, y - box.y0, box.y1 - y);
    let room = Math.min(d, edge * 0.8);
    cand.push([room * Math.min(1, 0.45 + edge / (0.18 * span)), x, y, room, c]);
  }
  cand.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);
  let spots = [];
  for (let [score, x, y, d, c] of cand) {
    if (spots.some(p => Math.hypot(p.x - x, p.y - y) < Math.max(p.d, d) * 1.5 + 8)) continue;
    let cx = c % w, row = c - cx, l = cx, r = cx;
    while (l > 0 && ids[row + l - 1] === -1 && toLand[row + l - 1] * cell > 1.2) --l;
    while (r < w - 1 && ids[row + r + 1] === -1 && toLand[row + r + 1] * cell > 1.2) ++r;
    spots.push({x, y, d, run: (r - l) * cell, mid: x0 + ((l + r) / 2 + 0.5) * cell});
    if (spots.length >= 9) break;
  }
  // and the open ocean round the world, for the names of the outer seas
  let cxm = (box.x0 + box.x1) / 2, cym = (box.y0 + box.y1) / 2, off = span * 0.07;
  let outer = [[cxm, box.y1 + off], [cxm, box.y0 - off]].map(([x, y]) => {
    let cx = Math.floor((x - x0) / cell), cy = Math.floor((y0 - y) / cell);
    let c = cx >= 0 && cy >= 0 && cx < w && cy < h ? cy * w + cx : -1;
    return {x, y, d: c >= 0 && ids[c] === -1 ? toLand[c] * cell : 0, run: span * 0.8, mid: x, outer: true};
  }).filter(p => p.d > 2.5);
  return {rose: spots[0], ship: spots[1], serpent: spots[2], names: spots.slice(3).concat(outer)};
}
