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
// Exits with 1 when a rule fails.
import {readFileSync} from 'node:fs';
import {buildWorld} from '../world.js';
import {planarSubgraph} from '../planar.js';
import {graphFromDot} from '../dot.js';
import {MEASURES, measureDoc} from '../measures.js';

const args = process.argv.slice(2);
const at = args.indexOf('--edits');
const editsArg = at >= 0 ? args.splice(at, 2)[1] || '' : '';
const dotAt = args.indexOf('--dot');
const dotFile = dotAt >= 0 ? args.splice(dotAt, 2)[1] : '';
const byAt = args.indexOf('--by');
const by = byAt >= 0 ? args.splice(byAt, 2)[1] || '' : '';
if (by && !MEASURES[by]) { console.error(`--by: expected one of ${Object.keys(MEASURES).filter(Boolean).join(', ')}`); process.exit(2); }
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
  const off = land.map(c => [c.id, area(c) / (perPerson * c.population) - 1]).filter(([, e]) => Math.abs(e) > 0.01);
  return {pairs: wanted.size, missing, extra, off};
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

const edits = editsArg ? parseEdits(editsArg) : [];
for (const seed of seeds) {
  const plain = await run(`world ${seed}`, doc, {seed});
  if (edits.length) await run(`world ${seed} with ${editsArg}`, edited(edits), {seed, base: plain.layout});
}
process.exit(failed ? 1 : 0);
