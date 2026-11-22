// Builds world 1 and keeps a picture's worth of data from each stage for the explainer's figures:
// discs, the cut link, the mesh, cells while they grow, after annealing and repairs, the lines as
// they are smoothed and fitted, and the finished world. Writes data/*.json (about 30 MB, not kept
// in git).
//   node capture.mjs [seed]
//
// The engine has no hooks for this, so the script copies the project's files into .engine/ and
// adds two there: a snapshot at every stage of buildWorld, and one each time growth paints a cell.
// If a change to world.js or label.js moves the lines they hang on, the script says so and stops.
import {readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const ENGINE = join(HERE, '.engine');
const DATA = join(HERE, 'data');

// ---- the engine, copied and hooked
rmSync(ENGINE, {recursive: true, force: true});
for (const file of execFileSync('git', ['-C', REPO, 'ls-files'], {encoding: 'utf8'}).trim().split('\n')) {
  if (!/\.(js|json)$/.test(file) || file.startsWith('tools/') || file.startsWith('how-it-works/')) continue;
  mkdirSync(dirname(join(ENGINE, file)), {recursive: true});
  copyFileSync(join(REPO, file), join(ENGINE, file));
}
function hook(file, from, to) {
  const path = join(ENGINE, file);
  const text = readFileSync(path, 'utf8');
  if (!text.includes(from)) throw new Error(`${file}: the line the snapshot hook hangs on has changed:\n  ${from}`);
  writeFileSync(path, text.replace(from, to));
}
const LIVE = ['S', 'mesh', 'pos', 'geoPos', 'rad', 'meshIds', 'planned', 'pieces', 'geo', 'tiny', 'edges', 'landComps', 'trueTarget'];
const live = '{' + LIVE.map(v => `get ${v}() { try { return ${v}; } catch { return null; } }`).join(', ') + '}';
hook('world.js', 'const stage = name => { if (timings) timings.push([name, now() - tStart]); };',
  `const stage = name => { if (timings) timings.push([name, now() - tStart]); if (options.snap) options.snap(name, ${live}); };`);
hook('label.js', 'lab[u] = l; area[l] += mesh.area[u];', 'lab[u] = l; area[l] += mesh.area[u]; if (globalThis.GROWSNAP) globalThis.GROWSNAP(lab, key);');

const load = file => import(pathToFileURL(join(ENGINE, file)).href);
const {buildWorld} = await load('world.js');
const {planarSubgraph, kuratowskiSubgraph} = await load('planar.js');
const {measureDoc} = await load('measures.js');
const {extractBoundary, Geo} = await load('geom.js');

const seed = +(process.argv[2] || 1);
const doc = measureDoc(JSON.parse(readFileSync(join(ENGINE, 'countries.json'), 'utf8')), '', null);
const n = doc.nodes.length;
const r2 = v => Math.round(v * 100) / 100;
const out = {seed, nodes: doc.nodes.map(r => ({id: r[0], name: r[1], continent: r[3], pop: +r[4] || 0}))};
mkdirSync(DATA, {recursive: true});
const save = (name, data) => { writeFileSync(join(DATA, name + '.json'), JSON.stringify(data)); console.log('saved', name, (JSON.stringify(data).length / 1024).toFixed(0) + ' KB'); };

// polygons of a labelling: label -> rings of [x, y] (y as the page draws it, north up)
function ringsOf(geo, ownerOf = l => l) {
  const polys = {};
  for (const [l, rings] of geo.rings()) {
    const o = ownerOf(l);
    for (const ring of rings) (polys[o] ||= []).push(geo.ringPoints(ring).map(p => [r2(geo.vx[p]), r2(-geo.vy[p])]));
  }
  return polys;
}
function linesOf(geo, ownerOf = l => l) {
  return geo.chains.map(c => ({a: c.L >= 0 ? ownerOf(c.L) : -1, b: c.R >= 0 ? ownerOf(c.R) : -1, p: c.v.map(p => [r2(geo.vx[p]), r2(-geo.vy[p])])}));
}
const geoOfLabels = (mesh, lab) => {
  const bd = extractBoundary(mesh, lab);
  return new Geo(bd.vx, bd.vy, bd.chains, {linked: () => true, clearance: () => 0, maxClearance: 0.5});
};

const kept = {};
let meshRef = null, piecesRef = [];
const ownerOf = l => l < n ? l : (piecesRef.find(p => p.label === l) || {owner: l}).owner;
const growFrames = [];
let grown = 0;
globalThis.GROWSNAP = lab => { if (++grown % 1500 === 0) growFrames.push(Int32Array.from(lab)); };

const t0 = Date.now();
const world = await buildWorld(doc, {seed, planarSubgraph, snap(name, live) {
  if (name === 'layout1') kept.layout1 = {pos: [...live.geoPos].map(([i, p]) => [i, r2(p[0]), r2(-p[1])]), rad: live.rad.map(r2)};
  if (name === 'exclaveChoice') kept.planned = live.planned.map(e => e.slice());
  if (name === 'layout2') kept.layout2 = {pos: live.pos.map(p => p && [r2(p[0]), r2(-p[1])]), rad: live.rad.map(r2), meshIds: live.landComps.flat()};
  if (name === 'mesh') { meshRef = live.mesh; kept.meshN = live.mesh.N; }
  if (['growth', 'anneal', 'bridges', 'armsRibbons', 'exclaves', 'labelDone'].includes(name)) {
    piecesRef = live.pieces || [];
    const geo = geoOfLabels(meshRef, live.S.lab);
    kept['lab-' + name] = {polys: ringsOf(geo, ownerOf), lines: linesOf(geo, ownerOf)};
  }
  if (['boundary', 'smooth', 'roughen', 'tiny', 'cleanup'].includes(name)) {
    kept['geo-' + name] = {polys: ringsOf(live.geo, ownerOf), lines: linesOf(live.geo, ownerOf)};
    if (name === 'cleanup') kept.pieces = {raw: Object.fromEntries(Object.entries(ringsOf(live.geo)).filter(([l]) => +l >= n)), pieces: live.pieces.map(p => ({...p}))};
  }
}});
console.log(`world ${seed} built in ${Date.now() - t0} ms; ${growFrames.length} growth frames`);

out.world = {
  countries: world.countries.map(c => ({id: c.id, rings: c.rings.map(r => r.map(([x, y]) => [r2(x), r2(-y)]))})),
  lines: world.lines.map(l => ({a: l.a, b: l.b, kind: l.kind, p: l.points.map(([x, y]) => [r2(x), r2(-y)])})),
  exclaves: world.exclaves,
  links: world.links,
};
save('world', out);
save('layout', {layout1: kept.layout1, layout2: kept.layout2, planned: kept.planned, links: world.links, meshN: kept.meshN});
for (const k of Object.keys(kept)) if (k.startsWith('lab-') || k.startsWith('geo-')) save(k, kept[k]);

// cells of the mesh, every one of them, as polygons (for crops)
{
  const lab = new Int32Array(meshRef.N);
  for (let u = 0; u < meshRef.N; ++u) lab[u] = meshRef.frozen[u] ? -1 : u;
  const geo = geoOfLabels(meshRef, lab);
  const cells = ringsOf(geo);
  const pts = [];
  for (let u = 0; u < meshRef.N; ++u) pts.push([r2(meshRef.coords[2 * u]), r2(-meshRef.coords[2 * u + 1])]);
  save('mesh', {cells, pts});
}
// growth frames as country polygons
save('growth', growFrames.filter((f, k) => k % 2 === 1).map(lab => ringsOf(geoOfLabels(meshRef, lab))));

// the terrain, valleys and climate parts, as they are
{
  const T = world.terrain, C = world.climate;
  const r3 = v => Math.round(v * 1000) / 1000;
  save('terrain', {grid: T.grid, shown: T.shown, mountain: Array.from(T.mountain, r3), rivers: T.rivers.map(r => {
    const p = []; for (let k = 0; k + 1 < r.points.length; k += 2) p.push([r2(r.points[k]), r2(-r.points[k + 1])]);
    return {p, flow: Array.from(r.flow, r3)};
  })});
  save('climate', {grid: C.grid, biomes: C.biomes, biome: Array.from(C.biome), winds: C.winds});
}

save('pieces', kept.pieces);
// the same world with the France–Spain border taken away, drawn from it as the page does
{
  const index = new Map(doc.nodes.map((r, i) => [r[0], i]));
  const fr = index.get('FR'), es = index.get('ES');
  const links = [];
  for (let i = 0; i < doc.links.length; i += 2) { const a = doc.links[i], b = doc.links[i + 1]; if ((a === fr && b === es) || (a === es && b === fr)) continue; links.push(a, b); }
  const t1 = Date.now();
  const edited = await buildWorld({...doc, links}, {seed, planarSubgraph, base: world.layout});
  console.log(`edited world in ${Date.now() - t1} ms`);
  save('edited', {countries: edited.countries.map(c => ({id: c.id, rings: c.rings.map(r => r.map(([x, y]) => [r2(x), r2(-y)]))})), lines: edited.lines.map(l => ({a: l.a, b: l.b, kind: l.kind, p: l.points.map(([x, y]) => [r2(x), r2(-y)])})), exclaves: edited.exclaves});
}
// a knot: a Kuratowski subgraph of the countries' border graph
{
  const edges = [];
  for (let i = 0; i < doc.links.length; i += 2) edges.push([doc.links[i], doc.links[i + 1]]);
  const k = kuratowskiSubgraph(n, edges, 1);
  save('knot', {k, edges});
}
rmSync(ENGINE, {recursive: true, force: true});
