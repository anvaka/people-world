// The weather of a world, and what grows where: one climate for each world, which every style
// reads. It is warm in the south and cold in the north, and colder up in the mountains. The winds
// blow in belts, as on the Earth (easterly trades in the south, westerlies in the middle, easterlies
// again in the far north), and bring the sea's moisture inland: the land the wind reaches first is
// the wettest, the heart of a continent is dry, a range takes the rain on its windward side and
// leaves its lee in a rain shadow. Between the belts of the south and the middle the air is still
// and dry: there lie the deserts. A river waters its banks whatever the sky does.
//
// From warmth and moisture comes what grows (Whittaker's table): tundra, taiga, steppe, forest,
// desert, jungle. A style draws them its own way (firs or round crowns, dunes, reeds, the colour
// of the ground) but invents none of its own, so the same world shows the same woods and deserts
// however it is drawn.
//
// Everything is a function of the world's number and of positions on the map, on the grid of the
// world's land (land.js). One of the generator's addons (addons.js); with the terrain's addon off
// the land is flat and has no rivers, and the climate is the winds' alone.
//
//   makeClimate({countries, lines, terrain}, seed) -> {
//     grid         the land's: {w, h, cell, x0, y0} (read a field between cells with land.js's valueAt)
//     temperature  Float32Array, w * h: 0 (polar) to 1 (tropical), at the height of the ground
//     moisture     Float32Array, w * h: 0 (arid) to 1 (wet): the rain the winds bring, and the
//                  rivers' water
//     woods        Float32Array, w * h: how wooded the ground is, 0 to 1, in stands and clearings
//                  down to the size of a cell. Woods are drawn where it is at least `wooded`
//     wooded       the value of `woods` from which a style draws woods
//     biome        Uint8Array, w * h: what grows in each cell, an index into `biomes` (0: the sea)
//     biomes       the names: BIOMES
//     winds        {calms, front, spin}: the latitudes (0 at the land's southern end, 1 at its
//                  northern) where the belts of wind meet, and which way the world turns: with spin
//                  1 the westerlies between `calms` and `front` blow from the west, and the trades
//                  south of them and the easterlies north of them from the east; with -1 the
//                  other way round
//   }
// (The three fields run on a few cells out to sea, so that a value read between cells at the coast
// is the land's.)
import {noise2, fbm2} from './util.js';
import {landOf, dab, CELL} from './land.js';

