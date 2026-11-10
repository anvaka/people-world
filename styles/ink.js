// The inked map: the world as the endpaper of a book. Ink on parchment, the land the paper itself;
// colour only where it means something (a ribbon in a deeper shade of each realm's paper inside its
// borders, the rivers, the names of the great realms in red). It keeps to the page's style contract
// (window.mapStyles.ink, scoped to <html data-style="ink">):
//   ripples   none: the shore is hatched in the ink's own sea tiles
//   markerPx  the radius of the ring round a country too small to see
//   render    once per drawn world: colours, the survey (in the worker), names planned, tile layers
//   view      after every redraw: names lettered, the tiles of this zoom band asked for or shown,
//             the veil over the realms not chosen
//   settled   a promise: the survey is done and the tiles of the view are in
//   unmount   the page switches to another style: everything this style added goes
//
// The ink itself is drawn in tiles by a worker (styles/ink-worker.js, drawing with ink-engine.js on
// OffscreenCanvas) and placed in the world's svg as images: the sea tiles under the countries (so
// the land cuts the rhumb lines and the shore hatching off at the coast) and the land tiles over
// them, under the lines and names. Tiles are anchored to the world, one set per zoom band; a band
// already drawn is reused when the zoom comes back to it. A gesture moves them with the svg as one
// picture; when it rests the page only places tiles (new ones fade in) and asks the worker for the
// missing ones, so the main thread never draws ink. Where a worker cannot draw, the page draws the
// tiles itself, one at a time.
import {createEngine, packWorld, bandOf, bandK, TILE_PX, roseRadius, vignetteSize, grainTile, drawOrnament} from './ink-engine.js';

const NS = 'http://www.w3.org/2000/svg';
const html = document.documentElement;
const active = () => html.dataset.style === 'ink';
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => html.dataset.theme === 'dark' || (html.dataset.theme !== 'light' && darkQuery.matches);
const SLOTS = 7;
const screen = {w: innerWidth, h: innerHeight};
const dev = () => (screen.w < 600 ? 1.15 : 1);          // marks a little smaller and closer on a phone
// (tiles are shown at 0.71 to 1.41 times their band's scale: drawn a little finer than the screen,
// so the ink stays crisp through most of a band)
const tileRes = () => Math.min((devicePixelRatio || 1) * 1.25, 2.4);

// ---------------------------------------------------------------------------------------------
// Colours come from the style sheet, so day and night are both set there
let pal = null;
function readPalette() {
  let cs = getComputedStyle(html), v = name => cs.getPropertyValue(name).trim();
  pal = {
    dark: isDark(), theme: isDark() ? 'd' : 'l',
    ink: v('--ink'), sea: v('--sea'), shore: v('--shore-ink'), wave: v('--wave-ink'), rhumb: v('--rhumb-ink'),
    river: v('--river'), roseFill: v('--rose-fill'), accent: v('--accent'),
    land: Array.from({length: SLOTS}, (_, i) => v('--land-' + i)),
    band: Array.from({length: SLOTS}, (_, i) => v('--band-' + i)),
  };
  return pal;
}

// The realms' papers. Neighbours never share one, and they differ as much as the seven papers
// allow, by value above all (at night, two dark papers of different hue blur together on a phone):
// most constrained first, each realm takes the paper farthest from its neighbours' (ties go to a
// paper of its own, by its code, so colours stay put when an edit leaves a realm alone), then two
// passes improve the worst pairs. Worked out per theme, since the two sets of papers differ.
function labOf(hex) {
  let m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return [50, 0, 0];
  let c = [m[1], m[2], m[3]].map(x => { let v = parseInt(x, 16) / 255; return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92; });
  let X = (0.4124 * c[0] + 0.3576 * c[1] + 0.1805 * c[2]) / 0.95047, Y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], Z = (0.0193 * c[0] + 0.1192 * c[1] + 0.9505 * c[2]) / 1.08883;
  let f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
function colourSlots(world, known) {
  let theme = pal.theme;
  if (known && known.slots && known.slots[theme]) return known.slots[theme];
  let labs = pal.land.map(labOf);
  let gap = (a, b) => Math.hypot(2 * (labs[a][0] - labs[b][0]), labs[a][1] - labs[b][1], labs[a][2] - labs[b][2]);
  let slot = new Int8Array(world.result.countries.length).fill(-1);
  let order = world.items.map(it => it.index).sort((a, b) => world.neighbours[b].length - world.neighbours[a].length || a - b);
  let pick = i => {
    let id = world.result.countries[i].id, start = (id.charCodeAt(0) * 3 + id.charCodeAt(1) * 5) % SLOTS, best = -1, bestScore = -1;
    for (let k = 0; k < SLOTS; ++k) {
      let s = (start + k) % SLOTS, score = Infinity;
      for (let j of world.neighbours[i]) if (slot[j] >= 0) score = Math.min(score, slot[j] === s ? -1 : gap(s, slot[j]));
      if (score > bestScore + 1e-9) { bestScore = score; best = s; }
    }
    return best;
  };
  for (let i of order) slot[i] = pick(i);
  for (let pass = 0; pass < 2; ++pass) for (let i of order) slot[i] = pick(i);
  if (known) (known.slots || (known.slots = {}))[theme] = slot;
  return slot;
}
// The papers given to a world's realms (again when the theme changes)
function applySlots(world) {
  let slots = colourSlots(world, world.ink.known);
  world.ink.slots = slots;
  world.items.forEach(item => {
    item.inkSlot = slots[item.index];
    item.path.setAttribute('class', item.path.getAttribute('class').replace(/\bland-\d\b/, 'land-' + item.inkSlot));
    if (item.label.classList.contains('ink-name')) item.label.setAttribute('class', item.label.getAttribute('class').replace(/\bink-halo-\d\b/, 'ink-halo-' + item.inkSlot));
  });
}

// ---------------------------------------------------------------------------------------------
// The engine: in the worker when it can draw, else here
let workers = [], local = null, worlds = 0, mounted = false;
const ofResult = new WeakMap();        // build result → its id, survey and furniture
const byId = new Map();                // world id → world
// the engine runs in workers (two where the device has the cores), each with its own survey of
// the world; tiles are dealt out between them
function engine() {
  if (workers.length || local) return;
  let n = (navigator.hardwareConcurrency || 2) >= 4 && screen.w >= 600 ? 2 : 1;   // (merge: one on a phone, for memory)
  // (?ink=noworker: the tiles drawn on the page, as where a worker cannot draw)
  if (/[?&]ink=noworker/.test(location.search)) { fallBack(); return; }
  try {
    for (let i = 0; i < n; ++i) {
      let w = new Worker(new URL('./ink-worker.js', import.meta.url), {type: 'module'});
      w.onmessage = ({data}) => onEngine(data, i);
      w.onerror = e => { e.preventDefault(); fallBack(); };
      workers.push(w);
    }
  } catch (e) { fallBack(); }
  if (pal) send({type: 'palette', palette: pal});
}
function fallBack() {
  workers.forEach(w => w.terminate());
  workers = [];
  if (local) return;
  local = {engine: createEngine((w, h) => { let c = document.createElement('canvas'); c.width = w; c.height = h; return c; }), queue: [], timer: 0};
  if (pal) local.engine.palette(pal);
  // the worlds already sent to the worker are surveyed again here
  for (let w of byId.values()) if (w.ink && !w.ink.survey) startSurvey(w);
}
function send(msg, transfer) {
  if (workers.length) {
    if (msg.type === 'tiles') {
      // dealt out by place (a checkerboard), so both start near the middle of the view and a tile
      // asked for again goes to the worker that keeps it
      workers.forEach((w, i) => w.postMessage({type: 'tiles', list: msg.list.filter(t => ((t.ti + t.tj) % workers.length + workers.length) % workers.length === i)}));
    } else if (msg.type === 'init') {
      // each worker surveys the world; the first answer is the one used
      workers.forEach((w, i) => w.postMessage(msg, i === workers.length - 1 ? transfer || [] : []));
    } else workers.forEach(w => w.postMessage(msg));
    return;
  }
  if (!local) return;
  let e = local.engine;
  if (msg.type === 'init') setTimeout(() => { let r = e.init(msg.id, msg); onEngine({type: 'init', id: msg.id, spots: r.spots, sea: r.sea}); }, 0);
  else if (msg.type === 'palette') e.palette(msg.palette);
  else if (msg.type === 'decor') e.decor(msg.id, msg.decor);
  else if (msg.type === 'slots') e.slots(msg.id, msg.slots);
  else if (msg.type === 'drop') e.drop(msg.id);
  else if (msg.type === 'tiles') {
    local.queue = msg.list;
    let step = () => {
      local.timer = 0;
      let t = local.queue.shift();
      if (!t) return;
      let canvas = null, unknown = false;
      try { canvas = e.tile(t.id, t); } catch (err) { unknown = !!err.unknown; if (!unknown) console.warn('ink:', err); }
      onEngine({type: 'tile', key: t.key, id: t.id, canvas, unknown, failed: !canvas && unknown});
      if (local && local.queue.length) local.timer = setTimeout(step, 0);
    };
    if (!local.timer) local.timer = setTimeout(step, 0);
  }
}
function onEngine(data, from) {
  if (!active()) return;
  if (data.type === 'nodraw') { fallBack(); return; }
  if (data.type === 'error') { console.warn('ink:', data.message); return; }
  let world = byId.get(data.id);
  if (!world || !world.ink) return;
  if (data.type === 'init') { if (!world.ink.survey) surveyed(world, data); }
  else if (data.type === 'tile') tileArrived(world, data);
}

