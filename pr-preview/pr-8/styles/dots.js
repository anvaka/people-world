// The dots: one dot for every so many people. This map gives every person the same room, so the
// dots lie on one even grid over the whole world, the same distance apart in every country: a
// country is where its dots are, in a colour of its own. Near a border the dots step back from it, so that a clear gap runs
// between two countries' dots; none is taken away, so every country keeps one for every so many of
// its people. Nothing else is drawn: no coasts, no terrain, no tints.
// Zooming in, a dot stands for fewer people (a million, then a hundred thousand, then ten
// thousand...), so the dots stay a few pixels apart; the legend says how many a dot is.
//
// The page calls these hooks (window.mapStyles.dots) when html has data-style="dots":
//   ripples   none: there is no sea to draw
//   markerPx  the radius of the ring round a country too small to see (shown only when chosen)
//   render    once per drawn world: the names are this style's to letter (the page then leaves
//             them whole, never Switz. or Bos. & Herz.)
//   view      after every redraw: the dots for this view, the chosen country, the names
//   unmount   the canvas and the legend go, the names are as the page made them

const html = typeof document === 'undefined' ? null : document.documentElement;
const active = () => html && html.dataset.style === 'dots';

// A hexagonal grid with one point per `n` people has points sqrt(2 / sqrt(3) * area per point)
// apart. The step (how many people a dot is) is the one that puts them about SPACING_PX apart.
const SPACING_PX = 9, MIN_SPACING = 0.62, MAX_TIDY = 1.25;   // the spacing wanted; how much closer or farther may do
const HEX = Math.sqrt(2 / Math.sqrt(3));
const RADIUS = 0.27;        // a dot's radius, as a share of the spacing
const RADIUS_SOFT = 0.24;   // (in a softer colour a dot can be a little smaller)
const GAP = 0.6;            // how far from a border the nearest dots step back, as a share of the spacing
const REACH = 2.5;          // how far from a border dots move at all (less and less), in spacings
// A country only a few dots across has no room to step back: its dots move less (not at all below
// SMALL spacings across, fully from FULL), and its bigger neighbours' make the gap
const SMALL = 2.5, FULL = 8;
// Names: as large as a share of the country's size on screen (the side of a square as large as it,
// so as large as the square root of its people), but no wider than a little more than that size,
// and no larger than a cap: capitals for the countries of more than thirty million, and the rest
const NAME_REL = 0.2, NAME_OVER = 1.25, NAME_MIN_PX = 9, NAME_PX = 44, SMALL_NAME_PX = 22, BIG = 3e7;
// the most populous countries are named whenever they have room, at least this large (on a phone
// the whole world is small, and by size alone only the two largest would be)
const NAMED_FIRST = 12, NAMED_FIRST_PX = 10;

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

