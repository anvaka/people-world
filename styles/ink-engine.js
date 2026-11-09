// The inked map's engine: the survey of a world and the drawing of its tiles. It runs in the
// style's worker (on OffscreenCanvas) or, where a worker cannot draw, on the page itself.
//
// The ink is drawn in square tiles anchored to the world, one set per zoom band (each band twice
// the zoom of the one before). A tile is TILE_PX css pixels across at its band's own zoom, and is
// shown scaled between 0.71 and 1.41 times that until the zoom moves to the next band. Two layers:
//   sea   under the countries: paper grain, wave marks, rhumb lines, the hatched shore, the compass
//         rose, a ship and a serpent (the land, drawn over it, cuts all of it off at the coast)
//   land  over the countries, under the lines and names: the ribbon inside each border, rivers,
//         mountains, hills, woods, marshes and dunes
// Everything is a function of the world and the band, so a tile drawn twice is the same tile, and
// tiles drawn separately meet without a seam in their content.
import {hash, makeTerrain, smoothstep} from './ink-noise.js';
import {drawIds} from './ink-raster.js';
import {survey} from './ink-survey.js';

export const K_REF = 6;        // px per world unit of a whole-world view on a laptop
export const TILE_PX = 480;    // a tile's side in css px at its band's zoom
export const bandK = (z, dev) => K_REF * 2 ** z / dev;
export const bandOf = (k, dev) => Math.max(-6, Math.min(30, Math.round(Math.log2(k * dev / K_REF))));
const SLOTS = 7;
const RIVER_MIN = 300;         // cells of rain a river gathers before it is drawn (the same at every zoom)

// ---------------------------------------------------------------------------------------------
// The world, packed into flat arrays on the page (cheap to send) and unpacked here
export function packWorld(world, slots) {
  let items = world.items, n = items.length, rings = 0, pts = 0;
  items.forEach(it => { rings += it.country.rings.length; it.country.rings.forEach(r => { pts += r.length; }); });
  let idx = new Int32Array(n), slot = new Int8Array(n), itemStart = new Int32Array(n + 1), ringStart = new Int32Array(rings + 1), xy = new Float64Array(2 * pts);
  let ri = 0, p = 0;
  items.forEach((it, i) => {
    idx[i] = it.index; slot[i] = slots[it.index]; itemStart[i] = ri;
    for (let r of it.country.rings) { ringStart[ri++] = p; for (let [x, y] of r) { xy[2 * p] = x; xy[2 * p + 1] = y; ++p; } }
  });
  itemStart[n] = ri; ringStart[ri] = p;
  let L = world.result.lines, lp = 0;
  L.forEach(l => { lp += l.points.length; });
  let kind = new Uint8Array(L.length), a = new Int32Array(L.length), b = new Int32Array(L.length), lineStart = new Int32Array(L.length + 1), lxy = new Float64Array(2 * lp);
  p = 0;
  L.forEach((l, i) => {
    kind[i] = l.kind === 'border' ? 1 : 0; a[i] = l.a; b[i] = l.b; lineStart[i] = p;
    for (let [x, y] of l.points) { lxy[2 * p] = x; lxy[2 * p + 1] = y; ++p; }
  });
  lineStart[L.length] = p;
  let packed = {idx, slot, itemStart, ringStart, xy, kind, a, b, lineStart, lxy};
  return {packed, transfer: Object.values(packed).map(v => v.buffer)};
}
function unpackWorld(P) {
  let items = new Map(), lines = [];
  for (let i = 0; i < P.idx.length; ++i) {
    let rings = [];
    for (let r = P.itemStart[i]; r < P.itemStart[i + 1]; ++r) {
      let ring = [];
      for (let p = P.ringStart[r]; p < P.ringStart[r + 1]; ++p) ring.push([P.xy[2 * p], P.xy[2 * p + 1]]);
      rings.push(ring);
    }
    let area = Math.abs(rings.reduce((s, r) => s + ringArea(r), 0));
    items.set(P.idx[i], {index: P.idx[i], slot: P.slot[i], rings, box: boxOf(rings), size: Math.sqrt(area), bordered: false});
  }
  for (let i = 0; i < P.kind.length; ++i) {
    let points = [];
    for (let p = P.lineStart[i]; p < P.lineStart[i + 1]; ++p) points.push([P.lxy[2 * p], P.lxy[2 * p + 1]]);
    let kind = P.kind[i] ? 'border' : 'coast', a = P.a[i], b = P.b[i];
    let sizes = [a, b].filter(j => j >= 0 && items.has(j)).map(j => items.get(j).size);
    lines.push({kind, a, b, points, box: boxOf([points]), size: sizes.length ? Math.min(...sizes) : 0});
    if (kind === 'border') { if (items.has(a)) items.get(a).bordered = true; if (items.has(b)) items.get(b).bordered = true; }
  }
  return {items, lines};
}

