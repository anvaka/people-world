// The lie of the land: one terrain for each world, which every style draws. Where the mountains
// stand, and the rivers that rain running off them makes. A style adds its own woods, marshes and
// colours; it invents no mountains or rivers of its own, so the same world shows the same ones
// however it is drawn.
//
// Everything is a function of the world's number and of positions on the map (map units), on the
// grid of the world's land (land.js), whose cells sit on a fixed lattice: where an edit leaves the
// map alone, it leaves the terrain alone. One of the generator's addons (addons.js).
//
//   makeTerrain({countries, lines}, seed) -> {
//     grid      the land's: {w, h, cell, x0, y0} (read a field between cells with land.js's valueAt)
//     mountain  Float32Array, w * h: how high the ranges stand, 0 to 1. Mountains are drawn where it
//               is at least `shown`; below that the ground only rises toward them
//     foot      Float32Array, w * h: the high ground the ranges stand on, 0 to 1 (foothills)
//     shown     the value of `mountain` from which a style draws mountains
//     rivers    [{points: Float64Array (x, y, x, y, ...; y up), flow: Float32Array}], each from its
//               source down to the sea or to the river it joins; flow is the land it has drained
//               by each point, in square map units (rain falls more on the heights)
//     riverMin  the flow from which a stream counts as a river. Each river is drawn from higher up,
//               thinner, so that it is seen to rise where it does
//   }
import {noise2, hypot} from './util.js';
import {landOf, edt, spread, markLine, CELL} from './land.js';

const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const hashStr = s => { let h = 2166136261; for (let i = 0; i < s.length; ++i) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };

export const MOUNTAIN_SHOWN = 0.2;
// The lengths below are in map units of the world of countries, where a cell is about 0.3 across.
// A world of another size (a graph of your own) gets the same terrain for its size: everything is
// worked out with a cell counted as CELL across, whatever it measures on the map (land.js).
const RIDGE = 1.05, RIDGE_HEIGHT = 7;     // every border stands on a low ridge: half its width, its height
const MOUNTAIN_HEIGHT = 16, FOOT_HEIGHT = 3;
const RIVER_MIN = 22;              // square map units of land drained: a river
const SOURCE_MIN = 2.5;            // ... and how far up its largest stream a river is drawn
const DIVIDE_MIN = 1.5 * RIVER_MIN;   // a divide carries a range where both the streams it parts drain so much
const SHARE = 0.13;                // ... and at most this share of a country is under such ranges

// A binary min-heap of cells by a key (the same order whatever the engine: ties go to the lower cell)
function makeHeap(key) {
  let a = new Int32Array(4096), size = 0;
  return {
    get size() { return size; },
    push(v) {
      if (size === a.length) { const b = new Int32Array(2 * size); b.set(a); a = b; }
      let i = size++;
      const kv = key[v];
      while (i > 0) {
        const p = (i - 1) >> 1, q = a[p], kq = key[q];
        if (kq < kv || (kq === kv && q < v)) break;
        a[i] = q; i = p;
      }
      a[i] = v;
    },
    pop() {
      const top = a[0], last = a[--size], kl = key[last];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= size) break;
        if (c + 1 < size) { const l = a[c], r = a[c + 1]; if (key[r] < key[l] || (key[r] === key[l] && r < l)) c++; }
        const q = a[c], kq = key[q];
        if (kl < kq || (kl === kq && last < q)) break;
        a[i] = q; i = c;
      }
      a[i] = last;
      return top;
    },
  };
}

