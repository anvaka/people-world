// Cell labelling: every mesh cell is water (-1) or belongs to one label (a country or an exclave
// piece). Hard rules kept by every move:
//   - a cell may border a cell of another label only if the two labels are linked;
//   - each label stays connected and never gets a hole (simple-point test on the cell's ring);
//   - water never gets a new lake;
//   - a border between linked labels never shrinks below its required length.
// The energy (Potts boundary length + area error + a coast noise field) is minimised by
// Metropolis annealing under those rules.

import {hash2, hypot} from './util.js';

export const WATER = -1;

export function createState(mesh, NL, opts) {
  const S = {
    mesh, NL,
    lab: new Int32Array(mesh.N).fill(WATER),
    area: new Float64Array(NL),
    target: new Float64Array(NL),
    linked: new Uint8Array(NL * NL),
    pairLen: new Float64Array(NL * NL),
    need: new Float64Array(NL * NL),
    seedCell: new Int32Array(NL).fill(-1),
    noise: new Float64Array(mesh.N),
    wArea: new Float64Array(NL),
    active: new Uint8Array(NL),
    // (every field set later is here from the start, so the state keeps one shape)
    opts: {contactBonus: undefined, bridgeWiden: undefined, ...opts},
    cx: null, cy: null, _cw: null, keys: null, _ws: null, _fields: null, inner: null, why: '',
  };
  if (!('_dial' in mesh)) mesh._dial = null;
  return S;
}

export function setTargets(S) {
  const {NL, target} = S;
  const eps = S.opts.areaTol ?? 0.04;
  for (let i = 0; i < NL; ++i) S.wArea[i] = target[i] > 0 ? Math.sqrt(target[i]) / (eps * eps) : 0;
  for (let a = 0; a < NL; ++a) for (let b = 0; b < NL; ++b) {
    if (!S.linked[a * NL + b]) continue;
    S.need[a * NL + b] = (S.opts.needRel ?? 0.22) * Math.sqrt(Math.min(target[a], target[b]));
  }
}

export function recount(S) {
  const {mesh, lab, NL} = S;
  S.area.fill(0); S.pairLen.fill(0);
  for (let u = 0; u < mesh.N; ++u) {
    const a = lab[u];
    if (a < 0) continue;
    S.area[a] += mesh.area[u];
    for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) {
      const b = lab[mesh.ringNbr[k]];
      if (b >= 0 && b !== a) S.pairLen[a * NL + b] += mesh.ringLen[k] / 2;   // each edge seen from both sides
    }
  }
  // symmetrise exactly
  for (let a = 0; a < NL; ++a) for (let b = a + 1; b < NL; ++b) {
    const v = S.pairLen[a * NL + b] + S.pairLen[b * NL + a];
    S.pairLen[a * NL + b] = S.pairLen[b * NL + a] = v;
  }
}

// connected components of one label; keeps the one with the seed (else the largest)
function components(S, label, cells) {
  const {mesh, lab} = S;
  // cells already in a group: marked with this call's stamp
  const ws = workspace(S, 3);
  const mark = ++ws.mark;
  const seen = ws.stamp;
  const groups = [];
  for (const c of cells) {
    if (seen[c] === mark) continue;
    const g = [c];
    seen[c] = mark;
    for (let i = 0; i < g.length; ++i) {
      const u = g[i];
      for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) {
        const v = mesh.ringNbr[k];
        if (lab[v] === label && seen[v] !== mark) { seen[v] = mark; g.push(v); }
      }
    }
    groups.push(g);
  }
  return groups;
}

export function cellsByLabel(S) {
  const lists = Array.from({length: S.NL}, () => []);
  for (let u = 0; u < S.mesh.N; ++u) if (S.lab[u] >= 0) lists[S.lab[u]].push(u);
  return lists;
}

// keep one connected piece per label, and no contact between unlinked labels
export function enforce(S, strength) {
  const {mesh, lab, NL, linked} = S;
  for (let round = 0; round < 50; ++round) {
    let changed = 0;
    const lists = cellsByLabel(S);
    for (let a = 0; a < NL; ++a) {
      if (lists[a].length === 0) continue;
      const groups = components(S, a, lists[a]);
      if (groups.length < 2) continue;
      const seed = S.seedCell[a];
      let keep = groups.findIndex(g => g.includes(seed));
      if (keep < 0) keep = groups.reduce((best, g, i) => g.length > groups[best].length ? i : best, 0);
      groups.forEach((g, i) => { if (i !== keep) for (const u of g) { lab[u] = WATER; changed++; } });
    }
    for (let u = 0; u < mesh.N; ++u) {
      const a = lab[u];
      if (a < 0) continue;
      for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) {
        const v = mesh.ringNbr[k];
        const b = lab[v];
        if (b < 0 || b === a || linked[a * NL + b]) continue;
        // the cell less entitled to its label gives way
        const loser = u === S.seedCell[a] ? v : v === S.seedCell[b] ? u : (strength(u, a) < strength(v, b) ? u : v);
        lab[loser] = WATER;
        changed++;
        if (loser === u) break;
      }
    }
    if (!changed) break;
  }
  recount(S);
}

// ---------------------------------------------------------------------------------------------
// the move test and energy change for cell u: label a -> b
const ringLab = new Int32Array(64);
const decLab = new Int32Array(64), decLen = new Float64Array(64);

// mode 0: annealing (topology of land and water kept); 1: bridging (water may be split)
export function tryMove(S, u, b, mode = 0) {
  const {mesh, lab, NL, linked} = S;
  const a = lab[u];
  if (a === b || mesh.frozen[u]) return null;
  const s = mesh.start[u], e = mesh.start[u + 1], deg = e - s;
  for (let k = 0; k < deg; ++k) ringLab[k] = lab[mesh.ringNbr[s + k]];
  let runsA = 0, runsB = 0, countB = 0;
  for (let k = 0; k < deg; ++k) {
    const l = ringLab[k], p = ringLab[k === 0 ? deg - 1 : k - 1];
    if (l === a && p !== a) runsA++;
    if (l === b) { countB++; if (p !== b) runsB++; }
    if (b >= 0 && l >= 0 && l !== b && !linked[b * NL + l]) return null;
  }
  if (countB === deg) runsB = 1;
  // straits stay at least two cells wide: land may not take a cell whose water neighbour already
  // touches a country it must not touch
  if (b >= 0 && mode === 0 && S.opts.wideStraits && narrowsStrait(S, u, b)) return null;
  if (a >= 0 && runsA !== 1 && !(mode === 1 && runsA > 1 && stillConnected(S, u, a))) return null;
  if (a < 0 && runsA > 1 && mode === 0) return null;
  if (b < 0 ? runsB < 1 : runsB !== 1) return null;
  // borders of a must not shrink below their need
  let nd = 0;
  if (a >= 0) {
    for (let k = 0; k < deg; ++k) {
      const x = ringLab[k];
      if (x < 0 || x === a) continue;
      let j = 0;
      while (j < nd && decLab[j] !== x) j++;
      if (j === nd) { decLab[nd] = x; decLen[nd] = 0; nd++; }
      decLen[j] += mesh.ringLen[s + k];
    }
    for (let j = 0; j < nd; ++j) {
      const x = decLab[j];
      if (x === b || !linked[a * NL + x]) continue;
      const before = S.pairLen[a * NL + x], after = before - decLen[j];
      if (after < S.need[a * NL + x] && after < before - 1e-12) return null;
    }
  }
  return true;
}

