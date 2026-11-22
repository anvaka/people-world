// Every vector figure of the walkthrough, as SVG text, into figs.json: {name: svg}.
// Colours come from CSS classes the page themes (see the .fig rules in page.html). Each figure's
// svg carries an f-* class, so the page can set its label size on a phone.
import {writeFileSync} from 'node:fs';
import {W, load, Fig, finalPolys, colour, indexOf, nameOf, centre, degree} from './render.mjs';
import {pngDataUri} from './png.mjs';

const F = {};
const L = load('layout');
const WORLD = [-74, -53, 104, 52];
const EUROPE = [4, -40, 36, -14];
const ringArea = r => { let A = 0; for (let k = 0; k < r.length; ++k) { const [x0, y0] = r[k], [x1, y1] = r[(k + 1) % r.length]; A += x0 * y1 - x1 * y0; } return Math.abs(A) / 2; };

// ---- 1. discs and links, the whole world
{
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const i of L.layout2.meshIds) { const [x, y] = L.layout2.pos[i], r = L.layout2.rad[i]; bx0 = Math.min(bx0, x - r); bx1 = Math.max(bx1, x + r); by0 = Math.min(by0, y - r); by1 = Math.max(by1, y + r); }
  const g = new Fig([bx0 - 3, by0 - 3, bx1 + 3, by1 + 3], 1000);
  let d = '';
  for (const i of L.layout2.meshIds) { const [x, y] = L.layout2.pos[i]; d += `<circle cx="${g.X(x)}" cy="${g.Y(y)}" r="${g.len(L.layout2.rad[i])}"/>`; }
  const plannedKey = new Set(L.planned.map(([a, b]) => a + ',' + b));
  const links = [], cut = [];
  for (const [a, b] of L.links) {
    const p = L.layout2.pos[a], q = L.layout2.pos[b];
    if (!p || !q) continue;
    (plannedKey.has(a + ',' + b) || plannedKey.has(b + ',' + a) ? cut : links).push([p, q]);
  }
  const ids = ['IN', 'CN', 'US', 'ID', 'PK', 'NG', 'BR', 'RU', 'BD', 'EG', 'MX', 'ET'];
  const minor = new Set(['PK', 'EG', 'MX', 'ET']);
  const at = Object.fromEntries(ids.map(id => [id, L.layout2.pos[indexOf(id)]]));
  F.discs = g.svg(g.sea() + `<g class="disc">${d}</g><path class="link" d="${g.d(links, false)}"/><path class="link cut" d="${g.d(cut, false)}"/>` +
    g.labels(ids, {}, {size: 15, at, cls: id => minor.has(id) ? 'lbl minor' : 'lbl'}),
    {label: 'World 1 as discs: each country a disc whose area is its population, with a line between every pair of neighbours', cls: 'fig f-discs'});
}

// ---- 2. the knot, drawn by hand: three across the top, three along the bottom. Iran sits under
// Russia, so the long way round through China and Pakistan crosses nothing on its way.
{
  const P = {AM: [24, 20], TR: [70, 20], RU: [116, 20], GE: [24, 70], AZ: [80, 70], IR: [116, 70], CN: [146, 32], PK: [146, 58]};
  const e = [['AM', 'GE'], ['AM', 'IR'], ['AM', 'AZ'], ['TR', 'GE'], ['TR', 'IR'], ['TR', 'AZ'], ['RU', 'GE'], ['RU', 'AZ']];
  let s = '';
  for (const [a, b] of e) s += `<path class="${a === 'AM' && b === 'GE' ? 'k-cut' : 'k-edge'}" d="M${P[a]}L${P[b]}"/>`;
  s += `<path class="k-edge" d="M${P.RU}Q140 20 ${P.CN}L${P.PK}Q140 70 ${P.IR}"/>`;
  for (const [id, [x, y]] of Object.entries(P)) {
    const small = id === 'CN' || id === 'PK';
    s += `<circle class="${small ? 'k-via' : 'k-node'}" cx="${x}" cy="${y}" r="${small ? 2.4 : 3.6}"/>`;
    const name = nameOf(indexOf(id));
    s += `<text class="k-lbl${small ? ' k-small' : ''}" x="${small ? x + 5 : x}" y="${small ? y : y > 40 ? y + 11 : y - 8}" text-anchor="${small ? 'start' : 'middle'}" dominant-baseline="central">${name}</text>`;
  }
  F.knot = `<svg class="fig knot" viewBox="0 0 180 90" role="img" aria-label="Armenia, Turkey and Russia each border Georgia, Azerbaijan and Iran, Russia by way of China and Pakistan: nine borders that cannot all be drawn without a crossing">${s}</svg>`;
}