// ---------------------------------------------------------------------------------------------
// A world drawn
function render(world) {
  if (!active()) return;
  mount();
  if (!pal) readPalette();
  // what is worked out for a build result is kept with it: a world drawn again from the same
  // result (a style switch back to this one, an undo) reuses its survey, furniture and tiles
  let known = ofResult.get(world.result);
  if (!known) { known = {id: ++worlds}; ofResult.set(world.result, known); }
  let slots = colourSlots(world, known), id = known.id;
  world.ink = {id, known, slots, survey: known.survey || null, spots: known.spots, decor: known.decor, nameSpots: known.nameSpots,
    band: {}, ready: false, waiters: []};
  let was = byId.get(id);
  if (was && was !== world && was.ink) was.ink.waiters.splice(0).forEach(f => f());
  keepWorld(world);
  world.items.forEach(item => {
    item.inkSlot = slots[item.index];
    item.path.setAttribute('class', item.path.getAttribute('class').replace(/\bland-\d\b/, 'land-' + item.inkSlot));
    item.label.classList.add('hidden');
    item.font = 0;
    item.inkName = null;
  });
  // the layers: sea tiles and the seas' names under the countries, land tiles and the veil over them
  let root = world.root, countries = root.querySelector('#countries'), lines = root.querySelector('#lines');
  let g = cls => { let e = document.createElementNS(NS, 'g'); e.setAttribute('class', cls); return e; };
  world.ink.sea = g('ink-sea'); world.ink.seaNames = g('ink-seanames');
  world.ink.land = g('ink-land'); world.ink.veil = g('ink-veil');
  root.insertBefore(world.ink.sea, countries);
  root.insertBefore(world.ink.seaNames, countries);
  root.insertBefore(world.ink.land, lines);
  root.insertBefore(world.ink.veil, lines);
  let defs = document.createElementNS(NS, 'defs');
  root.insertBefore(defs, root.firstChild);
  world.ink.defs = defs;
  // the survey once the map is on screen, so the first picture is not held up by it
  if (!world.ink.survey) setTimeout(() => { if (active() && world.ink && !world.ink.survey) startSurvey(world); }, 30);
  planNames(world);
  fontsLoaded.then(() => {
    if (!world.ink || !world.ink.letteredEarly) return;
    world.ink.letteredEarly = false;
    world.ink.known.plans = null;
    world.items.forEach(item => { item.inkName = null; item.label.classList.add('hidden'); });
    if (current && current.world === world && active()) view(world, current.state, current.selected);
  });
}
function startSurvey(world) {
  engine();
  let {packed, transfer} = packWorld(world, world.ink.slots);
  let b = world.box, span = Math.max(b.maxX - b.minX, b.maxY - b.minY), pad = span * 0.12, cell = (span + 2 * pad) / 720;
  let grid = {w: Math.ceil((b.maxX - b.minX + 2 * pad) / cell), h: Math.ceil((b.maxY - b.minY + 2 * pad) / cell), cell,
    x0: b.minX - pad, y0: -(b.minY - pad), box: {x0: b.minX, x1: b.maxX, y0: -b.maxY, y1: -b.minY}};
  send({type: 'init', id: world.ink.id, packed, grid, seed: seedOf(), dev: dev(), terrain: world.result.terrain}, transfer);
}
function seedOf() {
  let m = /^#world-(\d+)/.exec(decodeURIComponent(location.hash));
  return m ? +m[1] : 1;
}
function surveyed(world, data) {
  world.ink.resurvey = false;
  world.ink.survey = world.ink.known.survey = data.sea;
  world.ink.spots = world.ink.known.spots = data.spots;
  if (current && current.world === world) { placeFurniture(world, current.state); view(world, current.state, current.selected); }
}

let current = null;
function view(world, state, selected) {
  if (!active() || !world.ink) return;
  current = {world, state: {...state}, selected};
  // (merge) the world shown is the most recently used; one let go is taken back and surveyed again
  if ([...byId.keys()].pop() !== world.ink.id || byId.get(world.ink.id) !== world) keepWorld(world);
  if (world.ink.evicted && !world.ink.survey) { world.ink.evicted = false; world.ink.resurvey = true; startSurvey(world); }
  letterNames(world, state, selected);
  paper(state);
  if (world.ink.survey) {
    if (!world.ink.decor) placeFurniture(world, state);
    else if (!world.ink.decorSent) { send({type: 'decor', id: world.ink.id, decor: world.ink.decor}); }
    world.ink.decorSent = true;
    tiles(world, state);
    seaNames(world, state);
    ornaments(world, state);
  }
  veil(world, selected);
  // a finer pen round the smallest realms: full-weight lines would swallow them
  for (let line of world.lineItems) {
    let fine = line.size * state.k < 32;
    if (line.inkFine !== fine) { line.inkFine = fine; line.node.classList.toggle('ink-fine', fine); }
  }
}

// The paper's grain under the sea: the background of the map's plate, so a gesture carries it with
// the map; pinned to the map's origin when the view is drawn
const grains = {};
function paper(state) {
  let plate = document.getElementById('plate');
  if (!plate) return;
  let key = isDark() ? 'd' : 'l';
  if (!grains[key]) { try { grains[key] = `url(${grainTile(document.createElement('canvas'), key === 'd').toDataURL('image/png')})`; } catch (e) { grains[key] = 'none'; } }
  plate.style.backgroundImage = grains[key];
  plate.style.backgroundPosition = `${((state.x % 256) + 256) % 256}px ${((state.y % 256) + 256) % 256}px`;
}