const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp = x => x < 0 ? 0 : x > 1 ? 1 : x;
// a number in [0, 1) for a world and a question about it: well mixed, so that worlds next to each
// other in number answer differently
const chance = (seed, k) => { let h = Math.imul(seed + Math.imul(k, 0x9e3779b1), 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return (h >>> 0) / 4294967296; };

export const WOODED = 0.5;
export const BIOMES = ['sea', 'tundra', 'taiga', 'steppe', 'grassland', 'forest', 'desert', 'scrub', 'savanna', 'jungle', 'marsh', 'alpine'];
const B = Object.fromEntries(BIOMES.map((name, i) => [name, i]));
// Whittaker's table. Down: warmth (polar, boreal, temperate, warm, tropical); across: moisture
// (arid, dry, moist, wet). What grows there, and how much of the ground is under trees
const KINDS = [
  [B.tundra, B.tundra, B.tundra, B.tundra],
  [B.steppe, B.taiga, B.taiga, B.taiga],
  [B.steppe, B.grassland, B.forest, B.forest],
  [B.desert, B.scrub, B.forest, B.forest],
  [B.desert, B.savanna, B.jungle, B.jungle],
];
const COVER = [
  [0, 0, 0.05, 0.1],
  [0, 0.15, 0.55, 0.7],
  [0, 0.06, 0.45, 0.72],
  [0, 0.03, 0.28, 0.65],
  [0, 0.06, 0.4, 0.85],
];
const ROWS = KINDS.length - 1, COLS = KINDS[0].length - 1;
function coverAt(t, m) {
  const r = t * ROWS, c = m * COLS, r0 = Math.min(ROWS - 1, Math.floor(r)), c0 = Math.min(COLS - 1, Math.floor(c)), fr = r - r0, fc = c - c0;
  return (COVER[r0][c0] * (1 - fc) + COVER[r0][c0 + 1] * fc) * (1 - fr) + (COVER[r0 + 1][c0] * (1 - fc) + COVER[r0 + 1][c0 + 1] * fc) * fr;
}

// Lengths are in the units of the land (land.js: the world of countries' map units)
const LAPSE = 0.5;                 // how much colder the crest of a range is than the plain at its foot
const STEP = 2, REACH = 90;        // the air is followed upwind in steps of so many cells, so many steps at most
const FETCH = 6;                   // so many steps of open water fill the air with moisture
const RAIN = 0.015;                // the share of its moisture the air sheds in a step over flat land
const OROGRAPHIC = 0.75;           // ... and more where the ground rises under it, by its rise (1: plain to crest)
const RECYCLED = 0.4;              // far inland the air keeps this much: the land's own damp, breathed back
const UPSLOPE = 0.9, LEE = 0.8;    // rain falls where the air climbs, and holds off where it sinks
const RIVERSIDE = 0.34;            // the moisture a great river lends its banks

export function makeClimate(world, seed = 1) {
  const tm = globalThis.CLIMATELOG ? [['start', Date.now()]] : null, lap = name => { if (tm) tm.push([name, Date.now()]); };
  const L = landOf(world);
  if (!L) return {grid: {w: 1, h: 1, cell: 1, x0: 0, y0: 0}, temperature: new Float32Array(1), moisture: new Float32Array(1), woods: new Float32Array(1), wooded: WOODED, biome: new Uint8Array(1), biomes: BIOMES, winds: {calms: 0, front: 1, spin: 1}};
  const {grid, ids, inland, K, box} = L, {w, h, cell, x0, y0} = grid, N = w * h;
  const T = world.terrain && world.terrain.mountain.length === N ? world.terrain : null;
  const ns = seed * 7919 + 101;
  const xOf = i => (x0 + (i % w + 0.5) * cell) * K, yOf = i => (y0 - (Math.floor(i / w) + 0.5) * cell) * K;
  // how high the ground stands over the plains: 0 on them, 1 and a little more on a crest
  const height = new Float32Array(N);
  if (T) for (let i = 0; i < N; ++i) if (ids[i] >= 0) height[i] = T.mountain[i] + 0.35 * T.foot[i];

  // ---- latitude: 0 at the land's southern end, 1 at its northern (ends on a coarse lattice, so
  // a coast that moves a little moves no climate)
  const q = 8 * cell, south = Math.floor(box.minY / q) * q, north = Math.ceil(box.maxY / q) * q;
  const lat = new Float32Array(h);
  for (let j = 0; j < h; ++j) lat[j] = clamp((y0 - (j + 0.5) * cell - south) / (north - south));

  // ---- the winds. Three belts: trades from the east below `calms`, westerlies above them up to
  // `front`, easterlies beyond. Each blows a little poleward or equatorward of due east or west,
  // and bends with the country. Where two belts meet the air stands still. (Half the worlds turn
  // the other way: their west is our east.)
  const spin = chance(seed, 3) < 0.5 ? 1 : -1;
  const calms = 0.34 + 0.08 * (chance(seed, 1) - 0.5), front = 0.72 + 0.08 * (chance(seed, 2) - 0.5);
  const WIND = 4, wc = Math.ceil(w / WIND), wr = Math.ceil(h / WIND);     // the wind is kept every few cells
  const windX = new Float32Array(wc * wr), windY = new Float32Array(wc * wr), slow = new Float32Array(wc * wr), zone = new Float32Array(wc * wr);
  const westerly = l => 2 * smoothstep(calms - 0.06, calms + 0.06, l) * (1 - smoothstep(front - 0.06, front + 0.06, l)) - 1;
  for (let j = 0; j < wr; ++j) for (let i = 0; i < wc; ++i) {
    const k = j * wc + i, cj = Math.min(h - 1, j * WIND + WIND / 2);
    const x = (x0 + (i * WIND + WIND / 2) * cell) * K, y = (y0 - cj * cell) * K;
    // (the belts do not keep to a line of latitude: they wander north and south across the map)
    const l = lat[cj] + 0.07 * fbm2(x / 52, y / 52, ns + 7, 2), west = westerly(l), s = west >= 0 ? 1 : -1, d = (l - calms) / 0.14;
    const angle = Math.atan2(0.38 * s, 0.92 * s * spin) + 0.6 * noise2(x / 38, y / 38, ns + 1);
    windX[k] = Math.cos(angle); windY[k] = -Math.sin(angle);    // (rows run south)
    // still air sheds its moisture sooner
    slow[k] = 1 / Math.max(0.4, Math.abs(west));
    // by latitude: wet in the tropics and along the front, dry under the calms and in the far north
    zone[k] = 1 - 0.42 * Math.exp(-d * d) - 0.25 * smoothstep(front, 1, l);
  }
  lap('winds');

  // ---- the moisture the wind brings. From a cell of land the air is followed back upwind, to the
  // sea it came from (or as far as the air remembers); then forward again: over water it fills,
  // over land it sheds a little at every step and much where the ground rises under it. What it
  // still holds when it arrives is what the cell can hope for
  const path = new Int32Array(REACH + 2), pathWind = new Int32Array(REACH + 2);
  const follow = i => {
    let x = i % w + 0.5, y = Math.floor(i / w) + 0.5, n = 0, sea = 0, open = false;
    path[n++] = i;
    while (n <= REACH) {
      const c = ((y | 0) / WIND | 0) * wc + ((x | 0) / WIND | 0);
      x -= windX[c] * STEP; y -= windY[c] * STEP;
      if (x < 0 || y < 0 || x >= w || y >= h) { open = true; break; }
      const j = (y | 0) * w + (x | 0);
      pathWind[n] = c; path[n++] = j;
      if (ids[j] >= 0) sea = 0;
      else if (++sea >= FETCH) { open = true; break; }
    }
    let air = open ? 1 : RECYCLED, under = 0;
    for (let s = n - 1; s >= 1; --s) {
      const j = path[s];
      if (ids[j] < 0) { air += (1 - air) * 0.3; under = 0; continue; }
      const up = height[j] - under;
      under = height[j];
      air *= 1 - Math.min(0.9, (RAIN + (up > 0 ? OROGRAPHIC * up : 0)) * slow[pathWind[s]]);
      if (air < RECYCLED) air += (RECYCLED - air) * 0.08;
    }
    return air;
  };
  // (followed from every other cell of every other row, and smoothed among those: the air does
  // not keep to lines a cell wide. The cells between take the mean of the ones round them)
  const hw = (w + 1) >> 1, hh = (h + 1) >> 1, air = new Float32Array(hw * hh), on = new Int8Array(hw * hh).fill(-1);
  for (let y = 0; y < hh; ++y) for (let x = 0; x < hw; ++x) {
    const i = 2 * y * w + 2 * x;
    if (ids[i] >= 0) { air[y * hw + x] = follow(i); on[y * hw + x] = 0; }
  }
  blurLand(air, on, hw, hh, 1, 2);
  lap('air');

  // ---- moisture: what arrives, more of it where the air climbs (the ground rising along the
  // wind) and less where it sinks; and by latitude. Then the coast's own damp, the rivers' water,
  // and the weather's whims
  const moisture = new Float32Array(N);
  for (let y = 0; y < h; ++y) for (let x = 0; x < w; ++x) {
    const i = y * w + x;
    if (ids[i] < 0) continue;
    let arrive = 0, c = 0;
    for (let yy = y >> 1; yy <= (y + 1) >> 1 && yy < hh; ++yy) for (let xx = x >> 1; xx <= (x + 1) >> 1 && xx < hw; ++xx) {
      if (on[yy * hw + xx] >= 0) { arrive += air[yy * hw + xx]; c++; }
    }
    arrive = c ? arrive / c : follow(i);
    const k = (y / WIND | 0) * wc + (x / WIND | 0);
    const ux = Math.round(x - windX[k] * STEP), uy = Math.round(y - windY[k] * STEP);
    const lift = height[i] - (ux >= 0 && uy >= 0 && ux < w && uy < h ? height[uy * w + ux] : 0);
    moisture[i] = zone[k] * arrive * (lift > 0 ? 1 + UPSLOPE * lift : Math.max(0.45, 1 + LEE * lift));
  }
  const brought = Float32Array.from(moisture);
  const riverside = new Float32Array(N);
  if (T) for (const r of T.rivers) {
    let lx = Infinity, ly = Infinity;
    for (let k = 0; k < r.flow.length; ++k) {
      const x = r.points[2 * k], y = r.points[2 * k + 1], f = r.flow[k] / T.riverMin;
      if (f < 0.4 || (Math.abs(x - lx) < 0.5 * cell && Math.abs(y - ly) < 0.5 * cell)) continue;
      lx = x; ly = y;
      dab(riverside, grid, x, y, (0.8 + 0.5 * Math.sqrt(Math.min(f, 12))) / K, smoothstep(0.4, 4, f));
    }
  }
  for (let i = 0; i < N; ++i) {
    if (ids[i] < 0) continue;
    const x = xOf(i), y = yOf(i);
    moisture[i] = clamp(moisture[i] + 0.07 * (1 - smoothstep(0, 3, inland[i])) + RIVERSIDE * riverside[i] + 0.16 * fbm2(x / 21, y / 21, ns + 2, 3));
  }
  lap('moisture');

  // ---- warmth: by latitude, the isotherms bent by the country and by the sea's air (in the
  // north the coasts the wind comes to are mild, and the dry heart of a continent is harsh), and
  // colder with height
  const temperature = new Float32Array(N);
  for (let i = 0; i < N; ++i) {
    if (ids[i] < 0) continue;
    const l = lat[(i / w) | 0];
    temperature[i] = clamp(0.02 + 1.12 * (1 - l) + 0.2 * fbm2(xOf(i) / 30, yOf(i) / 30, ns + 3, 3)
      + 0.22 * (brought[i] - 0.45) * smoothstep(0.3, 0.75, l) - LAPSE * height[i]);
  }

  // ---- what grows. Woods cover the share of the ground the table gives, in patches the size of a
  // province with ragged edges: where little of the ground is theirs they are copses far apart,
  // where most of it is, forest with clearings. None above the tree line (the cold of the heights
  // sees to most of that, the bare rock to the rest)
  const woods = new Float32Array(N), biome = new Uint8Array(N);
  for (let i = 0; i < N; ++i) {
    if (ids[i] < 0) continue;
    const x = xOf(i), y = yOf(i), t = temperature[i], m = moisture[i];
    // (the patches' noise, spread evenly over 0 to 1: so the share of the ground under `cover` is `cover`)
    const patch = 1 / (1 + Math.exp(-6.75 * (fbm2(x / 9, y / 9, ns + 4, 4, 0.55) - 0.02)));
    woods[i] = clamp(0.5 + 2.2 * (coverAt(t, m) - patch)) * (T ? 1 - smoothstep(0.25, 0.6, T.mountain[i]) : 1);
    let kind = KINDS[Math.round(t * ROWS)][Math.round(m * COLS)];
    if (T && T.mountain[i] >= T.shown) kind = B.alpine;
    // marshes: low wet ground near the sea, at a river's mouth or where the land lies flat and soaked
    else if (m > 0.6 && t > 0.2 && inland[i] < 4.5 && height[i] < 0.05 && woods[i] < WOODED
      && (riverside[i] > 0.45 && inland[i] < 3.2 || noise2(x / 4.6 + 31.7, y / 4.6 - 12.3, ns + 6) > 0.42)) kind = B.marsh;
    biome[i] = kind;
  }
  lap('biomes');

  // ---- a few cells out to sea, the fields carry on as on the nearest land
  seaward([temperature, moisture, woods], ids, inland, w, h, 4);
  lap('seaward');
  if (tm) console.log('climate: ' + tm.slice(1).map(([n, t], k) => n + ' ' + (t - tm[k][1])).join(', ') + ' ms');
  return {grid, temperature, moisture, woods, wooded: WOODED, biome, biomes: BIOMES, winds: {calms, front, spin}};
}

// The field averaged over the land within `r` cells (a box, `passes` times over): the sea neither
// counts nor is written
function blurLand(field, ids, w, h, r, passes) {
  const tmp = new Float32Array(w * h), n = new Float32Array(w * h);
  for (let pass = 0; pass < passes; ++pass) {
    for (let y = 0; y < h; ++y) {
      let s = 0, c = 0;
      const row = y * w;
      for (let x = 0; x < Math.min(w, r); ++x) if (ids[row + x] >= 0) { s += field[row + x]; c++; }
      for (let x = 0; x < w; ++x) {
        if (x + r < w && ids[row + x + r] >= 0) { s += field[row + x + r]; c++; }
        if (x - r - 1 >= 0 && ids[row + x - r - 1] >= 0) { s -= field[row + x - r - 1]; c--; }
        tmp[row + x] = s; n[row + x] = c;
      }
    }
    for (let x = 0; x < w; ++x) {
      let s = 0, c = 0;
      for (let y = 0; y < Math.min(h, r); ++y) { s += tmp[y * w + x]; c += n[y * w + x]; }
      for (let y = 0; y < h; ++y) {
        if (y + r < h) { s += tmp[(y + r) * w + x]; c += n[(y + r) * w + x]; }
        if (y - r - 1 >= 0) { s -= tmp[(y - r - 1) * w + x]; c -= n[(y - r - 1) * w + x]; }
        if (ids[y * w + x] >= 0 && c > 0) field[y * w + x] = s / c;
      }
    }
  }
}

// Carries the fields `steps` cells out to sea: each ring of sea cells takes the mean of its
// neighbours that have a value already
function seaward(fields, ids, inland, w, h, steps) {
  const N = w * h, known = new Uint8Array(N), DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1];
  let ring = new Int32Array(1024), n = 0, next = new Int32Array(1024), m = 0;
  for (let i = 0; i < N; ++i) if (ids[i] >= 0) known[i] = 1;
  // (the first ring: the sea cells that touch the land, found from the land's own shore)
  for (let i = 0; i < N; ++i) {
    if (ids[i] < 0 || inland[i] > 1.5 * CELL) continue;
    const x = i % w, y = (i - x) / w;
    for (let k = 0; k < 8; ++k) {
      const xx = x + DX[k], yy = y + DY[k];
      if (xx < 0 || yy < 0 || xx >= w || yy >= h || known[yy * w + xx]) continue;
      known[yy * w + xx] = 2;
      if (n === ring.length) { const b = new Int32Array(2 * n); b.set(ring); ring = b; }
      ring[n++] = yy * w + xx;
    }
  }
  const F = fields.length, sums = new Float64Array(F);
  for (let step = 0; step < steps && n; ++step) {
    const values = new Float32Array(n * F);
    for (let r = 0; r < n; ++r) {
      const i = ring[r], x = i % w, y = (i - x) / w;
      let c = 0;
      sums.fill(0);
      for (let k = 0; k < 8; ++k) {
        const xx = x + DX[k], yy = y + DY[k];
        if (xx < 0 || yy < 0 || xx >= w || yy >= h || known[yy * w + xx] !== 1) continue;
        c++;
        for (let f = 0; f < F; ++f) sums[f] += fields[f][yy * w + xx];
      }
      for (let f = 0; f < F; ++f) values[r * F + f] = sums[f] / c;
    }
    for (let r = 0; r < n; ++r) for (let f = 0; f < F; ++f) fields[f][ring[r]] = values[r * F + f];
    for (let r = 0; r < n; ++r) known[ring[r]] = 1;
    m = 0;
    for (let r = 0; r < n; ++r) {
      const i = ring[r], x = i % w, y = (i - x) / w;
      for (let k = 0; k < 8; ++k) {
        const xx = x + DX[k], yy = y + DY[k];
        if (xx < 0 || yy < 0 || xx >= w || yy >= h || known[yy * w + xx]) continue;
        known[yy * w + xx] = 2;
        if (m === next.length) { const b = new Int32Array(2 * m); b.set(next); next = b; }
        next[m++] = yy * w + xx;
      }
    }
    [ring, next, n] = [next, ring, m];
  }
}
