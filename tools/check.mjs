// Builds worlds in Node and checks the map's three rules on each:
//   1. countries that are neighbours in the graph share a border,
//   2. countries that are not neighbours share none,
//   3. every country's area is proportional to its population (within 1%).
//
//   node tools/check.mjs                       worlds 1, 2 and 3
//   node tools/check.mjs 4 5                   worlds 4 and 5
//   node tools/check.mjs 1 --edits cut-FR-ES-add-JP-KR
//                                              world 1, then the same world with those border
//                                              edits, drawn from it as the page does
//   node tools/check.mjs --dot graph.dot 1 2   a graph of your own in place of the countries, as
//                                              the page draws a DOT file dropped on it
//   node tools/check.mjs --by gdp 1 2          the countries sized by GDP (or --by land: by land
//                                              area), as the page's "Size by" draws them
//   node tools/check.mjs 1 --years 1960,1992   world 1, then the same world in those years, as the
//                                              page's year player draws them (time.js). A year's map
//                                              is the drawn one moved, so on top of the sizes it is
//                                              checked for still being a map: no boundary crosses
//                                              another, no ring has turned over, no country lies
//                                              over another
// Exits with 1 when a rule fails.
import {readFileSync} from 'node:fs';
import {buildWorld} from '../world.js';
import {planarSubgraph} from '../planar.js';
import {graphFromDot} from '../dot.js';
import {MEASURES, measureDoc} from '../measures.js';
import {throughYears} from '../time.js';

const args = process.argv.slice(2);
const at = args.indexOf('--edits');
const editsArg = at >= 0 ? args.splice(at, 2)[1] || '' : '';
const dotAt = args.indexOf('--dot');
const dotFile = dotAt >= 0 ? args.splice(dotAt, 2)[1] : '';
const byAt = args.indexOf('--by');
const by = byAt >= 0 ? args.splice(byAt, 2)[1] || '' : '';
if (by && !MEASURES[by]) { console.error(`--by: expected one of ${Object.keys(MEASURES).filter(Boolean).join(', ')}`); process.exit(2); }
const yearsAt = args.indexOf('--years');
const years = yearsAt >= 0 ? (args.splice(yearsAt, 2)[1] || '').split(',').filter(Boolean).map(Number) : [];
if (years.length && (by || dotFile)) { console.error('--years: the years are of the countries by population'); process.exit(2); }
const seeds = args.length ? args.map(Number) : dotFile ? [1] : [1, 2, 3];
const json = name => JSON.parse(readFileSync(new URL('../' + name, import.meta.url), 'utf8'));
const doc = dotFile ? graphFromDot(readFileSync(dotFile, 'utf8'), dotFile.replace(/^.*[\\/]/, ''))
  : measureDoc(json('countries.json'), by, MEASURES[by] && MEASURES[by].data ? json(MEASURES[by].data) : null);
if (dotFile || by) console.log(`${doc.title}: ${dotFile ? doc.about + ', ' : ''}sized by ${doc.measure}`);

function parseEdits(text) {
  const words = text.split('-').filter(Boolean), list = [];
  for (let k = 0; k + 2 < words.length; k += 3) {
    if (words[k] !== 'cut' && words[k] !== 'add') throw new Error(`edits: expected cut or add, got "${words[k]}"`);
    list.push({add: words[k] === 'add', a: words[k + 1], b: words[k + 2]});
  }
  return list;
}

function edited(edits) {
  const index = new Map(doc.nodes.map((r, i) => [r[0], i]));
  const key = (a, b) => a < b ? a + '|' + b : b + '|' + a;
  const links = new Map();
  for (let i = 0; i < doc.links.length; i += 2) links.set(key(doc.nodes[doc.links[i]][0], doc.nodes[doc.links[i + 1]][0]), [doc.links[i], doc.links[i + 1]]);
  for (const e of edits) {
    if (!index.has(e.a) || !index.has(e.b)) throw new Error(`edits: unknown country ${index.has(e.a) ? e.b : e.a}`);
    if (e.add) links.set(key(e.a, e.b), [index.get(e.a), index.get(e.b)]);
    else links.delete(key(e.a, e.b));
  }
  return {...doc, links: Array.from(links.values()).flat()};
}