export function narrowsStrait(S, u, b) {
  const {mesh, lab, NL, linked} = S;
  for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) {
    const v = mesh.ringNbr[k];
    if (lab[v] !== WATER) continue;
    for (let j = mesh.start[v]; j < mesh.start[v + 1]; ++j) {
      const z = lab[mesh.ringNbr[j]];
      if (z >= 0 && z !== b && !linked[b * NL + z]) return true;
    }
  }
  return false;
}

export function applyMove(S, u, b) {
  const {mesh, lab, NL} = S;
  const a = lab[u];
  const s = mesh.start[u], e = mesh.start[u + 1];
  for (let k = s; k < e; ++k) {
    const x = lab[mesh.ringNbr[k]], len = mesh.ringLen[k];
    if (x >= 0 && a >= 0 && x !== a) { S.pairLen[a * NL + x] -= len; S.pairLen[x * NL + a] -= len; }
    if (x >= 0 && b >= 0 && x !== b) { S.pairLen[b * NL + x] += len; S.pairLen[x * NL + b] += len; }
  }
  if (a >= 0) S.area[a] -= mesh.area[u];
  if (b >= 0) S.area[b] += mesh.area[u];
  lab[u] = b;
}

function areaCost(S, i, A) {
  const t = S.target[i];
  const d = (A - t) / t;
  return S.wArea[i] * d * d;
}

export function deltaE(S, u, b) {
  const {mesh, lab} = S;
  const a = lab[u];
  const wC = S.opts.coastWeight ?? 1, wB = 1;
  let dE = 0;
  for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) {
    const x = lab[mesh.ringNbr[k]], len = mesh.ringLen[k];
    const after = x === b ? 0 : (x < 0 || b < 0) ? wC : wB;
    const before = x === a ? 0 : (x < 0 || a < 0) ? wC : wB;
    dE += (after - before) * len;
  }
  const al = mesh.area[u];
  if (a >= 0) dE += areaCost(S, a, S.area[a] - al) - areaCost(S, a, S.area[a]);
  if (b >= 0) dE += areaCost(S, b, S.area[b] + al) - areaCost(S, b, S.area[b]);
  dE += S.noise[u] * mesh.hloc[u] * ((b >= 0 ? 1 : 0) - (a >= 0 ? 1 : 0));
  // compactness: land far from its country's centre costs (pulls arms in, keeps shapes round)
  const ls = S.opts.compact ?? 0;
  if (ls > 0 && S.cx) {
    const x = mesh.coords[2 * u], y = mesh.coords[2 * u + 1], h = mesh.hloc[u];
    if (b >= 0) dE += ls * h * ((x - S.cx[b]) ** 2 + (y - S.cy[b]) ** 2) / S.target[b];
    if (a >= 0) dE -= ls * h * ((x - S.cx[a]) ** 2 + (y - S.cy[a]) ** 2) / S.target[a];
  }
  // borders still shorter than they need to be pull like a spring
  const beta = S.opts.contactBonus ?? 3;
  if (beta > 0) {
    const {NL, linked} = S;
    const s = mesh.start[u], e = mesh.start[u + 1];
    let nd = 0;
    for (let k = s; k < e; ++k) {
      const x = lab[mesh.ringNbr[k]];
      if (x < 0) continue;
      let j = 0;
      while (j < nd && decLab[j] !== x) j++;
      if (j === nd) { decLab[nd] = x; decLen[nd] = 0; nd++; }
      decLen[j] += mesh.ringLen[k];
    }
    for (let j = 0; j < nd; ++j) {
      const x = decLab[j], l = decLen[j];
      if (a >= 0 && x !== a && linked[a * NL + x]) {
        const L0 = S.pairLen[a * NL + x], nd0 = S.need[a * NL + x];
        dE -= beta * (Math.min(L0 - l, nd0) - Math.min(L0, nd0));
      }
      if (b >= 0 && x !== b && linked[b * NL + x]) {
        const L0 = S.pairLen[b * NL + x], nd0 = S.need[b * NL + x];
        dE -= beta * (Math.min(L0 + l, nd0) - Math.min(L0, nd0));
      }
    }
  }
  return dE;
}

// Every cell's key: a hash of where it is. Annealing visits cells in key order and draws its
// random numbers from (key, sweep), never from a running random sequence, so where the map is the
// same it anneals the same way, whatever changed elsewhere.
function cellKeys(S) {
  if (S.keys) return S.keys;
  const {mesh} = S;
  const key = new Int32Array(mesh.N);
  const movable = [];
  for (let u = 0; u < mesh.N; ++u) {
    const qx = Math.round(mesh.coords[2 * u] * 4096), qy = Math.round(mesh.coords[2 * u + 1] * 4096);
    key[u] = Math.floor(hash2(qx, qy, S.opts.seed ?? 1) * 2147483647);
    if (!mesh.frozen[u]) movable.push(u);
  }
  movable.sort((u, v) => key[u] - key[v] || mesh.coords[2 * u] - mesh.coords[2 * v]);
  const order = Int32Array.from(movable);
  // each cell's place in that order (-1: not visited)
  const rank = new Int32Array(mesh.N).fill(-1);
  for (let i = 0; i < order.length; ++i) rank[order[i]] = i;
  return (S.keys = {key, order, rank});
}

