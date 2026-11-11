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
//               source down to the sea or to the river it joins, the largest first. One that joins
//               another ends on a point of that river's line, and no two cross. flow is the land
//               a river has drained by each point, in square map units (rain falls more on the
//               heights)
//     riverMin  the flow from which a stream counts as a river. Each river is drawn from higher up,
//               thinner, so that it is seen to rise where it does
//   }
import {noise2, hypot} from './util.js';
import {landOf, edt, spread, markLine, valueAt, CELL} from './land.js';

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
  // ---- rivers: the cells that gather enough. Where two streams meet, the larger is the river and
  // runs on; the smaller is its tributary and ends there, on the river's line
  const isRiver = i => land(i) && flow[i] >= RIVER_MIN;
  const upBest = new Int32Array(N).fill(-1), hasUp = new Uint8Array(N);
  for (let i = 0; i < N; ++i) {
    const d = down[i];
    if (d < 0 || !land(i)) continue;
    if (upBest[d] < 0 || flow[i] > flow[upBest[d]]) upBest[d] = i;
    if (isRiver(i)) hasUp[d] = 1;
  }
  // the heads (where a stream first counts as a river), the largest rivers first: by what each
  // carries where it ends, at the sea or in a larger river. So a river is drawn before any that
  // joins it
  const heads = [];
  for (let i = 0; i < N; ++i) {
    if (!isRiver(i) || hasUp[i]) continue;
    let e = i;
    while (down[e] >= 0 && land(down[e]) && upBest[down[e]] === e) e = down[e];
    heads.push([i, flow[e]]);
  }
  heads.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  // The courses bend. Every point of the map is pushed aside a little, by a slow wave and a quicker
  // one: the same push for every river, so two that meet still meet and two that do not, do not
  // cross. No push at the coast (a river ends where its water does) nor by a border (it crosses
  // one square on)
  const fieldsOf = {grid: G};
  const pushed = (x, y) => {
    const u = x * K, v = y * K;
    const hold = smoothstep(0, 1.2, valueAt(fieldsOf, inland, x, y)) * smoothstep(0.3, 1.6, valueAt(fieldsOf, borderD, x, y)) / K;
    return [x + hold * (0.4 * noise2(u / 2.5, v / 2.5, ns + 6) + 0.13 * noise2(u / 0.9, v / 0.9, ns + 7)),
      y + hold * (0.4 * noise2(u / 2.5 + 37.2, v / 2.5 - 11.8, ns + 8) + 0.13 * noise2(u / 0.9 - 5.3, v / 0.9 + 21.4, ns + 9))];
  };
  // owner: the river through each cell (its place in `rivers`); place: how many cells down that
  // river's course the cell is
  const owner = new Int32Array(N).fill(-1), place = new Int32Array(N), rivers = [];
  // drawn: the pieces of the rivers' lines that start in each cell, as a chain through `links`
  // (river, point, the next piece in the cell)
  const drawn = new Int32Array(N).fill(-1), links = [];
  for (const [head] of heads) {
    // up its largest stream to where the river rises; a source is clear of the borders' ridges (a
    // river that begins on a border looks cut off by it)
    const source = [];
    for (let u = upBest[head]; u >= 0 && owner[u] < 0 && flow[u] >= SOURCE_MIN; u = upBest[u]) source.push(u);
    while (source.length && borderD[source[source.length - 1]] < RIDGE) source.pop();
    source.reverse();
    // down to the sea, or to a larger river. It joins that river where it first comes alongside
    // it, within two cells: two rivers so close are one to the eye, and drawn side by side they
    // would run together or cross
    let cells = [...source, head], join = -1;
    for (let i = head; ;) {
      const x = i % w, y = (i - x) / w;
      for (let dy = -2; dy <= 2; ++dy) for (let dx = -2; dx <= 2; ++dx) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (owner[q] >= 0 && flow[q] >= flow[i] && (join < 0 || flow[q] > flow[join])) join = q;
      }
      if (join >= 0) break;
      const j = down[i];
      if (j < 0) break;
      if (owner[j] >= 0) { join = j; break; }
      cells.push(j);
      if (!land(j)) break;
      i = j;
    }
    // (one that starts on a border's ridge and has no stream above it starts below the ridge)
    let start = 0;
    while (start < cells.length - 1 && land(cells[start]) && borderD[cells[start]] < RIDGE && !source.length) ++start;
    cells = cells.slice(start);
    if (cells.length + (join >= 0 ? 1 : 0) < 6) continue;
    // the course: the cells' middles, pushed; the last, where it joins, on the larger river's line
    let pts = cells.map(c => pushed(xOf(c), yOf(c))), fl = cells.map(c => land(c) ? flow[c] : 0);
    const R = join >= 0 ? rivers[owner[join]].points : null;
    let met = -1;        // the point of the larger river's line where this one meets it
    if (R) {
      const at = pushed(xOf(join), yOf(join)), mid = Math.min(8 * place[join], R.length / 2 - 1);
      for (let q = Math.max(0, mid - 12), d2 = Infinity; q <= Math.min(R.length / 2 - 1, mid + 12); ++q) {
        const d = (R[2 * q] - at[0]) ** 2 + (R[2 * q + 1] - at[1]) ** 2;
        if (d < d2) { d2 = d; met = q; }
      }
      pts.push([R[2 * met], R[2 * met + 1]]);
      fl.push(fl[fl.length - 1]);
    }
    // (a river's flow never falls on its way down: the cell it ends in is the sea's, or another river's)
    for (let k = 1; k < fl.length; ++k) if (fl[k] < fl[k - 1]) fl[k] = fl[k - 1];
    // the grid's steps and corners smoothed away (the ends stay where they are)
    for (let pass = 0; pass < 3; ++pass) {
      const np = pts.map(p => p);
      for (let k = 1; k + 1 < pts.length; ++k) np[k] = [0.25 * pts[k - 1][0] + 0.5 * pts[k][0] + 0.25 * pts[k + 1][0], 0.25 * pts[k - 1][1] + 0.5 * pts[k][1] + 0.25 * pts[k + 1][1]];
      pts = np;
    }
    // a smooth line through those points (Catmull-Rom), four to a cell
    let line = [], fline = [];
    for (let k = 0; k + 1 < pts.length; ++k) {
      const p0 = pts[Math.max(0, k - 1)], p1 = pts[k], p2 = pts[k + 1], p3 = pts[Math.min(pts.length - 1, k + 2)];
      for (let t = 0; t < 1; t += 0.25) {
        const t2 = t * t, t3 = t2 * t;
        line.push([0.5 * (2 * p1[0] + (p2[0] - p0[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (3 * p1[0] - p0[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * (2 * p1[1] + (p2[1] - p0[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (3 * p1[1] - p0[1] - 3 * p2[1] + p3[1]) * t3)]);
        fline.push(fl[k] + (fl[k + 1] - fl[k]) * t);
      }
    }
    line.push(pts[pts.length - 1]); fline.push(fl[fl.length - 1]);
    // the small turns of a river's own, too small to bring it near another: a wave along its
    // course, none at its ends
    let along = 0;
    const key = head % 9973;
    line = line.map((p, k) => {
      const a = line[Math.max(0, k - 1)], b = line[Math.min(line.length - 1, k + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], l = hypot(dx, dy) || 1;
      if (k) along += hypot(p[0] - line[k - 1][0], p[1] - line[k - 1][1]) * K;
      const off = 0.05 * noise2(along / 0.33, key * 0.37, ns + 10) * Math.min(1, k / 6, (line.length - 1 - k) / 6) / K;
      return [p[0] - dy / l * off, p[1] + dx / l * off];
    });
    // (and its corners cut once: Chaikin)
    const points = new Float64Array(4 * line.length), told = new Float32Array(2 * line.length);
    let n = 0;
    const put = (x, y, f) => { points[2 * n] = x; points[2 * n + 1] = y; told[n++] = f; };
    put(line[0][0], line[0][1], fline[0]);
    for (let k = 0; k + 1 < line.length; ++k) {
      const [ax, ay] = line[k], [bx, by] = line[k + 1];
      put(0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by, 0.75 * fline[k] + 0.25 * fline[k + 1]);
      put(0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by, 0.25 * fline[k] + 0.75 * fline[k + 1]);
    }
    put(line[line.length - 1][0], line[line.length - 1][1], fline[fline.length - 1]);
    // A river ends where it first meets one drawn before it: the river it joins, as a rule at the
    // point found above, or another that came between (two tributaries that reach a river side by
    // side). Its last point is then a point of that river's line
    meet: for (let k = 0; k + 1 < n; ++k) {
      const ax = points[2 * k], ay = points[2 * k + 1], bx = points[2 * k + 2], by = points[2 * k + 3];
      const gx = Math.floor((ax - x0) / cell), gy = Math.floor((y0 - ay) / cell);
      let hit = 2, to = -1, of = null;
      for (let yy = Math.max(0, gy - 1); yy <= Math.min(h - 1, gy + 1); ++yy) for (let xx = Math.max(0, gx - 1); xx <= Math.min(w - 1, gx + 1); ++xx) {
        for (let e = drawn[yy * w + xx]; e >= 0; e = links[3 * e + 2]) {
          const S = rivers[links[3 * e]].points, q = links[3 * e + 1];
          const cx = S[2 * q], cy = S[2 * q + 1], dx = S[2 * q + 2], dy = S[2 * q + 3];
          const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
          if (d === 0) continue;
          const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d, u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
          if (t < 0 || t > 1 || u < 0 || u > 1 || t >= hit) continue;
          hit = t; of = S; to = u < 0.5 ? q : q + 1;
        }
      }
      if (!of) continue;
      points[2 * k + 2] = of[2 * to]; points[2 * k + 3] = of[2 * to + 1];
      n = k + 2;
      break meet;
    }
    cells.forEach((c, k) => { if (land(c)) { owner[c] = rivers.length; place[c] = k; } });
    rivers.push({points: points.slice(0, 2 * n), flow: Float32Array.from(told.subarray(0, n), f => f / (K * K)), told: told.slice(0, n)});
    // (its line, by cell, for the rivers still to come)
    for (let q = 0; q + 1 < n; ++q) {
      const gx = Math.floor((points[2 * q] - x0) / cell), gy = Math.floor((y0 - points[2 * q + 1]) / cell);
      if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
      links.push(rivers.length - 1, q, drawn[gy * w + gx]);
      drawn[gy * w + gx] = links.length / 3 - 1;
    }
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
