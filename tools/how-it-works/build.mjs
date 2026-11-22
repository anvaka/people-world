// Builds how-it-works/index.html, the explainer on the site, from page.html here: fills in the
// figures (figs.json, from figs.mjs), the exclaves, the biome legend, the "In the code" folds and
// the appendix of every algorithm (algorithms.json), with code links at the current commit.
//   node build.mjs
import {readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(HERE, '..', '..');
const OUT = join(REPO_DIR, 'how-it-works', 'index.html');
const SHA = execFileSync('git', ['-C', REPO_DIR, 'rev-parse', 'HEAD']).toString().trim();
const REPO = 'https://github.com/anvaka/people-world';
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

// ---- algorithms: names, one-liners, refs (lines as they were at the list's base commit)
const LIST = JSON.parse(readFileSync(join(HERE, 'algorithms.json'), 'utf8'));
const OLD = LIST.base;
const slugOf = name => name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[₀-₉]/g, d => String(d.charCodeAt(0) - 0x2080)).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// a line of the base commit, found again at HEAD by its text
const changed = new Set(execFileSync('git', ['-C', REPO_DIR, 'diff', '--name-only', OLD, SHA]).toString().trim().split('\n'));
const fileCache = new Map();
const linesAt = (rev, file) => {
  const key = rev + ':' + file;
  if (!fileCache.has(key)) fileCache.set(key, execFileSync('git', ['-C', REPO_DIR, 'show', `${rev}:${file}`], {maxBuffer: 64 << 20}).toString().split('\n'));
  return fileCache.get(key);
};
const moved = [];
function lineNow(file, line) {
  if (!line || !changed.has(file)) return line;
  const text = linesAt(OLD, file)[line - 1];
  const now = linesAt(SHA, file);
  let best = -1;
  if (text && text.trim()) now.forEach((t, k) => { if (t === text && (best < 0 || Math.abs(k + 1 - line) < Math.abs(best - line))) best = k + 1; });
  if (best < 0) { moved.push(`${file}:${line} lost`); return null; }
  if (best !== line) moved.push(`${file}:${line} -> ${best}`);
  return best;
}
const urlOf = (file, line) => `${REPO}/blob/${SHA}/${file}${line ? '#L' + line : ''}`;

// the step of each algorithm
const CH_OF_BRANCH = {layout: 1, exclaves: 2, mesh: 3, lines: 7, islands: 8, edits: 12, land: 9, terrain: 9, climate: 10, page: 11, ink: 11, realm: 11, base: 13};
const GROWTH = {4: ['Capped growth from seeds', 'Power diagram start', 'Binary min-heap', 'Component cleanup'],
  5: ['Potts energy', 'Metropolis annealing', 'Simple-point test', 'Position-keyed random order', 'Active frontier set']};
const ALGOS = LIST.algorithms.map(a => {
  let ch = CH_OF_BRANCH[a.branch];
  if (a.branch === 'growth') ch = GROWTH[4].includes(a.name) ? 4 : GROWTH[5].includes(a.name) ? 5 : 6;
  if (!ch) throw new Error('no step for ' + a.name);
  return {...a, ch, refs: a.refs.map(r => ({...r, line: lineNow(r.file, r.line)})), slug: slugOf(a.name)};
});
const BY_NAME = new Map(ALGOS.map(a => [a.name, a]));

const CH_TITLE = {1: 'Discs', 2: 'Borders that can’t all exist', 3: 'Cells', 4: 'Paint', 5: 'Shaking', 6: 'Repairs', 7: 'Cells to lines',
  8: 'Islands', 9: 'Mountains and rivers', 10: 'Weather', 11: 'Drawing', 12: 'Changing a border', 13: 'Shared tools'};
const PICKS = {
  1: ['Floyd–Warshall distances', 'Stress majorization (SMACOF)', 'Constraint projection', 'Link uncrossing sweep', 'Continent orientation'],
  2: ['Left-Right planarity test', 'Kuratowski extraction', 'Implicit hitting set'],
  3: ['Graded jittered quadtree', 'Delaunay triangulation', 'Barycentric dual'],
  4: ['Capped growth from seeds', 'Binary min-heap'],
  5: ['Potts energy', 'Metropolis annealing', 'Simple-point test'],
  6: ['Border bridging', 'Reinsertion', 'Arm pruning', 'Exclave carving', 'Channel broadening'],
  7: ['Boundary chain graph', 'Guarded vertex moves', 'Taubin smoothing', 'Fractal roughening', 'Exact area fitting', 'Radial collapse', 'Gap opening'],
  8: ['Exact-area blobs', 'Expanding-ring search', 'Open-water placement'],
  9: ['Rough inland relief', 'Priority-flood', 'Flow accumulation', 'Divides into ranges', 'River extraction', 'Valleys by flow'],
  10: ['Wandering wind belts', 'Upwind moisture trace', 'Orographic rain shadow', 'Whittaker biome table'],
  11: ['Pole of inaccessibility', 'Principal-axis name fit', 'Ranked Douglas–Peucker', 'Bitmap gesture preview', 'Widest open water', 'Imhof-style shading'],
  12: ['Pull-back layout', 'Incremental planarity', 'Position-hashed jitter'],
};
const FILES = {1: 'layout.js', 2: 'planar.js', 3: 'mesh.js', 4: 'label.js', 5: 'label.js', 6: 'label.js, world.js', 7: 'geom.js, process.js',
  8: 'islands.js', 9: 'terrain.js, valleys.js', 10: 'climate.js', 11: 'index.html, styles/', 12: 'world.js'};