// opts.near: only cells of these labels, or touching them, are visited (a local repair anneals
// its own neighbourhood, not the whole map). opts.tag: varies the random numbers between calls
// that are otherwise alike.
export function anneal(S, rng, sweeps, tau0, tau1 = 0, opts = {}) {
  const {mesh, lab} = S;
  const keys = cellKeys(S), key = keys.key;
  let order = keys.order;
  if (opts.near) {
    // (a mask over the labels: the same test as a set lookup, faster)
    const mask = new Uint8Array(S.NL);
    let water = false;
    for (const l of opts.near) { if (l >= 0 && l < S.NL) mask[l] = 1; else if (l === WATER) water = true; }
    const isNear = l => (l >= 0 ? mask[l] === 1 : water && l === WATER);
    // (cells looked at in index order, then put back in visiting order by their rank)
    const start = mesh.start, ringNbr = mesh.ringNbr, rank = keys.rank, all = order;
    const kept = new Int32Array(all.length);
    let n = 0;
    for (let u = 0; u < mesh.N; ++u) {
      if (rank[u] < 0) continue;
      let hit = isNear(lab[u]);
      for (let k = start[u]; !hit && k < start[u + 1]; ++k) hit = isNear(lab[ringNbr[k]]);
      if (hit) kept[n++] = rank[u];
    }
    const ranks = kept.subarray(0, n).sort();
    for (let i = 0; i < n; ++i) ranks[i] = all[ranks[i]];
    order = ranks;
  }
  const call = ((opts.tag ?? 0) * 7919 + sweeps * 131 + Math.round(tau0 * 1000) * 17 + Math.round(tau1 * 1000)) | 0;
  const M = order.length;
  let accepted = 0;
  // cells on an edge between labels (or land and water), kept current as cells change: a cell
  // inside one label draws a neighbour of its own label and nothing happens, so it is skipped
  const N = mesh.N, start = mesh.start, ringNbr = mesh.ringNbr;
  const edge = v => { const l = lab[v]; for (let k = start[v]; k < start[v + 1]; ++k) if (lab[ringNbr[k]] !== l) return 1; return 0; };
  const onEdge = new Uint8Array(N);
  if (M > N >> 2) for (let u = 0; u < N; ++u) onEdge[u] = edge(u);
  else for (let i = 0; i < M; ++i) onEdge[order[i]] = edge(order[i]);
  for (let sw = 0; sw < sweeps; ++sw) {
    if (S.opts.compact) centroids(S);
    const f = sweeps > 1 ? sw / (sweeps - 1) : 1;
    const tau = tau0 + (tau1 - tau0) * f;
    const salt = call * 1009 + sw;
    for (let it = 0; it < M; ++it) {
      const u = order[sw % 2 ? M - 1 - it : it];
      if (!onEdge[u]) continue;
      const s = mesh.start[u], deg = mesh.start[u + 1] - s;
      const a = lab[u];
      const b = lab[mesh.ringNbr[s + Math.floor(hash2(key[u], salt, 17) * deg)]];
      if (b === a) continue;
      if (a < 0) {
        // a water cell only turns to land if it touches land
      }
      // (the energy test first: it is cheaper and rejects more; both must pass)
      const dE = deltaE(S, u, b);
      if (!(dE <= 0 || (tau > 0 && hash2(key[u], salt, 29) < Math.exp(-dE / (tau * mesh.hloc[u]))))) continue;
      if (!tryMove(S, u, b)) continue;
      applyMove(S, u, b);
      accepted++;
      onEdge[u] = edge(u);
      for (let k = start[u]; k < start[u + 1]; ++k) onEdge[ringNbr[k]] = edge(ringNbr[k]);
    }
  }
  return accepted;
}

export function centroids(S) {
  const {mesh, lab, NL} = S;
  const cx = S.cx || (S.cx = new Float64Array(NL)), cy = S.cy || (S.cy = new Float64Array(NL));
  const w = S._cw || (S._cw = new Float64Array(NL));
  cx.fill(0); cy.fill(0); w.fill(0);
  centroidSums(lab, mesh.area, mesh.coords, mesh.N, cx, cy, w);
  centroidMeans(cx, cy, w, NL);
}
// (two small functions rather than two loops in one: each is compiled with its own feedback)
function centroidSums(lab, area, coords, N, cx, cy, w) {
  for (let u = 0; u < N; ++u) {
    const a = lab[u];
    if (a < 0) continue;
    const m = area[u];
    cx[a] += coords[2 * u] * m; cy[a] += coords[2 * u + 1] * m; w[a] += m;
  }
}
function centroidMeans(cx, cy, w, NL) {
  for (let a = 0; a < NL; ++a) if (w[a] > 0) { cx[a] /= w[a]; cy[a] /= w[a]; }
}

export function missingPairs(S, pairs) {
  const out = [];
  for (const [a, b] of pairs) if (S.pairLen[a * S.NL + b] < S.need[a * S.NL + b] * 0.999) out.push([a, b, S.pairLen[a * S.NL + b]]);
  return out;
}

// false contacts (should never happen)
export function falseContacts(S) {
  const {mesh, lab, NL, linked} = S;
  const bad = new Set();
  for (let u = 0; u < mesh.N; ++u) {
    const a = lab[u];
    if (a < 0) continue;
    for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) {
      const b = lab[mesh.ringNbr[k]];
      if (b >= 0 && b !== a && !linked[a * NL + b]) bad.add(Math.min(a, b) + ',' + Math.max(a, b));
    }
  }
  return [...bad];
}

// is label a still connected without cell u? (global check, used only when bridging)
function stillConnected(S, u, a) {
  const {mesh, lab} = S;
  let first = -1;
  const ring = [];
  for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) if (lab[mesh.ringNbr[k]] === a) ring.push(mesh.ringNbr[k]);
  if (!ring.length) return false;
  first = ring[0];
  const want = new Set(ring);
  const seen = new Set([u, first]);
  want.delete(first);
  const stack = [first];
  while (stack.length && want.size) {
    const c = stack.pop();
    for (let k = mesh.start[c]; k < mesh.start[c + 1]; ++k) {
      const v = mesh.ringNbr[k];
      if (lab[v] !== a || seen.has(v)) continue;
      seen.add(v);
      want.delete(v);
      stack.push(v);
    }
  }
  return want.size === 0;
}

// ---------------------------------------------------------------------------------------------
// Bridge a missing border: the two labels grow arms toward each other along the cheapest path
// of cells each of them may legally take (water is cheap, a linked third country's land dearer).
function canTake(S, u, X) {
  const {mesh, lab, NL, linked} = S;
  if (mesh.frozen[u]) return false;
  const y = lab[u];
  if (y === X) return true;
  if (y >= 0 && !linked[X * NL + y]) return false;
  for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) {
    const l = lab[mesh.ringNbr[k]];
    if (l >= 0 && l !== X && !linked[X * NL + l]) return false;
  }
  return true;
}

// binary min-heap of (key, cell) over typed arrays (the same sift order as a plain array heap)
class Heap {
  constructor(cap = 1024) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  grow() {
    const k = new Float64Array(this.k.length * 2), v = new Int32Array(this.v.length * 2);
    k.set(this.k); v.set(this.v);
    this.k = k; this.v = v;
  }
  push(key, val) {
    if (this.n === this.k.length) this.grow();
    const k = this.k, v = this.v;
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0], last = --this.n;
    const lk = k[last], lv = v[last];
    if (last > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= last) break;
        if (c + 1 < last && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
  clear() { this.n = 0; }
  get size() { return this.n; }
}

function workspace(S, k) {
  S._ws = S._ws || [];
  const N = S.mesh.N;
  if (!S._ws[k]) S._ws[k] = {dist: new Float64Array(N), prev: new Int32Array(N), stamp: new Uint32Array(N), mark: 0, list: [], take: new Uint32Array(N)};
  return S._ws[k];
}

// cheapest paths from the cells of X over cells X may legally take (typed-array workspace)
function fieldFrom(S, X, cells, banned, limit, landCost, ws) {
  const {mesh, lab} = S;
  const m = ++ws.mark;
  const {dist, prev, stamp, take} = ws;
  const list = ws.list;
  list.length = 0;
  const heap = new Heap();
  for (const c of cells) if (lab[c] === X && stamp[c] !== m) { stamp[c] = m; dist[c] = 0; prev[c] = -1; list.push(c); heap.push(0, c); }
  while (heap.size) {
    const u = heap.pop();
    const du = dist[u];
    if (du > limit) break;
    for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) {
      const v = mesh.ringNbr[k];
      if (lab[v] === X || banned.has(v)) continue;
      if (lab[v] >= 0 && !landCost) continue;
      const dv = du + mesh.hloc[v] * (lab[v] < 0 ? 1 : landCost);
      if (stamp[v] === m && dv >= dist[v]) continue;
      // (whether X may take v does not change during the search: worked out once per cell)
      if (take[v] >>> 1 !== m) take[v] = (m << 1) | (canTake(S, v, X) ? 1 : 0);
      if (!(take[v] & 1)) continue;
      if (stamp[v] !== m) { stamp[v] = m; list.push(v); }
      dist[v] = dv; prev[v] = u;
      heap.push(dv, v);
    }
  }
  return {has: v => stamp[v] === m, get: v => dist[v], prevOf: v => prev[v], list};
}