// The borders near the view, as segments in buckets REACH spacings wide (in the svg's units), each
// border simplified to a quarter of the spacing first: the dots step back from its course, not
// from every wobble of its line
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  let keep = new Uint8Array(pts.length), stack = [[0, pts.length - 1]], t2 = tol * tol;
  keep[0] = keep[pts.length - 1] = 1;
  while (stack.length) {
    let [a, b] = stack.pop(), best = -1, at = -1;
    let ax = pts[a][0], ay = pts[a][1], dx = pts[b][0] - ax, dy = pts[b][1] - ay, L = dx * dx + dy * dy;
    for (let i = a + 1; i < b; ++i) {
      let t = L ? Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / L)) : 0;
      let ex = pts[i][0] - ax - t * dx, ey = pts[i][1] - ay - t * dy, d = ex * ex + ey * ey;
      if (d > best) { best = d; at = i; }
    }
    if (best > t2) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return pts.filter((p, i) => keep[i]);
}
function bordersNear(world, step, s, view) {
  let D = REACH * s, buckets = new Map(), [vx0, vy0, vx1, vy1] = view;
  world.lineItems.forEach((line, li) => {
    if (line.kind !== 'border') return;
    let b = line.box;
    if (b.x1 < vx0 - D || b.x0 > vx1 + D || b.y1 < vy0 - D || b.y0 > vy1 + D) return;
    if (!line.dotsPts || line.dotsStep !== step) {
      line.dotsStep = step;
      line.dotsPts = simplify(line.points.map(([x, y]) => [x, -y]), 0.25 * s);
    }
    let p = line.dotsPts;
    for (let i = 1; i < p.length; ++i) {
      let ax = p[i - 1][0], ay = p[i - 1][1], bx = p[i][0], by = p[i][1];
      let seg = [ax, ay, bx, by, li, line.a, line.b];
      for (let u = Math.floor(Math.min(ax, bx) / D); u <= Math.floor(Math.max(ax, bx) / D); ++u)
        for (let v = Math.floor(Math.min(ay, by) / D); v <= Math.floor(Math.max(ay, by) / D); ++v) {
          let key = u * 73856093 ^ v * 19349663, list = buckets.get(key);
          if (!list) buckets.set(key, list = []);
          list.push(seg);
        }
    }
  });
  return {D, buckets};
}