const pieces = load('pieces');
// ---- 3. Georgia's piece, on the finished map, with all six countries of the knot named
// Armenia's name left of the ring, Turkey's lower right, so the note beside the ring has room
const CAUCASUS_AT = {AM: [11.9, -12.7], TR: [19, -10.4]};
{
  const g = new Fig([3, -24, 23, -8], 800);
  const GE = indexOf('GE');
  const piece = pieces.pieces.find(p => p.owner === GE);
  const pc = centre(pieces.raw[piece.label]);
  F.caucasus = g.svg(g.sea() + g.fills(finalPolys, l => 'c' + colour[l] + (l === GE ? ' hl-fill' : '')) + g.strokes(W.world.lines) +
    `<circle class="ring" cx="${g.X(pc[0])}" cy="${g.Y(pc[1])}" r="${g.len(0.9)}"/>` +
    g.labels(['GE', 'AM', 'AZ', 'TR', 'RU', 'IR'], finalPolys, {size: 30, at: CAUCASUS_AT}) +
    `<text class="lbl note" x="${g.X(pc[0] + 1.05)}" y="${g.Y(pc[1] - 0.2)}" font-size="26" dominant-baseline="central">a piece of Georgia</text>`,
    {label: 'The Caucasus in world 1: a small piece of Georgia sits on the border of Armenia and Turkey', cls: 'fig f-caucasus'});
}

// ---- 4. the cells, with the smallest countries named
{
  const g = new Fig([9, -34, 27, -22], 900);
  const M = load('mesh');
  const seen = new Set();
  const runs = [];
  for (const r of Object.values(M.cells).flat()) {
    if (!r.some(([x, y]) => x > g.cbox[0] && x < g.cbox[2] && y > g.cbox[1] && y < g.cbox[3])) continue;
    let run = null;
    for (let k = 0; k < r.length; ++k) {
      const p = r[k], q = r[(k + 1) % r.length];
      const a = g.X(p[0]) + ',' + g.Y(p[1]), b = g.X(q[0]) + ',' + g.Y(q[1]);
      const key = a < b ? a + '|' + b : b + '|' + a;
      if (a === b) continue;
      if (seen.has(key)) { run = null; continue; }
      seen.add(key);
      if (!run) runs.push(run = [p]);
      run.push(q);
    }
  }
  let d = '';
  for (const i of L.layout2.meshIds) {
    const [x, y] = L.layout2.pos[i], r = L.layout2.rad[i];
    if (x + r > g.box[0] && x - r < g.box[2] && y + r > g.box[1] && y - r < g.box[3]) d += `<circle cx="${g.X(x)}" cy="${g.Y(y)}" r="${g.len(r)}"/>`;
  }
  const mean = ids => ids.map(id => L.layout2.pos[indexOf(id)]).reduce((s, p, _, a) => [s[0] + p[0] / a.length, s[1] + p[1] / a.length], [0, 0]);
  // each name beside its patch, on the side with room: the Baltic states sit at the left edge,
  // Luxembourg at the right, the three Alpine ones low in the middle
  const groups = [[['LU'], 'Luxembourg', 'end'], [['EE', 'LV', 'LT'], 'the Baltic states', 'start'], [['LI', 'SM', 'VA'], 'Liechtenstein, San Marino, the Vatican', 'end']];
  let names = '';
  for (const [ids, text, anchor] of groups) {
    const [x, y] = mean(ids);
    const xs = ids.map(id => L.layout2.pos[indexOf(id)][0]);
    const gap = 0.45;
    const lx = anchor === 'start' ? Math.max(...xs) + gap : Math.min(...xs) - gap;
    names += `<text class="lbl" x="${g.X(lx)}" y="${g.Y(y)}" font-size="17" text-anchor="${anchor}" dominant-baseline="central">${text}</text>`;
  }
  F.mesh = g.svg(g.sea() + `<path class="cell" d="${g.d(runs, false)}"/><g class="disc outline">${d}</g>` + names,
    {label: 'The cells over part of Europe: small where small countries sit, large elsewhere', cls: 'fig f-mesh'});
}