export function bridge(S, A, B, lists, reach = 4, absLimit = Infinity) {
  const {mesh, lab} = S;
  const banned = new Set();
  const limit = Math.min(absLimit, reach * (Math.sqrt(S.target[A]) + Math.sqrt(S.target[B])));
  const wa = workspace(S, 0), wb = workspace(S, 1);
  for (let attempt = 0; attempt < 12; ++attempt) {
    const landCost = attempt < 3 ? 0 : 4;
    const fa = fieldFrom(S, A, lists[A], banned, limit, landCost, wa), fb = fieldFrom(S, B, lists[B], banned, limit, landCost, wb);
    // the best meeting edge
    let best = Infinity, bu = -1, bv = -1;
    for (const u of fa.list) {
      const du = fa.get(u);
      for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) {
        const v = mesh.ringNbr[k];
        if (!fb.has(v)) continue;
        if (lab[u] === B || lab[v] === A) continue;
        const d = du + fb.get(v);
        if (d < best && d <= limit) { best = d; bu = u; bv = v; }
      }
    }
    if (bu < 0) {
      S.why = 'nopath' + attempt;
      if (landCost === 0) { attempt = 2; continue; }
      return false;
    }
    const pathA = [], pathB = [];
    for (let c = bu; lab[c] !== A; c = fa.prevOf(c)) pathA.push(c);
    for (let c = bv; lab[c] !== B; c = fb.prevOf(c)) pathB.push(c);
    pathA.reverse(); pathB.reverse();
    const inA = new Set(pathA);
    const clash = pathB.find(c => inA.has(c));
    if (clash !== undefined) { banned.add(clash); continue; }
    const done = [];
    let failed = -1;
    const order = [];
    for (let i = 0; i < Math.max(pathA.length, pathB.length); ++i) {
      if (i < pathA.length) order.push([pathA[i], A]);
      if (i < pathB.length) order.push([pathB[i], B]);
    }
    for (const [c, X] of order) {
      if (lab[c] === X) continue;
      if (!tryMove(S, c, X, 1)) { failed = c; S.why = 'move:' + lab[c] + '->' + X + ':' + whyNot(S, c, X); break; }
      done.push([c, lab[c]]);
      applyMove(S, c, X);
    }
    if (failed < 0) {
      for (const [c] of done) lists[lab[c]].push(c);
      // widen the new corridor by a ring of cells on each side where the rules allow, so the
      // contact is not made through a one-cell sliver
      for (let ring = 0; ring < (S.opts.bridgeWiden ?? 1); ++ring) {
        const path = done.map(([c]) => c);
        for (const c of path) {
          const X = lab[c];
          for (let k = mesh.start[c]; k < mesh.start[c + 1]; ++k) {
            const v = mesh.ringNbr[k];
            if (lab[v] === X || lab[v] === A || lab[v] === B) continue;
            if (!tryMove(S, v, X, 0)) continue;
            done.push([v, lab[v]]);
            applyMove(S, v, X);
            lists[X].push(v);
          }
        }
      }
      return true;
    }
    for (let i = done.length - 1; i >= 0; --i) applyMove(S, done[i][0], done[i][1]);
    banned.add(failed);
  }
  return false;
}

export function whyNot(S, u, b) {
  const {mesh, lab, NL, linked} = S;
  const a = lab[u];
  const s = mesh.start[u], e = mesh.start[u + 1], deg = e - s;
  let runsA = 0, runsB = 0, countB = 0;
  for (let k = 0; k < deg; ++k) {
    const l = lab[mesh.ringNbr[s + k]], p = lab[mesh.ringNbr[s + (k === 0 ? deg - 1 : k - 1)]];
    if (l === a && p !== a) runsA++;
    if (l === b) { countB++; if (p !== b) runsB++; }
    if (b >= 0 && l >= 0 && l !== b && !linked[b * NL + l]) return 'unlinked ' + l;
  }
  return `runsA ${runsA} runsB ${runsB} count ${countB}/${deg}`;
}

// ---------------------------------------------------------------------------------------------
// Distance field (sum of cell sizes along the cheapest path) from the cells of some labels.
// Every cell within `limit` gets its exact cheapest-path distance, and every cell just beyond it
// the cheapest distance through a cell within it (others stay Infinity): what Dijkstra's
// algorithm with a binary heap gives, whatever order equal keys come in. Run on a bucket queue
// (Dial's algorithm): a step costs at least twice the bucket width, so a cell is final when its
// bucket comes up and the cells of one bucket can be settled in any order.
function bucketPlan(mesh) {
  if (mesh._dial) return mesh._dial;
  let hmin = Infinity, hmax = 0;
  for (let u = 0; u < mesh.N; ++u) { const h = mesh.hloc[u]; if (h > 0 && h < hmin) hmin = h; if (h > hmax) hmax = h; }
  const width = 0.5 * hmin;
  const B = Math.floor(hmax / width) + 4;
  return (mesh._dial = {width, B, buckets: Array.from({length: B}, () => [])});
}

// `needed`: the cells whose distance the caller reads; the search may stop once they are settled.
// (A source cell whose neighbours are all sources is not expanded: that would change nothing.)
export function distanceField(S, sources, limit, passable = null, needed = null) {
  const {mesh} = S;
  const N = mesh.N, start = mesh.start, ringNbr = mesh.ringNbr, hloc = mesh.hloc, frozen = mesh.frozen;
  // (the array comes from a pool: callers hand it back with releaseField when done with it)
  const dist = (S._fields && S._fields.pop()) || new Float64Array(N);
  dist.fill(Infinity);
  const ws = workspace(S, 5), mark = ++ws.mark, seen = ws.stamp;
  const {width, B, buckets} = bucketPlan(mesh);
  let pending = 0;
  for (const c of sources) dist[c] = 0;
  const b0 = buckets[0];
  for (const c of sources) {
    if (seen[c] === mark) continue;
    seen[c] = mark;
    let inner = true;
    for (let k = start[c]; k < start[c + 1]; ++k) {
      const v = ringNbr[k];
      if (dist[v] !== 0 && !frozen[v] && !(passable && !passable(v))) { inner = false; break; }
    }
    if (!inner) { b0.push(c); pending++; }
  }
  for (const c of b0) seen[c] = 0;
  let want = 0;
  const isNeeded = needed ? new Uint8Array(N) : null;
  if (needed) for (const c of needed) if (!isNeeded[c] && dist[c] !== 0) { isNeeded[c] = 1; want++; }
  for (let b = 0; pending > 0; ++b) {
    if ((b - 1) * width > limit) break;     // (one bucket of slack for rounding)
    if (needed && want === 0) break;
    const bucket = buckets[b % B];
    while (bucket.length) {
      const u = bucket.pop();
      pending--;
      if (seen[u] === mark) continue;
      const du = dist[u];
      if (du > limit) continue;
      seen[u] = mark;
      if (isNeeded && isNeeded[u]) want--;
      const hu = hloc[u];
      for (let k = start[u]; k < start[u + 1]; ++k) {
        const v = ringNbr[k];
        if (frozen[v] || (passable && !passable(v))) continue;
        const dv = du + 0.5 * (hu + hloc[v]);
        if (dv < dist[v]) { dist[v] = dv; buckets[Math.floor(dv / width) % B].push(v); pending++; }
      }
    }
  }
  // leave the shared buckets empty
  if (pending > 0) for (const bucket of buckets) bucket.length = 0;
  return dist;
}