// ---------------------------------------------------------------------------------------------
// Tiles. Each world shows the tiles of one band per layer; a new band is shown once its tiles for
// the view are in, fading in over the old one. A tile arrives as a PNG and is shown as an svg
// image, once the browser has decoded it (off the main thread), so nothing pops in half drawn.
// (Tiles used to be shown on canvases in a foreignObject; on phones a tile could then come out
// black where it should be clear.) The worker keeps the tiles it drew, so the page holds only
// those placed.
const empty = new Set();          // keys of tiles with nothing on them
// (merge) worlds kept surveyed and tiled: the map and the map before the edits. A tile let go gives
// its pixels back at once (a phone may not wait for the collector).
const KEEP_WORLDS = 2;
// the worker keeps the surveys of the last few worlds shown; the page lets older ones go. The map
// without edits stays (before/after needs it; the page marks the others world.edited), and a world
// let go that is shown again is surveyed again.
function keepWorld(world) {
  let id = world.ink.id;
  byId.delete(id);
  byId.set(id, world);
  while (byId.size > KEEP_WORLDS) {
    let entries = [...byId.entries()];
    let [oldId, old] = entries.find(([, w]) => w !== world && w.edited) || entries.find(([, w]) => w !== world);
    byId.delete(oldId);
    send({type: 'drop', id: oldId});
    if (old.ink) {
      old.ink.known.survey = null; old.ink.waiters.splice(0).forEach(f => f());
      for (let layer in old.ink.band) for (let b of old.ink.band[layer].values()) release(b.g);
      old.ink.band = {};
      old.ink.survey = null;
      old.ink.decorSent = false;
      old.ink.ready = false;
      old.ink.evicted = true;
    }
  }
}
function release(g) {
  g.remove();
  for (let im of g.querySelectorAll('image')) { let url = im.getAttribute('href'); if (url) URL.revokeObjectURL(url); im.removeAttribute('href'); }
}
const tileKey = (world, layer, z, ti, tj) => `${world.ink.id}|${pal.theme}|${layer}|${z}|${ti}|${tj}`;
const hasTile = (band, key) => band.images.has(key) || empty.has(key);
function tiles(world, state) {
  let ink = world.ink, d = dev(), z = bandOf(state.k, d), kb = bandK(z, d), TW = TILE_PX / kb, k = state.k;
  let x0 = -state.x / k, x1 = (screen.w - state.x) / k, y0 = (state.y - screen.h) / k, y1 = state.y / k;
  let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, want = [], res = tileRes();
  let request = (layer, zz, ti, tj, TWz, names, extra) => {
    let tx0 = ti * TWz, ty0 = tj * TWz;
    return {key: tileKey(world, layer, zz, ti, tj), id: ink.id, theme: pal.theme, layer, z: zz, ti, tj, res,
      dist: Math.hypot(tx0 + TWz / 2 - cx, ty0 + TWz / 2 - cy) + (layer === 'sea' ? TWz * 0.3 : 0),
      names: layer === 'land' ? names.filter(n => n.box[2] > tx0 - TWz * 0.2 && n.box[0] < tx0 + TWz * 1.2 && n.box[3] > ty0 - TWz * 0.2 && n.box[1] < ty0 + TWz * 1.2) : [], ...extra};
  };
  let names = nameShapes(world, z, kb);
  for (let layer of ['land', 'sea']) {
    let band = shownBand(world, layer, z);
    for (let ti = Math.floor(x0 / TW); ti <= Math.floor(x1 / TW); ++ti) for (let tj = Math.floor(y0 / TW); tj <= Math.floor(y1 / TW); ++tj) {
      let key = tileKey(world, layer, z, ti, tj);
      band.keys.add(key);
      if (!hasTile(band, key)) want.push(request(layer, z, ti, tj, TW, names));
    }
    settleBand(world, layer);
  }
  want.sort((a, b) => a.dist - b.dist);
  // then, while nothing else is wanted, the next band in for the middle of the view: the worker
  // draws and keeps those tiles, so a pinch inward finds them ready
  let z1 = z + 1, kb1 = bandK(z1, d), TW1 = TILE_PX / kb1, mx = (x1 - x0) / 4, my = (y1 - y0) / 4, names1 = null;
  for (let layer of ['land', 'sea'])
    for (let ti = Math.floor((cx - mx) / TW1); ti <= Math.floor((cx + mx) / TW1); ++ti) for (let tj = Math.floor((cy - my) / TW1); tj <= Math.floor((cy + my) / TW1); ++tj) {
      if (empty.has(tileKey(world, layer, z1, ti, tj))) continue;
      want.push(request(layer, z1, ti, tj, TW1, layer === 'land' ? (names1 || (names1 = nameShapes(world, z1, kb1))) : [], {ahead: true}));
    }
  send({type: 'tiles', list: want});
  checkReady(world);
}
// the group of a layer for band z, made if needed (hidden until its tiles are in)
function shownBand(world, layer, z) {
  let ink = world.ink, bands = ink.band[layer] || (ink.band[layer] = new Map());
  let band = bands.get(z);
  if (!band) {
    let g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'ink-band incoming');
    world.ink[layer].appendChild(g);
    band = {z, g, images: new Map(), keys: new Set(), loading: new Set(), shown: false};
    bands.set(z, band);
  }
  band.keys = new Set();
  ink.z = z;
  return band;
}
function place(world, band, key, url) {
  let [, , , z, ti, tj] = key.split('|'), kb = bandK(+z, dev()), TW = TILE_PX / kb;
  let g = document.createElementNS(NS, 'g');
  g.setAttribute('transform', `translate(${+ti * TW} ${-(+tj + 1) * TW}) scale(${1 / kb})`);
  let im = document.createElementNS(NS, 'image');
  im.setAttribute('width', TILE_PX);
  im.setAttribute('height', TILE_PX);
  im.setAttribute('preserveAspectRatio', 'none');
  im.setAttribute('class', 'ink-tile' + (band.shown ? ' fresh' : ''));   // a tile added to a band on screen fades in
  im.setAttribute('href', url);
  g.appendChild(im);
  band.g.appendChild(g);
  band.images.set(key, g);
}
function tileArrived(world, data) {
  let ink = world.ink, key = data.key;
  if (ink.pending) ink.pending.delete(key);
  let [, theme, layer, z] = key.split('|');
  let band = ink.band[layer] && ink.band[layer].get(+z);
  if (data.unknown) {
    // the worker no longer has this world's survey (let go, or a fresh worker): survey it again
    if (!ink.resurvey) { ink.resurvey = true; ink.survey = ink.known.survey = null; startSurvey(world); }
    return;
  }
  if (!data.blob && !data.canvas) { if (!data.failed) empty.add(key); }
  else if (theme === pal.theme && band && band.keys.has(key) && !band.images.has(key) && !band.loading.has(key)) {
    // decoded before it is placed; the band is shown once every tile of the view is placed
    band.loading.add(key);
    let still = () => active() && ink.band[layer] && ink.band[layer].get(+z) === band && band.keys.has(key) && !band.images.has(key);
    (data.blob ? Promise.resolve(data.blob) : new Promise(r => data.canvas.toBlob(r, 'image/png'))).then(blob => {
      if (!blob || !still()) return null;
      let url = URL.createObjectURL(blob), probe = new Image();
      probe.src = url;
      return probe.decode().catch(() => {}).then(() => url);
    }).then(url => {
      band.loading.delete(key);
      if (!url) return;
      if (!still()) { URL.revokeObjectURL(url); return; }
      place(world, band, key, url);
      settleBand(world, layer);
      checkReady(world);
    });
  }
  if (empty.size > 20000) empty.clear();
  settleBand(world, layer);
  checkReady(world);
}
// A band whose tiles for the view are all in fades in; the bands under it go
function settleBand(world, layer) {
  let ink = world.ink, bands = ink.band[layer];
  if (!bands) return;
  let band = bands.get(ink.z);
  if (!band) return;
  // tiles placed earlier that the view no longer needs are let go (their canvas with them)
  if (band.shown) for (let [key, g] of band.images) if (!band.keys.has(key) && band.images.size > 3 * band.keys.size) { release(g); band.images.delete(key); }
  let missing = [...band.keys].some(key => !hasTile(band, key));
  if (!band.shown && !missing) {
    band.shown = true;
    band.g.setAttribute('class', 'ink-band');
    world.ink[layer].appendChild(band.g);   // on top of the others
  }
  for (let b of [...bands.values()]) {
    if (b === band) continue;
    // a band left behind before it was shown is dropped at once
    if (!b.shown) { dropBand(bands, b); continue; }
    // the old picture stays until this band is in
    if (!band.shown) continue;
    // A band drawn over this one goes at once: the view came back to a band still on screen
    // (a quick pinch in and out), and its ink would lie doubled over this band's. One under this
    // band goes once this one has faded in, unless the view comes back to it first.
    let above = band.g.compareDocumentPosition(b.g) & Node.DOCUMENT_POSITION_FOLLOWING;
    if (above || reduceMotion()) dropBand(bands, b);
    else if (!b.drop) b.drop = setTimeout(() => {
      b.drop = 0;
      if (bands.get(b.z) === b && b !== bands.get(ink.z)) dropBand(bands, b);
    }, 300);
  }
}
function dropBand(bands, b) {
  clearTimeout(b.drop);
  b.drop = 0;
  release(b.g);
  if (bands.get(b.z) === b) bands.delete(b.z);
}
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function checkReady(world) {
  let ink = world.ink;
  if (!ink.survey || !ink.band.land || !ink.band.sea) return;
  let ok = ['land', 'sea'].every(l => { let b = ink.band[l].get(ink.z); return b && b.shown; });
  if (ok && !ink.ready) { ink.ready = true; ink.waiters.splice(0).forEach(f => f()); }
  window.__inkSettled = ok && current && current.world === world;
}
function settled(world) {
  if (!world || !world.ink || world.ink.ready) return Promise.resolve();
  return new Promise(resolve => { world.ink.waiters.push(resolve); setTimeout(resolve, 8000); });
}