// A priority flood from the sea (and from the shores of straits) gives every land cell a way down
// without pits: down[i] is the cell it drains to (-1: the sea), `order` the cells from the lowest up
const NBX = [1, -1, 0, 0, 1, 1, -1, -1], NBY = [0, 0, 1, -1, 1, -1, 1, -1];
function flood(elev, ids, shore, w, h) {
  const N = w * h, down = new Int32Array(N).fill(-2), level = new Float32Array(N);
  const heap = makeHeap(level), order = new Int32Array(N);
  let n = 0;
  for (let y = 0; y < h; ++y) for (let x = 0; x < w; ++x) {
    const i = y * w + x;
    if (ids[i] >= 0) { if (shore[i]) { down[i] = -1; level[i] = elev[i]; heap.push(i); } continue; }
    let coast = false;
    for (let k = 0; k < 8 && !coast; ++k) { const xx = x + NBX[k], yy = y + NBY[k]; coast = xx >= 0 && yy >= 0 && xx < w && yy < h && ids[yy * w + xx] >= 0; }
    if (coast) { down[i] = -1; level[i] = -1; heap.push(i); }
  }
  while (heap.size) {
    const i = heap.pop(), x = i % w, y = (i - x) / w, base = level[i] + 1e-3;
    order[n++] = i;
    for (let k = 0; k < 8; ++k) {
      const xx = x + NBX[k], yy = y + NBY[k];
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (down[j] !== -2 || ids[j] < 0) continue;
      down[j] = i;
      level[j] = elev[j] > base ? elev[j] : base;
      heap.push(j);
    }
  }
  return {down, order: order.subarray(0, n)};
}