// a distance field's array, back to the pool
export function releaseField(S, f) { (S._fields || (S._fields = [])).push(f); }

// A bucket queue on the shared buckets (see distanceField): cells come out in buckets of growing
// distance; a cell may be pushed more than once, and the caller skips those already settled.
function bucketQueue(mesh) {
  const {width, B, buckets} = bucketPlan(mesh);
  let cur = 0, pending = 0;
  return {
    push(v, d) { buckets[Math.floor(d / width) % B].push(v); pending++; },
    pop() {
      while (pending > 0) {
        const bucket = buckets[cur % B];
        if (bucket.length) { pending--; return bucket.pop(); }
        cur++;
      }
      return -1;
    },
  };
}

// Depth of every cell of a region (the cells of one label, or water when `water`) below the
// region's edge: half a cell at the edge, plus steps of half the two cells' sizes inward. Exact
// shortest paths, as with a heap.
function edgeDepth(S, water) {
  const {mesh, lab} = S;
  const N = mesh.N, start = mesh.start, ringNbr = mesh.ringNbr, hloc = mesh.hloc;
  const depth = new Float64Array(N).fill(Infinity);
  const ws = workspace(S, 6), mark = ++ws.mark, done = ws.stamp;
  const q = bucketQueue(mesh);
  for (let u = 0; u < N; ++u) {
    const a = lab[u];
    if (water ? a !== WATER : a < 0) continue;
    for (let j = start[u]; j < start[u + 1]; ++j) if (lab[ringNbr[j]] !== a) { depth[u] = hloc[u] / 2; q.push(u, depth[u]); break; }
  }
  for (let u; (u = q.pop()) >= 0;) {
    if (done[u] === mark) continue;
    done[u] = mark;
    const a = lab[u], du = depth[u], hu = hloc[u];
    for (let j = start[u]; j < start[u + 1]; ++j) {
      const v = ringNbr[j];
      if (lab[v] !== a) continue;
      const d = du + 0.5 * (hu + hloc[v]);
      if (d < depth[v]) { depth[v] = d; q.push(v, d); }
    }
  }
  return depth;
}

// From the cells where cover is 0, the distance within each region to every cell that lies
// within reach(v, label) of them (others stay Infinity)
function coverFrom(S, cover, reach) {
  const {mesh, lab} = S;
  const N = mesh.N, start = mesh.start, ringNbr = mesh.ringNbr, hloc = mesh.hloc;
  const ws = workspace(S, 6), mark = ++ws.mark, done = ws.stamp;
  const q = bucketQueue(mesh);
  for (let u = 0; u < N; ++u) if (cover[u] === 0) q.push(u, 0);
  for (let u; (u = q.pop()) >= 0;) {
    if (done[u] === mark) continue;
    done[u] = mark;
    const a = lab[u], cu = cover[u], hu = hloc[u];
    for (let j = start[u]; j < start[u + 1]; ++j) {
      const v = ringNbr[j];
      if (lab[v] !== a) continue;
      const d = cu + 0.5 * (hu + hloc[v]);
      if (d < cover[v] && d <= reach(v, a)) { cover[v] = d; q.push(v, d); }
    }
  }
  return cover;
}

export function snapshot(S) { return Int32Array.from(S.lab); }
export function restore(S, snap) { S.lab.set(snap); recount(S); }

// grow label X from cell `centre` over cells it may legally take until it reaches `area`
export function growBlob(S, X, centre, area, mayTake) {
  const {mesh, lab} = S;
  const heap = new Heap();
  // cells already queued: marked with this call's stamp
  const ws = workspace(S, 2);
  const mark = ++ws.mark;
  const seen = ws.stamp;
  seen[centre] = mark;
  heap.push(0, centre);
  const cx = mesh.coords[2 * centre], cy = mesh.coords[2 * centre + 1];
  let got = S.area[X] || 0;
  let first = true;
  while (heap.size && got < area) {
    const u = heap.pop();
    if (lab[u] !== X) {
      if (!mayTake(u) || !canTake(S, u, X)) continue;
      if (first) {
        // the first cell starts a new region: only its old owner's connectivity matters
        const a = lab[u];
        if (a >= 0 && !stillConnected(S, u, a)) continue;
        applyMove(S, u, X);
        first = false;
      } else {
        if (!tryMove(S, u, X, 1)) continue;
        applyMove(S, u, X);
      }
      got = S.area[X];
    }
    for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) {
      const v = mesh.ringNbr[k];
      if (seen[v] === mark || mesh.frozen[v]) continue;
      seen[v] = mark;
      heap.push(hypot(mesh.coords[2 * v] - cx, mesh.coords[2 * v + 1] - cy), v);
    }
  }
  return got;
}

// Remove label X and grow it again where all its neighbours are closest.
export function reinsert(S, X, nbrs) {
  const {mesh, lab, NL} = S;
  const cells = [];
  for (let u = 0; u < mesh.N; ++u) if (lab[u] === X) cells.push(u);
  if (!cells.length) return false;
  for (const u of cells) applyMove(S, u, WATER);
  const rho = Math.sqrt(S.target[X] / Math.PI);
  const lists = cellsByLabel(S);
  // (the score below saturates once a field passes 10.6 rho, so the fields only need to reach
  // 12 rho: farther cells score the same; dBad only matters below 1.4 rho)
  const limit = Math.min(8 * rho + 20 * Math.sqrt(S.target[X]), 12 * rho);
  const fields = nbrs.map(Y => distanceField(S, lists[Y], limit));
  const bad = [];
  const ok = new Uint8Array(NL);
  for (const Y of nbrs) ok[Y] = 1;
  // (only the edge of the bad land: dBad is read on water and ok land alone, which the inner
  // cells of the bad land reach only through its edge)
  for (let u = 0; u < mesh.N; ++u) {
    if (lab[u] < 0 || ok[lab[u]]) continue;
    for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) { const y = lab[mesh.ringNbr[k]]; if (y < 0 || ok[y]) { bad.push(u); break; } }
  }
  const dBad = distanceField(S, bad, 1.5 * rho);
  let best = -1, bestScore = Infinity;
  for (let u = 0; u < mesh.N; ++u) {
    if (mesh.frozen[u]) continue;
    const y = lab[u];
    if (y >= 0 && !ok[y]) continue;
    // primary: how many neighbours lie within reach of a blob here; secondary: how far the rest are
    let sc = 0, reached = 0;
    for (const f of fields) { const d = Math.max(0, f[u] - 0.6 * rho); if (d === 0) reached++; sc += Math.min(d * d, 100 * rho * rho); }
    sc -= reached * 1000 * rho * rho;
    if (dBad[u] < 1.4 * rho) sc += 50 * (1.4 * rho - dBad[u]) ** 2 + 3e3 * rho * rho * (dBad[u] < 0.5 * rho);
    if (sc < bestScore) { bestScore = sc; best = u; }
  }
  for (const f of fields) releaseField(S, f);
  releaseField(S, dBad);
  if (best < 0) return false;
  growBlob(S, X, best, S.target[X], () => true);
  return S.area[X] > 0;
}

