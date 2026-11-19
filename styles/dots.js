// The dots: one dot for every so many people. This map gives every person the same room, so the
// dots lie on one even grid over the whole world, the same distance apart in every country: a
// country is where its dots are, and along a border they shrink to pinpricks. Nothing else is
// drawn: no coasts, no terrain, no tints. Zooming in, a dot stands for fewer people (a million,
// then a hundred thousand, then ten thousand...), so the dots stay a few pixels apart; the legend
// says how many a dot is.
//
// The page calls these hooks (window.mapStyles.dots) when html has data-style="dots":
//   ripples   none: there is no sea to draw
//   markerPx  the radius of the ring round a country too small to see
//   view      after every redraw: the dots for this view and the chosen country
//   unmount   the canvas and the legend go
// The page letters the names itself (this style has no render hook); its stylesheet sets them.

const html = typeof document === 'undefined' ? null : document.documentElement;
const active = () => html && html.dataset.style === 'dots';

// A hexagonal grid with one point per `n` people has points sqrt(2 / sqrt(3) * area per point)
// apart. The step (how many people a dot is) is the one that puts them about SPACING_PX apart.
const SPACING_PX = 9, MIN_SPACING = 0.62, MAX_TIDY = 1.25;   // the spacing wanted; how much closer or farther may do
const HEX = Math.sqrt(2 / Math.sqrt(3));
const RADIUS = 0.27;        // a dot's radius, as a share of the spacing
const PINPRICK = 0.38;      // a dot by a border, as a share of a dot
const BORDER = 0.34;        // how near a border a dot shrinks, as a share of the spacing
const NAME_PX = 46, SMALL_NAME_PX = 22;   // the largest names on screen: capitals, and the rest