// The names of a band, as thick polylines in world coordinates, for the land tiles to keep clear of
function nameShapes(world, z, kb) {
  let out = [];
  for (let item of world.items) {
    let s = item.inkName, p = s ? s.p : (world.ink.known.plans && world.ink.known.plans.get(item.index + ''));
    if (!p || !(p.f > 0)) continue;
    // as large as the name is shown anywhere in the band (from kb / √2 to kb × √2)
    let f = Math.min(p.f, p.tier.px * Math.SQRT2 / kb);
    if (p.f * kb * Math.SQRT2 < 10 || p.w * p.f * kb * Math.SQRT2 < 18) continue;
    let half = p.w * f / 2 - p.spacing * f * 0.5, pts = [];
    if (p.curve) {
      let {A, B, C} = p.curve, nx = -p.uy, ny = p.ux;
      for (let i = 0; i <= 12; ++i) {
        let t = (i / 12 - 0.5) * 2 * half, sv = A * t * t + B * t + C;
        pts.push([p.x + t * p.ux + sv * nx, p.y + t * p.uy + sv * ny]);
      }
    } else pts.push([p.x - p.ux * half, p.y - p.uy * half], [p.x + p.ux * half, p.y + p.uy * half]);
    let r = f * (p.lines.length === 1 ? 0.5 : 1.08) + 1.5 / kb;
    let box = [Infinity, Infinity, -Infinity, -Infinity];
    pts.forEach(([x, y]) => { box[0] = Math.min(box[0], x - r); box[1] = Math.min(box[1], y - r); box[2] = Math.max(box[2], x + r); box[3] = Math.max(box[3], y + r); });
    out.push({pts, r, box});
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The chosen realm and its neighbours keep their ink; the others fade under a veil (drawn over the
// land tiles, under the lines), their lines and names fade with them
function veil(world, selected) {
  let ink = world.ink;
  if (ink.veiled === selected && (!selected || ink.veilK === bandOf(current.state.k, dev()))) return;
  ink.veiled = selected;
  ink.veilK = selected ? bandOf(current.state.k, dev()) : null;
  ink.veil.textContent = '';
  world.items.forEach(it => it.path.classList.toggle('ink-chosen', it === selected));
  let keep = selected ? new Set([selected.index, ...world.neighbours[selected.index]]) : null;
  world.lineItems.forEach(line => line.node.classList.toggle('ink-faded', !!keep && !keep.has(line.a) && !keep.has(line.b)));
  if (!selected) return;
  let tol = 0.4 / current.state.k, d = '';
  for (let item of world.items) {
    if (keep.has(item.index)) continue;
    for (let r of item.country.rings) d += ringD(simplifyRing(r, tol));
  }
  let p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d);
  ink.veil.appendChild(p);
}
const ringD = r => 'M' + r.map(([x, y]) => x + ' ' + (-y)).join('L') + 'Z';
function simplifyRing(ring, tol) {
  let n = ring.length;
  if (n < 6) return ring;
  let keep = new Uint8Array(n), t2 = tol * tol, far = 0, at = 0;
  for (let i = 1; i < n; ++i) { let d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2; if (d > far) { far = d; at = i; } }
  keep[0] = keep[at] = keep[n - 1] = 1;
  let stack = [0, at, at, n - 1];
  while (stack.length) {
    let j = stack.pop(), i = stack.pop();
    let [ax, ay] = ring[i], [bx, by] = ring[j], dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy, worst = -1, w = -1;
    for (let m = i + 1; m < j; ++m) {
      let [px, py] = ring[m], t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
      let d = (ax + t * dx - px) ** 2 + (ay + t * dy - py) ** 2;
      if (d > worst) { worst = d; w = m; }
    }
    if (worst > t2) { keep[w] = 1; stack.push(i, w, w, j); }
  }
  return ring.filter((p, m) => keep[m]);
}
function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}

// ---------------------------------------------------------------------------------------------
// The sea's furniture, placed once per world in the widest open water clear of the title and the
// panels as the world is first shown: the rose, a ship, a serpent, and the names of the seas
function placeFurniture(world, state) {
  let ink = world.ink, sp = ink.spots, k = state.k;
  let panels = panelRects(), S = (x, y) => [state.x + k * x, state.y - k * y];
  let cand = [sp.rose, sp.ship, sp.serpent, ...sp.names.filter(s => !s.outer)].filter(Boolean);
  let free = (s, r) => {
    let [x, y] = S(s.x, s.y);
    return !panels.some(p => x + r > p[0] && x - r < p[2] && y + r > p[1] && y - r < p[3]);
  };
  let used = new Set(), pick = r => cand.find(s => !used.has(s) && free(s, r(s)) && used.add(s));
  let rose = pick(s => roseRadius(s, k) * 1.35);
  // on a phone the rose alone: a ship and a serpent too crowd a small screen
  let roomy = screen.w >= 600;
  let shipS = roomy && pick(s => vignetteSize(s, k) * 2);
  let serp = roomy && pick(s => vignetteSize(s, k) * 2.2);
  let seed = seedOf();
  let decor = {rose, ship: shipS && {...shipS, dir: seed % 2 ? 1 : -1}, serpent: serp && {...serp, dir: seed % 3 ? -1 : 1}, clear: []};
  if (rose) decor.clear.push([rose.x, rose.y, roseRadius(rose, k) * 1.4]);
  [decor.ship, decor.serpent].forEach(s => { if (s) decor.clear.push([s.x, s.y, vignetteSize(s, k) * 2.2]); });
  ink.decor = ink.known.decor = decor;
  ink.nameSpots = ink.known.nameSpots = sp.names.filter(s => !used.has(s));
  send({type: 'decor', id: ink.id, decor});
  ink.decorSent = true;
}
function panelRects(live) {
  let out = [];
  for (let sel of ['header.cartouche', '#credit', '#info', '#dock', '#controls']) {
    let el = document.querySelector(sel), r = el && !el.hidden && el.getBoundingClientRect();
    if (r && r.width) out.push([r.left - 10, r.top - 10, r.right + 10, r.bottom + 10]);
  }
  // (a panel that opens later, the chosen realm's, hides what it would cover: see ornaments)
  return out;
}

// The furniture as images in the sea's layer, as large on screen as the open water allows within
// limits; one the title or a panel would cover is hidden (where they are is measured after the frame)
const ornamentArt = new Map();
function ornamentUrl(kind, r, dir) {
  let key = pal.theme + kind + dir + r;
  if (!ornamentArt.has(key)) {
    let {canvas, half} = drawOrnament(document.createElement('canvas'), kind, r, dir, pal, 2);
    ornamentArt.set(key, {url: canvas.toDataURL('image/png'), half});
  }
  return ornamentArt.get(key);
}
let lastPanels = null;
function ornaments(world, state) {
  let ink = world.ink, d = ink.decor;
  if (!d) return;
  let k = state.k, panels = lastPanels || panelRects(true);
  if (!ink.ornaments) {
    ink.ornaments = [];
    for (let [kind, spot] of [['rose', d.rose], ['ship', d.ship], ['serpent', d.serpent]]) {
      if (!spot) continue;
      let img = document.createElementNS(NS, 'image');
      img.setAttribute('class', 'ink-ornament');
      img.setAttribute('preserveAspectRatio', 'none');
      ink.seaNames.appendChild(img);
      ink.ornaments.push({kind, spot, img, theme: null});
    }
  }
  for (let o of ink.ornaments) {
    let ref = o.kind === 'rose' ? 60 : 36, r = o.kind === 'rose' ? roseRadius(o.spot, k) : vignetteSize(o.spot, k);
    let art = ornamentUrl(o.kind, ref, o.spot.dir || 1);
    if (o.theme !== pal.theme) { o.img.setAttribute('href', art.url); o.theme = pal.theme; }
    let half = art.half * r / ref, x = o.spot.x - half / k, y = -o.spot.y - half / k, w = 2 * half / k;
    o.img.setAttribute('x', x); o.img.setAttribute('y', y); o.img.setAttribute('width', w); o.img.setAttribute('height', w);
    let sx = state.x + k * o.spot.x, sy = state.y - k * o.spot.y, m = half * 0.8;
    let covered = panels.some(p => sx + m > p[0] && sx - m < p[2] && sy + m > p[1] && sy - m < p[3]);
    o.img.classList.toggle('hidden', covered);
  }
  // the panels as drawn this frame, for the next view (and again now, if they moved)
  requestAnimationFrame(() => setTimeout(() => {
    if (!active() || !current || current.world !== world) return;
    let now = panelRects(true), same = lastPanels && JSON.stringify(now) === JSON.stringify(lastPanels);
    lastPanels = now;
    if (!same) ornaments(world, current.state);
  }, 0));
}

// The seas' names in spaced italic capitals on a gentle arch, as svg text under the countries,
// chosen once (where the open water holds them) and kept the same size on screen
const SEAS = {west: 'Mare Occidentale', east: 'Mare Orientale', south: 'Mare Australe', north: 'Mare Septentrionale', mid: 'Mare Medium'};
function seaNames(world, state) {
  let ink = world.ink, k = state.k;
  if (!ink.seaNameList) chooseSeaNames(world, state);
  for (let n of ink.seaNameList) {
    let px = n.px, total = n.per * px, R = total * 1.6 / k, f = px / k;
    let a = total / 2 / (total * 1.6);
    let x0 = n.x - Math.sin(a) * R, x1 = n.x + Math.sin(a) * R, yEnd = n.y - (1 - Math.cos(a)) * R;
    n.path.setAttribute('d', `M ${x0} ${-yEnd} A ${R} ${R} 0 0 1 ${x1} ${-yEnd}`);
    n.text.setAttribute('font-size', f);
  }
}
function chooseSeaNames(world, state) {
  let ink = world.ink, sv = ink.survey, k = state.k, b = world.box, list = [];
  let cx = (b.minX + b.maxX) / 2, cy = -(b.minY + b.maxY) / 2, used = new Set(), placed = panelRects();
  if (ink.decor) for (let [x, y, r] of ink.decor.clear) { let sx = state.x + k * x, sy = state.y - k * y; placed.push([sx - r, sy - r, sx + r, sy + r]); }
  let measure = measurer || (measurer = document.createElement('canvas').getContext('2d'));
  for (let spot of ink.nameSpots || []) {
    if (used.size >= 3) break;
    let dx = (spot.x - cx) / (b.maxX - b.minX), dy = (spot.y - cy) / (b.maxY - b.minY);
    let side = Math.abs(dx) < 0.18 && Math.abs(dy) < 0.18 ? 'mid' : Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'west' : 'east') : (dy < 0 ? 'south' : 'north');
    if (used.has(side)) continue;
    let text = SEAS[side].toUpperCase();
    measure.font = `italic 100px ${FONT}, Georgia, serif`;
    let per = [...text].reduce((a, ch) => a + measure.measureText(ch).width / 100 + 0.42, 0) - 0.42;
    let px = Math.min(spot.outer ? 19 : 17, spot.d * 0.5 * k, spot.run * k * 0.8 / per);
    if (px < 10) continue;
    let total = per * px, sx = state.x + k * spot.mid, sy = state.y - k * spot.y;
    if (sx - total / 2 < 14 || sx + total / 2 > screen.w - 14 || sy < 30 || sy > screen.h - 30) continue;
    let rect = [sx - total / 2 - px, sy - px * 1.5, sx + total / 2 + px, sy + px * 1.5];
    if (placed.some(r => rect[0] < r[2] && rect[2] > r[0] && rect[1] < r[3] && rect[3] > r[1])) continue;
    // every letter on open water
    let wet = true, R = total * 1.6;
    for (let t = -0.5; t <= 0.5 && wet; t += 0.05) {
      let a = t * total / R, lx = sx + Math.sin(a) * R, ly = sy + (1 - Math.cos(a)) * R;
      let wx = (lx - state.x) / k, wy = (state.y - ly) / k;
      let c = Math.floor((wx - sv.x0) / sv.cell), r = Math.floor((sv.y0 - wy) / sv.cell);
      if (c >= 0 && r >= 0 && c < sv.w && r < sv.h) { let i = r * sv.w + c; wet = sv.ids[i] === -1 && sv.toLand[i] * sv.cell * k > px * 0.75; }
    }
    if (!wet) continue;
    placed.push(rect);
    used.add(side);
    list.push({x: spot.mid, y: spot.y, px, per, text});
  }
  ink.seaNameList = list.map(n => {
    let path = document.createElementNS(NS, 'path'), id = 'ink-sea-' + ink.id + '-' + (++curves);
    path.setAttribute('id', id);
    ink.defs.appendChild(path);
    let text = document.createElementNS(NS, 'text');
    text.setAttribute('class', 'ink-seaname');
    text.setAttribute('letter-spacing', '0.42em');
    let tp = document.createElementNS(NS, 'textPath');
    tp.setAttribute('href', '#' + id);
    tp.setAttribute('startOffset', '50%');
    tp.textContent = n.text;
    text.appendChild(tp);
    ink.seaNames.appendChild(text);
    return {...n, path, text};
  });
}