const refLink = r => `<a class="loc" href="${urlOf(r.file, r.line)}" target="_blank" rel="noopener">${esc(r.file)} · ${esc(r.label)}</a>`;
// the fold at the end of a step: names are plain text here (the appendix only repeats them)
function codeBox(ch) {
  const items = PICKS[ch].map(name => {
    const a = BY_NAME.get(name);
    if (!a) throw new Error('no algorithm ' + name);
    const r = a.refs.find(r => r.line) || a.refs[0];
    return `<dt>${esc(a.name)}</dt><dd>${esc(a.what)}${r ? ` ${refLink(r)}` : ''}</dd>`;
  });
  const n = ALGOS.filter(a => a.ch === ch).length;
  return `<details class="code"><summary>In the code <span class="files">${esc(FILES[ch])}</span></summary><dl>${items.join('')}</dl>` +
    `<p class="more"><a href="#group-${ch}">All ${n} algorithms of this step</a></p></details>`;
}
// the list of steps, beside the page, in its contents and in the menu on narrow screens
const STEPS = [['puzzle', '·', 'The puzzle'], ...Object.entries(CH_TITLE).filter(([c]) => c <= 12).map(([c, t]) => [
  ['discs', 'knots', 'cells', 'paint', 'shaking', 'repairs', 'lines', 'islands', 'rivers', 'weather', 'drawing', 'edits'][c - 1], c, t]),
  ['all-algorithms', '·', 'Every algorithm']];
const stepList = only12 => `<ol>${STEPS.filter(s => !only12 || /\d/.test(s[1])).map(([id, n, t]) => `<li><a href="#${id}"><span class="n">${n}</span><span class="t">${esc(t)}</span></a></li>`).join('')}</ol>`;
function appendix() {
  const out = [];
  for (let ch = 1; ch <= 13; ++ch) {
    const list = ALGOS.filter(a => a.ch === ch);
    out.push(`<details class="group" id="group-${ch}"><summary><span class="t">${ch <= 12 ? `<span class="n">${ch}</span> ` : ''}${esc(CH_TITLE[ch])}</span><span class="c">${list.length} algorithms</span></summary><dl class="algos">` +
      list.map(a => `<div id="${a.slug}"><dt>${esc(a.name)}</dt><dd>${esc(a.what)}</dd><dd class="refs">${a.refs.length ? a.refs.map(r => r.line ? refLink(r) : `<a href="${urlOf(r.file)}" target="_blank" rel="noopener">${esc(r.file)}</a>`).join('') : esc(a.where)}</dd></div>`).join('') +
      `</dl></details>`);
  }
  return out.join('\n');
}

// ---- figures and lists
const F = JSON.parse(readFileSync(join(HERE, 'figs.json'), 'utf8'));
let html = readFileSync(join(HERE, 'page.html'), 'utf8');
html = html.replace(/<!--fig:([a-z]+)(?:\.(\d))?-->/gi, (m, name, k) => {
  const v = k === undefined ? F[name] : F[name][+k];
  if (!v) throw new Error('no figure ' + m);
  return v;
});
html = html.replace('<!--exclaves-->', `<div class="panels ex">${F.exclaveList.map((e, k) => `<div><div class="frame">${F.exclaves[k]}</div><span class="tag"><span class="n">${k + 1}</span> ${esc(e.owner)}, ${e.host2 ? `on the border of ${esc(e.host)} and ${esc(e.host2)}` : `in ${esc(e.host)}`}</span></div>`).join('')}</div>`);
html = html.replace('<!--steps:12-->', stepList(true)).replaceAll('<!--steps-->', stepList(false));
const SHOWN = ['tundra', 'taiga', 'steppe', 'grassland', 'forest', 'scrub', 'desert', 'savanna', 'jungle', 'marsh', 'alpine'];
html = html.replace('<!--biomes-->', `<ul class="legend" aria-label="Legend">${SHOWN.map(b => `<li><span class="sw" style="background: var(--b-${b})"></span>${b === 'alpine' ? 'bare heights' : b}</li>`).join('')}</ul>`);
html = html.replace(/<!--code:(\d+)-->/g, (m, ch) => codeBox(+ch));
html = html.replace('<!--appendix-->', appendix());
html = html.replace('<!--sha-->', SHA.slice(0, 7));
const left = html.match(/<!--[a-z]+[:-]?[^>]*-->/g);
if (left) throw new Error('placeholders left: ' + left.join(' '));
writeFileSync(OUT, html);
console.log(`how-it-works/index.html: ${(html.length / 1024).toFixed(0)} KB, ${ALGOS.length} algorithms; ` +
  Object.entries(CH_TITLE).map(([c]) => c + ':' + ALGOS.filter(a => a.ch === +c).length).join(' '));
console.log('moved refs:', moved.length, moved.filter(m => m.includes('lost')).join(', '));