// ---- 5. paint spreading: three moments and the end, with five countries named in each
{
  const g = new Fig(EUROPE, 480);
  const G = load('growth');
  const end = load('lab-growth');
  const ids = ['DE', 'FR', 'PL', 'IT', 'UA'];
  const at = Object.fromEntries(ids.map(id => [id, centre(end.polys[indexOf(id)])]));
  const names = g.labels(ids, end.polys, {size: 26, at});
  F.growth = [1, 3, 6].map(k => g.svg(g.sea() + g.fills(G[k]) + names, {label: 'Countries spreading from their seeds', cls: 'fig f-growth'}))
    .concat([g.svg(g.sea() + g.fills(end.polys) + g.strokes(end.lines) + names, {label: 'Every country at its size', cls: 'fig f-growth'})]);
}

// ---- 6. annealing: before and after, close up
{
  const g = new Fig([7, -37, 29, -21], 600);
  const ids = ['DE', 'PL', 'CZ', 'AT', 'HU', 'UA', 'BY'];
  F.anneal = [load('lab-growth'), load('lab-anneal')].map((S, k) => g.svg(g.sea() + g.fills(S.polys) + g.strokes(S.lines) + g.labels(ids, S.polys, {size: 18}),
    {label: k ? 'After annealing: rounder countries with shorter borders' : 'Straight after growth: ragged countries', cls: 'fig f-anneal'}));
}

// ---- 7. the exclaves of world 1, each close up: the owner tinted one colour, the country around it another
{
  F.exclaves = [];
  F.exclaveList = [];
  for (const p of pieces.pieces) {
    const rs = pieces.raw[p.label];
    const r = Math.sqrt(rs.reduce((s, q) => s + ringArea(q), 0) / Math.PI);
    const c = centre(rs), h = Math.min(4, Math.max(1.1, r * 6));
    const g = new Fig([c[0] - h, c[1] - h, c[0] + h, c[1] + h], 300);
    const hosts = new Set([p.host, p.host2]);
    const cls = l => 'c' + colour[l] + (l === p.owner ? ' hl-fill' : hosts.has(l) ? ' hl2-fill' : '');
    const item = {owner: nameOf(p.owner), host: nameOf(p.host), host2: p.host2 >= 0 ? nameOf(p.host2) : null};
    F.exclaveList.push(item);
    F.exclaves.push(g.svg(g.sea() + g.fills(finalPolys, cls) + g.strokes(W.world.lines) +
      `<circle class="ring" cx="${g.X(c[0])}" cy="${g.Y(c[1])}" r="${g.len(Math.max(r * 1.9, h * 0.2))}"/>`,
      {label: `A piece of ${item.owner} inside ${item.host}${item.host2 ? ' and ' + item.host2 : ''}`, cls: 'fig f-exclave'}));
  }
}

// ---- 8. cells to lines: the staircase, smoothed, finished
{
  const g = new Fig([16, -28.2, 19.6, -25.8], 420);
  F.lines = ['geo-boundary', 'geo-smooth', 'geo-cleanup'].map((s, k) => { const S = load(s); return g.svg(g.sea() + g.fills(S.polys) + g.strokes(S.lines) + g.labels(['CZ', 'SK'], S.polys, {size: 22}), {label: ['Borders along the cell edges', 'Smoothed', 'Roughened and fitted to size'][k], cls: 'fig f-lines'}); });
}

// ---- 9. islands: south-west of the main land
{
  const g = new Fig([-75, 1, -37, 27], 800);
  const island = l => degree(l) === 0;
  F.islands = g.svg(g.sea() + g.fills(finalPolys, l => island(l) ? 'isl' : 'c' + colour[l]) + g.strokes(W.world.lines) +
    g.labels(['PH', 'AU', 'NZ', 'ID', 'BD', 'TH'], finalPolys, {size: 16}), {label: 'Island countries off the south-west of the main land: the Philippines, Australia, New Zealand and the Pacific islands', cls: 'fig f-islands'});
  F.islandCount = W.nodes.filter((r, i) => r.pop > 0 && degree(i) === 0).length;
}