export function linksOf(S, X, pairsList) {
  return pairsList.filter(([a, b]) => a === X || b === X).map(([a, b]) => a === X ? b : a);
}

// carve a piece of label P (an exclave of some owner) out of host H, near `toward` cells.
// First choice: inside the host, away from every other label. Fallback: in the sea against the
// host's coast (a piece that touches nothing but the host and water).
export function carveExclave(S, P, H, area, toward, H2 = -1) {
  const {mesh, lab} = S;
  const lists = cellsByLabel(S);
  const rho = Math.sqrt(area / Math.PI);
  // (only the edge of the other land: dOther is read on the hosts and water alone, which the
  // inner cells of the other land reach only through its edge)
  const others = [];
  for (let u = 0; u < mesh.N; ++u) {
    const a = lab[u];
    if (a < 0 || a === H || a === H2) continue;
    for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) { const y = lab[mesh.ringNbr[k]]; if (y < 0 || y === H || y === H2) { others.push(u); break; } }
  }
  const dOther = distanceField(S, others, 4 * rho + 1);
  // dToward is read on the hosts' cells and the water next to them only
  const needed = [];
  for (const L of H2 >= 0 ? [H, H2] : [H]) for (const u of lists[L]) {
    needed.push(u);
    for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) needed.push(mesh.ringNbr[k]);
  }
  const dToward = distanceField(S, toward, Infinity, null, needed);
  try {
    return carveWith(S, P, H, area, H2, lists, rho, dOther, dToward);
  } finally {
    releaseField(S, dOther); releaseField(S, dToward);
  }
}

function carveWith(S, P, H, area, H2, lists, rho, dOther, dToward) {
  const {mesh, lab} = S;
  const tryAt = (cands, mayTake) => {
    cands.sort((a, b) => a[1] - b[1]);
    // (a piece on the border of two hosts takes a stretch of that border: it must leave the hosts
    // a border of their own, at least half of what they had or of what they need. The first cell
    // of a piece is taken without the border test, and a short border could vanish under it.)
    const hh = H2 >= 0 ? H * S.NL + H2 : -1;
    const keep = hh >= 0 ? 0.5 * Math.min(S.pairLen[hh], S.need[hh]) : 0;
    for (const [u] of cands.slice(0, 6)) {
      const snap = snapshot(S);
      growBlob(S, P, u, area, mayTake);
      const ok = S.area[P] >= 0.6 * area && (H2 < 0 || S.pairLen[P * S.NL + H] > 0 && S.pairLen[P * S.NL + H2] > 0 && S.pairLen[hh] > 0 && S.pairLen[hh] >= keep);
      if (ok) return true;
      restore(S, snap);
    }
    return false;
  };
  if (H2 >= 0) {
    // on the border of the two hosts
    const cands = [];
    for (const u of lists[H]) {
      if (dOther[u] < 0.5 * rho) continue;
      let touches = false;
      for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) if (lab[mesh.ringNbr[k]] === H2) touches = true;
      if (touches) cands.push([u, dToward[u] - 2 * Math.min(dOther[u], 3 * rho)]);
    }
    if (!cands.length) return false;
    // also try from the H2 side of the border
    for (const u of lists[H2]) {
      if (dOther[u] < 0.5 * rho) continue;
      for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) if (lab[mesh.ringNbr[k]] === H) { cands.push([u, dToward[u] - 2 * Math.min(dOther[u], 3 * rho)]); break; }
    }
    return tryAt(cands, u => lab[u] === H || lab[u] === H2 || lab[u] === WATER);
  }
  // inside the host
  const inner = [];
  for (const u of lists[H]) if (dOther[u] >= 1.3 * rho) inner.push([u, dToward[u]]);
  if (inner.length && tryAt(inner, u => lab[u] === H || lab[u] === WATER)) return true;
  // in the host, wherever there is most room
  const roomy = lists[H].map(u => [u, -dOther[u]]);
  if (roomy.length && tryAt(roomy, u => lab[u] === H || lab[u] === WATER)) return true;
  // in the sea along the host's coast
  const coast = [];
  for (let u = 0; u < mesh.N; ++u) {
    if (lab[u] !== WATER || mesh.frozen[u]) continue;
    let touchesH = false, ok = true;
    for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) {
      const l = lab[mesh.ringNbr[k]];
      if (l === H) touchesH = true;
      else if (l >= 0) ok = false;
    }
    if (touchesH && ok && dOther[u] >= 0.8 * rho) coast.push([u, dToward[u] - 3 * Math.min(dOther[u], 2 * rho)]);
  }
  if (coast.length && tryAt(coast, u => lab[u] === WATER)) return true;
  return false;
}

// Capped growth from seeds (how fantasy generators expand states): every country's front advances
// at a speed proportional to its size and stops at its target area; a cell next to a country it
// may not touch is left to someone else (or to the sea). Small countries keep a round blob at
// their seed, big ones flow around them.
export function growFromSeeds(S, seeds, speed, costOf, fill = 1.0) {
  const {mesh, lab, NL, linked} = S;
  lab.fill(WATER);
  const area = new Float64Array(NL);
  const heap = new Heap();
  // keys must be unique-ish per (cell, label): encode label in a parallel array
  const entLab = [];
  const push = (key, cell, l) => { entLab.push(l); heap.push(key, (entLab.length - 1) * 0 + cell * NL + l); };
  for (const [l, c] of seeds) {
    if (lab[c] !== WATER) continue;
    lab[c] = l; area[l] += mesh.area[c];
    for (let k = mesh.start[c]; k < mesh.start[c + 1]; ++k) {
      const v = mesh.ringNbr[k];
      if (!mesh.frozen[v]) push(costOf(v) / speed[l], v, l);
    }
  }
  const dist = new Float64Array(mesh.N * 0 + 1);
  void dist;
  while (heap.size) {
    const key = heap.k[0];
    const code = heap.pop();
    const u = Math.floor(code / NL), l = code - u * NL;
    if (lab[u] !== WATER || area[l] >= fill * S.target[l]) continue;
    let ok = true;
    for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) {
      const x = lab[mesh.ringNbr[k]];
      if (x >= 0 && x !== l && !linked[l * NL + x]) { ok = false; break; }
    }
    if (!ok || (S.opts.wideStraits && narrowsStrait(S, u, l))) continue;
    lab[u] = l; area[l] += mesh.area[u];
    for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) {
      const v = mesh.ringNbr[k];
      if (lab[v] === WATER && !mesh.frozen[v]) push(key + costOf(v) / speed[l], v, l);
    }
  }
}