// ---------------------------------------------------------------------------------------------
// Names. The great realms in widely spaced capitals, arched across their land and lettered in red;
// then smaller and closer capitals; then the lesser realms in a roman hand, the least in italic.
// Widths are measured in the lettering's own font once it has loaded.
const FONT = 'Fondamento';
const TIERS = [
  {min: 1e8, caps: true, rel: 0.2, px: 40, spacing: [0.32, 0.85], arch: 0.11, rubric: true},
  {min: 3e7, caps: true, rel: 0.19, px: 29, spacing: [0.22, 0.6], arch: 0.09},
  {min: 5e6, caps: true, rel: 0.18, px: 21, spacing: [0.12, 0.32], arch: 0.07},
  {min: 5e5, caps: false, rel: 0.17, px: 17, spacing: [0.03, 0.1]},
  {min: 0, caps: false, italic: true, rel: 0.17, px: 15, spacing: [0.02, 0.05]},
];
let measurer = null, widths = new Map();
function advance(text, italic) {
  let key = (italic ? 'i' : 'r') + text, w = widths.get(key);
  if (w !== undefined) return w;
  if (!measurer) measurer = document.createElement('canvas').getContext('2d');
  measurer.font = `${italic ? 'italic ' : ''}100px ${FONT}, Georgia, serif`;
  w = measurer.measureText(text).width / 100;
  widths.set(key, w);
  return w;
}
let fontsReady = false;
const fontsLoaded = (document.fonts ? Promise.all([`100px ${FONT}`, `italic 100px ${FONT}`].map(f => document.fonts.load(f))) : Promise.resolve())
  .catch(() => {}).then(() => { fontsReady = true; widths.clear(); });