// The cells of a terrain or climate grid inside a figure's box: [i0, i1, j0, j1] and where they land.
function gridWindow(g, grid) {
  const {w, h, cell, x0, y0} = grid;
  const b = g.cbox;
  const i0 = Math.max(0, Math.floor((b[0] - x0) / cell)), i1 = Math.min(w - 1, Math.ceil((b[2] - x0) / cell));
  const j0 = Math.max(0, Math.floor((b[1] + y0) / cell)), j1 = Math.min(h - 1, Math.ceil((b[3] + y0) / cell));
  const X0 = g.X(x0 + i0 * cell), X1 = g.X(x0 + (i1 + 1) * cell), Y0 = g.Y(-y0 + j0 * cell), Y1 = g.Y(-y0 + (j1 + 1) * cell);
  return {i0, i1, j0, j1, at: `x="${X0}" y="${Y0}" width="${X1 - X0}" height="${Y1 - Y0}" preserveAspectRatio="none"`};
}
// A mask where a grid value crosses thr: the value is read between cell centres, `up` pixels a
// cell, and the edge eased over a short ramp, so the shape is smooth instead of a staircase.
function contourMask(g, grid, value, thr, id, up = 4) {
  const {w, h} = grid;
  const {i0, i1, j0, j1, at} = gridWindow(g, grid);
  const nw = (i1 - i0 + 1) * up, nh = (j1 - j0 + 1) * up;
  const px = new Uint8Array(nw * nh);
  const v = (i, j) => (i < 0 || j < 0 || i >= w || j >= h) ? 0 : value(j * w + i);
  const e = 0.004;
  for (let y = 0; y < nh; ++y) for (let x = 0; x < nw; ++x) {
    const fx = i0 + (x + 0.5) / up - 0.5, fy = j0 + (y + 0.5) / up - 0.5;
    const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
    const val = (v(i, j) * (1 - tx) + v(i + 1, j) * tx) * (1 - ty) + (v(i, j + 1) * (1 - tx) + v(i + 1, j + 1) * tx) * ty;
    px[y * nw + x] = Math.round(255 * Math.min(1, Math.max(0, (val - thr + e) / (2 * e))));
  }
  return `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${g.W}" height="${g.H}"><image href="${pngDataUri(nw, nh, 1, px)}" ${at}/></mask>`;
}

// ---- 10. mountains and rivers, Africa and Arabia
{
  const g = new Fig([14, -16, 62, 36], 800);
  const T = load('terrain');
  const masks = contourMask(g, T.grid, k => T.mountain[k], T.shown, 'm-mtn') + contourMask(g, T.grid, k => T.mountain[k], 0.55, 'm-mtn-hi');
  const mtn = `<rect class="mtn" width="${g.W}" height="${g.H}" mask="url(#m-mtn)"/><rect class="mtn hi" width="${g.W}" height="${g.H}" mask="url(#m-mtn-hi)"/>`;
  // rivers in pieces of 6 points, each as wide as its flow, grouped in four widths
  const widths = [[], [], [], []];
  for (const r of T.rivers) for (let k = 0; k + 1 < r.p.length; k += 6) {
    const f = r.flow[Math.min(r.flow.length - 1, k + 3)] || 0;
    const w = Math.min(3, Math.floor(Math.log2(1 + Math.max(0, f) / 22)));
    widths[w].push(r.p.slice(k, k + 7));
  }
  const rv = widths.map((list, w) => `<path class="river w${w}" d="${g.d(list.flatMap(p => clipLineSafe(p, g.cbox)), false)}"/>`).join('');
  F.terrain = g.svg(`<defs>${masks}</defs>` + g.sea() + g.fills(finalPolys, () => 'land') + mtn + g.strokes(W.world.lines, {border: 'border faint'}) + rv +
    g.labels(['EG', 'SA', 'ET', 'NG', 'CD'], finalPolys, {size: 15, name: {CD: 'D.R. Congo'}}),
    {label: 'Mountains and rivers of Africa and Arabia in world 1', cls: 'fig f-terrain'});
  F.riverCount = T.rivers.length;
}
function clipLineSafe(pts, b) {
  const ins = p => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
  return pts.some(ins) ? [pts] : [];
}