// ---------------------------------------------------------------------------------------------
// Geometry
function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}
function boxOf(rings) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  rings.forEach(r => r.forEach(([x, y]) => { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; }));
  return b;
}
const meets = (b, x0, y0, x1, y1, m = 0) => b[2] >= x0 - m && b[0] <= x1 + m && b[3] >= y0 - m && b[1] <= y1 + m;
function simplify(points, tol, closed) {
  let n = points.length;
  if (n <= 3 || tol <= 0) return points;
  let keep = new Uint8Array(n), t2 = tol * tol, stack;
  keep[0] = keep[n - 1] = 1;
  if (closed) {
    let far = 0, at = 0;
    for (let i = 1; i < n; ++i) { let d = (points[i][0] - points[0][0]) ** 2 + (points[i][1] - points[0][1]) ** 2; if (d > far) { far = d; at = i; } }
    keep[at] = 1;
    stack = [0, at, at, n - 1];
  } else stack = [0, n - 1];
  while (stack.length) {
    let j = stack.pop(), i = stack.pop();
    let [ax, ay] = points[i], [bx, by] = points[j], dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy, worst = -1, w = -1;
    for (let m = i + 1; m < j; ++m) {
      let [px, py] = points[m];
      let t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
      let d = (ax + t * dx - px) ** 2 + (ay + t * dy - py) ** 2;
      if (d > worst) { worst = d; w = m; }
    }
    if (worst > t2) { keep[w] = 1; stack.push(i, w, w, j); }
  }
  let out = [];
  for (let m = 0; m < n; ++m) if (keep[m]) out.push(points[m]);
  return out;
}
// A uniform grid of line segments: is any line within r of a point?
function segmentGrid(lines, box) {
  let G = 0.6, x0 = box.x0 - 2, y0 = box.y0 - 2, w = Math.ceil((box.x1 - box.x0 + 4) / G);
  let cells = new Map(), segs = [];
  lines.forEach(line => {
    let p = line.points;
    for (let i = 1; i < p.length; ++i) {
      let s = segs.length;
      segs.push(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]);
      let cx0 = Math.floor((Math.min(p[i - 1][0], p[i][0]) - x0) / G), cx1 = Math.floor((Math.max(p[i - 1][0], p[i][0]) - x0) / G);
      let cy0 = Math.floor((Math.min(p[i - 1][1], p[i][1]) - y0) / G), cy1 = Math.floor((Math.max(p[i - 1][1], p[i][1]) - y0) / G);
      for (let cx = cx0; cx <= cx1; ++cx) for (let cy = cy0; cy <= cy1; ++cy) {
        let key = cy * w + cx, list = cells.get(key);
        if (!list) cells.set(key, list = []);
        list.push(s);
      }
    }
  });
  segs = new Float64Array(segs);
  return function near(x, y, r) {
    let cx0 = Math.floor((x - r - x0) / G), cx1 = Math.floor((x + r - x0) / G);
    let cy0 = Math.floor((y - r - y0) / G), cy1 = Math.floor((y + r - y0) / G), r2 = r * r;
    for (let cy = cy0; cy <= cy1; ++cy) for (let cx = cx0; cx <= cx1; ++cx) {
      let list = cells.get(cy * w + cx);
      if (!list) continue;
      for (let s of list) {
        let ax = segs[s], ay = segs[s + 1], dx = segs[s + 2] - ax, dy = segs[s + 3] - ay;
        let len = dx * dx + dy * dy, t = len ? ((x - ax) * dx + (y - ay) * dy) / len : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        let ex = ax + t * dx - x, ey = ay + t * dy - y;
        if (ex * ex + ey * ey < r2) return true;
      }
    }
    return false;
  };
}
// Point in a country, from its edges sorted into horizontal bands (made on first use)
function inCountry(item, x, y) {
  let b = item.box;
  if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) return false;
  let ix = item.pip;
  if (!ix) {
    let n = 64, hgt = (b[3] - b[1]) / n || 1, bands = Array.from({length: n}, () => []);
    for (let ring of item.rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      let y0 = Math.min(ring[i][1], ring[j][1]), y1 = Math.max(ring[i][1], ring[j][1]);
      for (let k = Math.max(0, Math.floor((y0 - b[1]) / hgt)); k <= Math.min(n - 1, Math.floor((y1 - b[1]) / hgt)); ++k)
        bands[k].push(ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
    }
    ix = item.pip = {bands: bands.map(a => new Float64Array(a)), hgt, n};
  }
  let e = ix.bands[Math.max(0, Math.min(ix.n - 1, Math.floor((y - b[1]) / ix.hgt)))], hit = false;
  for (let k = 0; k < e.length; k += 4) {
    let xj = e[k], yj = e[k + 1], xi = e[k + 2], yi = e[k + 3];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// ---------------------------------------------------------------------------------------------
// The survey's cells
function cellAt(sv, x, y) {
  let cx = Math.floor((x - sv.x0) / sv.cell), cy = Math.floor((sv.y0 - y) / sv.cell);
  return cx < 0 || cy < 0 || cx >= sv.w || cy >= sv.h ? -1 : cy * sv.w + cx;
}
function fieldAt(sv, f, x, y) {
  let fx = (x - sv.x0) / sv.cell - 0.5, fy = (sv.y0 - y) / sv.cell - 0.5;
  let cx = Math.floor(fx), cy = Math.floor(fy), tx = fx - cx, ty = fy - cy;
  if (cx < 0 || cy < 0 || cx >= sv.w - 1 || cy >= sv.h - 1) return 0;
  let i = cy * sv.w + cx, a = f[i], b = f[i + 1], c = f[i + sv.w], d = f[i + sv.w + 1];
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}
// does the rectangle hold any cell passing the test (outside the raster counts as sea)?
function anyCell(sv, x0, y0, x1, y1, test) {
  let cx0 = Math.floor((x0 - sv.x0) / sv.cell) - 1, cx1 = Math.floor((x1 - sv.x0) / sv.cell) + 1;
  let cy0 = Math.floor((sv.y0 - y1) / sv.cell) - 1, cy1 = Math.floor((sv.y0 - y0) / sv.cell) + 1;
  for (let cy = cy0; cy <= cy1; ++cy) for (let cx = cx0; cx <= cx1; ++cx) {
    let id = cx < 0 || cy < 0 || cx >= sv.w || cy >= sv.h ? -1 : sv.ids[cy * sv.w + cx];
    if (test(id)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// The engine: worlds by id, a palette, and tiles
export function createEngine(makeCanvas) {
  const worlds = new Map();
  const pals = {};

  function init(id, {packed, grid, seed, dev}) {
    let {items, lines} = unpackWorld(packed);
    let ids = grid.ids || drawIds(makeCanvas(grid.w, grid.h).getContext('2d', {willReadFrequently: true}), grid, Array.from(items.values(), it => [it.index, it.rings]));
    let sv = {...grid, ids, ...survey({...grid, ids, seed})};
    let st = {id, seed, dev, sv, items, lines, T: makeTerrain(seed), marks: new Map(), levels: new Map(), decor: null};
    st.near = segmentGrid(lines, grid.box);
    st.nearBorder = segmentGrid(lines.filter(l => l.kind === 'border'), grid.box);
    st.rivers = riverLines(st);
    worlds.set(id, st);
    while (worlds.size > 4) worlds.delete(worlds.keys().next().value);
    // the page needs the open water (to place the furniture and the seas' names) and where it is
    return {spots: sv.spots, sea: {w: sv.w, h: sv.h, cell: sv.cell, x0: sv.x0, y0: sv.y0, ids: sv.ids.slice(), toLand: sv.toLand.slice()}};
  }

  // A tile: a canvas, or null when it would be empty
  function tile(id, {layer, z, ti, tj, res, names, theme}) {
    let st = worlds.get(id);
    let pal = pals[theme];
    if (!st) throw Object.assign(new Error('unknown world'), {unknown: true});
    if (!pal) return null;
    let kb = bandK(z, st.dev), TW = TILE_PX / kb;
    let v = {st, z, kb, res, x0: ti * TW, y0: tj * TW, x1: (ti + 1) * TW, y1: (tj + 1) * TW, names: names || []};
    let sv = st.sv;
    if (layer === 'land' && !anyCell(sv, v.x0, v.y0, v.x1, v.y1, id => id !== -1)) return null;
    if (layer === 'sea' && !anyCell(sv, v.x0, v.y0, v.x1, v.y1, id => id === -1)) return null;
    let N = Math.round(TILE_PX * res), canvas = makeCanvas(N, N);
    // drawn in memory, not on the GPU: the page shows a tile as an image taken from this canvas,
    // and an image backed by a GPU texture of the worker's could come out without its alpha (black
    // where the tile is clear) or be lost with the worker's GPU context on a phone. An image in
    // memory is uploaded by the page's own compositor like any other picture.
    ctx = canvas.getContext('2d', {willReadFrequently: true});
    v.S = (x, y) => [(x - v.x0) * kb, (v.y1 - y) * kb];
    v.toPx = () => ctx.setTransform(res, 0, 0, res, 0, 0);
    v.toWorld = () => ctx.setTransform(res * kb, 0, 0, res * kb, -res * kb * v.x0, res * kb * v.y1);   // svg coords (y down)
    v.level = level(st, z, kb);
    v.inked = false;
    P = pal;
    if (layer === 'land') { ribbons(v); rivers(v); marks(v); }
    else { waves(v); rhumbs(v); shore(v); }
    ctx = null;
    return v.inked ? canvas : null;
  }

  function level(st, z, kb) {
    let lv = st.levels.get(z);
    if (lv) return lv;
    lv = {tol: 0.3 / kb, rings: new Map(), borders: new Map(), lines: new Map()};
    st.levels.set(z, lv);
    if (st.levels.size > 6) st.levels.delete(st.levels.keys().next().value);
    return lv;
  }
  const countryPath = (v, item) => {
    let lv = v.level, p = lv.rings.get(item.index);
    if (p) return p;
    p = new Path2D();
    for (let r of item.rings) { simplify(r, lv.tol, true).forEach(([x, y], k) => k ? p.lineTo(x, -y) : p.moveTo(x, -y)); p.closePath(); }
    lv.rings.set(item.index, p);
    return p;
  };
  const linePoints = (v, i) => {
    let lv = v.level, p = lv.lines.get(i);
    if (!p) lv.lines.set(i, p = simplify(v.st.lines[i].points, lv.tol, false));
    return p;
  };
  const borderPath = (v, item) => {
    let lv = v.level, p = lv.borders.get(item.index);
    if (p) return p;
    p = new Path2D();
    v.st.lines.forEach((line, i) => {
      if (line.kind !== 'border' || (line.a !== item.index && line.b !== item.index)) return;
      linePoints(v, i).forEach(([x, y], j) => j ? p.lineTo(x, -y) : p.moveTo(x, -y));
    });
    lv.borders.set(item.index, p);
    return p;
  };

  // ------------------------------------------------------------------------------- land layer
  // The ribbon: a thin stripe in a deeper shade of the realm's own paper just inside its land
  // borders, a hair of paper between it and the inked border (outline colouring)
  const RIBBON_GAP = 2.1, RIBBON_W = 1.4;
  function ribbons(v) {
    let {st, kb} = v;
    v.toWorld();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    for (let item of st.items.values()) {
      // (only round realms big enough that a ribbon does not crowd them)
      if (!item.bordered || item.size * kb < 64 || !meets(item.box, v.x0, v.y0, v.x1, v.y1, 6 / kb)) continue;
      ctx.save();
      ctx.clip(countryPath(v, item), 'evenodd');
      ctx.strokeStyle = P.band[item.slot];
      ctx.lineWidth = 2 * (RIBBON_GAP + RIBBON_W) / kb;
      ctx.stroke(borderPath(v, item));
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = 2 * RIBBON_GAP / kb;
      ctx.stroke(borderPath(v, item));
      ctx.restore();
      v.inked = true;
    }
  }

  // Rivers: blue, unbroken, swelling downstream; they keep off the borders (where a river comes
  // within a few pixels of one it is not drawn, so it can never run along a border or be taken for
  // one). The same rivers at every zoom.
  function rivers(v) {
    let {st, kb} = v, m = 4 / kb;
    let list = st.rivers.filter(r => meets(r.box, v.x0, v.y0, v.x1, v.y1, m));
    if (!list.length) return;
    v.toWorld();
    ctx.save();
    let land = new Path2D();
    // (not across a realm too small on screen: the river would cover a good part of it)
    for (let item of st.items.values()) if (item.size * kb >= 26 && meets(item.box, v.x0, v.y0, v.x1, v.y1, m)) land.addPath(countryPath(v, item));
    ctx.clip(land, 'nonzero');
    v.toPx();
    ctx.strokeStyle = P.river;
    ctx.lineCap = ctx.lineJoin = 'round';
    let gap = 3.5 / kb, width = a => Math.min(2.6, 0.7 + 0.45 * Math.log2(1 + a / RIVER_MIN));
    for (let r of list) {
      let line = r.pts, ok = line.map(([x, y]) => !st.nearBorder(x, y, gap));
      let i = 0;
      while (i < line.length - 1) {
        if (!ok[i] || !ok[i + 1]) { ++i; continue; }
        let w = width(line[i][2]), j = i + 1;
        while (j < line.length - 1 && ok[j + 1] && Math.abs(width(line[j][2]) - w) < 0.18) ++j;
        ctx.beginPath();
        for (let q = i; q <= j; ++q) { let [x, y] = v.S(line[q][0], line[q][1]); q === i ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
        ctx.lineWidth = w;
        ctx.stroke();
        v.inked = true;
        i = j;
      }
    }
    ctx.restore();
  }

  // Marks: each kind on a jittered grid in world coordinates whose step halves with every band, so
  // marks keep their size on screen; deeper in, they spread out and grow a little, and woods open
  // into clearings, so a small realm seen close is not carpeted
  const TILE = 36;
  const CLEAR_PX = 5.5;
  const KINDS = {mountain: {px: 10.5, size: 1.6, thin: 0.15}, hill: {px: 12, size: 1.1, thin: 0.3}, tree: {px: 5.2, size: 1.05, thin: 0.32}, marsh: {px: 10, size: 1, thin: 0.3}, dune: {px: 8, size: 1, thin: 0.3}};
  // (and at a whole-world view the woods are a little sparser too, so they read as woods, not smudges)
  const spread = (spec, b) => Math.min(2.4, 1 + spec.thin * Math.max(0, b - 1)) * (b <= 0 && spec === KINDS.tree ? 1.22 : 1);
  const grow = b => Math.min(1.45, 1 + 0.1 * Math.max(0, b - 1));
  const RISE = {mountain: 0.36, hill: 0.15, tree: 0.55, marsh: 0.1, dune: 0.15};
  const SALT = {mountain: 1, hill: 2, tree: 3, marsh: 4, dune: 5};

  function markTile(st, kind, b, ti, tj) {
    let key = kind + b + ':' + ti + ':' + tj, out = st.marks.get(key);
    if (out) return out;
    let sv = st.sv, T = st.T, spec = KINDS[kind], kb = bandK(b, st.dev);
    let h = spec.px * spread(spec, b) / kb, size = spec.size * spec.px * grow(b) / kb;
    let clear = size * 0.62 + CLEAR_PX / kb, rise = RISE[kind], F = sv.fields;
    out = [];
    for (let i = ti * TILE; i < (ti + 1) * TILE; ++i) for (let j = tj * TILE; j < (tj + 1) * TILE; ++j) {
      let r1 = hash(i, j, b * 8 + SALT[kind], st.seed), r2 = hash(j, i, b * 8 + SALT[kind], st.seed + 1);
      let x = (i + 0.5 + (r1 - 0.5) * 0.8) * h, y = (j + 0.5 + (r2 - 0.5) * 0.8) * h;
      let my = y + rise * size;
      let c = cellAt(sv, x, my);
      if (c < 0 || sv.ids[c] === -1) continue;
      let inland = sv.toSea[c] * sv.cell, s = 1, at = f => fieldAt(sv, f, x, y);
      if (kind === 'mountain') {
        if (inland < 1) continue;
        let M = at(F.mountain) * smoothstep(1.0, 3.5, inland);
        if (M < 0.6) continue;
        s = 0.7 + 0.65 * smoothstep(0.6, 0.97, M);
      } else if (kind === 'hill') {
        if (at(F.hill) * smoothstep(0.6, 2, inland) < 0.36) continue;
        if (at(F.mountain) * smoothstep(1.0, 3.5, inland) >= 0.6) continue;
        s = 0.8 + 0.3 * r1;
      } else if (kind === 'tree') {
        if (at(F.forest) < 0.04 || at(F.dry) > 0.2 || at(F.hill) > 0.36) continue;
        if (at(F.mountain) * smoothstep(1.0, 3.5, inland) > 0.3) continue;
        // clearings at the scale of the screen, deeper in
        if (b >= 2 && T.noise(x * kb / 70 + 7.7, y * kb / 70 - 3.1) < -0.12) continue;
        s = 0.85 + 0.3 * r2;
      } else if (kind === 'marsh') {
        if (inland > 4 || at(F.wet) < 0.3 || at(F.forest) > 0.1 || at(F.mountain) > 0.15) continue;
      } else if (kind === 'dune') {
        if (inland < 2.5 || at(F.dry) < 0.22 || at(F.forest) > 0.0 || at(F.mountain) > 0.3) continue;
      }
      // not on a river, nor right beside one
      if (kind !== 'mountain' && nearRiver(sv, c)) continue;
      // in one country, clear of its borders and coasts
      let id = sv.ids[c];
      if (!(id >= 0 && (sv.toEdge[c] - 1.5) * sv.cell > clear)) {
        if (st.near(x, my, clear)) continue;
        id = id >= 0 && sv.toEdge[c] >= 1 ? id : countryNear(st, c, x, my);
        if (id < 0) continue;
      }
      let item = st.items.get(id);
      // a realm too small on screen keeps its paper plain (a mark would cover a good part of it)
      if (!item || item.size * kb < 26) continue;
      out.push({x, y, kind, s: size * s, v: r1, w: r2, slot: item.slot, cold: y + 16 * T.noise(x / 13 + 4.1, y / 13 - 2.7) > 27});
    }
    st.marks.set(key, out);
    if (st.marks.size > 3000) st.marks.delete(st.marks.keys().next().value);
    return out;
  }
  function nearRiver(sv, c) {
    let a = sv.acc, w = sv.w;
    return a[c] >= RIVER_MIN || a[c - 1] >= RIVER_MIN || a[c + 1] >= RIVER_MIN || a[c - w] >= RIVER_MIN || a[c + w] >= RIVER_MIN;
  }
  function countryNear(st, c, x, y) {
    let sv = st.sv, seen = new Set();
    for (let dy = -1; dy <= 1; ++dy) for (let dx = -1; dx <= 1; ++dx) {
      let id = sv.ids[c + dy * sv.w + dx];
      if (id >= 0 && !seen.has(id)) {
        seen.add(id);
        let item = st.items.get(id);
        if (item && inCountry(item, x, y)) return id;
      }
    }
    for (let item of st.items.values()) if (inCountry(item, x, y)) return item.index;
    return -1;
  }

  function marks(v) {
    let {st, z, kb} = v, list = [];
    for (let kind in KINDS) {
      let spec = KINDS[kind], h = spec.px * spread(spec, z) / kb, span = TILE * h, pad = 2.5 * spec.size * spec.px * grow(z) / kb;
      for (let ti = Math.floor((v.x0 - pad) / span); ti <= Math.floor((v.x1 + pad) / span); ++ti)
        for (let tj = Math.floor((v.y0 - pad) / span); tj <= Math.floor((v.y1 + pad) / span); ++tj)
          for (let g of markTile(st, kind, z, ti, tj)) if (g.x > v.x0 - pad && g.x < v.x1 + pad && g.y > v.y0 - pad && g.y < v.y1 + pad) list.push(g);
    }
    if (!list.length) return;
    // back (top) to front, the same order in every tile
    list.sort((a, b) => b.y - a.y || a.x - b.x);
    // the marks give way to the names: one whose footprint would touch a name is left out
    let names = v.names;
    let clearOfNames = (x, y, s) => {
      for (let n of names) {
        if (x < n.box[0] - s || x > n.box[2] + s || y < n.box[1] - s || y > n.box[3] + s) continue;
        for (let i = 1; i < n.pts.length; ++i) {
          let [ax, ay] = n.pts[i - 1], [bx, by] = n.pts[i], dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
          let t = l ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l)) : 0;
          if (Math.hypot(ax + t * dx - x, ay + t * dy - y) < n.r + s * 0.55) return false;
        }
      }
      return true;
    };
    v.toPx();
    let dark = P.dark;
    if (dark) ctx.globalAlpha = 0.82;
    let trees = null, treeY = -Infinity;
    let flushTrees = () => {
      if (!trees || !trees.n) return;
      // each crown clears the ink under it, so the realm's own paper shows there
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fill(trees.fill);
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = P.ink;
      ctx.lineWidth = Math.max(0.6, Math.min(0.85, 0.4 + trees.s * 0.07));
      ctx.stroke(trees.line);
      ctx.lineWidth = 0.55;
      ctx.stroke(trees.shade);
      trees = null;
    };
    let flat = new Path2D(), dots = new Path2D();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let g of list) {
      if (names.length && !clearOfNames(g.x, g.y + RISE[g.kind] * g.s, g.s)) continue;
      let [x, y] = v.S(g.x, g.y), s = g.s * kb;
      v.inked = true;
      if (g.kind === 'tree') {
        if (!trees || y - treeY > s * 0.35) { flushTrees(); trees = {fill: new Path2D(), line: new Path2D(), shade: new Path2D(), n: 0, s}; treeY = y; }
        tree(x, y, s, g, trees, dark);
        trees.n++;
        continue;
      }
      flushTrees();
      if (g.kind === 'mountain') mountain(x, y, s, g, dark);
      else if (g.kind === 'hill') hill(x, y, s, g, dark);
      else if (g.kind === 'marsh') marsh(x, y, s, g, flat);
      else dune(x, y, s, g, flat, dots);
    }
    flushTrees();
    ctx.strokeStyle = P.ink;
    ctx.lineWidth = 0.75;
    ctx.stroke(flat);
    ctx.fillStyle = P.ink;
    ctx.fill(dots);
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------------------- sea layer
  // A scatter of wave marks far from land: three crests and a shorter one under them
  function waves(v) {
    let {st, kb} = v, sv = st.sv, h = 70 / kb, path = new Path2D(), any = false;
    let z = v.z;
    for (let i = Math.floor(v.x0 / h) - 1; i <= Math.ceil(v.x1 / h); ++i) for (let j = Math.floor(v.y0 / h) - 1; j <= Math.ceil(v.y1 / h); ++j) {
      let r1 = hash(i, j, z, st.seed + 9), r2 = hash(j, i, z, st.seed + 10);
      if (r1 < 0.72) continue;   // a sparse scatter: the sea is a quiet ground
      let x = (i + r1) * h, y = (j + r2) * h, c = cellAt(sv, x, y);
      if (c >= 0 && (sv.ids[c] !== -1 || sv.toLand[c] * sv.cell * kb < 22)) continue;
      if (st.decor && st.decor.clear.some(([cx, cy, r]) => Math.hypot(cx - x, cy - y) < r / kb + 14 / kb)) continue;
      let [sx, sy] = v.S(x, y), w = 3 + 1.5 * r2;
      path.moveTo(sx - 3 * w, sy);
      for (let q = 0; q < 3; ++q) path.quadraticCurveTo(sx - 3 * w + (2 * q + 1) * w, sy + (q % 2 ? 1 : -1) * w * 0.5, sx - 3 * w + (2 * q + 2) * w, sy);
      path.moveTo(sx - 1.5 * w, sy + w * 1.1);
      path.quadraticCurveTo(sx - 0.5 * w, sy + w * 0.6, sx + 0.5 * w, sy + w * 1.1);
      any = true;
    }
    if (!any) return;
    v.toPx();
    ctx.strokeStyle = P.wave;
    ctx.lineWidth = 0.75;
    ctx.lineCap = 'round';
    ctx.stroke(path);
    v.inked = true;
  }

  // Rhumb lines from the rose, over the whole sea; the land drawn over them stops them at the coast
  function rhumbs(v) {
    let d = v.st.decor;
    if (!d || !d.rose) return;
    let [cx, cy] = v.S(d.rose.x, d.rose.y), r = roseRadius(d.rose, v.kb), far = 4000;
    // the eight winds only: thirty-two lines across the whole sea made the map busy
    let main = new Path2D();
    for (let i = 0; i < 8; ++i) {
      let a = i * Math.PI / 4;
      // (from inside the rose's disc: the rose, an image over the sea tiles, covers their start)
      main.moveTo(cx + Math.cos(a) * r * 0.6, cy + Math.sin(a) * r * 0.6);
      main.lineTo(cx + Math.cos(a) * far, cy + Math.sin(a) * far);
    }
    v.toPx();
    ctx.strokeStyle = P.rhumb;
    ctx.lineWidth = 0.7;
    ctx.stroke(main);
    v.inked = true;
  }

  // The shore: short strokes standing out from the coast into the sea, longer where the coast is
  // long and open. Each is drawn across the coast; the land, drawn over the layer, hides the inner half.
  // Only round land big enough on screen: around a small island the strokes made a burr, not a coast.
  function shore(v) {
    let {st, kb} = v, path = new Path2D(), any = false, m = 10 / kb;
    st.lines.forEach((line, i) => {
      if (line.kind !== 'coast' || line.size * kb < 40 || !meets(line.box, v.x0, v.y0, v.x1, v.y1, m)) return;
      let pts = linePoints(v, i), step = 2.4, carry = 0;
      let L = Math.min(4.5, 1.6 + 0.03 * line.size * kb);
      for (let j = 1; j < pts.length; ++j) {
        let [ax, ay] = v.S(pts[j - 1][0], pts[j - 1][1]), [bx, by] = v.S(pts[j][0], pts[j][1]);
        let dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
        if (!len) continue;
        let nx = -dy / len, ny = dx / len;
        let inside = !(Math.max(ax, bx) < -L - 2 || Math.min(ax, bx) > TILE_PX + L + 2 || Math.max(ay, by) < -L - 2 || Math.min(ay, by) > TILE_PX + L + 2);
        for (let t = step - carry; t <= len; t += step) {
          if (!inside) continue;
          let px = ax + dx * t / len, py = ay + dy * t / len;
          let wx = pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * t / len, wy = pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * t / len;
          let f = 0.62 + 0.5 * st.T.noise(wx * 0.9, wy * 0.9) + 0.12 * st.T.noise(wx * 5, wy * 5);
          let l = L * Math.max(0.3, f);
          path.moveTo(px - nx * l, py - ny * l);
          path.lineTo(px + nx * l, py + ny * l);
          any = true;
        }
        carry = (carry + len) % step;
      }
    });
    if (!any) return;
    v.toPx();
    ctx.strokeStyle = P.shore;
    ctx.lineWidth = 0.55;
    ctx.lineCap = 'round';
    ctx.stroke(path);
    v.inked = true;
  }

  return {
    init, tile,
    palette(p) { pals[p.theme] = p; },
    decor(id, d) { let st = worlds.get(id); if (st) st.decor = d; },
    drop(id) { worlds.delete(id); },
  };
}
export const roseRadius = (spot, k) => Math.max(24, Math.min(spot.d * 0.7 * k, 60));
export const vignetteSize = (spot, k) => Math.max(16, Math.min(spot.d * 0.55 * k, 36));

// ---------------------------------------------------------------------------------------------
// Rivers: the cells that gather enough rain, from their heads down to the sea, smoothed
function riverLines(st) {
  let sv = st.sv, acc = new Float32Array(sv.w * sv.h);
  for (let i = 0; i < sv.river.cell.length; ++i) acc[sv.river.cell[i]] = sv.river.acc[i];
  sv.acc = acc;
  let recv = new Map(), up = new Map();
  for (let i = 0; i < sv.river.cell.length; ++i) {
    if (sv.river.acc[i] < RIVER_MIN) continue;
    let c = sv.river.cell[i], r = sv.river.recv[i];
    recv.set(c, r);
    up.set(r, (up.get(r) || 0) + 1);
  }
  let heads = [...recv.keys()].filter(c => !up.has(c)).sort((a, b) => a - b);
  let seen = new Set(), lines = [];
  let pos = c => { let cx = c % sv.w, cy = (c - cx) / sv.w; return [sv.x0 + (cx + 0.5) * sv.cell, sv.y0 - (cy + 0.5) * sv.cell]; };
  for (let head of heads) {
    let pts = [], c = head;
    while (true) {
      pts.push([...pos(c), acc[c] || RIVER_MIN]);
      if (seen.has(c)) break;
      seen.add(c);
      let r = recv.get(c);
      if (r === undefined || r < 0) break;
      if (!recv.has(r)) { pts.push([...pos(r), acc[c]]); break; }
      c = r;
    }
    if (pts.length < 4) continue;
    let smooth = smoothRiver(pts, st.T, sv.cell);
    lines.push({pts: smooth, box: boxOf([smooth])});
  }
  return lines;
}
function smoothRiver(pts, T, cell) {
  let out = pts.map(([x, y, a], i) => {
    if (i === 0 || i === pts.length - 1) return [x, y, a];
    let n = T.noise(x / 1.3 + 50, y / 1.3 - 20) * cell * 0.45;
    let [px, py] = pts[i - 1], [qx, qy] = pts[i + 1], dx = qx - px, dy = qy - py, l = Math.hypot(dx, dy) || 1;
    return [x - dy / l * n, y + dx / l * n, a];
  });
  for (let it = 0; it < 3; ++it) {
    let next = [out[0]];
    for (let i = 0; i < out.length - 1; ++i) {
      let [ax, ay, aa] = out[i], [bx, by, ba] = out[i + 1];
      next.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by, aa], [0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by, ba]);
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The marks, in css px of the tile (y down), drawn on the tile's context
let ctx = null, P = null;
function clearShape() {
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}
// A mountain: two slopes meeting at a peak a little off centre, its inside cleared to the paper so
// it hides the ones behind, the shaded face hatched with strokes falling from the slope parallel to
// the lit one. By night the lit face is hatched, in pale ink: on dark paper the pen draws light.
function mountain(x, y, s, g, dark) {
  let w = s, h = s * (0.5 + 0.26 * g.w);
  let px = x + (g.v - 0.5) * 0.24 * w, py = y - h, lx = x - w / 2, rx = x + w / 2;
  let lcx = lx + (px - lx) * 0.62, lcy = y - h * 0.38, rcx = px + (rx - px) * 0.38, rcy = y - h * 0.38;
  ctx.beginPath();
  ctx.moveTo(lx, y); ctx.quadraticCurveTo(lcx, lcy, px, py); ctx.quadraticCurveTo(rcx, rcy, rx, y); ctx.closePath();
  clearShape();
  ctx.beginPath();
  ctx.moveTo(lx, y); ctx.quadraticCurveTo(lcx, lcy, px, py); ctx.quadraticCurveTo(rcx, rcy, rx, y);
  ctx.strokeStyle = P.ink;
  ctx.lineWidth = Math.min(1.35, 0.7 + s * 0.03);
  ctx.stroke();
  let n = Math.max(2, Math.min(6, Math.round(s / 3.4)));
  let q = (t, ax, ay, cx, cy, bx, by) => [(1 - t) * (1 - t) * ax + 2 * t * (1 - t) * cx + t * t * bx, (1 - t) * (1 - t) * ay + 2 * t * (1 - t) * cy + t * t * by];
  let dx = dark ? rx - px : lx - px, dy = y - py, dl = Math.hypot(dx, dy);
  dx /= dl; dy /= dl;
  ctx.beginPath();
  for (let i = 0; i < n; ++i) {
    let t = 0.14 + 0.78 * (i + 0.5) / n;
    let [sx, sy] = dark ? q(1 - t, lx, y, lcx, lcy, px, py) : q(t, px, py, rcx, rcy, rx, y);
    let across = Math.abs(sx - px) * (0.8 - 0.25 * t), len = Math.min(across / Math.abs(dx), (y - sy) / dy * 0.9);
    if (len < 1) continue;
    ctx.moveTo(sx, sy + 0.2);
    ctx.lineTo(sx + dx * len, sy + 0.2 + dy * len);
  }
  ctx.lineWidth = 0.6;
  ctx.stroke();
}
// A hill: a low dome with a few strokes of shade at its foot
function hill(x, y, s, g, dark) {
  let w = s, h = s * (0.32 + 0.12 * g.w);
  ctx.beginPath();
  ctx.moveTo(x - w / 2, y); ctx.quadraticCurveTo(x - w * 0.05, y - 2 * h, x + w / 2, y); ctx.closePath();
  clearShape();
  ctx.beginPath();
  ctx.moveTo(x - w / 2, y); ctx.quadraticCurveTo(x - w * 0.05, y - 2 * h, x + w / 2, y);
  let side = dark ? -1 : 1;
  for (let i = 0; i < 3; ++i) {
    let tx = x + side * w * (0.12 + 0.13 * i), top = y - h * (0.85 - 0.25 * i);
    ctx.moveTo(tx, top + h * 0.15);
    ctx.lineTo(tx - side * w * 0.06, y - 0.3);
  }
  ctx.strokeStyle = P.ink;
  ctx.lineWidth = 0.75;
  ctx.stroke();
}
// A tree: a rounded crown on a short trunk, or in the north a fir with two tiers of boughs. Woods
// are drawn in bands from the back, so the trees in front hide the feet of those behind.
function tree(x, y, s, g, T, dark) {
  let f = T.fill, side = dark ? -1 : 1;
  if (g.cold && s < 6) {
    let h = s * 1.3, half = s * 0.34, foot = y - s * 0.16;
    f.moveTo(x, foot - h * 0.84); f.lineTo(x + half, foot); f.lineTo(x - half, foot); f.closePath();
    T.line.moveTo(x - half, foot); T.line.lineTo(x, foot - h * 0.84); T.line.lineTo(x + half, foot);
    T.line.moveTo(x, foot); T.line.lineTo(x, y);
    return;
  }
  if (g.cold) {
    let h = s * 1.35, half = s * 0.4, foot = y - s * 0.16, mid = foot - h * 0.42;
    let pts = [[x, foot - h * 0.84], [x + half * 0.62, mid], [x + half * 0.28, mid - h * 0.02], [x + half, foot], [x - half, foot], [x - half * 0.28, mid - h * 0.02], [x - half * 0.62, mid]];
    pts.forEach(([px, py], i) => i ? f.lineTo(px, py) : f.moveTo(px, py));
    f.closePath();
    T.line.moveTo(x - half, foot);
    [5, 6, 0, 1, 2, 3].forEach(i => T.line.lineTo(pts[i][0], pts[i][1]));
    T.line.moveTo(x, foot); T.line.lineTo(x, y);
    if (s < 5.5) return;
    T.shade.moveTo(x + side * half * 0.15, mid + h * 0.05); T.shade.lineTo(x + side * half * 0.55, foot - 0.5);
    T.shade.moveTo(x + side * half * 0.1, foot - h * 0.66); T.shade.lineTo(x + side * half * 0.35, mid - 0.3);
    return;
  }
  let r = s * 0.5 * (0.9 + 0.2 * g.v), cy = y - s * 0.22 - r * 0.8;
  f.moveTo(x - r, cy + r * 0.55);
  f.bezierCurveTo(x - r * 1.15, cy - r * 0.6, x - r * 0.2, cy - r * 1.25, x + r * 0.15, cy - r * 0.9);
  f.bezierCurveTo(x + r * 0.9, cy - r * 1.2, x + r * 1.25, cy - r * 0.1, x + r, cy + r * 0.55);
  f.closePath();
  T.line.moveTo(x - r, cy + r * 0.55);
  T.line.bezierCurveTo(x - r * 1.15, cy - r * 0.6, x - r * 0.2, cy - r * 1.25, x + r * 0.15, cy - r * 0.9);
  T.line.bezierCurveTo(x + r * 0.9, cy - r * 1.2, x + r * 1.25, cy - r * 0.1, x + r, cy + r * 0.55);
  T.line.moveTo(x, cy + r * 0.5); T.line.lineTo(x, y);
  if (s < 5.5) return;
  T.shade.moveTo(x + side * r * 0.75, cy - r * 0.05);
  T.shade.quadraticCurveTo(x + side * r * 0.65, cy + r * 0.4, x + side * r * 0.25, cy + r * 0.55);
}
// A marsh: tufts of reeds over short level strokes of water
function marsh(x, y, s, g, F) {
  let w = s * 0.9;
  F.moveTo(x - w / 2, y); F.lineTo(x + w / 2, y);
  F.moveTo(x - w * 0.25 + g.v * 2, y + s * 0.22); F.lineTo(x + w * 0.3 + g.v * 2, y + s * 0.22);
  for (let i = -1; i <= 1; ++i) { F.moveTo(x + i * s * 0.1, y - 0.5); F.lineTo(x + i * s * 0.2, y - s * (i ? 0.32 : 0.42)); }
}
// Dunes: a ridge of sand with its slip face stippled
function dune(x, y, s, g, F, dots) {
  F.moveTo(x - s / 2, y);
  F.quadraticCurveTo(x - s * 0.1, y - s * 0.42, x + s / 2, y);
  for (let i = 0; i < 3; ++i) {
    let dx = (hash(i, 3, g.v * 1e6 | 0, 1) - 0.5) * s, dy = hash(i, 5, g.w * 1e6 | 0, 2) * s * 0.4;
    dots.moveTo(x + dx + 0.5, y + dy); dots.arc(x + dx, y + dy, 0.5, 0, 2 * Math.PI);
  }
}

// The compass rose: thirty-two points, the cardinal ones long, each split into a dark half and a
// light half, inside a ring of ticks, north marked with a lily
function rose(x, y, r) {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineJoin = 'miter';
  let light = P.dark ? P.sea : P.roseFill;
  ctx.fillStyle = P.sea;
  ctx.beginPath(); ctx.arc(0, 0, r * 0.98, 0, 2 * Math.PI); ctx.fill();
  ctx.strokeStyle = P.ink;
  ctx.lineWidth = 1.1; ctx.beginPath(); ctx.arc(0, 0, r * 0.92, 0, 2 * Math.PI); ctx.stroke();
  ctx.lineWidth = 0.6; ctx.beginPath(); ctx.arc(0, 0, r * 0.84, 0, 2 * Math.PI); ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < 64; ++i) {
    let a = i * Math.PI / 32, r0 = i % 8 === 0 ? r * 0.76 : i % 2 === 0 ? r * 0.8 : r * 0.82;
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); ctx.lineTo(Math.cos(a) * r * 0.84, Math.sin(a) * r * 0.84);
  }
  ctx.lineWidth = 0.5; ctx.stroke();
  let point = (a, len, wd) => {
    let c = Math.cos(a), s = Math.sin(a), nx = -s, ny = c;
    ctx.beginPath(); ctx.moveTo(c * len, s * len); ctx.lineTo(nx * wd, ny * wd); ctx.lineTo(0, 0); ctx.closePath();
    ctx.fillStyle = P.ink; ctx.fill();
    ctx.beginPath(); ctx.moveTo(c * len, s * len); ctx.lineTo(-nx * wd, -ny * wd); ctx.lineTo(0, 0); ctx.closePath();
    ctx.fillStyle = light; ctx.fill();
    ctx.lineWidth = 0.6; ctx.strokeStyle = P.ink;
    ctx.beginPath(); ctx.moveTo(-nx * wd, -ny * wd); ctx.lineTo(c * len, s * len); ctx.lineTo(nx * wd, ny * wd); ctx.stroke();
  };
  for (let i = 0; i < 16; ++i) if (i % 2) point(i * Math.PI / 8 - Math.PI / 2, r * 0.5, r * 0.05);
  for (let i = 0; i < 4; ++i) point(i * Math.PI / 2 + Math.PI / 4 - Math.PI / 2, r * 0.7, r * 0.08);
  for (let i = 0; i < 4; ++i) point(i * Math.PI / 2 - Math.PI / 2, r * 1.12, r * 0.12);
  ctx.beginPath(); ctx.arc(0, 0, r * 0.07, 0, 2 * Math.PI); ctx.fillStyle = light; ctx.fill(); ctx.lineWidth = 0.7; ctx.stroke();
  ctx.translate(0, -r * 1.24);
  let u = r * 0.012;
  ctx.beginPath();
  ctx.moveTo(0, -14 * u); ctx.bezierCurveTo(5 * u, -9 * u, 5 * u, -3 * u, 0, 1 * u); ctx.bezierCurveTo(-5 * u, -3 * u, -5 * u, -9 * u, 0, -14 * u);
  ctx.moveTo(1 * u, 0); ctx.bezierCurveTo(5 * u, -2 * u, 10 * u, -2 * u, 11 * u, -8 * u); ctx.bezierCurveTo(13 * u, -2 * u, 8 * u, 3 * u, 1 * u, 2.5 * u); ctx.closePath();
  ctx.moveTo(-1 * u, 0); ctx.bezierCurveTo(-5 * u, -2 * u, -10 * u, -2 * u, -11 * u, -8 * u); ctx.bezierCurveTo(-13 * u, -2 * u, -8 * u, 3 * u, -1 * u, 2.5 * u); ctx.closePath();
  ctx.rect(-6 * u, 3 * u, 12 * u, 2 * u);
  ctx.fillStyle = P.ink; ctx.fill();
  ctx.restore();
}
// A ship under sail: a round-bellied hull, two masts with full sails, a pennant, the sea at her bow
function ship(x, y, r, dir) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(dir * r / 30, r / 30);
  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.strokeStyle = P.ink;
  let light = P.dark ? P.sea : P.roseFill;
  ctx.beginPath();
  ctx.moveTo(-30, -8); ctx.lineTo(-22, -6); ctx.lineTo(18, -6); ctx.lineTo(30, -11);
  ctx.bezierCurveTo(27, 0, 20, 6, 8, 7); ctx.lineTo(-18, 7); ctx.bezierCurveTo(-26, 5, -29, 0, -30, -8); ctx.closePath();
  ctx.fillStyle = light; ctx.fill(); ctx.lineWidth = 1.6; ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < 4; ++i) { let yy = -3 + i * 2.6; ctx.moveTo(-26 + i * 1.5, yy); ctx.lineTo(24 - i * 3.5, yy); }
  ctx.lineWidth = 0.8; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-8, -6); ctx.lineTo(-8, -50); ctx.moveTo(12, -6); ctx.lineTo(12, -40); ctx.moveTo(-22, -7); ctx.lineTo(-24, -30);
  ctx.lineWidth = 1.3; ctx.stroke();
  let sail = (x0, top, bottom, wdt, belly) => {
    ctx.beginPath();
    ctx.moveTo(x0 - wdt / 2, top); ctx.quadraticCurveTo(x0, top - 2, x0 + wdt / 2, top);
    ctx.quadraticCurveTo(x0 + wdt / 2 + belly, (top + bottom) / 2, x0 + wdt / 2, bottom);
    ctx.quadraticCurveTo(x0, bottom + 2, x0 - wdt / 2, bottom);
    ctx.quadraticCurveTo(x0 - wdt / 2 + belly, (top + bottom) / 2, x0 - wdt / 2, top);
    ctx.closePath();
    ctx.fillStyle = light; ctx.fill(); ctx.lineWidth = 1.1; ctx.stroke();
    ctx.beginPath();
    for (let i = 1; i <= 2; ++i) { let xx = x0 + wdt / 2 - i * 3; ctx.moveTo(xx, top + 3); ctx.quadraticCurveTo(xx + belly * 0.8, (top + bottom) / 2, xx, bottom - 3); }
    ctx.lineWidth = 0.6; ctx.stroke();
  };
  sail(-8, -47, -31, 22, 5); sail(-8, -28, -11, 26, 6);
  sail(12, -37, -24, 16, 4); sail(12, -21, -10, 19, 5);
  ctx.beginPath(); ctx.moveTo(-24, -28); ctx.lineTo(-32, -12); ctx.lineTo(-23, -12); ctx.closePath();
  ctx.fillStyle = light; ctx.fill(); ctx.lineWidth = 1; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-8, -50); ctx.quadraticCurveTo(-2, -53, 6, -50); ctx.lineTo(-8, -47);
  ctx.fillStyle = P.accent; ctx.fill(); ctx.lineWidth = 0.7; ctx.stroke();
  ctx.beginPath();
  for (let i = -3; i <= 3; ++i) { let xx = i * 11; ctx.moveTo(xx - 6, 10 + Math.abs(i)); ctx.quadraticCurveTo(xx - 1, 6 + Math.abs(i), xx + 5, 10 + Math.abs(i)); }
  ctx.moveTo(30, -8); ctx.quadraticCurveTo(36, -4, 40, 2);
  ctx.lineWidth = 0.9; ctx.stroke();
  ctx.restore();
}
// A sea serpent: two coils of its back out of the water, scaled and finned, a long head with a
// curled crest, the tail's fluke, and ripples where it breaks the surface
function serpent(x, y, r, dir) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(dir * r / 30, r / 30);
  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.strokeStyle = P.ink;
  let light = P.dark ? P.sea : P.roseFill;
  let coil = (cx, wdt, ht, thick) => {
    ctx.beginPath();
    ctx.moveTo(cx - wdt / 2, 0);
    ctx.bezierCurveTo(cx - wdt / 2, -ht * 1.3, cx + wdt / 2, -ht * 1.3, cx + wdt / 2, 0);
    ctx.lineTo(cx + wdt / 2 - thick, 0);
    ctx.bezierCurveTo(cx + wdt / 2 - thick, -(ht - thick) * 1.3, cx - wdt / 2 + thick, -(ht - thick) * 1.3, cx - wdt / 2 + thick, 0);
    ctx.closePath();
    ctx.fillStyle = light; ctx.fill(); ctx.lineWidth = 1.3; ctx.stroke();
    ctx.beginPath();
    for (let i = 1; i < 6; ++i) {
      let a = Math.PI * (1 - i / 6);
      let ox = cx + Math.cos(a) * wdt / 2 * 0.98, oy = -Math.sin(a) * ht * 0.98;
      let ix = cx + Math.cos(a) * (wdt / 2 - thick) * 1.02, iy = -Math.sin(a) * (ht - thick) * 1.02;
      ctx.moveTo(ox, oy); ctx.lineTo(ix * 0.5 + ox * 0.5, iy * 0.5 + oy * 0.5);
    }
    ctx.lineWidth = 0.7; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - wdt * 0.18, -ht * 0.97); ctx.lineTo(cx - wdt * 0.05, -ht * 1.35); ctx.lineTo(cx + wdt * 0.02, -ht * 0.99);
    ctx.lineTo(cx + wdt * 0.12, -ht * 1.28); ctx.lineTo(cx + wdt * 0.2, -ht * 0.93);
    ctx.fillStyle = light; ctx.fill(); ctx.lineWidth = 0.8; ctx.stroke();
  };
  coil(-26, 18, 11, 5); coil(-4, 20, 14, 5.5);
  ctx.beginPath();
  ctx.moveTo(10, 0); ctx.bezierCurveTo(10, -18, 14, -30, 24, -32);
  ctx.bezierCurveTo(30, -33, 36, -31, 40, -27); ctx.lineTo(33, -25); ctx.bezierCurveTo(36, -23, 37, -21, 35, -20);
  ctx.bezierCurveTo(30, -22, 26, -24, 23, -22); ctx.bezierCurveTo(20, -14, 18, -6, 17, 0); ctx.closePath();
  ctx.fillStyle = light; ctx.fill(); ctx.lineWidth = 1.3; ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(22, -32); ctx.quadraticCurveTo(16, -40, 20, -44); ctx.quadraticCurveTo(21, -38, 26, -34);
  ctx.moveTo(19, -31); ctx.quadraticCurveTo(12, -34, 12, -39);
  ctx.lineWidth = 0.9; ctx.stroke();
  ctx.beginPath(); ctx.arc(29, -29, 1.1, 0, 2 * Math.PI); ctx.fillStyle = P.ink; ctx.fill();
  ctx.beginPath();
  for (let i = 0; i < 5; ++i) { let yy = -4 - i * 5; ctx.moveTo(11 + i * 0.6, yy); ctx.lineTo(14 + i * 0.6, yy - 1.5); }
  ctx.lineWidth = 0.6; ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-40, 0); ctx.quadraticCurveTo(-44, -6, -50, -12); ctx.quadraticCurveTo(-46, -5, -52, -3); ctx.quadraticCurveTo(-45, -2, -38, 0); ctx.closePath();
  ctx.fillStyle = light; ctx.fill(); ctx.lineWidth = 1.1; ctx.stroke();
  ctx.beginPath();
  for (let xx of [-48, -36, -26, -14, 7, 20]) { ctx.moveTo(xx - 5, 2.5); ctx.quadraticCurveTo(xx, -0.5, xx + 5, 2.5); }
  ctx.moveTo(-42, 6); ctx.lineTo(-30, 6); ctx.moveTo(-10, 6); ctx.lineTo(4, 6); ctx.moveTo(12, 6); ctx.lineTo(22, 6);
  ctx.lineWidth = 0.8; ctx.stroke();
  ctx.restore();
}

