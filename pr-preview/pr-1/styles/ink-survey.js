// The inked map's survey: from a raster of the world (which country, or sea, in each cell) it
// measures how far every cell lies from the sea, from the land and from the nearest border or
// coast, samples the terrain fields, raises an invented relief and lets rain run off it to find
// the rivers, and finds the widest open water for the sea's furniture.
// Input {w, h, ids (Int16Array: country index, -1 sea, -2 an edge cell), cell (world units),
// x0, y0 (world position of cell 0, y up), seed, box}. Distances are in cells.
import {makeTerrain} from './ink-noise.js';

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

// A binary min-heap of cell indices keyed by a Float32Array
function heap(key) {
  let a = [];
  return {
    get size() { return a.length; },
    push(i) {
      a.push(i);
      let c = a.length - 1;
      while (c > 0) { let p = (c - 1) >> 1; if (key[a[p]] <= key[a[c]]) break; [a[p], a[c]] = [a[c], a[p]]; c = p; }
    },
    pop() {
      let top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last;
        let c = 0;
        while (true) {
          let l = 2 * c + 1, r = l + 1, m = c;
          if (l < a.length && key[a[l]] < key[a[m]]) m = l;
          if (r < a.length && key[a[r]] < key[a[m]]) m = r;
          if (m === c) break;
          [a[m], a[c]] = [a[c], a[m]]; c = m;
        }
      }
      return top;
    },
  };
}

export function survey({w, h, ids, cell, x0, y0, seed, box}) {
  const N = w * h;
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

  // The relief: rising inland, with ridges where the mountain field says so, and a little noise.
  // Rivers find their way down it to the sea.
  const T = makeTerrain(seed), fbm = T.fbm;
  const elev = new Float32Array(N);
  // the terrain fields, sampled once per cell over the land (the page reads them back, smoothly
  // interpolated, instead of computing noise for every mark)
  const fields = {mountain: new Float32Array(N), hill: new Float32Array(N), forest: new Float32Array(N), dry: new Float32Array(N), wet: new Float32Array(N)};
  for (let y = 0; y < h; ++y) for (let x = 0; x < w; ++x) {
    let i = y * w + x;
    // (sea cells next to land are sampled too, so interpolation at the coast is sound)
    if (!land[i] && toLand[i] > 1.5) { elev[i] = 0; continue; }
    let wx = x0 + (x + 0.5) * cell, wy = y0 - (y + 0.5) * cell;
    let m = T.mountain(wx, wy);
    fields.mountain[i] = m; fields.hill[i] = T.hill(wx, wy); fields.forest[i] = T.forest(wx, wy);
    fields.dry[i] = T.dry(wx, wy); fields.wet[i] = T.wet(wx, wy);
    if (!land[i]) { elev[i] = 0; continue; }
    elev[i] = toSea[i] * cell + 9 * m + 2.2 * fbm(wx / 9, wy / 9, 2) + 0.6 * fbm(wx / 2.5, wy / 2.5, 2);
  }
  // priority flood from the coast: every land cell drains to the neighbour it was reached from
  const recv = new Int32Array(N).fill(-1), done = new Uint8Array(N), level = new Float32Array(N);
  const q = heap(level), order = [];
  for (let i = 0; i < N; ++i) {
    if (!land[i]) continue;
    let x = i % w, y = (i - x) / w;
    for (let [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || !land[ny * w + nx]) {
        if (!done[i]) { done[i] = 1; level[i] = elev[i]; recv[i] = (nx < 0 || ny < 0 || nx >= w || ny >= h) ? -1 : ny * w + nx; q.push(i); }
      }
    }
  }
  const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  while (q.size) {
    let i = q.pop();
    order.push(i);
    let x = i % w, y = (i - x) / w;
    for (let [dx, dy] of D8) {
      let nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      let j = ny * w + nx;
      if (!land[j] || done[j]) continue;
      done[j] = 1;
      level[j] = Math.max(elev[j], level[i] + 1e-3 * cell);
      recv[j] = i;
      q.push(j);
    }
  }
  // rain, more of it inland of the mountains, gathered downstream
  const acc = new Float32Array(N);
  for (let i = 0; i < N; ++i) if (land[i]) acc[i] = 1;
  for (let k = order.length - 1; k >= 0; --k) {
    let i = order[k], r = recv[i];
    if (r >= 0 && land[r]) acc[r] += acc[i];
  }
  // the cells big enough to carry a river at the finest detail shown
  const MIN = 90;
  let cells = [];
  for (let i = 0; i < N; ++i) if (land[i] && acc[i] >= MIN) cells.push(i);
  const river = {cell: new Int32Array(cells), recv: new Int32Array(cells.map(i => recv[i])), acc: new Float32Array(cells.map(i => acc[i]))};
  return {toSea, toLand, toEdge, river, ids, fields, spots: seaSpots({w, h, ids, cell, x0, y0, toLand, box})};
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