const WORDS = n => {
  if (n >= 1e9) return (n / 1e9).toLocaleString('en-US') + ' billion';
  if (n >= 1e6) return (n / 1e6).toLocaleString('en-US') + ' million';
  return n.toLocaleString('en-US');
};
// what a dot can stand for: round numbers (1, 2 and 5 of a power of ten) of people, or of the
// measure the countries are sized by. A power of ten itself is tidier and is preferred (tidy).
const tidy = words => /^\$?10*(\D|$)/.test(words.replace(/,/g, ''));
function stepsOf(world) {
  let given = world.result.legend, measure = world.result.measure;
  if (given) return given.steps.map(s => ({n: s.n, words: s.words, tidy: tidy(s.words)}));
  if (measure) {
    // (a graph from a file: a dot is a share of the whole)
    let out = [];
    for (let e = -7; e <= -1; ++e) out.push({n: 10 ** e * world.dots.people, words: +(10 ** e * 100).toPrecision(1) + '% of all its ' + measure, tidy: true});
    return out;
  }
  let out = [];
  for (let e = 0; e <= 10; ++e) for (let m of [1, 2, 5]) {
    let n = m * 10 ** e;
    out.push({n, words: n === 1 ? 'one person' : WORDS(n) + ' people', tidy: m === 1});
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Each world once: its countries as Path2D (in the svg's units: x, and y downwards), their boxes,
// and how much land a person has
function prepare(world) {
  if (world.dots) return world.dots;
  let shapes = [], land = 0, people = 0;
  world.items.forEach(item => {
    let d = item.path.getAttribute('d') || '';
    let nums = d.match(/-?[\d.]+(?:e[-+]?\d+)?/g) || [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i + 1 < nums.length; i += 2) {
      let x = +nums[i], y = +nums[i + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    shapes.push({item, path: new Path2D(d), box: [x0, y0, x1, y1], id: shapes.length + 1});
    land += item.area;
    people += item.country.population;
  });
  return world.dots = {shapes, perPerson: land / Math.max(1, people), people, byIndex: new Map(shapes.map(s => [s.item.index, s]))};
}

// ---------------------------------------------------------------------------------------------
// The layer: a canvas under the svg (the svg keeps the names, the rings round tiny countries and
// what the pointer finds), and an id map: every country filled in a colour of its own, off screen,
// to tell which country a dot is in
let canvas = null, idCanvas = null, legend = null, mountedNow = false;
let current = null, currentSelected = null, drawnKey = '';
const stats = {draws: 0, lastMs: 0, dots: 0, step: 0};

const idColour = id => `rgb(${id & 255},${(id >> 8) & 255},${(id * 97 + 31) & 255})`;
const idAt = (data, w, x, y) => {
  if (x < 0 || y < 0 || x >= w) return -1;
  let o = 4 * (y * w + x);
  if (o >= data.length) return -1;
  if (data[o + 3] < 255) return data[o + 3] ? -1 : 0;       // the sea (0), or the edge of a shape (-1)
  let id = data[o] | (data[o + 1] << 8);
  return ((id * 97 + 31) & 255) === data[o + 2] ? id : -1;   // (two shapes blended on an edge: -1)
};

function colours() {
  let cs = getComputedStyle(html);
  let get = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {ink: get('--dot', '#161514'), lit: get('--dot-lit', '#e2412b'), faint: get('--dot-faint', 'rgba(22, 21, 20, 0.22)')};
}

function draw(world, state, selected) {
  if (!canvas || !world || !active()) return;
  let svg = document.getElementById('map');
  let W = svg.clientWidth, H = svg.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
  let theme = html.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'auto-dark' : 'auto-light');
  let key = [state.x, state.y, state.k, W, H, dpr, theme, selected ? selected.index : -1].join(',');
  if (key === drawnKey && world === current) return;
  let t0 = performance.now();
  drawnKey = key;
  let dots = prepare(world), {k, x: ox, y: oy} = state;
  // how many people a dot is. The spacing wanted is closer on a small screen, where the whole world
  // is small. A power of ten (a million, a hundred thousand) whose dots are between a little closer
  // and a little farther apart than that; else the round number (2 or 5 of a power of ten) nearest it
  let want = Math.max(5.5, Math.min(SPACING_PX, SPACING_PX * Math.sqrt(Math.min(W, H) / 800)));
  let least = want * MIN_SPACING, most = want * MAX_TIDY;
  let steps = stepsOf(world).map(s => ({...s, px: k * HEX * Math.sqrt(s.n * dots.perPerson)})), best = null;
  let fit = s => Math.abs(Math.log(s.px / want));
  for (let s of steps) if (s.tidy && s.px >= least && s.px <= most && (!best || fit(s) < fit(best))) best = s;
  if (!best) for (let s of steps) if (s.px >= least && (!best || fit(s) < fit(best))) best = s;
  if (!best) best = steps[steps.length - 1];   // (zoomed out past every step: the largest)
  let s = best.px / k;                         // the spacing, in map units
  stats.step = best.n;

  // the id map, at one pixel per css pixel, of the countries in view
  if (idCanvas.width !== W || idCanvas.height !== H) { idCanvas.width = W; idCanvas.height = H; }
  let ic = idCanvas.getContext('2d', {willReadFrequently: true});
  ic.setTransform(1, 0, 0, 1, 0, 0);
  ic.clearRect(0, 0, W, H);
  ic.setTransform(k, 0, 0, k, ox, oy);
  let vx0 = -ox / k, vx1 = (W - ox) / k, vy0 = -oy / k, vy1 = (H - oy) / k;
  let inView = dots.shapes.filter(sh => sh.box[2] >= vx0 && sh.box[0] <= vx1 && sh.box[3] >= vy0 && sh.box[1] <= vy1);
  for (let sh of inView) { ic.fillStyle = idColour(sh.id); ic.fill(sh.path, 'evenodd'); }
  let data = ic.getImageData(0, 0, W, H).data;
  let byId = new Map(inView.map(sh => [sh.id, sh]));

  // the dots: a grid fixed to the map (so they keep their places as it moves), rows s * sqrt(3) / 2 apart
  let near = new Set(selected ? world.neighbours[selected.index] : []);
  let groups = {ink: [], lit: [], faint: []};
  let r = Math.max(0.6, RADIUS * best.px), g = BORDER * best.px, count = 0;
  let ring = [0, 1, 2, 3, 4, 5].map(a => [Math.cos(a * Math.PI / 3) * g, Math.sin(a * Math.PI / 3) * g]);
  let dy = s * Math.sqrt(3) / 2;
  for (let j = Math.floor(vy0 / dy) - 1, jEnd = Math.ceil(vy1 / dy) + 1; j <= jEnd; ++j) {
    let my = j * dy, off = (j & 1) ? s / 2 : 0, py = oy + k * my;
    for (let i = Math.floor((vx0 - off) / s) - 1, iEnd = Math.ceil((vx1 - off) / s) + 1; i <= iEnd; ++i) {
      let px = ox + k * (i * s + off);
      if (px < -r || py < -r || px > W + r || py > H + r) continue;
      let xi = Math.round(px), yi = Math.round(py), id = idAt(data, W, xi, yi);
      if (id === 0) continue;
      if (id < 0) {
        // on the very edge of a shape: ask the shapes around it, exactly
        id = 0;
        let seen = new Set();
        for (let ddx = -2; ddx <= 2 && !id; ++ddx) for (let ddy = -2; ddy <= 2 && !id; ++ddy) {
          let c = idAt(data, W, xi + ddx, yi + ddy);
          if (c > 0 && !seen.has(c)) { seen.add(c); if (ic.isPointInPath(byId.get(c).path, px, py, 'evenodd')) id = c; }
        }
        if (!id) continue;
      }
      let sh = byId.get(id);
      if (!sh) continue;
      // by a border: another country within g pixels
      let edge = false;
      for (let [ex, ey] of ring) {
        let c = idAt(data, W, Math.round(px + ex), Math.round(py + ey));
        if (c > 0 && c !== id) { edge = true; break; }
      }
      let idx = sh.item.index;
      let group = !selected ? 'ink' : idx === selected.index ? 'lit' : near.has(idx) ? 'ink' : 'faint';
      groups[group].push(px, py, edge ? r * PINPRICK : r);
      ++count;
    }
  }

  // drawn in one path per colour
  let cw = Math.round(W * dpr), ch = Math.round(H * dpr);
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  let c = canvas.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, cw, ch);
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  let paint = colours();
  for (let name of ['faint', 'ink', 'lit']) {
    let list = groups[name];
    if (!list.length) continue;
    c.beginPath();
    for (let q = 0; q < list.length; q += 3) { c.moveTo(list[q] + list[q + 2], list[q + 1]); c.arc(list[q], list[q + 1], list[q + 2], 0, 2 * Math.PI); }
    c.fillStyle = paint[name];
    c.fill();
  }
  showLegend(best, r);
  stats.draws++;
  stats.dots = count;
  stats.lastMs = performance.now() - t0;
}

// the key: one dot, as large as on the map, and how many it stands for
function showLegend(best, r) {
  if (!legend) return;
  let d = Math.max(2, Math.min(14, 2 * r));
  legend.dot.style.width = legend.dot.style.height = d + 'px';
  let text = best.words;
  if (legend.val.textContent !== text) legend.val.textContent = text;
  legend.box.hidden = false;
}

function view(world, state, selected) {
  if (!active()) return;
  if (!mountedNow) mount();
  current = world;
  currentSelected = selected;
  draw(world, state, selected);
  // the names of the countries not lit when one is chosen step back with their dots; no name grows
  // past a size on screen (the page sizes them to their country, which zooming in makes huge)
  let near = new Set(selected ? world.neighbours[selected.index] : []), k = state.k;
  world.items.forEach(item => {
    item.label.classList.toggle('dots-dim', !!selected && item !== selected && !near.has(item.index));
    let px = item.country.population > 3e7 ? NAME_PX : SMALL_NAME_PX;
    let f = Math.min(item.font, px / k);
    if (item.dotsFont !== f) { item.dotsFont = f; item.label.setAttribute('font-size', f); }
  });
}

// what the svg shows now (for a view set by rewriting the transform, as a test harness does)
function viewOf() {
  let t = document.getElementById('viewport').getAttribute('transform') || '';
  let m = /translate\(([-\d.e+]+)[ ,]+([-\d.e+]+)\)\s*scale\(([-\d.e+]+)\)/.exec(t);
  return m ? {x: +m[1], y: +m[2], k: +m[3]} : null;
}

// ---------------------------------------------------------------------------------------------
let watchers = [];
function mount() {
  if (mountedNow || !active()) return;
  let plate = document.getElementById('plate'), svg = document.getElementById('map');
  if (!plate || !svg) return;
  mountedNow = true;
  canvas = document.createElement('canvas');
  canvas.id = 'dots-layer';
  canvas.setAttribute('aria-hidden', 'true');
  plate.insertBefore(canvas, svg);
  idCanvas = document.createElement('canvas');
  if (!document.getElementById('dots-scale')) {
    let box = document.createElement('div');
    box.id = 'dots-scale';
    box.hidden = true;
    box.innerHTML = '<span class="dot-wrap" aria-hidden="true"><span class="dot"></span></span><span><span class="cap">One dot is</span> <span class="val"></span></span>';
    document.body.insertBefore(box, document.getElementById('credit'));
    legend = {box, dot: box.querySelector('.dot'), val: box.querySelector('.val')};
  }
  let redraw = () => { if (active() && current) { drawnKey = ''; let v = viewOf(); if (v) draw(current, v, currentSelected); } };
  let mql = matchMedia('(prefers-color-scheme: dark)');
  mql.addEventListener('change', redraw);
  let themeObs = new MutationObserver(redraw);
  themeObs.observe(html, {attributes: true, attributeFilter: ['data-theme']});
  let vp = document.getElementById('viewport'), vpObs = null;
  if (vp) {
    vpObs = new MutationObserver(() => requestAnimationFrame(() => { if (active() && current) { let v = viewOf(); if (v) draw(current, v, currentSelected); } }));
    vpObs.observe(vp, {attributes: true, attributeFilter: ['transform']});
  }
  watchers = [() => mql.removeEventListener('change', redraw), () => themeObs.disconnect(), () => vpObs && vpObs.disconnect()];
}
// Leaves the page as if the style had never run
function unmount() {
  if (!mountedNow) return;
  mountedNow = false;
  watchers.forEach(stop => stop());
  watchers = [];
  if (canvas) canvas.remove();
  canvas = null;
  idCanvas = null;
  let box = document.getElementById('dots-scale');
  if (box) box.remove();
  legend = null;
  if (current) current.items.forEach(item => {
    item.label.classList.remove('dots-dim');
    if (item.dotsFont !== undefined) { item.label.setAttribute('font-size', item.font); delete item.dotsFont; }
  });
  current = null;
  currentSelected = null;
  drawnKey = '';
}

if (typeof window !== 'undefined') {
  window.mapStyles = window.mapStyles || {};
  window.mapStyles.dots = {ripples: [], markerPx: 5, view, unmount, stats};
}
if (active()) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