// ---- 11. climate: what grows where, the whole world. A picture, one pixel a cell, in the
// biome colours of each theme (the same values as the --b-* tokens in page.html); the browser
// smooths it as it scales, and the coasts are drawn over it.
const BIOME_RGB = {
  light: {tundra: '#c9cdc3', taiga: '#8aa38c', steppe: '#ddd29c', grassland: '#bfd18e', forest: '#7ea46a', desert: '#edd393', scrub: '#cdb382', savanna: '#d9c477', jungle: '#4e8b58', marsh: '#8db4a6', alpine: '#ecebe6'},
  dark: {tundra: '#59605a', taiga: '#3d5a44', steppe: '#6b6440', grassland: '#56683a', forest: '#35573a', desert: '#7a6b45', scrub: '#6a5a3c', savanna: '#6f6330', jungle: '#24492d', marsh: '#3e5f58', alpine: '#a9a69c'},
};
{
  const g = new Fig(WORLD, 700);
  const C = load('climate');
  const {w} = C.grid;
  const {i0, i1, j0, j1, at} = gridWindow(g, C.grid);
  const nw = i1 - i0 + 1, nh = j1 - j0 + 1;
  const images = Object.entries(BIOME_RGB).map(([theme, rgb]) => {
    const px = new Uint8Array(nw * nh * 4);
    for (let j = j0; j <= j1; ++j) for (let i = i0; i <= i1; ++i) {
      const b = C.biome[j * w + i];
      if (!(b > 0)) continue;
      const hex = rgb[C.biomes[b]];
      const o = ((j - j0) * nw + (i - i0)) * 4;
      px[o] = parseInt(hex.slice(1, 3), 16); px[o + 1] = parseInt(hex.slice(3, 5), 16); px[o + 2] = parseInt(hex.slice(5, 7), 16); px[o + 3] = 255;
    }
    return `<image class="ras ras-${theme}" href="${pngDataUri(nw, nh, 4, px)}" ${at}/>`;
  }).join('');
  F.climate = g.svg(g.sea() + images + g.strokes(W.world.lines, {border: 'border faint'}) +
    g.labels(['RU', 'CN', 'IN', 'EG', 'NG', 'BR', 'US'], finalPolys, {size: 12}),
    {label: 'What grows where in world 1: deserts in a band across the middle, forests and jungle in the south, tundra in the north', cls: 'fig f-climate'});
  F.biomes = C.biomes;
  F.winds = C.winds;
}

// ---- 12. an edit: France and Spain no longer neighbours
{
  const g = new Fig([18, -36, 42, -14], 520);
  const E = load('edited');
  const ePolys = Object.fromEntries(E.countries.map((c, i) => [i, c.rings]).filter(([, r]) => r.length));
  const FR = indexOf('FR'), ES = indexOf('ES');
  const cls = l => 'c' + colour[l] + (l === FR ? ' hl-fill' : l === ES ? ' hl2-fill' : '');
  F.edit = [[finalPolys, W.world.lines, 'World 1, where France and Spain share a border'], [ePolys, E.lines, 'World 1 without the France–Spain border']].map(([P, Ls, label]) =>
    g.svg(g.sea() + g.fills(P, cls) + g.strokes(Ls) + g.labels(['FR', 'ES', 'IT', 'DE'], P, {size: 22}), {label, cls: 'fig f-edit'}));
}

writeFileSync(new URL('./figs.json', import.meta.url), JSON.stringify(F));
let total = 0;
for (const [k, v] of Object.entries(F)) {
  const len = JSON.stringify(v).length;
  total += len;
  if (len > 200) console.log(k.padEnd(12), (len / 1024).toFixed(0) + ' KB');
}
console.log('total', (total / 1024).toFixed(0) + ' KB; islands', F.islandCount, 'rivers', F.riverCount, 'winds', JSON.stringify(F.winds));