function inside(ring, x, y) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    let [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
function clearOf(ring, x, y, r) {
  let r2 = r * r;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    let ax = ring[j][0], ay = ring[j][1], dx = ring[i][0] - ax, dy = ring[i][1] - ay;
    let len = dx * dx + dy * dy, t = len ? ((x - ax) * dx + (y - ay) * dy) / len : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    let ex = ax + t * dx - x, ey = ay + t * dy - y;
    if (ex * ex + ey * ey < r2) return false;
  }
  return true;
}
function axisOf(ring) {
  let A = 0, cx = 0, cy = 0, ixx = 0, iyy = 0, ixy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    let [x0, y0] = ring[j], [x1, y1] = ring[i], c = x0 * y1 - x1 * y0;
    A += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
    iyy += (x0 * x0 + x0 * x1 + x1 * x1) * c; ixx += (y0 * y0 + y0 * y1 + y1 * y1) * c;
    ixy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * c;
  }
  A /= 2; cx /= 6 * A; cy /= 6 * A;
  let sxx = iyy / 12 / A - cx * cx, syy = ixx / 12 / A - cy * cy, sxy = ixy / 24 / A - cx * cy;
  let mid = (sxx + syy) / 2, r = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
  return {angle: 0.5 * Math.atan2(2 * sxy, sxx - syy), elong: Math.sqrt((mid + r) / Math.max(mid - r, 1e-12))};
}
// Largest font (world units) at which a block w em by h em centred at (x, y) along (ux, uy) fits
function fitFont(ring, x, y, ux, uy, w, h, limit) {
  let ok = f => {
    let half = h * f / 2 + f * 0.14;
    for (let k of [0, 6, 3, 1, 5, 2, 4]) {
      let t = (k / 6 - 0.5) * w * f, px = x + t * ux, py = y + t * uy;
      if (!clearOf(ring, px, py, half) || !inside(ring, px, py)) return false;
    }
    return true;
  };
  if (ok(limit)) return limit;
  let lo = 0, hi = limit;
  for (let it = 0; it < 10; ++it) { let m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
  return lo;
}
function placeName(item, short) {
  let c = item.country, name = (short || c.name).trim();
  let tier = TIERS.find(t => c.population >= t.min);
  let text = tier.caps ? name.toUpperCase() : name, italic = !!tier.italic;
  let main = c.rings.reduce((best, r) => Math.abs(ringArea(r)) > Math.abs(ringArea(best)) ? r : best);
  let ring = simplifyRing(main, item.size * 0.015);
  let {angle, elong} = axisOf(ring);
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle <= -Math.PI / 2) angle += Math.PI;
  let angles = [0];
  if (elong > 1.25 && Math.abs(angle) > 0.12 && Math.abs(angle) < 1.15) angles.push(angle);
  let layouts = [[text]];
  let words = text.split(' ');
  if (words.length > 1 && text.length > 10) {
    let best = null;
    for (let k = 1; k < words.length; ++k) {
      let a = words.slice(0, k).join(' '), b = words.slice(k).join(' ');
      let d = Math.abs(advance(a, italic) - advance(b, italic));
      if (!best || d < best.d) best = {d, lines: [a, b]};
    }
    layouts.push(best.lines);
  }
  let s0 = tier.spacing[0];
  let width = lines => Math.max(...lines.map(l => advance(l, italic) + s0 * Math.max(0, l.length - 1)));
  let limit = tier.rel * item.size, pick = null;
  for (let lines of layouts) for (let a of angles) {
    let ux = Math.cos(a), uy = Math.sin(a), w = width(lines), h = lines.length === 1 ? 0.8 : 2.05;
    for (let shift of a === 0 && elong < 1.25 ? [0] : [0, -0.3, 0.3]) {
      let x = item.pole.x + shift * item.pole.r * ux, y = item.pole.y + shift * item.pole.r * uy;
      let f = fitFont(ring, x, y, ux, uy, w, h, limit);
      let score = f * (a === 0 ? 1 : 0.86) * (lines.length === 1 ? 1 : 0.9);
      if (!pick || score > pick.score) pick = {score, f, a, x, y, lines, w, h, ux, uy};
    }
  }
  pick.curve = null;
  if (pick.f > 0 && pick.lines.length === 1 && (elong > 1.45 || tier.arch)) pick.curve = bend(ring, pick, tier);
  let spacing = s0;
  if (pick.f > 0 && tier.spacing[1] > s0 && pick.lines.length === 1) {
    let n = Math.max(1, pick.lines[0].length - 1), base = advance(pick.lines[0], italic);
    let lo = s0, hi = tier.spacing[1];
    let fits = sp => pick.curve ? curveFits(ring, pick, pick.curve, base + sp * n, pick.f)
      : fitFont(ring, pick.x, pick.y, pick.ux, pick.uy, base + sp * n, pick.h, pick.f) >= pick.f * 0.999;
    if (fits(hi)) lo = hi;
    else for (let it = 0; it < 6; ++it) { let m = (lo + hi) / 2; if (fits(m)) lo = m; else hi = m; }
    spacing = lo;
    pick.w = base + spacing * n;
  }
  return {tier, italic, ...pick, spacing};
}
function middle(ring, pick, t) {
  let cx = pick.x + t * pick.ux, cy = pick.y + t * pick.uy, nx = -pick.uy, ny = pick.ux;
  let lo = -Infinity, hi = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    let ax = ring[j][0] - cx, ay = ring[j][1] - cy, bx = ring[i][0] - cx, by = ring[i][1] - cy;
    let da = ax * pick.ux + ay * pick.uy, db = bx * pick.ux + by * pick.uy;
    if ((da > 0) === (db > 0)) continue;
    let u = da / (da - db), sv = (ax + u * (bx - ax)) * nx + (ay + u * (by - ay)) * ny;
    if (sv <= 0 && sv > lo) lo = sv;
    if (sv > 0 && sv < hi) hi = sv;
  }
  return lo > -Infinity && hi < Infinity ? (lo + hi) / 2 : null;
}
// The baseline bent to follow the middle of the land (a parabola fitted to the middles of the
// crossings along the name); a great realm's name that would run straight is arched a little
// instead, as a letterer arches a name across a kingdom
function bend(ring, pick, tier) {
  let half = pick.w * pick.f / 2, pts = [];
  for (let k = -6; k <= 6; ++k) {
    let t = k / 6 * half * 1.1, m = middle(ring, pick, t);
    if (m !== null) pts.push([t, m]);
  }
  let A = 0, B = 0, C = 0;
  if (pts.length >= 9) {
    let S = [0, 0, 0, 0, 0], T = [0, 0, 0];
    for (let [t, m] of pts) { let p = 1; for (let e = 0; e < 5; ++e) { S[e] += p; if (e < 3) T[e] += p * m; p *= t; } }
    let M = [[S[4], S[3], S[2]], [S[3], S[2], S[1]], [S[2], S[1], S[0]]], R = [T[2], T[1], T[0]];
    let det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    let D = det(M);
    if (D) {
      let col = c => M.map((row, r) => row.map((v, q) => q === c ? R[r] : v));
      A = det(col(0)) / D; B = det(col(1)) / D; C = det(col(2)) / D;
    }
  }
  let sag = Math.abs(A) * half * half;
  let options = [];
  if (sag >= 0.22 * pick.f) {
    if (sag > half / 6) A *= half / 6 / sag;
    options.push({A, B, C}, {A: A * 0.6, B: B * 0.6, C: C * 0.6});
  }
  if (tier.arch) {
    let a = tier.arch * half / (half * half);
    options.push({A: -a, B: 0, C: a * half * half * 0.4}, {A: -a * 0.6, B: 0, C: a * half * half * 0.25});
  }
  for (let c of options) if (curveFits(ring, pick, c, pick.w, pick.f)) return c;
  return null;
}
function curveFits(ring, pick, c, w, f) {
  let half = w * f / 2, r = pick.h * f / 2 + f * 0.14, nx = -pick.uy, ny = pick.ux;
  for (let k = -4; k <= 4; ++k) {
    let t = k / 4 * half, sv = c.A * t * t + c.B * t + c.C;
    let x = pick.x + t * pick.ux + sv * nx, y = pick.y + t * pick.uy + sv * ny;
    if (!clearOf(ring, x, y, r) || !inside(ring, x, y)) return false;
  }
  return true;
}