function check(world, graph) {
  const id = i => world.countries[i].id;
  const pair = (a, b) => [a, b].sort().join('-');
  const borders = new Set(world.lines.filter(l => l.kind === 'border').map(l => pair(id(l.a), id(l.b))));
  const wanted = new Set();
  for (let i = 0; i < graph.links.length; i += 2) {
    const a = graph.nodes[graph.links[i]], b = graph.nodes[graph.links[i + 1]];
    if (+a[4] > 0 && +b[4] > 0) wanted.add(pair(a[0], b[0]));
  }
  const missing = [...wanted].filter(p => !borders.has(p));
  const extra = [...borders].filter(p => !wanted.has(p));
  const area = c => Math.abs(c.rings.reduce((s, r) => {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
    return s + a / 2;
  }, 0));
  const land = world.countries.filter(c => c.population > 0);
  const perPerson = land.reduce((s, c) => s + area(c), 0) / land.reduce((s, c) => s + c.population, 0);
  const errors = land.map(c => [c.id, area(c) / (perPerson * c.population) - 1]);
  const off = errors.filter(([, e]) => Math.abs(e) > 0.01);
  return {pairs: wanted.size, missing, extra, off, worst: errors.reduce((m, [, e]) => Math.max(m, Math.abs(e)), 0)};
}

