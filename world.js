// Countries map, fantasy-generator style: size-aware seed layout, graded cell mesh, constrained
// Potts annealing of cell labels, then continuous boundary work for exact areas and a hand-drawn
// look. See REPORT.md.
import {mulberry32, fbm2, pause, hash2} from './util.js';
import {layoutComponent, linkGeometry} from './layout.js';
import {buildMesh} from './mesh.js';
import {extractBoundary, Geo} from './geom.js';
import {smooth, subdivide, simplify, roughen, fitAreas, collapse, openGaps, despike, cutSpurs, straightenJunctions} from './process.js';
import {placeIslands, islandRing} from './islands.js';
import {isPlanar} from './planar.js';
import {createState, setTargets, recount, enforce, anneal, growFromSeeds, pruneArms, pruneThin, broadenChannels, fillFingers, fillThinWater, missingPairs, falseContacts, bridge, cellsByLabel, reinsert, linksOf, snapshot, restore, carveExclave, WATER} from './label.js';

export const UNIT = 1e6;          // people per square map unit

export async function buildWorld(doc, options = {}) {
  const seed = options.seed || 1;
  const onProgress = options.onProgress || (() => {});
  const debug = options.debug || null;
  const rng = mulberry32(seed * 7919 + 13);
  const t0 = Date.now();
  const n = doc.nodes.length;
  const pop = doc.nodes.map(r => +r[4] || 0);
  const edges = [];
  for (let i = 0; i < doc.links.length; i += 2) edges.push([doc.links[i], doc.links[i + 1]]);
  const nb = doc.nodes.map(() => []);
  edges.forEach(([a, b]) => { nb[a].push(b); nb[b].push(a); });
  const ids = doc.nodes.map(r => r[0]);
  // A warm start: options.base is the `layout` of an earlier world from the same countries.
  // Countries start where they were, and only those near a changed link have reason to move.
  const base = options.base || null;

  // ---- components
  const comp = new Int32Array(n).fill(-1);
  const comps = [];
  for (let i = 0; i < n; ++i) {
    if (comp[i] >= 0 || pop[i] <= 0) continue;
    const list = [i];
    comp[i] = comps.length;
    for (let k = 0; k < list.length; ++k) for (const j of nb[list[k]]) if (comp[j] < 0 && pop[j] > 0) { comp[j] = comps.length; list.push(j); }
    comps.push(list);
  }
  const landComps = comps.filter(c => c.length > 1).sort((a, b) => b.length - a.length);

  // ---- mesh resolution and the area each country gets in the mesh phase
  const h0 = options.h0 ?? 0.8, hmin = h0 / 16;
  const minArea = 12 * hmin * hmin;
  const meshArea = pop.map(p => Math.max(p / UNIT, minArea));
  const rad = meshArea.map(a => Math.sqrt(a / Math.PI));

  // ---- layout, pass 1 with every link: the natural arrangement
  const allLinked = (a, b) => nb[a].includes(b);
  const pass1 = new Map();
  const geoPos = new Map();
  // starting points of a warm start: each country where it was; one that had no place on the
  // land (an island that gained a neighbour) beside its neighbours, on their seaward side
  const warmInit = comp => {
    const at = new Map();
    for (const i of comp) if (base.pos[ids[i]]) at.set(i, base.pos[ids[i]].slice());
    // a new piece of land made only of former islands starts where those islands were
    if (!at.size) for (const i of comp) if (base.islands[ids[i]]) at.set(i, base.islands[ids[i]].slice());
    let cx = 0, cy = 0;
    at.forEach(p => { cx += p[0]; cy += p[1]; });
    cx /= Math.max(1, at.size); cy /= Math.max(1, at.size);
    for (let pass = 0; pass < 4; ++pass) for (const i of comp) {
      if (at.has(i)) continue;
      const near = nb[i].filter(j => at.has(j));
      if (!near.length && pass < 3) continue;
      if (!near.length) { at.set(i, [cx, cy]); continue; }
      let x = 0, y = 0, d = 0;
      for (const j of near) { x += at.get(j)[0]; y += at.get(j)[1]; d = Math.max(d, rad[i] + rad[j]); }
      x /= near.length; y /= near.length;
      const ox = x - cx, oy = y - cy, ol = Math.hypot(ox, oy) || 1;
      at.set(i, [x + ox / ol * d, y + oy / ol * d]);
    }
    return comp.map(i => at.get(i));
  };
  for (const comp of landComps) {
    // (a warm start's points already are an arrangement: relaxing them with every link, the ones
    // that end up exclaves too, would pull far-apart countries together)
    const P = base ? warmInit(comp) : layoutComponent(comp, rad, allLinked, rng);
    pass1.set(comp, P);
    comp.forEach((i, k) => geoPos.set(i, P[k]));
  }
  // links that cannot all be borders of a flat map become exclaves; among the fewest such sets,
  // drop the links the natural arrangement finds hardest (crossing others, stretched)
  const geoEdges = edges.filter(([a, b]) => geoPos.has(a) && geoPos.has(b));
  const P1 = [];
  geoPos.forEach((p, i) => { P1[i] = p; });
  const lg = linkGeometry(geoEdges, P1, rad);
  const hard = new Map(geoEdges.map(([a, b], k) => [a + ',' + b, lg.cross[k] * 2 + Math.max(0, lg.stretch[k] - 0.9) * 3]));
  const baseRemoved = new Set(base ? base.removed.flatMap(([a, b]) => [a + '-' + b, b + '-' + a]) : []);
  const ps = base ? {removed: []} : options.planarSubgraph(n, edges, {seed, budgetMs: 60000, weight: e => {
    const [a, b] = edges[e];
    const h = hard.get(a + ',' + b) ?? 0;
    // a warm start prefers the exclaves the earlier world had
    const before = base && baseRemoved.has(ids[a] + '-' + ids[b]) ? 0.25 : 1;
    return before * Math.sqrt(Math.min(pop[a], pop[b]) / UNIT + 0.1) / (1 + h);
  }});
  if (debug) debug.log(`planar subgraph: optimal ${ps.optimal}, weightOptimal ${ps.weightOptimal}, ${ps.stats && ps.stats.ms} ms`);
  let planned = globalThis.NOPLAN ? [] : ps.removed.map(e => edges[e]);
  if (base) {
    // a warm start keeps the earlier world's exclaves: its other links stay borders (a subset of a
    // flat drawing is flat), and each new link becomes a border if the map stays flat with it
    const before = new Set(base.links.map(([a, b]) => a + '-' + b));
    const isNew = ([a, b]) => !before.has(ids[a] + '-' + ids[b]) && !before.has(ids[b] + '-' + ids[a]);
    const kept = [], drop = [];
    for (const e of edges) if (!isNew(e)) (baseRemoved.has(ids[e[0]] + '-' + ids[e[1]]) ? drop : kept).push(e);
    for (const e of edges) if (isNew(e)) (isPlanar(n, kept.concat([e])) ? kept : drop).push(e);
    planned = drop;
  }
  const plannedSet = new Set(planned.map(([a, b]) => a + ',' + b));
  const keptLinked = (a, b) => !plannedSet.has(a + ',' + b) && !plannedSet.has(b + ',' + a) && nb[a].includes(b);
  if (debug) debug.log(`planned exclaves: ${planned.map(([a, b]) => doc.nodes[a][0] + '-' + doc.nodes[b][0]).join(' ')}`);
  onProgress({done: 0.08});

  // ---- layout pass 2 with the kept links, then the components on the world
  const pos = new Array(n).fill(null);
  const compBox = [];
  for (const ids of landComps) {
    const P = layoutComponent(ids, rad, keptLinked, rng, base
      ? {init: pass1.get(ids), iterations: 200, centerPull: 0, anchors: ids.map(i => base.pos[doc.nodes[i][0]] || null), anchorPull: 0.05}
      : {init: pass1.get(ids), iterations: 500});
    if (base) {
      // a warm start keeps the earlier world's frame: no turning, mirroring or moving
      ids.forEach((i, k) => { pos[i] = P[k]; });
      continue;
    }
    let cx = 0, cy = 0, w = 0;
    ids.forEach((i, k) => { cx += P[k][0] * meshArea[i]; cy += P[k][1] * meshArea[i]; w += meshArea[i]; });
    cx /= w; cy /= w;
    // orientation: the main continent lies along its long axis (landscape), the second one
    // stands upright beside it; small ones at a random angle. Mirrors vary with the seed.
    let sxx = 0, syy = 0, sxy = 0;
    ids.forEach((i, k) => { const dx = P[k][0] - cx, dy = P[k][1] - cy; sxx += dx * dx * meshArea[i]; syy += dy * dy * meshArea[i]; sxy += dx * dy * meshArea[i]; });
    const axis = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const rank = compBox.length;
    const th = rank === 0 ? -axis : rank === 1 ? Math.PI / 2 - axis : rng() * Math.PI * 2;
    const mirX = rng() < 0.5 ? -1 : 1, mirY = rng() < 0.5 ? -1 : 1;
    const c = Math.cos(th), s = Math.sin(th);
    let R = 0, bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    ids.forEach((i, k) => {
      const x = P[k][0] - cx, y = P[k][1] - cy;
      pos[i] = [(x * c - y * s) * mirX, (x * s + y * c) * mirY];
      R = Math.max(R, Math.hypot(pos[i][0], pos[i][1]) + rad[i]);
      bx0 = Math.min(bx0, pos[i][0] - rad[i]); bx1 = Math.max(bx1, pos[i][0] + rad[i]);
      by0 = Math.min(by0, pos[i][1] - rad[i]); by1 = Math.max(by1, pos[i][1] + rad[i]);
    });
    compBox.push({ids, R, bx0, bx1, by0, by1});
  }
  // place components: the main one at the centre, the second beside it (left or right), the
  // small ones in the nearest free spot around them
  const placed = [];
  if (!base) compBox.forEach((cb, k) => {
    let ox = 0, oy = 0;
    if (k === 1) {
      const m = compBox[0];
      const right = rng() < 0.5;
      ox = right ? m.bx1 + 10 - cb.bx0 : m.bx0 - 10 - cb.bx1;
      oy = (rng() - 0.5) * 0.4 * (m.by1 - m.by0);
    } else if (k > 1) {
      const ang0 = rng() * Math.PI * 2;
      outer: for (let dist = placed[0].R * 0.5; ; dist += 1.5) {
        for (let t = 0; t < 36; ++t) {
          const ang = ang0 + t * Math.PI * 2 / 36;
          const x = Math.cos(ang) * dist * 1.3, y = Math.sin(ang) * dist * 0.75;
          if (placed.every(p => (x + cb.R + 4 < p.bx0 || x - cb.R - 4 > p.bx1 || y + cb.R + 4 < p.by0 || y - cb.R - 4 > p.by1))) { ox = x; oy = y; break outer; }
        }
      }
    }
    for (const i of cb.ids) pos[i] = [pos[i][0] + ox, pos[i][1] + oy];
    placed.push({x: ox, y: oy, R: cb.R, bx0: cb.bx0 + ox, bx1: cb.bx1 + ox, by0: cb.by0 + oy, by1: cb.by1 + oy});
  });
  onProgress({done: 0.15});
  await pause();

  // ---- mesh over all multi-country land
  const meshIds = landComps.flat();
  const disks = meshIds.map(i => ({x: pos[i][0], y: pos[i][1], r: rad[i]}));
  const mesh = buildMesh(disks, rng, {h0, hmin, seed});
  if (debug) debug.log(`mesh ${mesh.N} cells, ${mesh.T} triangles, ${Date.now() - t0} ms`);
  onProgress({done: 0.25});
  await pause();

  // ---- labels: countries are labels 0..n-1, exclave pieces come after
  const NL = n + 48;
  const S = createState(mesh, NL, {seed, areaTol: 0.04, needRel: 0.22, coastWeight: globalThis.CW ?? 2, compact: globalThis.COMPACT ?? 1, wideStraits: globalThis.WIDE ?? true});
  for (const i of meshIds) S.target[i] = meshArea[i];
  edges.forEach(([a, b]) => { if (keptLinked(a, b)) { S.linked[a * NL + b] = S.linked[b * NL + a] = 1; } });
  setTargets(S);
  // coast noise: low-frequency continents-scale field plus detail
  const nseed = seed * 31 + 7;
  for (let u = 0; u < mesh.N; ++u) {
    const x = mesh.coords[2 * u], y = mesh.coords[2 * u + 1];
    S.noise[u] = (globalThis.NZL ?? 4) * fbm2(x / 22, y / 22, nseed, 3, 0.5) + (globalThis.NZS ?? 1.2) * fbm2(x / 7, y / 7, nseed + 3, 2, 0.5);
  }
  // initial assignment: power diagram of the seeds, clipped to (noisy) disks
  const alpha = globalThis.ALPHA || 1.12;
  const cellOf = new Int32Array(n).fill(-1), cellD = new Float64Array(n).fill(Infinity);
  for (let u = 0; u < mesh.N; ++u) {
    if (mesh.frozen[u]) continue;
    const x = mesh.coords[2 * u], y = mesh.coords[2 * u + 1];
    let best = -1, bestP = Infinity;
    const lim = alpha * (1 + 0.25 * fbm2(x / 6, y / 6, nseed + 1, 4));
    for (const i of meshIds) {
      const dx = x - pos[i][0], dy = y - pos[i][1];
      const d2 = dx * dx + dy * dy;
      const r = rad[i];
      if (d2 < cellD[i]) { cellD[i] = d2; cellOf[i] = u; }
      if (d2 > lim * lim * r * r) continue;
      const pw = d2 - r * r;
      if (pw < bestP) { bestP = pw; best = i; }
    }
    S.lab[u] = best;
  }
  // inland seas where the large-scale noise peaks inside the land
  {
    const vals = [];
    for (let u = 0; u < mesh.N; ++u) if (S.lab[u] >= 0) vals.push(S.noise[u]);
    vals.sort((a, b) => a - b);
    const th = vals[Math.floor(vals.length * (1 - (globalThis.SEAQ ?? 0)))];
    if (globalThis.SEAQ) for (let u = 0; u < mesh.N; ++u) if (S.lab[u] >= 0 && S.noise[u] > th) S.lab[u] = WATER;
  }
  for (const i of meshIds) { S.seedCell[i] = cellOf[i]; S.lab[cellOf[i]] = i; }
  if (!globalThis.POWERINIT) {
    // capped growth instead: small countries keep their spot, big ones flow around them
    const used = new Set();
    const seeds = [];
    const bySize = meshIds.slice().sort((a, b) => S.target[a] - S.target[b]);
    for (const i of bySize) {
      let c = cellOf[i];
      if (used.has(c) || mesh.frozen[c]) {
        // nearest free cell
        let best = -1, bd = Infinity;
        for (let u = 0; u < mesh.N; ++u) {
          if (used.has(u) || mesh.frozen[u]) continue;
          const d = (mesh.coords[2 * u] - pos[i][0]) ** 2 + (mesh.coords[2 * u + 1] - pos[i][1]) ** 2;
          if (d < bd) { bd = d; best = u; }
        }
        c = best;
      }
      used.add(c);
      seeds.push([i, c]);
      S.seedCell[i] = c;
    }
    const speed = new Float64Array(NL);
    for (const i of meshIds) speed[i] = rad[i];
    const gn = globalThis.GROWNOISE ?? 0.8;
    growFromSeeds(S, seeds, speed, u => mesh.hloc[u] * Math.exp(gn * S.noise[u] / 4));
  }
  const strength = (u, a) => {
    const dx = mesh.coords[2 * u] - pos[a][0], dy = mesh.coords[2 * u + 1] - pos[a][1];
    return rad[a] / (Math.hypot(dx, dy) + 1e-9);
  };
  enforce(S, strength);
  const keptPairs = edges.filter(([a, b]) => keptLinked(a, b));
  // labels and the labels linked to them: the neighbourhood a local repair anneals
  const around = labels => {
    const s = new Set(labels);
    for (const l of labels) for (let m = 0; m < NL; ++m) if (S.linked[l * NL + m]) s.add(m);
    return s;
  };
  if (debug) debug.log(`initial: missing ${missingPairs(S, keptPairs).length}, false ${falseContacts(S).length}, ${Date.now() - t0} ms`);
  anneal(S, rng, options.sweeps ?? 30, 0.6, 0.02);
  recount(S);
  // missing borders: grow arms toward each other, then let annealing fatten them
  for (let round = 0; round < 3; ++round) {
    const miss = missingPairs(S, keptPairs).filter(([a, b, len]) => len <= 0);
    if (!miss.length) break;
    const lists = cellsByLabel(S);
    let fixed = 0;
    for (const [a, b] of miss) { if (bridge(S, a, b, lists)) fixed++; else if (debug) debug.log(`  ${doc.nodes[a][0]}-${doc.nodes[b][0]}: ${S.why}`); }
    recount(S);
    if (debug) debug.log(`bridges round ${round}: ${fixed} of ${miss.length}`);
    anneal(S, rng, globalThis.BSWEEPS ?? 12, 0.3, 0.02, {near: around(miss.flatMap(([a, b]) => [a, b])), tag: round + 1});
    recount(S);
  }
  // still missing: move the smaller country to where all its neighbours are closest
  const bridgeAll = X => {
    const lists = cellsByLabel(S);
    for (const [a, b] of missingPairs(S, keptPairs).filter(([a, b, len]) => len <= 0)) bridge(S, a, b, lists);
    recount(S);
  };
  const tried = new Set();
  for (let round = 0; round < 2; ++round) {
    const miss = missingPairs(S, keptPairs).sort((x, y) => Math.min(S.target[x[0]], S.target[x[1]]) - Math.min(S.target[y[0]], S.target[y[1]]));
    for (const [a, b] of miss) {
      if (S.pairLen[a * NL + b] >= S.need[a * NL + b]) continue;
      for (const X of S.target[a] <= S.target[b] ? [a, b] : [b, a]) {
      if (S.pairLen[a * NL + b] >= S.need[a * NL + b]) break;
      if (tried.has(X) || S.target[X] > 60 || tried.size >= 14) continue;
      tried.add(X);
      const before = missingPairs(S, keptPairs).length;
      const snap = snapshot(S);
      reinsert(S, X, linksOf(S, X, keptPairs));
      recount(S);
      bridgeAll(X);
      anneal(S, rng, 6, 0.15, 0.02, {near: around([X]), tag: 100 + X});
      recount(S);
      const after = missingPairs(S, keptPairs).length;
      if (debug) debug.log(`  reinsert ${doc.nodes[X][0]}: ${before} -> ${after}`);
      if (after >= before) restore(S, snap);
      }
    }
  }
  // ribbons: small countries stretched into long arms by bridging get re-inserted where they can
  // be round, when that loses no border
  {
    const roundness = () => {
      const per = new Float64Array(NL);
      for (let u = 0; u < mesh.N; ++u) {
        const a = S.lab[u];
        if (a < 0) continue;
        for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) if (S.lab[mesh.ringNbr[k]] !== a) per[a] += mesh.ringLen[k];
      }
      return l => per[l] * per[l] / (4 * Math.PI * Math.max(S.area[l], 1e-12));
    };
    let shape = roundness();
    const cands = meshIds.filter(i => S.target[i] <= 60 && shape(i) > 2.4).sort((a, b) => shape(b) - shape(a)).slice(0, 8);
    for (const X of cands) {
      const before = missingPairs(S, keptPairs).length, c0 = shape(X);
      const snap = snapshot(S);
      reinsert(S, X, linksOf(S, X, keptPairs));
      recount(S);
      bridgeAll(X);
      anneal(S, rng, 6, 0.15, 0.02, {near: around([X]), tag: 100 + X});
      recount(S);
      const after = missingPairs(S, keptPairs).length;
      const fresh = roundness();
      const c1 = fresh(X);
      if (debug) debug.log(`  reshape ${doc.nodes[X][0]}: roundness ${c0.toFixed(2)} -> ${c1.toFixed(2)}, missing ${before} -> ${after}`);
      // a severe ribbon may cost one more exclave
      const allowed = c0 > 7 && c1 < 0.45 * c0 ? before + 1 : before;
      if (after > allowed || c1 > 0.8 * c0) restore(S, snap);
      else shape = fresh;
    }
  }
  // arms: what still reaches far from its country's centre is cut back; borders lost that way
  // become exclaves (a few more exclaves are better than snakes)
  if ((globalThis.ARM ?? 1.45) > 0) {
    let nPruned = pruneArms(S, meshIds, l => S.target[l] < (globalThis.ARMT ?? 15) ? (globalThis.ARMS ?? 1.25) : (globalThis.ARM ?? 1.45), l => S.target[l] < 12 * hmin * hmin * 1.01);
    if (globalThis.THIN ?? 0.4) nPruned += pruneThin(S, meshIds, globalThis.THIN ?? 0.4, l => S.target[l] < 12 * hmin * hmin * 1.01, globalThis.THINF ?? 0.15);
    enforce(S, strength);
    anneal(S, rng, 12, 0.2, 0.02);
    recount(S);
    // short bridges only: neighbours a little apart touch again, long arms do not come back
    const lists = cellsByLabel(S);
    for (const [a, b] of missingPairs(S, keptPairs).filter(([a, b, len]) => len <= 0)) {
      const rmin = Math.sqrt(Math.min(S.target[a], S.target[b]) / Math.PI);
      bridge(S, a, b, lists, 4, (globalThis.SHORTB ?? 0.6) * rmin);
    }
    recount(S);
    anneal(S, rng, 10, 0.15, 0.02);
    recount(S);
    // second pass: whatever the re-bridging and annealing grew back thin is cut again, for good
    if (globalThis.THIN2 ?? true) {
      nPruned += pruneThin(S, meshIds, globalThis.THIN ?? 0.4, l => S.target[l] < 12 * hmin * hmin * 1.01, globalThis.THINF ?? 0.15);
      enforce(S, strength);
      const cb = S.opts.contactBonus;
      S.opts.contactBonus = 0;
      anneal(S, rng, 6, 0.1, 0.02);
      S.opts.contactBonus = cb;
      recount(S);
    }
    if (debug) debug.log(`pruned ${nPruned} arm cells; missing now ${missingPairs(S, keptPairs).filter(([a, b, len]) => len <= 0).length}`);
    // ribbons that survived (hub countries squeezed between big neighbours): dissolve and regrow
    // where their neighbours meet; worth one more exclave if the shape becomes round
    if (globalThis.RIBBON ?? true) {
      const tiny0 = l => S.target[l] < 12 * hmin * hmin * 1.01;
      let tf = pruneThin(S, meshIds, 0.4, tiny0, 0, true);
      const cands = meshIds.filter(i => !tiny0(i) && tf[i] > (globalThis.RIBT ?? 0.15)).sort((a, b) => tf[b] - tf[a]).slice(0, 8);
      if (debug) debug.log('thin fractions: ' + meshIds.filter(i => tf[i] > 0.15).sort((a, b) => tf[b] - tf[a]).slice(0, 14).map(i => doc.nodes[i][0] + ' ' + (100 * tf[i]).toFixed(0)).join(', '));
      for (const X of cands) {
        const missNow = () => missingPairs(S, keptPairs).filter(([a, b, len]) => len <= 0).length;
        const before = missNow(), t0 = tf[X];
        const snap = snapshot(S);
        reinsert(S, X, linksOf(S, X, keptPairs));
        recount(S);
        const lists = cellsByLabel(S);
        for (const [a, b] of missingPairs(S, keptPairs).filter(([a, b, len]) => len <= 0 && (a === X || b === X))) {
          const rmin = Math.sqrt(Math.min(S.target[a], S.target[b]) / Math.PI);
          bridge(S, a, b, lists, 4, (globalThis.SHORTB ?? 0.6) * rmin);
        }
        recount(S);
        anneal(S, rng, 6, 0.1, 0.02, {near: around([X]), tag: 1000 + X});
        recount(S);
        const after = missNow();
        const tf1 = pruneThin(S, meshIds, 0.4, tiny0, 0, true);
        const ok = tf1[X] < 0.5 * t0 && after <= before + (t0 > 0.5 ? 2 : 1);
        if (debug) debug.log(`  ribbon ${doc.nodes[X][0]}: thin ${(100 * t0).toFixed(0)}% -> ${(100 * tf1[X]).toFixed(0)}%, missing ${before} -> ${after}${ok ? '' : ' (undone)'}`);
        if (ok) tf = tf1; else restore(S, snap);
      }
    }
  }
  recount(S);
  // whatever still has no border becomes an exclave: a piece of the smaller country inside the
  // other one (planned ones first)
  const pieces = [];
  const stillMissing = missingPairs(S, keptPairs).filter(([a, b, len]) => len <= 0);
  let exclavePairs = planned.concat(stillMissing.map(([a, b]) => [a, b]));
  let nextLabel = n;
  // one piece can serve two missing borders of the same owner when its two hosts border each
  // other: put it on their border
  {
    const used = new Set();
    const byCountry = new Map();
    exclavePairs.forEach(([a, b], k) => { for (const x of [a, b]) { if (!byCountry.has(x)) byCountry.set(x, []); byCountry.get(x).push(k); } });
    const order = [...byCountry.keys()].sort((x, y) => byCountry.get(y).length - byCountry.get(x).length);
    for (const O of order) {
      const ks = byCountry.get(O).filter(k => !used.has(k));
      if (ks.length < 2) continue;
      const hosts = ks.map(k => exclavePairs[k][0] === O ? exclavePairs[k][1] : exclavePairs[k][0]);
      for (let x = 0; x < ks.length; ++x) for (let y = x + 1; y < ks.length; ++y) {
        if (used.has(ks[x]) || used.has(ks[y])) continue;
        const H1 = hosts[x], H2 = hosts[y];
        if (!S.linked[H1 * NL + H2] || S.pairLen[H1 * NL + H2] <= 0 || nextLabel >= NL) continue;
        const P = nextLabel;
        const area = Math.max(Math.min(0.12 * S.target[O], 0.08 * Math.min(S.target[H1], S.target[H2])), 10 * hmin * hmin);
        for (const H of [H1, H2]) S.linked[O * NL + H] = S.linked[H * NL + O] = 0;
        S.linked[P * NL + H1] = S.linked[H1 * NL + P] = S.linked[P * NL + H2] = S.linked[H2 * NL + P] = 1;
        S.target[P] = area;
        setTargets(S);
        const lists = cellsByLabel(S);
        const ok = carveExclave(S, P, H1, area, lists[O], H2);
        recount(S);
        if (debug) debug.log(`  exclave ${doc.nodes[O][0]} on ${doc.nodes[H1][0]}|${doc.nodes[H2][0]}: ${ok ? 'ok' : 'failed'}`);
        if (!ok) {
          S.linked[P * NL + H1] = S.linked[H1 * NL + P] = S.linked[P * NL + H2] = S.linked[H2 * NL + P] = 0;
          S.target[P] = 0;
          continue;
        }
        S.target[O] -= area;
        setTargets(S);
        pieces.push({label: P, owner: O, host: H1, host2: H2});
        nextLabel++;
        used.add(ks[x]); used.add(ks[y]);
      }
    }
    exclavePairs = exclavePairs.filter((p, k) => !used.has(k));
  }
  for (const [a, b] of exclavePairs) {
    if (nextLabel >= NL) break;
    // the smaller country owns the piece; if it does not fit, try the other way round
    let done = false;
    for (const swap of [false, true]) {
      let O = pop[a] <= pop[b] ? a : b, H = O === a ? b : a;
      if (swap) [O, H] = [H, O];
      if (S.target[O] <= 0 || S.target[H] <= 0) continue;
      const P = nextLabel;
      S.linked[a * NL + b] = S.linked[b * NL + a] = 0;
      S.linked[P * NL + H] = S.linked[H * NL + P] = 1;
      const area = Math.max(Math.min(0.12 * S.target[O], 0.08 * S.target[H]), 10 * hmin * hmin);
      S.target[P] = area;
      setTargets(S);
      const lists = cellsByLabel(S);
      const ok = carveExclave(S, P, H, area, lists[O]);
      recount(S);
      if (debug) debug.log(`  exclave ${doc.nodes[O][0]} in ${doc.nodes[H][0]}: ${ok ? 'ok' : 'FAILED'} area ${S.area[P].toFixed(3)}/${area.toFixed(3)}`);
      if (!ok) { S.linked[P * NL + H] = S.linked[H * NL + P] = 0; S.target[P] = 0; continue; }
      S.target[O] -= area;
      setTargets(S);
      pieces.push({label: P, owner: O, host: H});
      nextLabel++;
      done = true;
      break;
    }
    if (!done) throw new Error(`no room for an exclave between ${doc.nodes[a][1]} and ${doc.nodes[b][1]}`);
  }
  // long channels between countries that may not touch become broad seas with ragged shores
  const makeSeas = () => {
    const r = broadenChannels(S, {
      minLength: 6, minRel: globalThis.SEAREL ?? 2.5, minR: globalThis.SEAR ?? 1.0,
      widthRel: globalThis.SEAW ?? 0.18, widthR: globalThis.SEAWR ?? 2, maxWidth: globalThis.SEAMAX ?? 6,
      bandR: globalThis.SEABAND ?? 0.8, maxLoss: globalThis.SEALOSS ?? 0.2,
      noiseAmp: 0.45, noise: (x, y) => fbm2(x / 5, y / 5, nseed + 11, 3),
    });
    recount(S);
    if (debug) debug.log(`seas: ${r.bodies} channel bodies, ${r.carved} cells carved; missing ${missingPairs(S, finalPairsNow()).filter(([a, b, len]) => len <= 0).length}`);
  };
  const finalPairsNow = () => keptPairs.filter(([a, b]) => S.linked[a * NL + b]).concat(pieces.map(p => [p.label, p.host]), pieces.filter(p => p.host2 >= 0).map(p => [p.label, p.host2]));
  if (globalThis.SEAS ?? true) { makeSeas(); makeSeas(); }
  anneal(S, rng, 16, 0.15, 0.01);
  recount(S);
  // borders still shorter than they should be: a few sweeps with a stronger pull on them
  const short = missingPairs(S, keptPairs.filter(([a, b]) => S.linked[a * NL + b]));
  if (short.length) {
    S.opts.contactBonus = 10;
    anneal(S, rng, 10, 0.08, 0.01, {near: around(short.flatMap(([a, b]) => [a, b]))});
    S.opts.contactBonus = 3;
    recount(S);
  }
  {
    let nf = fillFingers(S) + fillThinWater(S, globalThis.THINW ?? 1.5);
    recount(S);
    // carving and filling moved land around: rebalance the areas, then fill again what that opened
    for (let k = 0; k < (globalThis.REBAL ?? 2); ++k) {
      anneal(S, rng, 6, 0.05, 0.01);
      recount(S);
      nf += fillFingers(S) + fillThinWater(S, globalThis.THINW ?? 1.5);
      recount(S);
    }
    if (debug) debug.log(`filled ${nf} finger cells`);
  }
  const finalPairs = keptPairs.filter(([a, b]) => S.linked[a * NL + b]).concat(pieces.map(p => [p.label, p.host]), pieces.filter(p => p.host2 >= 0).map(p => [p.label, p.host2]));
  if (debug) {
    const miss = missingPairs(S, finalPairs);
    const nm = l => l < n ? doc.nodes[l][0] : 'piece' + l;
    debug.log(`annealed: missing ${miss.length} [${miss.map(([a, b]) => nm(a) + '-' + nm(b)).join(' ')}], false ${falseContacts(S).length}, ${Date.now() - t0} ms`);
    let worst = 0;
    for (const i of meshIds) worst = Math.max(worst, Math.abs(S.area[i] / S.target[i] - 1));
    {
      const per = new Float64Array(NL);
      for (let u = 0; u < mesh.N; ++u) { const a = S.lab[u]; if (a < 0) continue; for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) if (S.lab[mesh.ringNbr[k]] !== a) per[a] += mesh.ringLen[k]; }
      const rr = meshIds.map(i => [i, per[i] * per[i] / (4 * Math.PI * S.area[i])]).sort((a, b) => b[1] - a[1]);
      debug.log('least round: ' + rr.slice(0, 10).map(([i, r]) => doc.nodes[i][0] + ' ' + r.toFixed(1)).join(', ') + ' | over 4: ' + rr.filter(x => x[1] > 4).length);
    }
    const errs = [];
    for (let l = 0; l < NL; ++l) if (S.target[l] > 0) errs.push([l, S.area[l] / S.target[l] - 1]);
    errs.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    debug.log('mesh area errors: ' + errs.slice(0, 8).map(([l, e]) => (l < n ? doc.nodes[l][0] : 'p' + l) + ' ' + (e * 100).toFixed(1) + '%').join(', '));
    debug.log(`worst mesh area error ${(worst * 100).toFixed(1)}%`);
    debug.state = {S, mesh, pos, rad, meshIds};
  }
  onProgress({done: 0.55});
  await pause();

  // ================= continuous phase =================
  const ownerOf = l => l < n ? l : pieces.find(p => p.label === l).owner;
  const trueTarget = new Float64Array(NL);
  for (const i of meshIds) trueTarget[i] = pop[i] / UNIT;
  for (const p of pieces) { trueTarget[p.label] = S.target[p.label]; trueTarget[p.owner] -= S.target[p.label]; }
  const sizeOf = l => Math.sqrt(S.target[l]);
  const bd = extractBoundary(mesh, S.lab);
  const clearK = 0.05;
  const geo = new Geo(bd.vx, bd.vy, bd.chains, {
    linked: (a, b) => S.linked[a * NL + b] === 1,
    clearance: (a, b) => Math.min(0.5, clearK * Math.min(sizeOf(a), sizeOf(b))),
    maxClearance: 0.5,
  });
  const tg = Date.now();
  const areaReport = tag => {
    if (!debug) return;
    const {areas} = geo.labelAreas(geo.rings());
    const e = [];
    for (const [l, A] of areas) if (S.target[l] > 0) e.push([l, A / S.target[l] - 1]);
    e.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    debug.log(tag + ': ' + e.slice(0, 6).map(([l, x]) => (l < n ? doc.nodes[l][0] : 'p' + l) + ' ' + (x * 100).toFixed(1) + '%').join(', '));
  };
  areaReport('start');
  smooth(geo, 6, 0.5);
  areaReport('smoothed');
  fitAreas(geo, l => S.target[l], {iterations: 20, tol: 0.01});
  areaReport('prefit');
  // hand-drawn character: coasts get capes and coves finer than the mesh, borders a gentle wobble
  {
    const meanLen = new Map();
    geo.chains.forEach((c, ci) => {
      let t = 0;
      for (let i = 0; i + 1 < c.v.length; ++i) t += Math.hypot(geo.vx[c.v[i + 1]] - geo.vx[c.v[i]], geo.vy[c.v[i + 1]] - geo.vy[c.v[i]]);
      meanLen.set(c, t / Math.max(1, c.v.length - 1));
    });
    const isCoast = c => c.L < 0 || c.R < 0;
    subdivide(geo, c => meanLen.get(c) * (isCoast(c) ? 0.5 : 0.8));
    const RC = globalThis.RC ?? 1.0, RB = globalThis.RB ?? 0.35;
    if (!globalThis.SKIPROUGH) roughen(geo, c => meanLen.get(c) * (isCoast(c) ? RC : RB), seed * 17 + 5);
    smooth(geo, 1, 0.3);
  }
  areaReport('roughened');
  if (debug) debug.log(`geometry: ${geo.chains.length} chains, ${geo.vx.length} vertices; smoothed in ${Date.now() - tg} ms`);
  let worst;
  // tiny countries: shrink to their true size around a point inside them
  const tiny = new Set();
  {
    const {areas} = geo.labelAreas(geo.rings());
    for (const i of meshIds) {
      if (trueTarget[i] >= S.target[i] * 0.999) continue;
      const A = areas.get(i);
      if (!(A > 0)) continue;
      let ok = false;
      for (let attempt = 0; attempt < 8 && !ok; ++attempt) {
        // curve-shortening (plain Laplacian) on this country alone makes any blob convex in time
        if (attempt > 0) smooth(geo, 8, 0.5, c => c.L !== i && c.R !== i, false);
        const A2 = geo.labelAreas(geo.rings()).areas.get(i);
        ok = collapse(geo, i, Math.sqrt(trueTarget[i] / A2));
      }
      if (ok) tiny.add(i);
      else throw new Error(`could not shrink ${doc.nodes[i][1]} to its size`);
    }
  }
  areaReport('collapsed');
  const gapsLeft = globalThis.SKIPGAPS ? 0 : openGaps(geo, 8, l => tiny.has(l), l => (tiny.has(l) ? 0 : Math.min(0.8, (globalThis.THICK ?? 0) * Math.sqrt(S.target[l]))));
  areaReport('gaps');

  if (debug) debug.log(`gaps: ${gapsLeft} vertices still short of clearance, ${Date.now() - t0} ms`);
  despike(geo, 35, 6, l => tiny.has(l));
  if (globalThis.STRAIGHT ?? true) for (let k = 0; k < 2; ++k)
    straightenJunctions(geo, (a, b) => Math.min(1.5, (globalThis.SJD ?? 0.09) * Math.sqrt(Math.min(trueTarget[a], trueTarget[b]))), l => tiny.has(l));
  worst = fitAreas(geo, l => trueTarget[l], {iterations: 200, tol: 1e-3, frozen: l => tiny.has(l), smoothPasses: globalThis.FITSMOOTH ?? 2});
  const spikes = despike(geo, 35, 6, l => tiny.has(l));
  const nCut = cutSpurs(geo, 1.5, l => tiny.has(l));
  // the last moves may have brought countries that must not touch too close: open again, refit
  const gaps2 = openGaps(geo, 10, l => tiny.has(l));
  if (nCut || gaps2) worst = fitAreas(geo, l => trueTarget[l], {iterations: 60, tol: 1e-3, frozen: l => tiny.has(l)});
  // the refit can fold a few vertices again: a last clearance-safe despike (moves are tiny)
  if (despike(geo, 30, 4, l => tiny.has(l)) >= 0) {
    const {areas} = geo.labelAreas(geo.rings());
    worst = 0;
    for (const [l, A] of areas) if (trueTarget[l] > 0 && !tiny.has(l)) worst = Math.max(worst, Math.abs(A / trueTarget[l] - 1));
    if (worst > 2e-3) worst = fitAreas(geo, l => trueTarget[l], {iterations: 30, tol: 1e-3, frozen: l => tiny.has(l)});
  }
  // last: the coast runs straight on through border ends (clearance-limited moves), then a short
  // fit that may only move vertices away from junctions
  if (globalThis.STRAIGHT2 ?? false) {
    for (let k = 0; k < 3; ++k) straightenJunctions(geo, (a, b) => Math.min(1.5, (globalThis.SJD ?? 0.09) * Math.sqrt(Math.min(trueTarget[a], trueTarget[b]))), l => tiny.has(l));
    worst = fitAreas(geo, l => trueTarget[l], {iterations: 60, tol: 1e-3, frozen: l => tiny.has(l), pinJunctions: true});
  }
  if (debug) debug.log(`spikes left ${spikes}, spurs cut ${nCut}`);
  {
    const {areas} = geo.labelAreas(geo.rings());
    for (const [l, A] of areas) if (trueTarget[l] > 0 && !tiny.has(l)) worst = Math.max(worst, Math.abs(A / trueTarget[l] - 1));
  }
  if (debug) debug.log(`fit (true targets): worst ${(worst * 100).toFixed(3)}%, tiny ${tiny.size}, ${Date.now() - t0} ms`);
  onProgress({done: 0.9});

  // ---- output
  const rmap = geo.rings();
  const countries = doc.nodes.map((r, i) => ({index: i, id: r[0], name: r[1], continent: r[3], population: pop[i], rings: []}));
  for (const [l, rings] of rmap) {
    const c = countries[ownerOf(l)];
    for (const ring of rings) c.rings.push(geo.ringPoints(ring).map(p => [geo.vx[p], geo.vy[p]]));
  }
  const lines = geo.chains.map(c => {
    const pts = c.v.map(p => [geo.vx[p], geo.vy[p]]);
    let len = 0;
    for (let i = 1; i < pts.length; ++i) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const a = c.L >= 0 ? ownerOf(c.L) : -1, b = c.R >= 0 ? ownerOf(c.R) : -1;
    return {a: a >= 0 ? a : b, b: a >= 0 ? b : -1, points: pts, length: len, kind: a >= 0 && b >= 0 ? 'border' : 'coast'};
  });
  // ---- island countries
  {
    const cellG = 0.5;
    const occ = new Set();
    const mark = (x, y) => occ.add(Math.floor(x / cellG) * 100003 + Math.floor(y / cellG));
    for (let p = 0; p < geo.vx.length; ++p) mark(geo.vx[p], geo.vy[p]);
    // fill land interiors too: mesh land cells
    for (let u = 0; u < mesh.N; ++u) if (S.lab[u] >= 0) mark(mesh.coords[2 * u], mesh.coords[2 * u + 1]);
    const occupied = (x, y, r) => {
      const i0 = Math.floor((x - r) / cellG), i1 = Math.floor((x + r) / cellG);
      const j0 = Math.floor((y - r) / cellG), j1 = Math.floor((y + r) / cellG);
      for (let i = i0; i <= i1; ++i) for (let j = j0; j <= j1; ++j) {
        if (!occ.has(i * 100003 + j)) continue;
        const cx = (i + 0.5) * cellG, cy = (j + 0.5) * cellG;
        if (Math.hypot(cx - x, cy - y) < r + cellG) return true;
      }
      return false;
    };
    const contW = new Map();
    for (const i of meshIds) {
      const c = doc.nodes[i][3];
      const w = contW.get(c) || [0, 0, 0];
      w[0] += pos[i][0] * meshArea[i]; w[1] += pos[i][1] * meshArea[i]; w[2] += meshArea[i];
      contW.set(c, w);
    }
    let minY = Infinity, sumX = 0, cnt = 0;
    for (const i of meshIds) { minY = Math.min(minY, pos[i][1] - rad[i]); sumX += pos[i][0]; cnt++; }
    const anchorOf = it => {
      // a warm start puts an island back where it was (or, for a country that lost its last
      // neighbour, where it stood on the land), or as near as is free
      const was = base && (base.islands[ids[it.index]] || base.pos[ids[it.index]]);
      if (was) return was;
      const w = contW.get(it.continent);
      if (w) return [w[0] / w[2], w[1] / w[2]];
      if (it.continent === 'Oceania') { const a = contW.get('Asia'); return [a[0] / a[2] + 25, a[1] / a[2] - 30]; }
      return [sumX / cnt, minY - 10];
    };
    const list = [];
    for (let i = 0; i < n; ++i) if (pop[i] > 0 && !meshIds.includes(i)) list.push({index: i, id: ids[i], area: pop[i] / UNIT, continent: doc.nodes[i][3]});
    const placedIs = placeIslands(list, anchorOf, occupied, rng, base ? {keep: true, angle: it => hash2(it.index, seed, 5)} : {});
    for (const p of placedIs) {
      const ring = islandRing(p.x, p.y, p.area, seed * 1000 + p.index);
      countries[p.index].rings.push(ring);
      let len = 0;
      for (let k = 0; k < ring.length; ++k) { const a = ring[k], b = ring[(k + 1) % ring.length]; len += Math.hypot(b[0] - a[0], b[1] - a[1]); }
      lines.push({a: p.index, b: -1, points: ring.concat([ring[0]]), length: len, kind: 'coast'});
    }
    if (debug) debug.log(`islands placed ${placedIs.length} of ${list.length}`);
  }
  const exclaves = pieces.map(p => {
    const e = {owner: doc.nodes[p.owner][0], host: doc.nodes[p.host][0]};
    if (p.host2 >= 0) e.host2 = doc.nodes[p.host2][0];
    return e;
  });
  if (debug) debug.state.geo = geo;
  onProgress({done: 1});
  // what a warm start from this world needs
  const layout = {pos: {}, islands: {}, removed: planned.map(([a, b]) => [ids[a], ids[b]]), links: edges.map(([a, b]) => [ids[a], ids[b]])};
  for (const i of meshIds) layout.pos[ids[i]] = pos[i].slice();
  for (const c of countries) if (!meshIds.includes(c.index) && c.rings.length) {
    const r = c.rings[0];
    let x = 0, y = 0;
    for (const p of r) { x += p[0]; y += p[1]; }
    layout.islands[c.id] = [x / r.length, y / r.length];
  }
  return {countries, lakes: [], lines, exclaves, links: edges.map(([a, b]) => [a, b]), layout};
}