let curves = 0;
// A name's placing, worked out once per build result (and kept with it), for the whole name or,
// where the page offers one (item.abbr), the short form
function planOf(world, item, short) {
  let known = world.ink.known, plans = known.plans || (known.plans = new Map()), key = item.index + (short ? 's' : '');
  let p = plans.get(key);
  if (!p) { p = placeName(item, short ? item.abbr : null); plans.set(key, p); }
  return p;
}
const shortOf = item => item.abbr && item.abbr !== item.country.name ? item.abbr : null;
function letter(item, world, short) {
  if (!fontsReady) world.ink.letteredEarly = true;
  let label = item.label;
  let p = planOf(world, item, short);
  let deg = -p.a * 180 / Math.PI;
  let t = TIERS.indexOf(p.tier);
  label.setAttribute('class', `label ink-name ink-t${t} ink-halo-${item.inkSlot}` + (p.tier.rubric ? ' ink-rubric' : ''));
  label.setAttribute('x', p.x);
  label.setAttribute('y', -p.y);
  label.setAttribute('font-size', p.f);
  label.setAttribute('letter-spacing', p.spacing + 'em');
  label.removeAttribute('transform');
  label.textContent = '';
  let dx = p.spacing / 2 + 'em';
  if (p.curve) {
    let {A, B, C} = p.curve, half = p.w * p.f / 2 * 1.5, nx = -p.uy, ny = p.ux;
    let at = t => { let sv = A * t * t + B * t + C; return [p.x + t * p.ux + sv * nx, -(p.y + t * p.uy + sv * ny)]; };
    let s0 = A * half * half - B * half + C, slope = -2 * A * half + B;
    let ctrl = [p.x + (s0 + slope * half) * nx, -(p.y + (s0 + slope * half) * ny)];
    let [a0, a1] = [at(-half), at(half)];
    let path = document.createElementNS(NS, 'path');
    let id = 'ink-curve-' + (++curves);
    path.setAttribute('id', id);
    path.setAttribute('d', `M ${a0[0]} ${a0[1]} Q ${ctrl[0]} ${ctrl[1]} ${a1[0]} ${a1[1]}`);
    world.ink.defs.appendChild(path);
    let tp = document.createElementNS(NS, 'textPath');
    tp.setAttribute('href', '#' + id);
    tp.setAttribute('startOffset', '50%');
    let ts = document.createElementNS(NS, 'tspan');
    ts.setAttribute('dx', dx);
    ts.textContent = p.lines[0];
    tp.appendChild(ts);
    label.appendChild(tp);
    label.removeAttribute('x');
    label.removeAttribute('y');
  } else if (p.lines.length === 1) {
    if (deg) label.setAttribute('transform', `rotate(${deg} ${p.x} ${-p.y})`);
    let ts = document.createElementNS(NS, 'tspan');
    ts.setAttribute('dx', dx);
    ts.textContent = p.lines[0];
    label.appendChild(ts);
  } else {
    if (deg) label.setAttribute('transform', `rotate(${deg} ${p.x} ${-p.y})`);
    p.lines.forEach((line, k) => {
      let ts = document.createElementNS(NS, 'tspan');
      ts.setAttribute('x', p.x);
      ts.setAttribute('dx', dx);
      ts.setAttribute('dy', k === 0 ? '-0.55em' : '1.12em');
      ts.textContent = line;
      label.appendChild(ts);
    });
  }
  item.font = p.f * (p.tier.caps ? 1.12 : 1);
  item.labelFits = p.w * p.f;
  item.inkName = {font: p.f, px: p.tier.px, shown: p.f, p, short: !!short};
}

// Fitting names is done ahead, while the page is idle, biggest country first
function planNames(world) {
  let queue = world.items.slice().sort((p, q) => q.size - p.size);
  let later = window.requestIdleCallback || (f => setTimeout(() => f({timeRemaining: () => 10}), 30));
  let step = deadline => {
    if (world.ink.dead) return;
    while (queue.length && deadline.timeRemaining() > 1) {
      let item = queue.shift();
      if (!item.inkName) planOf(world, item);
    }
    if (queue.length) later(step);
  };
  fontsLoaded.then(() => later(step));
}

function letterNames(world, state, selected) {
  let k = state.k, [W, H] = [screen.w, screen.h];
  if (!world.ink.defs) {
    let defs = document.createElementNS(NS, 'defs');
    world.root.insertBefore(defs, world.root.firstChild);
    world.ink.defs = defs;
  }
  world.items.forEach(item => {
    if (item.size * k < 40 && !item.inkName) return;
    let x = state.x + k * item.pole.x, y = state.y - k * item.pole.y, r = 1.5 * item.size * k;
    if (!item.inkName && (x + r < 0 || x - r > W || y + r < 0 || y - r > H)) return;
    // the whole name where it is big enough to read, else the short form where that is
    let short = shortOf(item), use = false;
    if (short && planOf(world, item).f * k < 10 && planOf(world, item, short).f * k >= 10) use = true;
    if (!item.inkName || item.inkName.short !== use) letter(item, world, use ? short : null);
  });
  world.items.forEach(item => {
    let s = item.inkName;
    if (!s) return;
    let show = s.font * k >= 10 && item.labelFits * k >= 18;
    let f = Math.min(s.font, s.px / k);
    if (Math.abs(f - s.shown) > 1e-9 * s.font) { item.label.setAttribute('font-size', f); s.shown = f; }
    if (show && item !== selected) {
      let b = nameBox(item, state);
      if (b[2] < -20 || b[0] > W + 20 || b[3] < -20 || b[1] > H + 20) show = false;
    }
    item.label.classList.toggle('hidden', !show);
    item.label.classList.toggle('ink-dim', !!selected && item !== selected && !world.neighbours[selected.index].includes(item.index));
  });
  markerNames(world, state, selected);
}
function nameBox(item, state) {
  let s = item.inkName, p = s.p, k = state.k;
  let cx = state.x + k * p.x, cy = state.y - k * p.y;
  let hw = p.w * s.shown * k / 2, hh = (p.lines.length === 1 ? 0.75 : 1.9) * s.shown * k / 2;
  let c = Math.abs(Math.cos(p.a)), sn = Math.abs(Math.sin(p.a));
  let ex = hw * c + hh * sn, ey = hw * sn + hh * c;
  if (p.curve) ey += Math.abs(p.curve.A) * (p.w * s.font / 2) ** 2 * k + Math.abs(p.curve.C) * k;
  return [cx - ex, cy - ey, cx + ex, cy + ey];
}