// Arms: cells farther than k * R from their country's centre (R = radius of a disc of its area)
// are given up to an adjacent country that may take them, else to the sea. Returns cells changed.
export function pruneArms(S, labels, k, keep = () => false) {
  const {mesh, lab, NL, linked} = S;
  // pole of each label: its thickest point (largest distance to its own boundary)
  const depth = edgeDepth(S, false);
  const pole = new Int32Array(NL).fill(-1);
  for (let u = 0; u < mesh.N; ++u) {
    const a = lab[u];
    if (a >= 0 && (pole[a] < 0 || depth[u] > depth[pole[a]])) pole[a] = u;
  }
  let changed = 0;
  const far = [];
  const isL = new Uint8Array(NL);
  for (const l of labels) isL[l] = 1;
  for (let u = 0; u < mesh.N; ++u) {
    const a = lab[u];
    if (a < 0 || !isL[a] || keep(a) || pole[a] < 0) continue;
    const R = Math.sqrt(S.target[a] / Math.PI);
    const p = pole[a];
    const d = hypot(mesh.coords[2 * u] - mesh.coords[2 * p], mesh.coords[2 * u + 1] - mesh.coords[2 * p + 1]);
    const kk = typeof k === 'function' ? k(a) : k;
    if (d > kk * R) far.push([d / R, u]);
  }
  far.sort((x, y) => y[0] - x[0]);
  const count = new Map();
  for (const [, u] of far) {
    const a = lab[u];
    count.clear();
    for (let j = mesh.start[u]; j < mesh.start[u + 1]; ++j) {
      const y = lab[mesh.ringNbr[j]];
      if (y >= 0 && y !== a) count.set(y, (count.get(y) || 0) + 1);
    }
    let best = WATER, bc = 0;
    for (const [y, c] of count) {
      if (c <= bc) continue;
      // y may take u only if every labelled neighbour of u is y, linked to y, or a (which loses u)
      let ok = true;
      for (let j = mesh.start[u]; j < mesh.start[u + 1]; ++j) {
        const z = lab[mesh.ringNbr[j]];
        if (z >= 0 && z !== y && z !== a && !linked[y * NL + z]) { ok = false; break; }
        if (z === a && !linked[y * NL + a]) { ok = false; break; }
      }
      if (ok) { best = y; bc = c; }
    }
    lab[u] = best;
    changed++;
  }
  return changed;
}

// Long channels (water that keeps two countries apart that may not touch) become broad seas: land
// within a noise-modulated width of the channel turns to water (each cell only if the hard rules
// allow it), and the sea is frozen so annealing cannot squeeze it back into a canal.
export function broadenChannels(S, opts) {
  const {mesh, lab, NL, linked} = S;
  const N = mesh.N;
  // water cells next to (within two rings of) two countries that may not touch
  const chan = new Uint8Array(N);
  const near = [];
  for (let u = 0; u < N; ++u) {
    if (lab[u] !== WATER || mesh.frozen[u] && !S.inner?.[u]) continue;
    near.length = 0;
    for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) {
      const v = mesh.ringNbr[k];
      if (lab[v] >= 0) near.push(lab[v]);
      else for (let j = mesh.start[v]; j < mesh.start[v + 1]; ++j) { const z = lab[mesh.ringNbr[j]]; if (z >= 0) near.push(z); }
    }
    outer: for (let i = 0; i < near.length; ++i) for (let j = i + 1; j < near.length; ++j) {
      const a = near[i], b = near[j];
      if (a !== b && !linked[a * NL + b]) { chan[u] = 1; break outer; }
    }
  }
  // channel bodies: connected channel cells
  const comp = new Int32Array(N).fill(-1);
  const bodies = [];
  for (let u = 0; u < N; ++u) {
    if (!chan[u] || comp[u] >= 0) continue;
    const cells = [u];
    comp[u] = bodies.length;
    for (let i = 0; i < cells.length; ++i) {
      const c = cells[i];
      for (let k = mesh.start[c]; k < mesh.start[c + 1]; ++k) {
        const v = mesh.ringNbr[k];
        if (chan[v] && comp[v] < 0) { comp[v] = bodies.length; cells.push(v); }
      }
    }
    bodies.push(cells);
  }
  let carved = 0;
  const lost = new Map();
  const heap = new Heap();
  const ws = workspace(S, 4), dist = ws.dist, dstamp = ws.stamp;
  for (const cells of bodies) {
    // length of the body: its largest extent
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, hsum = 0;
    for (const c of cells) {
      const x = mesh.coords[2 * c], y = mesh.coords[2 * c + 1];
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      hsum += mesh.hloc[c];
    }
    const h = hsum / cells.length;
    const length = hypot(x1 - x0, y1 - y0);
    // the countries along it: only channels long for their size, between countries big enough to
    // give up a coast, become seas
    const along = new Set();
    for (const c of cells) for (let k = mesh.start[c]; k < mesh.start[c + 1]; ++k) { const z = lab[mesh.ringNbr[k]]; if (z >= 0) along.add(z); }
    const radii = [...along].map(z => Math.sqrt(S.target[z] / Math.PI)).sort((a, b) => a - b);
    if (!radii.length) continue;
    const Rmed = radii[radii.length >> 1];
    if (length < opts.minLength * h || length < opts.minRel * Rmed || Rmed < opts.minR) continue;
    // widen: distance field from the body over land and water, then carve within w(x)
    const width = Math.min(opts.maxWidth, opts.widthRel * length, opts.bandR * radii[radii.length - 1] * 1.6);
    // distances of this body: valid where the stamp is this body's
    const mark = ++ws.mark;
    heap.clear();
    for (const c of cells) { dstamp[c] = mark; dist[c] = 0; heap.push(0, c); }
    const order = [];
    while (heap.size) {
      const u = heap.pop();
      const du = dist[u];
      const x = mesh.coords[2 * u], y = mesh.coords[2 * u + 1];
      const nz = 1 + opts.noiseAmp * opts.noise(x, y);
      if (du > width * nz) continue;
      // each country gives up a shore band in proportion to its own size
      if (lab[u] >= 0 && du > opts.bandR * Math.sqrt(S.target[lab[u]] / Math.PI) * nz) continue;
      order.push(u);
      for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) {
        const v = mesh.ringNbr[k];
        if (mesh.frozen[v] && !S.inner?.[v]) continue;
        const dv = du + 0.5 * (mesh.hloc[u] + mesh.hloc[v]);
        if (dv < (dstamp[v] === mark ? dist[v] : Infinity)) { dstamp[v] = mark; dist[v] = dv; heap.push(dv, v); }
      }
    }
    // carve in distance order, so the sea grows outward from the channel; only countries much
    // bigger than the band give up land, and none more than a tenth of itself
    for (const u of order) {
      const a = lab[u];
      if (a >= 0) {
        // small countries give up little: losing a coastal band makes them regrow as a ribbon
        const Ra = Math.sqrt(S.target[a] / Math.PI);
        const cap = opts.maxLoss * Math.min(1, (Ra / (opts.fullR || 3)) ** 2);
        if ((lost.get(a) || 0) + mesh.area[u] > cap * S.target[a]) continue;
        if (!tryMove(S, u, WATER, 0)) continue;
        applyMove(S, u, WATER);
        lost.set(a, (lost.get(a) || 0) + mesh.area[u]);
        carved++;
      }
    }
    // freeze the sea (the water cells of this body and what was carved)
    for (const u of order) if (lab[u] === WATER) { mesh.frozen[u] = 1; (S.inner || (S.inner = new Uint8Array(N)))[u] = 1; }
  }
  // but not its fingers: a frozen cell that is not mostly surrounded by water is released, so land
  // may close it again (otherwise it ends up as a hairline of water between two countries)
  if (S.inner) for (let pass = 0; pass < 30; ++pass) {
    let released = 0;
    for (let u = 0; u < N; ++u) {
      if (!S.inner[u]) continue;
      let w = 0;
      for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) { const v = mesh.ringNbr[k]; if (lab[v] === WATER && (mesh.frozen[v] || S.inner[v])) w++; }
      if (w <= 2) { S.inner[u] = 0; mesh.frozen[u] = 0; released++; }
    }
    if (!released) break;
  }
  return {bodies: bodies.length, carved};
}