// The paper's grain: a tile of fine grain, fibres and faint mottling (laid under the sea by the
// page, as the background of the map's plate, so it travels with the map)
export function grainTile(canvas, dark) {
  const N = canvas.width = canvas.height = 256;
  let g = canvas.getContext('2d');
  let img = g.createImageData(N, N), d = img.data;
  let {noise} = makeTerrain(4242);
  for (let y = 0; y < N; ++y) for (let x = 0; x < N; ++x) {
    let i = 4 * (y * N + x), a = x / N * 2 * Math.PI, b = y / N * 2 * Math.PI;
    let m = 0.6 * noise(Math.cos(a) * 1.3 + 7, Math.sin(a) * 1.3 + Math.cos(b) * 1.3) + 0.4 * noise(Math.sin(b) * 2.6 + 3, Math.cos(a) * 2.6 - Math.sin(b) * 2.6);
    let r = hash(x, y, 77, 5) - 0.5, vv = r * 0.9 + m * 0.8, inkish = vv > 0;
    let alpha = Math.min(1, Math.abs(vv)) * (inkish ? 0.065 : 0.05);
    if (hash(x, y, 3, 9) < 0.0025) alpha = 0.16;
    let col = dark ? (inkish ? [0, 0, 0] : [190, 205, 220]) : (inkish ? [70, 50, 25] : [255, 252, 240]);
    d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = Math.round(alpha * 255);
  }
  g.putImageData(img, 0, 0);
  g.lineWidth = 0.6;
  for (let f = 0; f < 70; ++f) {
    let x = hash(f, 1, 2, 3) * N, y = hash(f, 4, 5, 6) * N, a = hash(f, 7, 8, 9) * Math.PI, l = 4 + 10 * hash(f, 1, 1, 1);
    g.strokeStyle = dark ? 'rgba(200,215,230,0.05)' : 'rgba(90,60,30,0.06)';
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + 2, y + Math.sin(a) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  return canvas;
}

// The rose, the ship and the serpent, each on a canvas of its own (the page shows them as images,
// and hides one when the title or a panel would cover it). r: the size in px; returns the canvas
// and where its centre is
export function drawOrnament(canvas, kind, r, dir, palette, res) {
  let half = kind === 'rose' ? 1.45 * r : 1.9 * r, n = Math.ceil(2 * half * res);
  canvas.width = canvas.height = n;
  ctx = canvas.getContext('2d');
  P = palette;
  ctx.setTransform(res, 0, 0, res, 0, 0);
  if (kind === 'rose') rose(half, half, r);
  else if (kind === 'ship') ship(half, half + 0.6 * r, r, dir);
  else serpent(half, half + 0.4 * r, r, dir);
  ctx = null;
  return {canvas, half};
}