// Names beside the rings of countries too small to see, in small italic, where they fit clear of
// other names and rings (once the view is well inside the world)
const MARK_PX = 11;
function markerNames(world, state, selected) {
  let k = state.k, [W, H] = [screen.w, screen.h];
  if (!world.ink.marks) {
    let g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'ink-marks');
    world.root.appendChild(g);
    world.ink.marks = g;
  }
  let box = world.box, deep = (box.maxX - box.minX) * k / W;
  let rings = world.items.filter(item => !item.marker.classList.contains('hidden') && (deep > 2.4 || item === selected));
  let taken = panelBoxes();
  world.items.forEach(item => { if (item.inkName && !item.label.classList.contains('hidden')) taken.push(nameBox(item, state)); });
  let at = item => [state.x + k * item.pole.x, state.y - k * item.pole.y];
  rings.forEach(item => { let [x, y] = at(item); taken.push([x - 7, y - 7, x + 7, y + 7]); });
  rings.sort((p, q) => (q === selected) - (p === selected) || q.country.population - p.country.population);
  let onScreen = rings.filter(item => { let [x, y] = at(item); return x > 0 && y > 0 && x < W && y < H; });
  if (onScreen.length > 12) rings = rings.filter(item => item === selected);
  let free = r => r[0] >= 12 && r[1] >= 12 && r[2] <= W - 12 && r[3] <= H - 12 &&
    !taken.some(t => r[0] < t[2] && r[2] > t[0] && r[1] < t[3] && r[3] > t[1]);
  // a callout lies on open water, clear of the coast by a few pixels: lettered across a neighbour's
  // land it read as that land's name and cluttered it. Only the chosen realm's may go on land.
  let sv = world.ink.survey;
  let wet = r => {
    if (!sv) return false;
    for (let py = r[1] - 2; py <= r[3] + 2; py += 3) for (let px = r[0] - 2; px <= r[2] + 2; px += 4) {
      let wx = (px - state.x) / k, wy = (state.y - py) / k;
      let cx = Math.floor((wx - sv.x0) / sv.cell), cy = Math.floor((sv.y0 - wy) / sv.cell);
      if (cx < 0 || cy < 0 || cx >= sv.w || cy >= sv.h) continue;
      let c = cy * sv.w + cx;
      if (sv.ids[c] !== -1 || sv.toLand[c] * sv.cell * k < 3) return false;
    }
    return true;
  };
  let shown = new Set(), count = 0;
  for (let item of rings) {
    let [x, y] = at(item);
    if (x < 0 || y < 0 || x > W || y > H) continue;
    // a few at a time: the biggest first, and the chosen one always
    if (item !== selected && count >= 6) continue;
    let pick = null, name = null;
    for (let text of [item.country.name.trim(), shortOf(item)]) {
      if (!text || pick) continue;
      let w = advance(text, true) * MARK_PX + 2, h = MARK_PX * 0.9, g = 8;
      let options = [
        ['start', x + g, y, [x + g, y - h / 2, x + g + w, y + h / 2]],
        ['end', x - g, y, [x - g - w, y - h / 2, x - g, y + h / 2]],
        ['middle', x, y - g - h / 2, [x - w / 2, y - g - h, x + w / 2, y - g]],
        ['middle', x, y + g + h / 2, [x - w / 2, y + g, x + w / 2, y + g + h]],
      ];
      pick = options.find(o => free(o[3]) && wet(o[3])) || (item === selected ? options.find(o => free(o[3])) : null);
      name = text;
    }
    if (!pick) continue;
    if (item !== selected) count++;
    taken.push(pick[3]);
    shown.add(item);
    let t = item.inkMark;
    if (!t) {
      t = item.inkMark = document.createElementNS(NS, 'text');
      t.setAttribute('class', 'label ink-mark');
      world.ink.marks.appendChild(t);
    }
    if (t.textContent !== name) t.textContent = name;
    t.setAttribute('x', (pick[1] - state.x) / k);
    t.setAttribute('y', (pick[2] - state.y) / k);
    t.setAttribute('font-size', MARK_PX / k);
    t.style.textAnchor = pick[0];
    t.classList.toggle('lit', item === selected);
    t.classList.remove('hidden');
  }
  world.items.forEach(item => { if (item.inkMark && !shown.has(item)) item.inkMark.classList.add('hidden'); });
}
// where the cartouche, the panel and the credit are, as of the last frame (asking during a redraw
// would make the browser lay out the whole map there and then)
let panels = [], panelsDue = false;
function panelBoxes() {
  if (!panelsDue) {
    panelsDue = true;
    requestAnimationFrame(() => setTimeout(() => {
      panelsDue = false;
      panels = [];
      for (let sel of ['header.cartouche', '#info', '#credit', '#dock', '#controls']) {
        let el = document.querySelector(sel), r = el && !el.hidden && el.getBoundingClientRect();
        if (r && r.width) panels.push([r.left - 4, r.top - 4, r.right + 4, r.bottom + 4]);
      }
    }, 0));
  }
  return panels.slice();
}

// ---------------------------------------------------------------------------------------------
// Mounting and unmounting (the page's style picker)
let frame = null, themeObserver = null, resizeHandler = null, themeHandler = null;
function mount() {
  if (mounted) return;
  mounted = true;
  readPalette();
  if (!document.getElementById('ink-frame')) {
    frame = document.createElement('div');
    frame.id = 'ink-frame';
    frame.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(frame, document.getElementById('stage').nextSibling);
  }
  // another theme: the tiles in its colours (kept apart in the cache, so switching back is instant)
  themeHandler = () => {
    if (!active()) return;
    readPalette();
    send({type: 'palette', palette: pal});
    for (let w of byId.values()) if (w.ink) {
      for (let layer in w.ink.band) for (let b of w.ink.band[layer].values()) b.g.remove();
      w.ink.band = {};
      // the other theme's papers, given out afresh (they differ: so do the best neighbours)
      applySlots(w);
      send({type: 'slots', id: w.ink.id, slots: Array.from(w.ink.slots)});
    }
    if (current) view(current.world, current.state, current.selected);
  };
  darkQuery.addEventListener('change', themeHandler);
  themeObserver = new MutationObserver(themeHandler);
  themeObserver.observe(html, {attributes: true, attributeFilter: ['data-theme']});
  resizeHandler = () => { screen.w = innerWidth; screen.h = innerHeight; };
  addEventListener('resize', resizeHandler);
  screen.w = innerWidth; screen.h = innerHeight;
  engine();
  send({type: 'palette', palette: pal});
}
function unmount() {
  if (!mounted) return;
  mounted = false;
  // the workers are idled, not stopped: they keep the surveys and the tiles drawn, so picking this
  // style again shows the same maps at once
  send({type: 'tiles', list: []});
  if (local) { clearTimeout(local.timer); local.queue = []; }
  for (let w of byId.values()) if (w.ink) {
    for (let layer in w.ink.band) for (let b of w.ink.band[layer].values()) { clearTimeout(b.drop); b.drop = 0; }
    w.ink.waiters.splice(0).forEach(f => f());
  }
  current = null;
  let f = document.getElementById('ink-frame');
  if (f) f.remove();
  let plate = document.getElementById('plate');
  if (plate) { plate.style.backgroundImage = ''; plate.style.backgroundPosition = ''; }
  frame = null;
  if (themeObserver) themeObserver.disconnect();
  darkQuery.removeEventListener('change', themeHandler);
  removeEventListener('resize', resizeHandler);
  window.__inkSettled = false;
}

if (typeof window !== 'undefined') {
  window.mapStyles = window.mapStyles || {};
  window.mapStyles.ink = {ripples: [], markerPx: 4.5, render, view, settled, unmount};
  window.__inkStats = () => current && current.world.ink ? {surveyed: !!current.world.ink.survey, ready: current.world.ink.ready, band: current.world.ink.z, placed: [...document.querySelectorAll('.ink-band .ink-tile')].length, pending: current.world.ink.pending ? current.world.ink.pending.size : 0} : null;
}
if (active()) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