// ---------------------------------------------------------------------------------------------
// The layer: a canvas under the svg (the svg keeps the names, the rings round tiny countries and
// what the pointer finds), and an id map: every country filled in a colour of its own, off screen,
// to tell which country a dot is in
let canvas = null, idCanvas = null, legend = null, mountedNow = false;
let current = null, currentSelected = null, drawnKey = '', clearings = [];
// Each country's dots are in one of a few muted colours, neighbours never alike, the chosen
// country's in the ink. (For comparing: ?dots-look=ink, grey or tones in the address draws them
// all black, all grey, or in four greys.)
const LOOKS = ['hues', 'ink', 'grey', 'tones'];
const LOOK = (() => { let q = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('dots-look'); return LOOKS.includes(q) ? q : 'hues'; })();
const stats = {draws: 0, lastMs: 0, dots: 0, step: 0, counts: {}};

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
  let set = LOOK === 'grey' ? [get('--dot-soft', '#7d7972')]
    : LOOK === 'tones' ? [0, 1, 2, 3].map(i => get('--dot-tone-' + i, '#7d7972'))
    : LOOK === 'hues' ? [0, 1, 2, 3, 4, 5].map(i => get('--dot-hue-' + i, '#7d7972'))
    : [get('--dot', '#161514')];
  // (among colours the chosen country is in the ink; among blacks and greys, in red)
  return {set, lit: LOOK === 'hues' ? get('--dot', '#161514') : get('--dot-lit', '#e2412b'), faint: +get('--dot-faint-alpha', '0.22')};
}
// A colour for each country, neighbours never alike: the country with the most differently
// coloured neighbours first (DSATUR), each taking the colour its code hashes to if it is free, so
// that the colours come out evenly and a country keeps its colour through most edits
function slotsOf(world, n) {
  let dots = prepare(world);
  if (dots.slots && dots.slots.n === n) return dots.slots.of;
  let near = world.neighbours, of = {}, sat = new Map(), left = new Set(world.items.map(it => it.index));
  let id = i => world.byIndex.get(i).country.id;
  let pref = i => { let h = 0; for (let ch of id(i)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % n; };
  while (left.size) {
    let best = null, bs = -1, bd = -1;
    for (let i of left) {
      let sn = sat.has(i) ? sat.get(i).size : 0, d = near[i].length;
      if (sn > bs || (sn === bs && d > bd) || (sn === bs && d === bd && id(i) < id(best))) { best = i; bs = sn; bd = d; }
    }
    left.delete(best);
    let used = new Set(near[best].map(j => of[j]).filter(v => v !== undefined)), p = pref(best), pick = p;
    for (let k = 0; k < n; ++k) { let c = (p + k) % n; if (!used.has(c)) { pick = c; break; } }
    of[best] = pick;
    near[best].forEach(j => { if (!sat.has(j)) sat.set(j, new Set()); sat.get(j).add(pick); });
  }
  dots.slots = {n, of};
  return of;
}

function draw(world, state, selected) {
  if (!canvas || !world || !active()) return;
  let svg = document.getElementById('map');
  let W = svg.clientWidth, H = svg.clientHeight, dpr = Math.min(3, window.devicePixelRatio || 1);
  let theme = html.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'auto-dark' : 'auto-light');
  let key = [state.x, state.y, state.k, W, H, dpr, theme, selected ? selected.index : -1, clearings.map(b => b.map(Math.round).join(' ')).join(';')].join(',');
  if (key === drawnKey && world === current) return;
  let t0 = performance.now();
  drawnKey = key;
  let dots = prepare(world), {k, x: ox, y: oy} = state;
  // how many people a dot is. The spacing wanted is closer on a small screen, where the whole world
  // is small. A power of ten (a million, a hundred thousand) whose dots are between a little closer
  // and a little farther apart than that; else the round number (2 or 5 of a power of ten) nearest it
  // (in the screen's own pixels: a phone's are small and many, so its dots can be closer in css
  // pixels and still be as clear as a laptop's)
  let want = SPACING_PX / Math.sqrt(Math.max(1, dpr)) * Math.min(1, Math.min(W, H) / 800);
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

  // The dots: one grid for the whole world, fixed to the map (so they keep their places as it
  // moves), a dot at every point of it on land. Within REACH spacings of a border a dot is moved
  // away from it: by GAP of the spacing right at the border, less and less farther in. So a clear gap
  // runs along every border, the dots just inside it are a little closer together, and none is
  // lost: each country keeps a dot for every so many of its people.
  let near = new Set(selected ? world.neighbours[selected.index] : []);
  let paint = colours(), slots = slotsOf(world, paint.set.length), groups = new Map();
  let groupOf = (colour, faint) => { let key = colour + (faint ? '~' : ''); if (!groups.has(key)) groups.set(key, {colour, faint, list: []}); return groups.get(key).list; };
  let r = Math.max(0.6, (LOOK === 'ink' ? RADIUS : RADIUS_SOFT) * best.px), g = GAP * s, count = 0, counts = {};
  let cleared = (x, y) => clearings.some(b => x > b[0] - r && x < b[2] + r && y > b[1] - r && y < b[3] + r);
  let {D, buckets} = bordersNear(world, best.n, s, [vx0, vy0, vx1, vy1]);
  let dy = s * Math.sqrt(3) / 2, nearest = new Map();
  for (let sh of inView) {
    let item = sh.item, idx = item.index, id = sh.id;
    let bx0 = Math.max(sh.box[0], vx0 - D), bx1 = Math.min(sh.box[2], vx1 + D), by0 = Math.max(sh.box[1], vy0 - D), by1 = Math.min(sh.box[3], vy1 + D);
    let own = paint.set[slots[idx] % paint.set.length];
    let list = !selected ? groupOf(own, false) : idx === selected.index ? groupOf(paint.lit, false) : groupOf(own, !near.has(idx)), n = 0;
    let across = Math.sqrt(Math.max(0, item.area)) / s, gc = g * Math.max(0, Math.min(1, (across - SMALL) / (FULL - SMALL)));
    for (let j = Math.floor(by0 / dy), jEnd = Math.ceil(by1 / dy); j <= jEnd; ++j) {
      let my = j * dy, off = (j & 1) ? s / 2 : 0;
      for (let i = Math.floor((bx0 - off) / s), iEnd = Math.ceil((bx1 - off) / s); i <= iEnd; ++i) {
        let mx = i * s + off, px = ox + k * mx, py = oy + k * my;
        // on land of this country: by the id map (off screen, by the shape itself), or exactly
        // when the point is on the very edge of a shape
        let on = px >= 0 && py >= 0 && px < W && py < H ? idAt(data, W, Math.round(px), Math.round(py)) : -1;
        if (on !== id && !(on < 0 && ic.isPointInPath(sh.path, px, py, 'evenodd'))) continue;
        // away from its borders: from the nearest point of each border within reach
        nearest.clear();
        let u0 = Math.floor(mx / D), v0 = Math.floor(my / D);
        if (gc > 0) for (let u = u0 - 1; u <= u0 + 1; ++u) for (let v = v0 - 1; v <= v0 + 1; ++v) {
          let segs = buckets.get(u * 73856093 ^ v * 19349663);
          if (!segs) continue;
          for (let q of segs) {
            if (q[5] !== idx && q[6] !== idx) continue;
            let ex = q[2] - q[0], ey = q[3] - q[1], L = ex * ex + ey * ey;
            let t = L ? Math.max(0, Math.min(1, ((mx - q[0]) * ex + (my - q[1]) * ey) / L)) : 0;
            let nx = q[0] + t * ex, ny = q[1] + t * ey, d = Math.hypot(mx - nx, my - ny);
            let was = nearest.get(q[4]);
            if (d < D && (!was || d < was[0])) nearest.set(q[4], [d, nx, ny]);
          }
        }
        // (pushed from several borders at once, a dot moves no farther than from one)
        let wx = 0, wy = 0;
        for (let [d, nx, ny] of nearest.values()) {
          if (d < 1e-9) continue;
          let f = gc * (1 - d / D) / d;
          wx += (mx - nx) * f; wy += (my - ny) * f;
        }
        let moved = Math.hypot(wx, wy);
        if (moved > gc) { wx *= gc / moved; wy *= gc / moved; }
        px = ox + k * (mx + wx); py = oy + k * (my + wy);
        ++n;
        if (px < -r || py < -r || px > W + r || py > H + r || cleared(px, py)) continue;   // (under a name: counted, not drawn)
        list.push(px, py, r);
      }
    }
    count += n;
    counts[item.country.id] = n;
  }

  // drawn in one path per colour
  let cw = Math.round(W * dpr), ch = Math.round(H * dpr);
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  let c = canvas.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, cw, ch);
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (let {colour, faint, list} of [...groups.values()].sort((p, q) => q.faint - p.faint)) {
    if (!list.length) continue;
    c.beginPath();
    for (let q = 0; q < list.length; q += 3) { c.moveTo(list[q] + list[q + 2], list[q + 1]); c.arc(list[q], list[q + 1], list[q + 2], 0, 2 * Math.PI); }
    c.globalAlpha = faint ? paint.faint : 1;
    c.fillStyle = colour;
    c.fill();
  }
  c.globalAlpha = 1;
  showLegend(best, r);
  stats.draws++;
  stats.dots = count;
  stats.counts = counts;
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
  clearings = names(world, state, selected);
  draw(world, state, selected);
}