let failed = false;
async function run(label, graph, options) {
  const t = Date.now();
  const world = await buildWorld(graph, {planarSubgraph, ...doc.build, ...options});
  const r = check(world, graph);
  const ok = !r.missing.length && !r.extra.length && !r.off.length;
  failed ||= !ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${r.pairs - r.missing.length}/${r.pairs} neighbour pairs share a border` +
    `${r.missing.length ? ` (missing ${r.missing.join(' ')})` : ''}, ${r.extra.length} false borders${r.extra.length ? ` (${r.extra.join(' ')})` : ''}, ` +
    `${r.off.length} countries off their size by more than 1%${r.off.length ? ` (${r.off.map(([c, e]) => `${c} ${(e * 100).toFixed(1)}%`).join(', ')})` : ''}; ` +
    `${world.exclaves.length} exclaves, ${((Date.now() - t) / 1000).toFixed(1)} s`);
  return world;
}

// Is a moved map still a map? Counts the pairs of boundary pieces that cross, the rings that have
// turned over, and the pairs of countries one of which lies over the other. (Neighbours share
// their border's points exactly, so a shared border is the same pieces twice and crosses nothing.)
function sound(world, before) {
  const ids = new Map(), xs = [], ys = [];
  const idOf = p => { const key = p[0] + ',' + p[1]; let i = ids.get(key); if (i === undefined) { i = xs.length; ids.set(key, i); xs.push(p[0]); ys.push(p[1]); } return i; };
  const rings = [];
  world.countries.forEach((c, ci) => c.rings.forEach((r, ri) => rings.push({c: ci, ri, at: r.map(idOf)})));
  const pieces = new Map();
  for (const r of rings) for (let i = 0, j = r.at.length - 1; i < r.at.length; j = i++) {
    const a = Math.min(r.at[i], r.at[j]), b = Math.max(r.at[i], r.at[j]);
    if (a !== b) pieces.set(a + '|' + b, [a, b]);
  }
  const segs = [...pieces.values()];
  // crossings: pieces are compared with those in the same cells of a grid about a piece wide
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, len = 0;
  for (let i = 0; i < xs.length; ++i) { x0 = Math.min(x0, xs[i]); x1 = Math.max(x1, xs[i]); y0 = Math.min(y0, ys[i]); y1 = Math.max(y1, ys[i]); }
  for (const [a, b] of segs) len += Math.hypot(xs[a] - xs[b], ys[a] - ys[b]);
  const cell = Math.max(2 * len / Math.max(1, segs.length), 1e-9), cols = Math.ceil((x1 - x0) / cell) + 1;
  const grid = new Map();
  segs.forEach(([a, b], k) => {
    const cx0 = Math.floor((Math.min(xs[a], xs[b]) - x0) / cell), cx1 = Math.floor((Math.max(xs[a], xs[b]) - x0) / cell);
    const cy0 = Math.floor((Math.min(ys[a], ys[b]) - y0) / cell), cy1 = Math.floor((Math.max(ys[a], ys[b]) - y0) / cell);
    for (let cy = cy0; cy <= cy1; ++cy) for (let cx = cx0; cx <= cx1; ++cx) { const key = cy * cols + cx; let list = grid.get(key); if (!list) grid.set(key, list = []); list.push(k); }
  });
  const side = (a, b, c) => Math.sign((xs[b] - xs[a]) * (ys[c] - ys[a]) - (ys[b] - ys[a]) * (xs[c] - xs[a]));
  const crossed = new Set();
  for (const list of grid.values()) for (let i = 0; i < list.length; ++i) for (let j = i + 1; j < list.length; ++j) {
    const [a, b] = segs[list[i]], [c, d] = segs[list[j]];
    if (a === c || a === d || b === c || b === d) continue;
    if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) crossed.add(Math.min(list[i], list[j]) + '|' + Math.max(list[i], list[j]));
  }
  // rings turned over: the way round each goes, against the map it was moved from
  const round = r => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.sign(a); };
  const turned = rings.filter(r => round(world.countries[r.c].rings[r.ri]) !== round(before.countries[r.c].rings[r.ri])).length;
  // one country over another: a point of a ring that is not on the other country's boundary, inside it
  const own = world.countries.map(() => new Set()), box = world.countries.map(() => [Infinity, Infinity, -Infinity, -Infinity]);
  for (const r of rings) for (const i of r.at) { own[r.c].add(i); const b = box[r.c]; b[0] = Math.min(b[0], xs[i]); b[1] = Math.min(b[1], ys[i]); b[2] = Math.max(b[2], xs[i]); b[3] = Math.max(b[3], ys[i]); }
  const inside = (i, c) => {
    let odd = false;
    for (const r of rings) if (r.c === c) for (let k = 0, j = r.at.length - 1; k < r.at.length; j = k++) {
      const ax = xs[r.at[k]], ay = ys[r.at[k]], bx = xs[r.at[j]], by = ys[r.at[j]];
      if ((ay > ys[i]) !== (by > ys[i]) && xs[i] < ax + (bx - ax) * (ys[i] - ay) / (by - ay)) odd = !odd;
    }
    return odd;
  };
  const over = new Set();
  for (const r of rings) for (let c = 0; c < world.countries.length; ++c) {
    if (c === r.c || !own[c].size) continue;
    const i = r.at.find(i => !own[c].has(i));
    if (i === undefined || xs[i] < box[c][0] || xs[i] > box[c][2] || ys[i] < box[c][1] || ys[i] > box[c][3]) continue;
    if (inside(i, c)) over.add([world.countries[r.c].id, world.countries[c].id].sort().join('-'));
  }
  return {crossed: crossed.size, turned, over: [...over]};
}

// The world in other years: the years the page keeps to play through (every eighth, each worked
// out from the one after it), then the ones asked for
function throughTheYears(label, world, graph) {
  const history = json('population.json'), through = throughYears(world, history);
  for (let y = history.last - 8; y > history.first; y -= 8) through.keep(y);
  through.keep(history.first);
  for (const y of years) {
    if (!(y >= history.first && y <= history.last)) { console.error(`--years: ${y} is outside ${history.first}–${history.last}`); process.exit(2); }
    const t = Date.now(), then = through.world(y);
    const r = check(then, graph), s = sound(then, world);
    const ok = !r.missing.length && !r.extra.length && !r.off.length && !s.crossed && !s.turned && !s.over.length;
    failed ||= !ok;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label} in ${y}: ${r.off.length} countries off their size by more than 1%` +
      `${r.off.length ? ` (${r.off.map(([c, e]) => `${c} ${(e * 100).toFixed(1)}%`).join(', ')})` : ` (the worst by ${(r.worst * 100).toFixed(2)}%)`}, ` +
      `${s.crossed} crossings, ${s.turned} rings turned over, ${s.over.length} countries over another${s.over.length ? ` (${s.over.join(' ')})` : ''}; ` +
      `${((Date.now() - t) / 1000).toFixed(1)} s`);
  }
}

const edits = editsArg ? parseEdits(editsArg) : [];
for (const seed of seeds) {
  const plain = await run(`world ${seed}`, doc, {seed});
  const changed = edits.length ? await run(`world ${seed} with ${editsArg}`, edited(edits), {seed, base: plain.layout}) : null;
  if (years.length) throughTheYears(changed ? `world ${seed} with ${editsArg}` : `world ${seed}`, changed || plain, changed ? edited(edits) : doc);
}
process.exit(failed ? 1 : 0);
