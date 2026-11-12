// The world at another time. A drawn world is taken to another year's populations by deforming
// it: flow.js carries every point of the map along a flow that swells the countries that had more
// people and shrinks those that had fewer. The map stays one sheet throughout, so neighbours keep
// their borders and no two other countries come to touch, and every country ends at its size for
// that year. A unit of area is the same number of people in every year, so the land itself grows
// and shrinks with the world's population.
//
//   prepare(result)                    the map as flat arrays, and the grid the flow runs on
//   solve(prep, from, targets, opts)   positions with every country at its target area
//   deformed(result, prep, pts, ...)   a result like the generator's for those positions
//   throughYears(result, history)      the two put to work: a world's positions and map for any
//                                      year of a history of its countries' people
import {Flow, flatten, areas, rasterize, blur} from './flow.js';

// The points that move: every ring's, then every line's, then any others the caller wants carried
// along (`extra`, x and y in turn: where the names stand, say). The grid is twice as wide as tall
// and holds the world with room to grow.
export function prepare(result, {nx = 1024, ny = 512, margin = 1.5, extra = null} = {}) {
  const flat = flatten(result.countries);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < flat.pts.length; i += 2) {
    x0 = Math.min(x0, flat.pts[i]); x1 = Math.max(x1, flat.pts[i]);
    y0 = Math.min(y0, flat.pts[i + 1]); y1 = Math.max(y1, flat.pts[i + 1]);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, h = Math.max((y1 - y0) * margin, (x1 - x0) * margin * ny / nx), w = h * nx / ny;
  let nl = 0;
  for (const l of result.lines) nl += l.points.length;
  const ringPts = flat.pts.length / 2;
  const all = new Float64Array(2 * (ringPts + nl) + (extra ? extra.length : 0));
  all.set(flat.pts);
  if (extra) all.set(extra, 2 * (ringPts + nl));
  const lineAt = [];
  let at = flat.pts.length;
  for (const l of result.lines) { lineAt.push(at / 2); for (const [x, y] of l.points) { all[at++] = x; all[at++] = y; } }
  // A border's points are in both countries' rings and in its line: points that start in the
  // same place are one point (`one`: which, `first`: where each is found), carried once
  const n = all.length / 2, one = new Int32Array(n), first = [], seen = new Map();
  for (let i = 0; i < n; ++i) {
    const key = all[2 * i] + ',' + all[2 * i + 1];
    let g = seen.get(key);
    if (g === undefined) { seen.set(key, g = first.length); first.push(i); }
    one[i] = g;
  }
  // the pieces of boundary, each once (a border is in two rings): pairs of those points
  const pieces = new Map(), g = first.length;
  for (const r of flat.rings) for (let i = r.start, j = r.start + r.len - 1; i < r.start + r.len; j = i++) {
    const a = Math.min(one[i], one[j]), b = Math.max(one[i], one[j]);
    if (a !== b) pieces.set(a * g + b, a);
  }
  const segs = new Int32Array(2 * pieces.size);
  let k = 0;
  for (const [key, a] of pieces) { segs[k++] = a; segs[k++] = key - a * g; }
  return {flat, domain: {x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2}, mid: [cx, cy], nx, ny, all, lineAt, ringPts, extraAt: ringPts + nl,
    one, first: Int32Array.from(first), segs, flow: null};
}

// The whole map scaled evenly about its middle (a world with fewer people is a smaller world:
// that much of a change of size stretches nothing)
export function evenly(prep, pts, k) {
  const out = new Float64Array(pts.length), [mx, my] = prep.mid;
  for (let i = 0; i < pts.length; i += 2) { out[i] = mx + k * (pts[i] - mx); out[i + 1] = my + k * (pts[i + 1] - my); }
  return out;
}

// Scales the plane about (cx, cy): by s within rin, less and less out to rout, not at all beyond.
// A country inside rin changes its area by s * s; what lies around it gives way.
function radial(pts, cx, cy, rin, rout, s) {
  const r2 = rout * rout, span = rout - rin;
  for (let i = 0; i < pts.length; i += 2) {
    const dx = pts[i] - cx, dy = pts[i + 1] - cy, d2 = dx * dx + dy * dy;
    if (d2 >= r2 || d2 === 0) continue;
    let k = s;
    if (d2 > rin * rin) { const u = (Math.sqrt(d2) - rin) / span; k = s + (1 - s) * u * u * (3 - 2 * u); }
    pts[i] = cx + dx * k; pts[i + 1] = cy + dy * k;
  }
}
function ringArea(pts, r) {
  let a = 0;
  for (let i = 0, j = r.len - 1; i < r.len; j = i++) a += pts[2 * (r.start + j)] * pts[2 * (r.start + i) + 1] - pts[2 * (r.start + i)] * pts[2 * (r.start + j) + 1];
  return a / 2;
}