// ---------------------------------------------------------------------------------------------
// Names, whole (never Switz. or Bos. & Herz.), sized by the country: as large as a share of its
// size on screen, which is as large as the square root of its people, and no wider than a little
// more than that size; on two lines where that lets a name be larger. The largest countries are
// named first, and a name that would run into one already placed is left out.
let measurer = null;
function layoutOf(item) {
  if (item.dotsName) return item.dotsName;
  let big = item.country.population > BIG, name = item.country.name.trim();
  if (!measurer) measurer = document.createElement('canvas').getContext('2d');
  measurer.font = `${big ? 700 : 600} 100px Inter, Helvetica, Arial, sans-serif`;
  let em = t => { let u = big ? t.toUpperCase() : t; return measurer.measureText(u).width / 100 + (big ? 0.05 : 0.01) * u.length; };
  let out = {big, one: {lines: [name], w: em(name)}, two: null};
  let words = name.split(' ');
  if (words.length > 1) {
    let bestCut = null;
    for (let i = 1; i < words.length; ++i) {
      let lines = [words.slice(0, i).join(' '), words.slice(i).join(' ')], w = Math.max(em(lines[0]), em(lines[1]));
      if (!bestCut || w < bestCut.w) bestCut = {lines, w};
    }
    out.two = bestCut;
  }
  return item.dotsName = out;
}
function names(world, state, selected) {
  let k = state.k, svg = document.getElementById('map'), W = svg.clientWidth, H = svg.clientHeight;
  let near = new Set(selected ? world.neighbours[selected.index] : []);
  let order = world.items.slice().sort((p, q) => (q === selected) - (p === selected) || q.country.population - p.country.population);
  let placed = [], shown = [], first = new Set(world.items.slice().sort((p, q) => q.country.population - p.country.population).slice(0, NAMED_FIRST));
  for (let item of order) {
    let label = item.label;
    label.classList.toggle('dots-dim', !!selected && item !== selected && !near.has(item.index));
    let lay = layoutOf(item), size = Math.sqrt(Math.max(0, item.area)) * k;
    let cap = lay.big ? NAME_PX : SMALL_NAME_PX, byPeople = Math.min(cap, NAME_REL * size);
    let one = Math.min(byPeople, NAME_OVER * size / lay.one.w);
    let two = lay.two ? Math.min(byPeople, NAME_OVER * size / lay.two.w) : 0;
    let pick = two > one * 1.15 ? {f: two, ...lay.two} : {f: one, ...lay.one};
    if (first.has(item)) pick.f = Math.max(pick.f, NAMED_FIRST_PX);
    if (item === selected) pick.f = Math.max(pick.f, 11);
    let x = state.x + k * item.pole.x, y = state.y - k * item.pole.y;
    let hw = pick.f * pick.w / 2 + 3, hh = pick.f * 0.55 * pick.lines.length + 2;
    let box = [x - hw, y - hh, x + hw, y + hh];
    let show = (pick.f >= NAME_MIN_PX || item === selected) && box[2] > 0 && box[0] < W && box[3] > 0 && box[1] < H &&
      (item === selected || !placed.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]));
    if (!show) { label.classList.add('hidden'); continue; }
    placed.push(box);
    shown.push(box);
    label.classList.remove('hidden');
    let f = pick.f / k;
    if (item.dotsFont !== f) { item.dotsFont = f; label.setAttribute('font-size', f); }
    let text = pick.lines.join('\n');
    if (item.dotsText !== text) {
      item.dotsText = text;
      if (pick.lines.length === 1) label.textContent = pick.lines[0];
      else {
        label.textContent = '';
        pick.lines.forEach((line, i) => {
          let t = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
          t.setAttribute('x', label.getAttribute('x'));
          t.setAttribute('dy', i ? '1.05em' : '-0.52em');
          t.textContent = line;
          label.appendChild(t);
        });
      }
    }
  }
  return shown;
}

// once per world: the names are this style's, so the page leaves them whole
function render(world) {
  world.items.forEach(item => { delete item.dotsName; delete item.dotsText; delete item.dotsFont; });
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
  // (names were measured in the fallback font until Inter arrives: measured again then)
  if (document.fonts) Promise.all([document.fonts.load('700 10px Inter'), document.fonts.load('600 10px Inter')]).then(() => {
    if (!active() || !current) return;
    current.items.forEach(item => { delete item.dotsName; });
    let v = viewOf();
    if (v) { clearings = names(current, v, currentSelected); draw(current, v, currentSelected); }
  }, () => {});
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
    if (item.dotsText !== undefined) { item.label.textContent = item.country.name; delete item.dotsText; }
  });
  current = null;
  currentSelected = null;
  drawnKey = '';
}

if (typeof window !== 'undefined') {
  window.mapStyles = window.mapStyles || {};
  window.mapStyles.dots = {ripples: [], markerPx: 5, render, view, unmount, stats};
}
if (active()) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