// Thin parts (ribbons, necks, slivers): a morphological opening of each country with a disc of
// radius rel * R. Cells not covered by any such disc that fits inside the country are given to a
// neighbour that may take them, or to the sea. The thickest part of the country always stays.
export function pruneThin(S, labels, rel, keep = () => false, minFrac = 0, dryRun = false) {
  const {mesh, lab, NL, linked} = S;
  const N = mesh.N;
  const depth = edgeDepth(S, false);
  const isL = new Uint8Array(NL);
  for (const l of labels) if (!keep(l)) isL[l] = 1;
  const maxDepth = new Float64Array(NL);
  for (let u = 0; u < N; ++u) { const a = lab[u]; if (a >= 0 && depth[u] > maxDepth[a]) maxDepth[a] = depth[u]; }
  const r = new Float64Array(NL);
  for (let a = 0; a < NL; ++a) if (isL[a]) r[a] = dryRun ? rel * Math.sqrt(S.target[a] / Math.PI) : Math.min(rel * Math.sqrt(S.target[a] / Math.PI), 0.8 * maxDepth[a]);
  // dilate the cores (cells with depth >= r) back by r, inside the country
  const cover = new Float64Array(N).fill(Infinity);
  for (let u = 0; u < N; ++u) { const a = lab[u]; if (a >= 0 && isL[a] && depth[u] >= r[a]) cover[u] = 0; }
  coverFrom(S, cover, (v, a) => 1.35 * r[a] + mesh.hloc[v]);
  // only countries that are substantially thin (a ribbon or a long arm), not every rough edge
  const thinArea = new Float64Array(NL);
  for (let u = 0; u < N; ++u) { const a = lab[u]; if (a >= 0 && isL[a] && cover[u] === Infinity) thinArea[a] += mesh.area[u]; }
  if (dryRun) { for (let a = 0; a < NL; ++a) thinArea[a] = S.area[a] > 0 ? thinArea[a] / S.area[a] : 0; return thinArea; }
  const thin = [];
  for (let u = 0; u < N; ++u) { const a = lab[u]; if (a >= 0 && isL[a] && cover[u] === Infinity && thinArea[a] > minFrac * S.target[a]) thin.push([depth[u], u]); }
  // outermost first
  thin.sort((x, y) => x[0] - y[0]);
  const count = new Map();
  let changed = 0;
  for (const [, u] of thin) {
    const a = lab[u];
    count.clear();
    for (let j = mesh.start[u]; j < mesh.start[u + 1]; ++j) {
      const y = lab[mesh.ringNbr[j]];
      if (y >= 0 && y !== a) count.set(y, (count.get(y) || 0) + 1);
    }
    let best = WATER, bc = 0;
    for (const [y, c] of count) {
      if (c <= bc) continue;
      let ok = true;
      for (let j = mesh.start[u]; j < mesh.start[u + 1]; ++j) {
        const z = lab[mesh.ringNbr[j]];
        if (z >= 0 && z !== y && z !== a && !linked[y * NL + z]) { ok = false; break; }
        if (z === a && !linked[y * NL + a]) { ok = false; break; }
      }
      if (ok) { best = y; bc = c; }
    }
    lab[u] = best;
    changed++;
  }
  // the seed of each country moves to its thickest cell, so the clean-up keeps the main body
  const pole = new Int32Array(NL).fill(-1);
  for (let u = 0; u < N; ++u) { const a = lab[u]; if (a >= 0 && (pole[a] < 0 || depth[u] > depth[pole[a]])) pole[a] = u; }
  for (let a = 0; a < NL; ++a) if (isL[a] && pole[a] >= 0) S.seedCell[a] = pole[a];
  return changed;
}

// Water fingers (inlets one cell wide) end up as hairlines once the coast is smoothed: fill them
// from the tip with the land around them, wherever the rules allow (never between countries that
// must not touch: those straits stay).
export function fillFingers(S, passes = 20) {
  const {mesh, lab} = S;
  let filled = 0;
  const count = new Map();
  for (let pass = 0; pass < passes; ++pass) {
    let changed = 0;
    for (let u = 0; u < mesh.N; ++u) {
      if (lab[u] !== WATER || (mesh.frozen[u] && !S.inner?.[u])) continue;
      let w = 0;
      count.clear();
      for (let k = mesh.start[u]; k < mesh.start[u + 1]; ++k) {
        const y = lab[mesh.ringNbr[k]];
        if (y === WATER) w++;
        else count.set(y, (count.get(y) || 0) + 1);
      }
      if (w > 2 || !count.size) continue;
      let best = -1, bc = 0;
      for (const [y, c] of count) if (c > bc) { bc = c; best = y; }
      if (!tryMove(S, u, best, 0)) continue;
      applyMove(S, u, best);
      if (S.inner) { S.inner[u] = 0; mesh.frozen[u] = 0; }
      changed++;
    }
    filled += changed;
    if (!changed) break;
  }
  return filled;
}

// Thin water (inlets and creeks narrower than ~2 * k cells) is filled with the surrounding land
// where the rules allow; straits between countries that must not touch stay.
export function fillThinWater(S, k = 1.5, passes = 6) {
  const {mesh, lab} = S;
  const N = mesh.N;
  let total = 0;
  for (let pass = 0; pass < passes; ++pass) {
    const depth = edgeDepth(S, true);
    const cover = new Float64Array(N).fill(Infinity);
    for (let u = 0; u < N; ++u) if (lab[u] === WATER && depth[u] >= k * mesh.hloc[u]) cover[u] = 0;
    coverFrom(S, cover, v => 1.35 * k * mesh.hloc[v] + mesh.hloc[v]);
    const thin = [];
    for (let u = 0; u < N; ++u) if (lab[u] === WATER && cover[u] === Infinity && !(mesh.frozen[u] && !S.inner?.[u])) thin.push([depth[u], u]);
    thin.sort((a, b) => a[0] - b[0]);
    let changed = 0;
    const count = new Map();
    for (const [, u] of thin) {
      if (lab[u] !== WATER) continue;
      count.clear();
      for (let j = mesh.start[u]; j < mesh.start[u + 1]; ++j) { const y = lab[mesh.ringNbr[j]]; if (y >= 0) count.set(y, (count.get(y) || 0) + 1); }
      const cands = [...count].sort((a, b) => b[1] - a[1]);
      for (const [y] of cands) {
        if (!tryMove(S, u, y, 0)) continue;
        applyMove(S, u, y);
        if (S.inner) { S.inner[u] = 0; mesh.frozen[u] = 0; }
        changed++;
        break;
      }
    }
    total += changed;
    if (!changed) break;
  }
  return total;
}