// Where three countries meet, or a coast doubles back, two pieces of boundary can lie a hair
// apart, and points carried one by one can end a hair on the wrong side of each other: the map
// is still right to the eye and no longer right. Pieces that have come to cross are found (on a
// grid about two pieces wide) and the point that went over the other piece is put back on the
// side it is on in the map as drawn, as far from it as it was there. Returns how many crossings
// are left (none, but for a tangle a few rounds do not undo).
function untangle(prep, pts, rounds = 6) {
  const {segs, one, first, all} = prep, m = segs.length / 2, g = first.length;
  const u = new Float64Array(2 * g), u0 = new Float64Array(2 * g);
  for (let k = 0; k < g; ++k) { u0[2 * k] = all[2 * first[k]]; u0[2 * k + 1] = all[2 * first[k] + 1]; }
  const side = (P, a, b, c) => (P[2 * b] - P[2 * a]) * (P[2 * c + 1] - P[2 * a + 1]) - (P[2 * b + 1] - P[2 * a + 1]) * (P[2 * c] - P[2 * a]);
  const length = (P, a, b) => Math.hypot(P[2 * b] - P[2 * a], P[2 * b + 1] - P[2 * a + 1]);
  const cx0 = new Int32Array(m), cy0 = new Int32Array(m), cx1 = new Int32Array(m), cy1 = new Int32Array(m);
  for (let round = 0; ; ++round) {
    for (let k = 0; k < g; ++k) { u[2 * k] = pts[2 * first[k]]; u[2 * k + 1] = pts[2 * first[k] + 1]; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, len = 0;
    for (let k = 0; k < m; ++k) {
      const a = segs[2 * k], b = segs[2 * k + 1];
      x0 = Math.min(x0, u[2 * a], u[2 * b]); x1 = Math.max(x1, u[2 * a], u[2 * b]);
      y0 = Math.min(y0, u[2 * a + 1], u[2 * b + 1]); y1 = Math.max(y1, u[2 * a + 1], u[2 * b + 1]);
      len += length(u, a, b);
    }
    let cell = Math.max(2 * len / Math.max(1, m), 1e-9);
    while ((x1 - x0) / cell * ((y1 - y0) / cell) > 4e6) cell *= 2;
    const cols = Math.floor((x1 - x0) / cell) + 1, rows = Math.floor((y1 - y0) / cell) + 1;
    // every piece in the cells its box covers
    const count = new Int32Array(cols * rows + 1);
    for (let k = 0; k < m; ++k) {
      const a = segs[2 * k], b = segs[2 * k + 1];
      cx0[k] = Math.floor((Math.min(u[2 * a], u[2 * b]) - x0) / cell); cx1[k] = Math.floor((Math.max(u[2 * a], u[2 * b]) - x0) / cell);
      cy0[k] = Math.floor((Math.min(u[2 * a + 1], u[2 * b + 1]) - y0) / cell); cy1[k] = Math.floor((Math.max(u[2 * a + 1], u[2 * b + 1]) - y0) / cell);
      for (let cy = cy0[k]; cy <= cy1[k]; ++cy) for (let cx = cx0[k]; cx <= cx1[k]; ++cx) ++count[cy * cols + cx + 1];
    }
    for (let c = 0; c < cols * rows; ++c) count[c + 1] += count[c];
    const items = new Int32Array(count[cols * rows]), fill = count.slice(0, cols * rows);
    for (let k = 0; k < m; ++k) for (let cy = cy0[k]; cy <= cy1[k]; ++cy) for (let cx = cx0[k]; cx <= cx1[k]; ++cx) items[fill[cy * cols + cx]++] = k;
    const crossed = [];
    for (let cy = 0; cy < rows; ++cy) for (let cx = 0; cx < cols; ++cx) {
      const c = cy * cols + cx;
      for (let i = count[c]; i < count[c + 1]; ++i) for (let j = i + 1; j < count[c + 1]; ++j) {
        const p = items[i], q = items[j];
        // (a pair that shares several cells is looked at in the first of them)
        if (Math.max(cx0[p], cx0[q]) !== cx || Math.max(cy0[p], cy0[q]) !== cy) continue;
        const a = segs[2 * p], b = segs[2 * p + 1], c2 = segs[2 * q], d = segs[2 * q + 1];
        if (a === c2 || a === d || b === c2 || b === d) continue;
        if (side(u, a, b, c2) * side(u, a, b, d) < 0 && side(u, c2, d, a) * side(u, c2, d, b) < 0) crossed.push(p, q);
      }
    }
    if (!crossed.length || round >= rounds) return crossed.length / 2;
    for (let k = 0; k < crossed.length; k += 2) {
      const p = crossed[k], q = crossed[k + 1];
      let best = null;
      // the two ends of one piece were on one side of the other piece: the end that is not, goes back
      const consider = (a, b, c, d) => {
        const o1 = side(u0, a, b, c), o2 = side(u0, a, b, d), was = Math.sign(o1 + o2);
        if (o1 * o2 < 0 || !was) return;
        const s1 = side(u, a, b, c), over = Math.sign(s1) !== was ? c : d, l = length(u, a, b), l0 = length(u0, a, b);
        if (!(l > 0) || !(l0 > 0)) return;
        const far = Math.abs(side(u, a, b, over)) / l;
        if (!best || far < best.far) best = {a, b, over, was, far, l, gap: Math.abs(over === c ? o1 : o2) / l0};
      };
      consider(segs[2 * p], segs[2 * p + 1], segs[2 * q], segs[2 * q + 1]);
      consider(segs[2 * q], segs[2 * q + 1], segs[2 * p], segs[2 * p + 1]);
      if (!best) continue;
      const {a, b, over, was, l} = best;
      const gap = Math.min(Math.max(best.gap, 1e-7), 0.25 * l);
      const move = was * gap - side(u, a, b, over) / l;
      u[2 * over] += move * -(u[2 * b + 1] - u[2 * a + 1]) / l;
      u[2 * over + 1] += move * (u[2 * b] - u[2 * a]) / l;
    }
    for (let i = 0; i < one.length; ++i) { pts[2 * i] = u[2 * one[i]]; pts[2 * i + 1] = u[2 * one[i] + 1]; }
  }
}

// targets: the area each country should have (0 for one that is not drawn). Flow passes bring
// the countries the grid can see to their areas; the ones too small for it are then scaled in
// place, one at a time; boundaries that came to cross on the way are put right. Returns the
// positions, how far off the worst country is, and how many crossings are left (none).
export function solve(prep, from, targets, {tol = 0.006, maxPasses = 30, clamp = 3, onPass = null} = {}) {
  const {flat, domain, nx, ny} = prep;
  const flow = prep.flow || (prep.flow = new Flow(domain, nx, ny));
  const cell = flow.dx * flow.dy, D = (domain.x1 - domain.x0) * (domain.y1 - domain.y0), SEEN = 24 * cell;
  const pts = Float64Array.from(from), n = targets.length;
  const seen = (a, i) => targets[i] > 0 && Math.min(a[i], targets[i]) >= SEEN;
  let passes = 0;
  const flowPasses = limit => {
    for (let k = 0; k < limit; ++k) {
      const a = areas(flat, pts);
      let worst = 0;
      for (let i = 0; i < n; ++i) if (seen(a, i)) worst = Math.max(worst, Math.abs(a[i] / targets[i] - 1));
      if (worst < tol) return;
      const ratio = new Float32Array(n);
      let land = 0, want = 0;
      for (let i = 0; i < n; ++i) {
        ratio[i] = targets[i] > 0 && a[i] > 0 ? Math.min(clamp, Math.max(1 / clamp, targets[i] / a[i])) : 1;
        land += a[i]; want += a[i] * ratio[i];
      }
      const sea = (D - want) / (D - land);
      const owner = rasterize(flat, pts, flow);
      let rho = new Float32Array(nx * ny);
      for (let c = 0; c < rho.length; ++c) rho[c] = owner[c] < 0 ? sea : ratio[owner[c]];
      rho = blur(rho, nx, ny, passes < 3 ? 1 : 0.5);
      flow.solve(rho);
      // (each point carried once, then put where all its copies are)
      const {one, first} = prep, u = new Float64Array(2 * first.length);
      for (let g = 0; g < first.length; ++g) { u[2 * g] = pts[2 * first[g]]; u[2 * g + 1] = pts[2 * first[g] + 1]; }
      flow.advect(u, 12);
      for (let i = 0; i < one.length; ++i) { pts[2 * i] = u[2 * one[i]]; pts[2 * i + 1] = u[2 * one[i] + 1]; }
      ++passes;
      if (onPass) onPass(passes, worst);
    }
  };
  // the small ones, smallest first: each scaled about its own middle until it has its area (what
  // one does to its small neighbours the next rounds put right)
  const fitSmall = () => {
    for (let round = 0; round < 12; ++round) {
      const a = areas(flat, pts);
      const list = [];
      for (let i = 0; i < n; ++i) if (targets[i] > 0 && a[i] > 0 && !seen(a, i) && Math.abs(a[i] / targets[i] - 1) > 0.002) list.push(i);
      if (!list.length) return;
      list.sort((p, q) => a[p] - a[q]);
      for (const c of list) {
        // each of its pieces on its own (an exclave lies apart), all by the same factor
        let area = 0;
        const pieces = [];
        for (let ri = flat.first[c]; ri < flat.first[c + 1]; ++ri) {
          const r = flat.rings[ri], ra = ringArea(pts, r);
          area += ra;
          let sx = 0, sy = 0;
          for (let i = r.start; i < r.start + r.len; ++i) { sx += pts[2 * i]; sy += pts[2 * i + 1]; }
          pieces.push({r, cx: sx / r.len, cy: sy / r.len, big: Math.abs(ra)});
        }
        area = Math.abs(area);
        if (!(area > 0)) continue;
        // (growing is taken a quarter at a time: more would fold the ring around it)
        const s = Math.min(1.25, Math.max(0.5, Math.sqrt(targets[c] / area)));
        const most = Math.max(...pieces.map(p => p.big));
        for (const p of pieces) {
          if (p.big < 0.02 * most && pieces.length > 1) continue;   // (a hole, or a crumb: it rides with what holds it)
          let rin = 0;
          for (let i = p.r.start; i < p.r.start + p.r.len; ++i) rin = Math.max(rin, Math.hypot(pts[2 * i] - p.cx, pts[2 * i + 1] - p.cy));
          radial(pts, p.cx, p.cy, rin * 1.02, rin * (s > 1 ? 1.9 : 1.5), s);
        }
      }
    }
  };
  let worst = Infinity, who = -1, crossed = 0;
  for (let outer = 0; outer < 3; ++outer) {
    flowPasses(outer ? 6 : maxPasses);
    fitSmall();
    crossed = untangle(prep, pts);
    const a = areas(flat, pts);
    worst = 0; who = -1;
    for (let i = 0; i < n; ++i) if (targets[i] > 0) { const e = Math.abs(a[i] / targets[i] - 1); if (e > worst) { worst = e; who = i; } }
    if (worst < 0.009 && !crossed) break;
  }
  return {pts, passes, worst, who, crossed};
}

// A build result for those positions: the same countries, lines and links with the points moved,
// `people` in each country (as the generator has `population`). Addons are for the caller to add.
export function deformed(result, prep, pts, people) {
  const {flat, lineAt} = prep;
  const countries = result.countries.map((c, i) => ({...c, population: people[i], rings: []}));
  for (const r of flat.rings) {
    const ring = new Array(r.len);
    for (let i = 0; i < r.len; ++i) ring[i] = [pts[2 * (r.start + i)], pts[2 * (r.start + i) + 1]];
    countries[r.country].rings.push(ring);
  }
  const lines = result.lines.map((l, k) => {
    const points = new Array(l.points.length);
    let length = 0;
    for (let i = 0; i < points.length; ++i) {
      points[i] = [pts[2 * (lineAt[k] + i)], pts[2 * (lineAt[k] + i) + 1]];
      if (i) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    }
    return {...l, points, length};
  });
  return {countries, lakes: [], lines, exclaves: result.exclaves, links: result.links, layout: result.layout};
}

// A world through the years of `history`: {first, last, series: {country id: people in each year}, world:
// the world's people in each year}. The result is the map of the last year. A country's area in
// a year is its area now times its people then over its people now.
//   positions(y)   where every point is in year y: worked out from the nearest year kept after it
//                  (the whole world first scaled evenly to that year's people, so the flow has only
//                  the differences left), or from between the two kept around it
//   keep(y)        the same, and kept to start other years from
//   world(y)       year y as a result like the generator's
export function throughYears(result, history, options = {}) {
  const prep = prepare(result, options), a0 = areas(prep.flat);
  const {first, last, series, world} = history;
  const frames = new Map([[last, prep.all]]);
  const share = (c, y) => series[c.id] ? series[c.id][y - first] / series[c.id][last - first] : 0;
  const targets = y => result.countries.map((c, i) => a0[i] > 0 ? a0[i] * share(c, y) : 0);
  const total = y => world[y - first];
  function positions(y) {
    if (frames.has(y)) return frames.get(y);
    let after = null, before = null;
    for (const k of frames.keys()) { if (k > y && (after === null || k < after)) after = k; if (k < y && (before === null || k > before)) before = k; }
    let start;
    if (before !== null) {
      // between two years on hand: a straight line between them is nearly there
      const a = frames.get(before), b = frames.get(after), t = (y - before) / (after - before);
      start = new Float64Array(a.length);
      for (let i = 0; i < a.length; ++i) start[i] = a[i] + (b[i] - a[i]) * t;
    } else start = evenly(prep, frames.get(after), Math.sqrt(total(y) / total(after)));
    return solve(prep, start, targets(y)).pts;
  }
  return {prep, frames, positions,
    keep(y) { if (!frames.has(y)) frames.set(y, positions(y)); return frames.get(y); },
    world(y) { return deformed(result, prep, positions(y), result.countries.map(c => Math.round(c.population * share(c, y)))); }};
}