export function makeTerrain(world, seed = 1) {
  const tm = globalThis.TERRAINLOG ? [['start', Date.now()]] : null, lap = name => { if (tm) tm.push([name, Date.now()]); };
  const L = landOf(world);
  if (!L) return {grid: {w: 1, h: 1, cell: 1, x0: 0, y0: 0}, mountain: new Float32Array(1), foot: new Float32Array(1), shown: MOUNTAIN_SHOWN, rivers: [], riverMin: RIVER_MIN};
  const countries = world.countries.filter(c => c.rings && c.rings.length);
  const G = L.grid, {w, h, cell, x0, y0} = G, N = w * h, {ids, inland, K, span} = L;
  const xOf = i => x0 + (i % w + 0.5) * cell, yOf = i => y0 - (Math.floor(i / w) + 0.5) * cell;

  lap('raster');
  // ---- distances (map units): to the nearest border, to where borders meet (and inland from the
  // coast: the land's own)
  const borderD = new Float64Array(N).fill(1e20), coastLine = new Uint8Array(N);
  for (const line of world.lines) {
    if (line.kind === 'border') markLine(borderD, G, line.points, 0);
    else markLine(coastLine, G, line.points, 1);
  }
  // (two countries side by side with no border line between them are kept apart by a strait too
  // narrow for the grid: the land along it stands on a ridge as a border does, and the cells the
  // two coasts pass through are shore, where a river ends: none runs on across the water)
  const shore = new Uint8Array(N);
  for (let y = 1; y < h - 1; ++y) for (let x = 1; x < w - 1; ++x) {
    const i = y * w + x, id = ids[i];
    if (id < 0) continue;
    for (const j of [i - 1, i + 1, i - w, i + w]) {
      const o = ids[j];
      if (o < 0 || o === id) continue;
      if (borderD[i] > 0 && borderD[j] > 0 && coastLine[i] && coastLine[j]) shore[i] = 1;
      else borderD[i] = 0;
    }
  }
  for (let i = 0; i < N; ++i) if (shore[i]) borderD[i] = 0;
  const junctions = [];
  for (let y = 2; y < h - 2; ++y) for (let x = 2; x < w - 2; ++x) {
    const i = y * w + x;
    if (borderD[i] !== 0) continue;
    let a = -3, b = -3, three = false;
    for (let dy = -2; dy <= 2 && !three; ++dy) for (let dx = -2; dx <= 2; ++dx) {
      const o = ids[i + dy * w + dx];
      if (o === a || o === b) continue;
      if (a === -3) a = o; else if (b === -3) b = o; else { three = true; break; }
    }
    if (three) junctions.push(i);
  }
  edt(borderD, w, h);
  const junctionD = spread(junctions, 2 * RIDGE / CELL + 1, w, h);
  for (let i = 0; i < N; ++i) { borderD[i] *= CELL; junctionD[i] *= CELL; }

  lap('distances');
  // ---- the ground before its ranges: rising inland, and rough. Every border stands on a low
  // ridge of its own, higher where three meet (or a border meets the sea): a river keeps off the
  // borders and crosses one at a saddle, square on and away from the corners, and does not run
  // along it, where it would be taken for the border
  const ns = seed * 7919 + 13;
  const land = i => ids[i] >= 0;
  const ground = new Float32Array(N);
  for (let i = 0; i < N; ++i) {
    if (!land(i)) continue;
    const x = xOf(i) * K, y = yOf(i) * K;
    let e = 8 + 3.4 * Math.sqrt(inland[i]) + 4.5 * noise2(x / 9.1, y / 9.1, ns + 2) + 2 * noise2(x / 3.2, y / 3.2, ns + 3) + 0.75 * noise2(x / 1.25, y / 1.25, ns + 4);
    const t = 1 - borderD[i] / RIDGE, u = 1 - junctionD[i] / (2 * RIDGE);
    if (t > 0) e += RIDGE_HEIGHT * t * t;
    if (u > 0) e += RIDGE_HEIGHT * u * u;
    ground[i] = Math.max(0, e);
  }
  // the crest along a range is broken into peaks and passes (at cell i)
  const peaks = i => 0.45 + 0.55 * smoothstep(-0.3, 0.25, noise2(xOf(i) * K / 2.7 + 11.3, yOf(i) * K / 2.7 - 4.9, ns + 5));
  const mountain = new Float32Array(N), foot = new Float32Array(N), rise = new Float32Array(N);

  lap('ground');
  // ---- ranges along some long borders (as the Pyrenees or the Andes follow theirs): on one side
  // of the border, the crest a little way in and no mountain on the line itself. The ground rises
  // from the line to the crest (no trough between them for a river to run in, along the border)
  const byIndex = new Map(countries.map(c => [c.index, c]));
  const widthOf = new Map();           // the side of a square of each country's size
  for (let i = 0; i < N; ++i) if (land(i)) widthOf.set(ids[i], (widthOf.get(ids[i]) || 0) + 1);
  for (const [id, n] of widthOf) widthOf.set(id, Math.sqrt(n) * CELL);
  for (const line of world.lines) {
    if (line.kind !== 'border') continue;
    const a = byIndex.get(line.a), b = byIndex.get(line.b);
    if (!a || !b) continue;
    const pair = [a.id, b.id].sort().join('-');
    let length = 0;
    for (let k = 1; k < line.points.length; ++k) length += hypot(line.points[k][0] - line.points[k - 1][0], line.points[k][1] - line.points[k - 1][1]);
    if (hashStr(pair) > 0.3 || length < 0.02 * span) continue;
    // (a range is as broad as its country lets it be, and a country too small has none: then
    // the range stands on the other side, if that is large enough)
    const room = c => Math.min(1, widthOf.get(c.index) / 8);
    let on = hashStr(pair + '|side') < 0.5 ? a : b;
    if (room(on) < 0.4) on = on === a ? b : a;
    if (room(on) < 0.4) continue;
    const side = on.index, scale = room(on), BELT_IN = 1.4 * scale, BELT_HALF = 1.2 * scale;
    // the distance to this border, in a box round it only
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const [x, y] of line.points) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y); }
    const reach = Math.ceil((BELT_IN + BELT_HALF) / CELL) + 1;
    const i0 = Math.max(0, Math.floor((bx0 - x0) / cell) - reach), i1 = Math.min(w - 1, Math.floor((bx1 - x0) / cell) + reach);
    const j0 = Math.max(0, Math.floor((y0 - by1) / cell) - reach), j1 = Math.min(h - 1, Math.floor((y0 - by0) / cell) + reach);
    const bw = i1 - i0 + 1, bh = j1 - j0 + 1;
    if (bw <= 0 || bh <= 0) continue;
    const d = new Float64Array(bw * bh).fill(1e20);
    markLine(d, {w: bw, h: bh, cell, x0: x0 + i0 * cell, y0: y0 - j0 * cell}, line.points, 0);
    edt(d, bw, bh);
    for (let j = 0; j < bh; ++j) for (let i = 0; i < bw; ++i) {
      const k = (j + j0) * w + i + i0;
      if (ids[k] !== side) continue;
      const dist = d[j * bw + i] * CELL, tent = 1 - Math.abs(dist - BELT_IN) / BELT_HALF;
      if (dist > BELT_IN + BELT_HALF) continue;
      // (not out to the coast)
      const fade = smoothstep(0.3, 1.5, inland[k]), p = peaks(k);
      if (tent > 0) {
        mountain[k] = Math.max(mountain[k], tent * fade * p);
        foot[k] = Math.max(foot[k], 0.8 * tent * fade);
      }
      rise[k] = Math.max(rise[k], (dist < BELT_IN ? 1 : tent) * fade * p);
    }
  }

  lap('belts');
  // ---- ranges of their own stand where the waters part. Rain run off the ground as it is finds
  // the rivers-to-be and the land each drains; the divides between two of them, where both are
  // sizeable, are the lines of the ranges, and the highest stretches of those lines carry them.
  // So a river rises in the mountains or runs along their feet, and does not cut through them.
  const elev = new Float32Array(N).fill(-1);
  for (let i = 0; i < N; ++i) if (land(i)) elev[i] = ground[i] + MOUNTAIN_HEIGHT * rise[i];
  const first = flood(elev, ids, shore, w, h);
  const cellArea = CELL * CELL;
  {
    const {down, order} = first;
    const flow = new Float32Array(N);
    for (let k = order.length - 1; k >= 0; --k) { const i = order[k]; if (!land(i)) continue; flow[i] += cellArea; if (down[i] >= 0) flow[down[i]] += flow[i]; }
    const river = i => land(i) && flow[i] >= RIVER_MIN;
    const best = new Int32Array(N).fill(-1);
    for (let i = 0; i < N; ++i) { const d = down[i]; if (d >= 0 && river(i) && (best[d] < 0 || flow[i] > flow[best[d]])) best[d] = i; }
    // every cell's stream: a river keeps its name up its largest branch, the others are streams
    // of their own; a cell that is no river belongs to the stream it runs into (-1: straight to
    // the sea). `size`: what a stream has drained where it ends
    const stream = new Int32Array(N).fill(-1), size = new Float32Array(N);
    for (const i of order) {
      if (!land(i)) continue;
      const d = down[i];
      if (river(i)) { if (d >= 0 && river(d) && best[d] === i) stream[i] = stream[d]; else { stream[i] = i; size[i] = flow[i]; } }
      else if (d >= 0 && land(d)) stream[i] = stream[d];
    }
    // the divides, each cell with the smaller of the two streams it parts
    const worth = new Float32Array(N);
    for (let y = 1; y < h - 1; ++y) for (let x = 1; x < w - 1; ++x) {
      const i = y * w + x, a = stream[i];
      if (a < 0 || inland[i] < 2.2 || borderD[i] < 1.6 || rise[i] > 0) continue;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        const b = stream[j];
        if (b < 0 || b === a) continue;
        const v = Math.min(size[a], size[b]);
        if (v > worth[i]) worth[i] = v;
      }
    }
    // A country's share of them is bounded (a large country's more tightly: its ranges are long
    // as it is): the highest of its divides, so no country is all mountain
    const RANGE_HALF = 1.2, perCell = 0.8 * RANGE_HALF / CELL;      // cells of shown mountain to a cell of crest, about
    const lists = new Map(), cells = new Map();
    for (let i = 0; i < N; ++i) {
      const id = ids[i];
      if (id < 0) continue;
      cells.set(id, (cells.get(id) || 0) + 1);
      if (worth[i] >= DIVIDE_MIN) { let l = lists.get(id); if (!l) lists.set(id, l = []); l.push(i); }
    }
    const crest = new Float32Array(N).fill(1e20);
    for (const [id, list] of lists) {
      const total = cells.get(id), width = Math.sqrt(total) * CELL;
      const k = Math.floor(SHARE * Math.min(1, Math.sqrt(9 / width)) * total / perCell);
      list.sort((p, q) => ground[q] - ground[p] || p - q);
      for (let t = 0; t < Math.min(k, list.length); ++t) crest[list[t]] = 0;
    }
    // (a few cells of crest on their own are no range)
    const seen = new Uint8Array(N);
    for (let i = 0; i < N; ++i) {
      if (crest[i] !== 0 || seen[i]) continue;
      const stack = [i], group = [];
      seen[i] = 1;
      while (stack.length) {
        const j = stack.pop(), x = j % w, y = (j - x) / w;
        group.push(j);
        for (let dy = -2; dy <= 2; ++dy) for (let dx = -2; dx <= 2; ++dx) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx;
          if (crest[q] === 0 && !seen[q]) { seen[q] = 1; stack.push(q); }
        }
      }
      if (group.length * CELL < 3.5) for (const j of group) crest[j] = 1e20;
    }
    const crests = [];
    for (let i = 0; i < N; ++i) if (crest[i] === 0) crests.push(i);
    const toCrest = spread(crests, 2.4 * RANGE_HALF / CELL + 1, w, h);
    for (let i = 0; i < N; ++i) {
      if (!land(i)) continue;
      const d = toCrest[i] * CELL;
      if (d > 2.4 * RANGE_HALF) continue;
      // (clear of the coast and of the borders, as the crests are)
      const fade = smoothstep(0.8, 2.2, inland[i]) * smoothstep(0.5, 1.6, borderD[i]);
      const tent = Math.max(0, 1 - d / RANGE_HALF) * fade;
      if (tent > 0) { const m = tent * peaks(i); if (m > mountain[i]) mountain[i] = m; if (m > rise[i]) rise[i] = m; }
      foot[i] = Math.max(foot[i], 0.8 * Math.max(0, 1 - d / (2.4 * RANGE_HALF)) * fade);
    }
  }

  lap('divides');
  // ---- the relief with its ranges, and the rain that runs off it: more of it on the heights
  for (let i = 0; i < N; ++i) if (land(i)) elev[i] = ground[i] + MOUNTAIN_HEIGHT * rise[i] + FOOT_HEIGHT * foot[i];
  const {down, order} = flood(elev, ids, shore, w, h);
  const flow = new Float32Array(N);
  for (let k = order.length - 1; k >= 0; --k) {
    const i = order[k];
    if (!land(i)) continue;
    flow[i] += cellArea * (1 + 3 * mountain[i] + foot[i]);
    if (down[i] >= 0) flow[down[i]] += flow[i];
  }

  lap('flood');
  // ---- rivers: the cells that gather enough, each traced from its source down
  const isRiver = i => land(i) && flow[i] >= RIVER_MIN;
  const upBest = new Int32Array(N).fill(-1), hasUp = new Uint8Array(N);
  for (let i = 0; i < N; ++i) {
    const d = down[i];
    if (d < 0 || !land(i)) continue;
    if (upBest[d] < 0 || flow[i] > flow[upBest[d]]) upBest[d] = i;
    if (isRiver(i)) hasUp[d] = 1;
  }
  const heads = [];
  for (let i = 0; i < N; ++i) if (isRiver(i) && !hasUp[i]) heads.push(i);
  heads.sort((a, b) => flow[b] - flow[a] || a - b);
  const taken = new Uint8Array(N), rivers = [];
  for (const head of heads) {
    // up its largest stream to where the river rises; a source is clear of the borders' ridges (a
    // river that begins on a border looks cut off by it)
    const source = [];
    for (let u = upBest[head]; u >= 0 && !taken[u] && flow[u] >= SOURCE_MIN; u = upBest[u]) source.push(u);
    while (source.length && borderD[source[source.length - 1]] < RIDGE) source.pop();
    source.reverse();
    const path = [...source, head];
    for (const j of path) taken[j] = 1;
    let i = head;
    while (down[i] >= 0) {
      const j = down[i];
      path.push(j);
      if (taken[j] || !land(j)) break;
      taken[j] = 1;
      i = j;
    }
    // (one that starts on a border's ridge and has no stream above it starts below the ridge)
    let start = 0;
    while (start < path.length - 1 && land(path[start]) && borderD[path[start]] < RIDGE && !source.length) ++start;
    const cells = path.slice(start);
    if (cells.length < 6) continue;
    // meanders: resampled at half a cell, pushed sideways by a slow and a quick wave of noise along
    // the course (less where the river is young, by a border or at its ends), then smoothed
    // (Chaikin, twice)
    let pts = [], fl = [], bd = [];
    for (let k = 0; k + 1 < cells.length; ++k) for (let t = 0; t < 1; t += 0.5) {
      const a = cells[k], b = cells[k + 1];
      pts.push([xOf(a) + (xOf(b) - xOf(a)) * t, yOf(a) + (yOf(b) - yOf(a)) * t]);
      fl.push(Math.min(flow[a], flow[b]) > 0 ? flow[a] + (flow[b] - flow[a]) * t : flow[a]);
      bd.push(Math.min(borderD[a], borderD[b]));
    }
    const last = cells[cells.length - 1];
    pts.push([xOf(last), yOf(last)]); fl.push(fl[fl.length - 1]); bd.push(borderD[last]);
    // (a river's flow never falls on its way down: the cell it ends in may be the sea's)
    for (let k = 1; k < fl.length; ++k) if (fl[k] < fl[k - 1]) fl[k] = fl[k - 1];
    let along = 0;
    const key = head % 9973;
    pts = pts.map((p, k) => {
      const a = pts[Math.max(0, k - 2)], b = pts[Math.min(pts.length - 1, k + 2)];
      const dx = b[0] - a[0], dy = b[1] - a[1], l = hypot(dx, dy) || 1;
      if (k) along += hypot(p[0] - pts[k - 1][0], p[1] - pts[k - 1][1]) * K;
      const ends = Math.min(1, k / 4, (pts.length - 1 - k) / 4) * smoothstep(0.3, 1.6, bd[k]);
      const off = (0.4 * noise2(along / 2.5, key * 0.37, ns + 6) + 0.16 * noise2(along / 0.9, key * 0.37, ns + 7)) * ends / K;
      return [p[0] - dy / l * off, p[1] + dx / l * off];
    });
    for (let it = 0; it < 2; ++it) {
      const np = [pts[0]], nf = [fl[0]];
      for (let k = 0; k + 1 < pts.length; ++k) {
        const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
        np.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by], [0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by]);
        nf.push(0.75 * fl[k] + 0.25 * fl[k + 1], 0.25 * fl[k] + 0.75 * fl[k + 1]);
      }
      np.push(pts[pts.length - 1]); nf.push(fl[fl.length - 1]);
      pts = np; fl = nf;
    }
    const points = new Float64Array(2 * pts.length);
    pts.forEach((p, k) => { points[2 * k] = p[0]; points[2 * k + 1] = p[1]; });
    rivers.push({points, flow: Float32Array.from(fl, f => f / (K * K)), told: Float32Array.from(fl)});
  }
  // Where a river passes through a range the range is broken: a gap as wide as the valley. (Its
  // headwaters, above where it counts as a river, rise among the mountains.)
  {
    const through = new Set();
    for (const r of rivers) for (let k = 0; k < r.flow.length; ++k) {
      if (r.told[k] < 0.6 * RIVER_MIN) continue;
      const cx = Math.floor((r.points[2 * k] - x0) / cell), cy = Math.floor((y0 - r.points[2 * k + 1]) / cell);
      if (cx >= 0 && cy >= 0 && cx < w && cy < h && mountain[cy * w + cx] > 0) through.add(cy * w + cx);
    }
    const gap = spread(through, 1.3 / CELL + 1, w, h);
    for (let i = 0; i < N; ++i) if (mountain[i] > 0 && gap[i] * CELL < 1.3) mountain[i] *= smoothstep(0.45, 1.3, gap[i] * CELL);
    for (const r of rivers) delete r.told;
  }
  lap('rivers');
  if (tm) console.log('terrain: ' + tm.slice(1).map(([n, t], k) => n + ' ' + (t - tm[k][1])).join(', ') + ' ms');
  return {grid: G, mountain, foot, shown: MOUNTAIN_SHOWN, rivers, riverMin: RIVER_MIN / (K * K)};
}
