// Kinpeki: the sea of a gold-leaf screen, worked out from the land. Pure computation (no DOM), so
// it runs in a worker, on the page or in Node, and gives the same sea for the same world.
//
//   buildSea({countries, box})  countries: [{index, rings}] in screen orientation (y down)
//   -> {domain, grid: {n, cell, x0, y0, near: Uint8Array}, strokes: [{level, xy}], clouds: [...]}
//
// 1. Land is rasterised on a grid round the world; an exact distance transform gives, for every
//    cell of sea, how far the nearest land is.
// 2. A flow field: near land the water runs along the shore, turned a little towards it so the
//    lines meet the coast as waves do; out at sea it follows a slow curl-noise current that winds
//    into eddies. (Kōrin's waves: long parallel strokes that curl.)
// 3. Evenly spaced streamlines (Jobard and Lefer) through that field in three levels, each half the
//    spacing of the one before, so zooming in brings finer waves between the broad ones.
// 4. Gold clouds (suyari-gasumi) in the open sea, kept well clear of every coast.

const TAU = Math.PI * 2;

// small deterministic helpers (no Math.random anywhere: the sea is a function of the world)
function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function noise2(x, y, seed) {
  let ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  let sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  let a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return 2 * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) - 1;
}
function fbm(x, y, seed, octaves) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; ++o) {
    let c = Math.cos(o * 1.3 + 0.4), s = Math.sin(o * 1.3 + 0.4);
    sum += amp * noise2((x * c - y * s) * f + o * 17.1, (x * s + y * c) * f - o * 9.7, seed + o * 101);
    norm += amp; amp *= 0.5; f *= 2.1;
  }
  return sum / norm;
}
function mulberry(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 1D squared distance transform (Felzenszwalb and Huttenlocher), in place on f[0..n)
function dt1(f, n, v, z, d) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; ++q) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      --k;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    ++k; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; ++q) {
    while (z[k + 1] < q) ++k;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

const EMPTY = [];
// Land mask by scanlines: every ring's crossings with every row of cell centres, filled in pairs.
// Countries never overlap, so the crossings of all of them together pair up the same way.
function rasterise(rings, x0, y0, cell, n, into = null, value = 1) {
  // only the rows the rings span
  let lo = n, hi = -1;
  for (let ring of rings) for (let p of ring) {
    let r = (p[1] - y0) / cell - 0.5;
    if (r < lo) lo = r;
    if (r > hi) hi = r;
  }
  let rows = [];
  for (let r = 0; r < n; ++r) rows.push(r >= Math.floor(lo) && r <= Math.ceil(hi) ? [] : EMPTY);
  for (let ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      let ax = ring[j][0], ay = ring[j][1], bx = ring[i][0], by = ring[i][1];
      if (ay === by) continue;
      let ya = (ay - y0) / cell - 0.5, yb = (by - y0) / cell - 0.5;
      let lo = Math.max(0, Math.ceil(Math.min(ya, yb))), hi = Math.min(n - 1, Math.floor(Math.max(ya, yb) - 1e-9));
      for (let r = lo; r <= hi; ++r) {
        let t = (r - ya) / (yb - ya);
        rows[r].push(((ax + t * (bx - ax)) - x0) / cell - 0.5);
      }
    }
  }
  let land = into || new Uint8Array(n * n);
  for (let r = 0; r < n; ++r) {
    if (!rows[r].length) continue;
    let xs = rows[r].sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let c0 = Math.max(0, Math.ceil(xs[k])), c1 = Math.min(n - 1, Math.floor(xs[k + 1]));
      for (let c = c0; c <= c1; ++c) land[r * n + c] = value;
    }
  }
  return land;
}

// Euclidean distance (in cells) from each cell to the nearest land cell
function distance(land, n) {
  const INF = 1e20;
  let g = new Float64Array(n * n);
  let f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let c = 0; c < n; ++c) {
    for (let r = 0; r < n; ++r) f[r] = land[r * n + c] ? 0 : INF;
    dt1(f, n, v, z, d);
    for (let r = 0; r < n; ++r) g[r * n + c] = d[r];
  }
  let out = new Float32Array(n * n);
  for (let r = 0; r < n; ++r) {
    for (let c = 0; c < n; ++c) f[c] = g[r * n + c];
    dt1(f, n, v, z, d);
    for (let c = 0; c < n; ++c) out[r * n + c] = Math.sqrt(d[c]);
  }
  return out;
}

export function buildSea({countries, box, quality = 1}) {
  let rings = [];
  for (let c of countries) for (let r of c.rings) rings.push(r);
  let t0 = Date.now();
  let w = box.maxX - box.minX, h = box.maxY - box.minY, span = Math.max(w, h);
  let cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
  let side = 2.6 * span;
  let n = Math.round(1024 * quality);
  let cell = side / n, x0 = cx - side / 2, y0 = cy - side / 2;
  let land = rasterise(rings, x0, y0, cell, n);
  let dist = distance(land, n);           // cells
  for (let i = 0; i < dist.length; ++i) dist[i] = land[i] ? -0.5 : dist[i] - 0.5;   // ~ to the coast
  let tMask = Date.now() - t0;

  // ------------------------------------------------------------------ the flow field, at nodes
  // Out at sea: a slow drift along the screen (the long horizontal waves of the screens), bent by a
  // curl-noise current that now and then winds into an eddy. Near land: along the shore, turned a
  // little towards it.
  let vx = new Float32Array(n * n), vy = new Float32Array(n * n);
  let curlScale = span / 2.4, L = 0.045 * span / cell;    // near-shore reach, in cells
  const C = 96;   // the current is large-scale: computed on a coarse lattice and interpolated
  let cc = side / C;
  let psi = new Float32Array((C + 1) * (C + 1));
  for (let r = 0; r <= C; ++r) for (let c = 0; c <= C; ++c) {
    let x = (x0 + c * cc - cx) / curlScale, y = (y0 + r * cc - cy) / curlScale;
    psi[r * (C + 1) + c] = fbm(x, y, 7, 3) + 0.3 * fbm(x * 2.6 + 3, y * 2.6 - 5, 11, 2);
  }
  let curx = new Float32Array(C * C), cury = new Float32Array(C * C);
  for (let r = 0; r < C; ++r) for (let c = 0; c < C; ++c) {
    let p00 = psi[r * (C + 1) + c], p10 = psi[r * (C + 1) + c + 1], p01 = psi[(r + 1) * (C + 1) + c], p11 = psi[(r + 1) * (C + 1) + c + 1];
    let dpx = (p10 + p11 - p00 - p01) / 2 / (cc / curlScale), dpy = (p01 + p11 - p00 - p10) / 2 / (cc / curlScale);
    curx[r * C + c] = dpy; cury[r * C + c] = -dpx;
  }
  const SHORE = 0.22;     // radians the near-shore flow turns towards land
  const CURL = 0.5;       // strength of the current against the drift
  for (let r = 0; r < n; ++r) {
    // the current, interpolated along the row without allocating
    let y = y0 + (r + 0.5) * cell;
    let hy = (y - y0) / cc - 0.5, cr0 = Math.max(0, Math.min(C - 2, Math.floor(hy))), fy = Math.max(0, Math.min(1, hy - cr0));
  for (let c = 0; c < n; ++c) {
    let i = r * n + c;
    let x = x0 + (c + 0.5) * cell;
    let hx = (x - x0) / cc - 0.5, cc0 = Math.max(0, Math.min(C - 2, Math.floor(hx))), fx = Math.max(0, Math.min(1, hx - cc0));
    let j = cr0 * C + cc0;
    let qx = (curx[j] * (1 - fx) + curx[j + 1] * fx) * (1 - fy) + (curx[j + C] * (1 - fx) + curx[j + C + 1] * fx) * fy;
    let qy = (cury[j] * (1 - fx) + cury[j + 1] * fx) * (1 - fy) + (cury[j + C] * (1 - fx) + cury[j + C + 1] * fx) * fy;
    let ux = 1 + CURL * qx, uy = CURL * qy;
    let ul = Math.hypot(ux, uy) || 1e-9;
    ux /= ul; uy /= ul;
    let d = dist[i];
    if (d <= 0) { vx[i] = ux; vy[i] = uy; continue; }
    let cl = c > 0 ? dist[i - 1] : d, cr = c < n - 1 ? dist[i + 1] : d;
    let ru = r > 0 ? dist[i - n] : d, rd = r < n - 1 ? dist[i + n] : d;
    let gx = cr - cl, gy = rd - ru, gl = Math.hypot(gx, gy);   // away from land
    let a = d > 8 * L ? 0 : Math.exp(-d / L);
    if (gl < 1e-6) a = 0;
    else { gx /= gl; gy /= gl; }
    let tx = -gy, ty = gx;
    if (tx * ux + ty * uy < 0) { tx = -tx; ty = -ty; }
    let sx = tx * Math.cos(SHORE) - gx * Math.sin(SHORE), sy = ty * Math.cos(SHORE) - gy * Math.sin(SHORE);
    let wx = a * sx + (1 - a) * ux, wy = a * sy + (1 - a) * uy, fl = Math.hypot(wx, wy) || 1e-9;
    vx[i] = wx / fl; vy[i] = wy / fl;
  }
  }
  let tField = Date.now() - t0 - tMask;

  // sample the field at (x, y), each corner turned to agree with direction (px, py)
  let out = [0, 0];
  function field(x, y, px, py) {
    let gx = (x - x0) / cell - 0.5, gy = (y - y0) / cell - 0.5;
    let c = Math.floor(gx), r = Math.floor(gy);
    if (c < 0 || r < 0 || c >= n - 1 || r >= n - 1) return null;
    let fx = gx - c, fy = gy - r, i = r * n + c;
    let sx = 0, sy = 0;
    let add = (j, wt) => {
      let a = vx[j], b = vy[j];
      if (a * px + b * py < 0) { a = -a; b = -b; }
      sx += a * wt; sy += b * wt;
    };
    add(i, (1 - fx) * (1 - fy)); add(i + 1, fx * (1 - fy)); add(i + n, (1 - fx) * fy); add(i + n + 1, fx * fy);
    let l = Math.hypot(sx, sy);
    if (l < 0.3) return null;
    out[0] = sx / l; out[1] = sy / l;
    return out;
  }
  function distAt(x, y) {
    let gx = (x - x0) / cell - 0.5, gy = (y - y0) / cell - 0.5;
    let c = Math.floor(gx), r = Math.floor(gy);
    if (c < 0 || r < 0 || c >= n - 1 || r >= n - 1) return -1;
    let fx = gx - c, fy = gy - r, i = r * n + c;
    return cell * ((dist[i] * (1 - fx) + dist[i + 1] * fx) * (1 - fy) + (dist[i + n] * (1 - fx) + dist[i + n + 1] * fx) * fy);
  }

  // ------------------------------------------------------------------ streamlines
  let dsep0 = span / 40;
  let LEVELS = [
    {dsep: dsep0, region: [x0 + cell * 2, y0 + cell * 2, x0 + side - cell * 2, y0 + side - cell * 2]},
    {dsep: dsep0 / 2, region: [box.minX - 0.6 * span, box.minY - 0.8 * span, box.maxX + 0.6 * span, box.maxY + 0.8 * span]},
    {dsep: dsep0 / 4, region: [box.minX - 0.1 * span, box.minY - 0.1 * span, box.maxX + 0.1 * span, box.maxY + 0.1 * span]},
    // the finest, only for close views of the seas between the lands: worked out after the rest
    {dsep: dsep0 / 8, region: [box.minX - 0.04 * span, box.minY - 0.04 * span, box.maxX + 0.04 * span, box.maxY + 0.04 * span], near: 0.06 * span},
  ];
  let strokes = [];
  let traceLevel = level => {
    let {dsep, region} = LEVELS[level];
    let [rx0, ry0, rx1, ry1] = region;
    let step = dsep * 0.2, dtest = dsep * 0.55, gcell = dsep;
    let gw = Math.ceil((rx1 - rx0) / gcell) + 1, gh = Math.ceil((ry1 - ry0) / gcell) + 1;
    // occupancy: points of every line drawn so far (this level and coarser), resampled finely
    let buckets = new Map();
    let put = (x, y, id) => {
      let c = Math.floor((x - rx0) / gcell), r = Math.floor((y - ry0) / gcell);
      if (c < 0 || r < 0 || c >= gw || r >= gh) return;
      let key = r * gw + c, b = buckets.get(key);
      if (!b) buckets.set(key, b = []);
      b.push(x, y, id);
    };
    let near = (x, y, rad, id) => {
      let c = Math.floor((x - rx0) / gcell), r = Math.floor((y - ry0) / gcell), r2 = rad * rad;
      for (let dr = -1; dr <= 1; ++dr) for (let dc = -1; dc <= 1; ++dc) {
        let b = buckets.get((r + dr) * gw + c + dc);
        if (!b) continue;
        for (let k = 0; k < b.length; k += 3) {
          if (b[k + 2] === id) continue;
          let ex = b[k] - x, ey = b[k + 1] - y;
          if (ex * ex + ey * ey < r2) return true;
        }
      }
      return false;
    };
    let insert = (xy, id) => {
      for (let k = 0; k + 2 < xy.length; k += 2) {
        let ax = xy[k], ay = xy[k + 1], bx = xy[k + 2], by = xy[k + 3];
        let m = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
        for (let s = 0; s < m; ++s) put(ax + (bx - ax) * s / m, ay + (by - ay) * s / m, id);
      }
      if (xy.length >= 2) put(xy[xy.length - 2], xy[xy.length - 1], id);
    };
    let lineId = 0;
    strokes.forEach(s => insert(s.xy, -1 - (lineId++)));
    let inside = (x, y) => x > rx0 && y > ry0 && x < rx1 && y < ry1;
    let minLand = dsep * 0.15;
    let maxSteps = Math.round(110 * dsep / step);
    function trace(sx, sy, dx, dy, id) {
      let pts = [], x = sx, y = sy, px = dx, py = dy;
      let own = [];
      for (let s = 0; s < maxSteps; ++s) {
        let f = field(x, y, px, py);
        if (!f) break;
        let mx = x + f[0] * step * 0.5, my = y + f[1] * step * 0.5;
        let g = field(mx, my, f[0], f[1]);
        if (!g) break;
        let nx = x + g[0] * step, ny = y + g[1] * step;
        if (!inside(nx, ny) || distAt(nx, ny) < minLand) break;
        if (near(nx, ny, dtest, id)) break;
        // closing on itself (an eddy): stop a little short
        let closed = false;
        for (let k = 0; k + 30 < own.length; k += 2) {
          let ex = own[k] - nx, ey = own[k + 1] - ny;
          if (ex * ex + ey * ey < dtest * dtest) { closed = true; break; }
        }
        if (closed) break;
        px = g[0]; py = g[1]; x = nx; y = ny;
        pts.push(x, y);
        if (s % 4 === 0) own.push(x, y);
      }
      return pts;
    }
    let queue = [];
    let tryLine = (sx, sy, id) => {
      if (!inside(sx, sy) || distAt(sx, sy) < dsep * 0.5) return null;
      if (near(sx, sy, dsep * 0.92, null)) return null;
      let f = field(sx, sy, 1, 0);
      if (!f) return null;
      let fx = f[0], fy = f[1];
      let fwd = trace(sx, sy, fx, fy, id), back = trace(sx, sy, -fx, -fy, id);
      let xy = [];
      for (let k = back.length - 2; k >= 0; k -= 2) xy.push(back[k], back[k + 1]);
      xy.push(sx, sy);
      for (let k = 0; k < fwd.length; ++k) xy.push(fwd[k]);
      let len = (xy.length / 2 - 1) * step;
      if (len < dsep * (level === 2 ? 3 : 4)) return null;
      return xy;
    };
    // Kōrin's waves end in a curl: some of the broad lines that stop in open water turn over at
    // the end into a small spiral, the crest of a wave (which side, and whether, from the place)
    let curl = (xy, atEnd) => {
      let m = xy.length / 2;
      if (m < 6) return xy;
      let i1 = atEnd ? m - 1 : 0, i0 = atEnd ? m - 3 : 2;
      let ex = xy[2 * i1], ey = xy[2 * i1 + 1];
      let h = hash2(Math.round(ex * 37), Math.round(ey * 41), 97 + level);
      if (h > 0.4 || distAt(ex, ey) < dsep * 2.5) return xy;
      let dx = ex - xy[2 * i0], dy = ey - xy[2 * i0 + 1], dl = Math.hypot(dx, dy) || 1;
      let ang = Math.atan2(dy / dl, dx / dl), side = h < 0.2 ? 1 : -1;
      let r = dsep * 0.3, x = ex, y = ey, out = [];
      // a spiral: a turn and a third, tightening as it goes round
      const N = 28, TURN = 8.4;
      for (let j = 1; j <= N; ++j) {
        let t = j / N, rr = r * (1 - 0.65 * t), da = TURN / N;
        ang += side * da;
        x += Math.cos(ang) * rr * da; y += Math.sin(ang) * rr * da;
        out.push(x, y);
      }
      if (atEnd) return xy.concat(out);
      let rev = [];
      for (let k = out.length - 2; k >= 0; k -= 2) rev.push(out[k], out[k + 1]);
      return rev.concat(xy);
    };
    let accept = (xy) => {
      if (level === 0) { xy = curl(curl(xy, true), false); }
      let id = lineId++;
      let arr = Float32Array.from(xy);
      strokes.push({level, xy: arr, step});
      insert(arr, id);
      queue.push(arr);
    };
    let fromLine = (xy) => {
      let every = Math.max(2, Math.round(dsep * 0.5 / step)) * 2;
      for (let k = 0; k + 3 < xy.length; k += every) {
        let ax = xy[k], ay = xy[k + 1], bx = xy[k + 2], by = xy[k + 3];
        let tx = bx - ax, ty = by - ay, tl = Math.hypot(tx, ty) || 1;
        let nx = -ty / tl, ny = tx / tl;
        for (let sgn of [1, -1]) {
          let xy2 = tryLine(ax + sgn * nx * dsep, ay + sgn * ny * dsep, lineId);
          if (xy2) accept(xy2);
        }
      }
    };
    let drain = () => { while (queue.length) fromLine(queue.shift()); };
    strokes.filter(s => s.level < level).forEach(s => queue.push(s.xy));
    drain();
    // a lattice of fallback seeds, in a fixed shuffled order, for the parts no line reaches
    let seeds = [];
    let gs = dsep * 2.5;
    for (let y = ry0 + gs / 2; y < ry1; y += gs) for (let x = rx0 + gs / 2; x < rx1; x += gs) seeds.push([x, y, hash2(Math.round(x / gs), Math.round(y / gs), 31 + level)]);
    seeds.sort((a, b) => a[2] - b[2]);
    for (let [x, y] of seeds) {
      if (LEVELS[level].near && distAt(x, y) > LEVELS[level].near) continue;
      let xy = tryLine(x, y, lineId);
      if (xy) { accept(xy); drain(); }
    }
  };
  for (let level = 0; level < 3; ++level) traceLevel(level);
  // the lines were traced in fine steps (their spacing is tested at every step); drawn, they need
  // far fewer points: they are smooth
  for (let st of strokes) st.xy = simplifyLine(st.xy, LEVELS[st.level].dsep * 0.012);
  let tLines = Date.now() - t0 - tMask - tField;
  // the finest level, on request: the strokes it adds
  let refine = () => {
    let before = strokes.length;
    traceLevel(3);
    let added = strokes.slice(before);
    for (let st of added) st.xy = simplifyLine(st.xy, LEVELS[3].dsep * 0.012);
    return added;
  };

  // ------------------------------------------------------------------ clouds
  let clouds = placeClouds({box, span, distAt});

  // distance to land for the shading of the sea: 0 at the coast, 255 at `far`
  let near8 = new Uint8Array(n * n);
  let far = 0.25 * span / cell;
  for (let i = 0; i < n * n; ++i) near8[i] = Math.max(0, Math.min(255, Math.round(255 * Math.max(0, dist[i]) / far)));
  let tT = Date.now();
  let terrain = buildTerrain({countries, box, span, x0, y0, cell, n, land});
  tT = Date.now() - tT;
  // the slow mottle of the wash, baked so the ground's shader only looks it up
  let mn = 512, mottle = new Uint8Array(mn * mn);
  for (let r = 0; r < mn; ++r) for (let c = 0; c < mn; ++c) {
    let qx = (x0 + (c + 0.5) * side / mn - cx) / span, qy = (y0 + (r + 0.5) * side / mn - cy) / span;
    let m = 0.6 * (noise2(qx * 9, qy * 9, 3) * 0.5 + 0.5) + 0.4 * (noise2(qx * 31 + 7, qy * 31 + 7, 5) * 0.5 + 0.5);
    mottle[r * mn + c] = Math.round(255 * Math.max(0, Math.min(1, m)));
  }
  return {
    domain: {x0, y0, side, span, cx, cy, box}, grid: {n, cell, near: near8, far: far * cell, mn, mottle},
    strokes, clouds, terrain: terrain.glyphs, terrainLevels: terrain.levels, levels: LEVELS.map(l => l.dsep),
    timing: {mask: tMask, field: tField, lines: tLines, terrain: tT, total: Date.now() - t0},
    refine,
  };
}

// ---------------------------------------------------------------------------------------------
// Mountains, drawn the way the screens' painters drew them: rounded peaks in small clusters,
// strung along ridges. The ridges come from noise over the world's positions (so an edit leaves the
// mountains of the countries it does not touch where they were). Each country is rasterised on the
// grid; a distance transform from every border and coast keeps every peak well inside its country,
// so no mountain ever crosses or hides a border.
//   -> [{x, y, s, level, country, v}]  x, y: the foot of the cluster; s: its width
function buildTerrain({countries, box, span, x0, y0, cell, n}) {
  let id = new Int16Array(n * n).fill(-1);
  for (let c of countries) rasterise(c.rings, x0, y0, cell, n, id, c.index);
  // distance (cells) from each cell to the nearest cell of another country or of the sea
  let edge = new Uint8Array(n * n);
  for (let r = 1; r < n - 1; ++r) for (let c = 1; c < n - 1; ++c) {
    let i = r * n + c, v = id[i];
    if (v < 0) continue;
    if (id[i - 1] !== v || id[i + 1] !== v || id[i - n] !== v || id[i + n] !== v) edge[i] = 1;
  }
  let inner = distance(edge, n);
  let glyphs = [];
  // a range: a row of peaks about 1.7 s wide and 0.55 s high, its foot at (x, y)
  const LEVELS = [span / 30, span / 60, span / 120];
  let taken = [];
  let free = (pts, r) => {
    for (let g of taken) for (let [x, y] of pts) { let dx = g[0] - x, dy = g[1] - y, rr = g[2] + r; if (dx * dx + dy * dy < rr * rr) return false; }
    return true;
  };
  for (let level = 0; level < LEVELS.length; ++level) {
    let s = LEVELS[level], step = s * 0.55;
    let cands = [];
    for (let y = box.minY; y <= box.maxY; y += step) {
      for (let x = box.minX; x <= box.maxX; x += step) {
        let gx = Math.round((x - box.minX) / step), gy = Math.round((y - box.minY) / step);
        let jx = x + (hash2(gx, gy, 71 + level) - 0.5) * step * 0.6, jy = y + (hash2(gx, gy, 73 + level) - 0.5) * step * 0.6;
        // ridges: where the noise crosses zero
        let qx = (jx - box.minX) / span, qy = (jy - box.minY) / span;
        let ridge = 1 - Math.abs(fbm(qx * 4.2, qy * 4.2, 211, 3));
        if (ridge < 0.8 - 0.03 * level) continue;
        cands.push([jx, jy, ridge + 0.03 * hash2(gx, gy, 79 + level)]);
      }
    }
    cands.sort((a, b) => b[2] - a[2]);
    for (let [x, y] of cands) {
      let mid = y - s * 0.24, r = s * 0.42;
      let pts = [[x - s * 0.55, mid], [x, mid], [x + s * 0.55, mid]];
      let who = null, ok = true;
      for (let [px, py] of pts) {
        let c = Math.floor((px - x0) / cell), rr = Math.floor((py - y0) / cell);
        if (c < 1 || rr < 1 || c >= n - 1 || rr >= n - 1) { ok = false; break; }
        let j = rr * n + c;
        if (id[j] < 0 || (who !== null && id[j] !== who) || inner[j] * cell < r + s * 0.22 + cell) { ok = false; break; }
        who = id[j];
      }
      if (!ok || !free(pts, r * 0.95)) continue;
      for (let p of pts) taken.push([p[0], p[1], r * 0.95]);
      glyphs.push({x, y, s, level, country: who, v: Math.floor(hash2(Math.round(x * 97), Math.round(y * 89), 5) * 6)});
    }
  }
  return {glyphs, levels: LEVELS};
}

// Douglas-Peucker on a flat [x, y, x, y, …] polyline
function simplifyLine(xy, tol) {
  let n = xy.length / 2;
  if (n <= 2) return xy;
  let keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  let stack = [0, n - 1], t2 = tol * tol;
  while (stack.length) {
    let j = stack.pop(), i = stack.pop();
    let ax = xy[2 * i], ay = xy[2 * i + 1], dx = xy[2 * j] - ax, dy = xy[2 * j + 1] - ay, len = dx * dx + dy * dy;
    let worst = -1, at = -1;
    for (let m = i + 1; m < j; ++m) {
      let px = xy[2 * m] - ax, py = xy[2 * m + 1] - ay;
      let t = len ? Math.max(0, Math.min(1, (px * dx + py * dy) / len)) : 0;
      let ex = t * dx - px, ey = t * dy - py, d = ex * ex + ey * ey;
      if (d > worst) { worst = d; at = m; }
    }
    if (worst > t2) { keep[at] = 1; stack.push(i, at, at, j); }
  }
  let out = [];
  for (let m = 0; m < n; ++m) if (keep[m]) out.push(xy[2 * m], xy[2 * m + 1]);
  return Float32Array.from(out);
}

// Gold clouds (suyari-gasumi): long bands drawn freehand, thicker and thinner along their length,
// with gently wandering centre lines, rounded heads, and a top edge scalloped into arcs of uneven
// size. One or two shorter bands step above or below the first. They lie in open water round the
// world, well off every coast.
//   cloud: {bands: [{xa, xb, y, t, amp, freq, phase, arc}], x0, x1, y0, y1, t}
//   the band's centre line: y + amp * t * sin(freq * (x - xa) / t + phase); half-thickness
//   t * (0.82 + 0.18 * sin(0.7 * freq * (x - xa) / t + 2 * phase)); scallops arc * t wide on top
export function cloudBand(b, x) {
  let u = (x - b.xa) / b.t;
  return {
    cy: b.y + b.amp * b.t * Math.sin(b.freq * u + b.phase),
    th: b.t * (0.82 + 0.18 * Math.sin(0.7 * b.freq * u + 2 * b.phase)),
  };
}
function placeClouds({box, span, distAt}) {
  let clouds = [];
  let margin = 0.035 * span;
  let cands = [];
  let gx = span / 34;
  for (let y = box.minY - 0.7 * span; y <= box.maxY + 0.7 * span; y += gx) {
    for (let x = box.minX - 0.5 * span; x <= box.maxX + 0.5 * span; x += gx) {
      // clouds belong in the margins round the world and in its widest inner seas
      let ox = Math.max(box.minX - x, x - box.maxX, 0), oy = Math.max(box.minY - y, y - box.maxY, 0);
      let out = Math.hypot(ox, oy) / span;
      let score = Math.abs(out - 0.05) + 0.16 * hash2(Math.round(x / gx), Math.round(y / gx), 5);
      cands.push([x, y, score]);
    }
  }
  cands.sort((a, b) => a[2] - b[2]);
  let fits = c => c.bands.every(b => {
    for (let q = 0; q <= 1; q += 0.05) {
      let x = b.xa + (b.xb - b.xa) * q, {cy, th} = cloudBand(b, x);
      if (distAt(x, cy) < th * (1 + b.arc * 0.5) + margin) return false;
    }
    return true;
  }) && clouds.every(o => !(c.x0 - margin * 2 < o.x1 && c.x1 + margin * 2 > o.x0 && c.y0 - margin * 2.5 < o.y1 && c.y1 + margin * 2.5 > o.y0)) &&
    clouds.every(o => Math.hypot((o.x0 + o.x1 - c.x0 - c.x1) / 2, (o.y0 + o.y1 - c.y0 - c.y1) / 2) > 0.3 * span);
  for (let [x, y] of cands) {
    if (clouds.length >= 8) break;
    let hx = Math.round(x * 13.1), hy = Math.round(y * 7.3);
    let T = span * (0.014 + 0.007 * hash2(hx, hy, 41));     // half-thickness
    let Lc = span * (0.24 + 0.22 * hash2(hx, hy, 43));
    for (let shrink of [1, 0.75, 0.55]) {
      let c = cloudShape(x, y, Lc * shrink, T * (0.8 + 0.2 * shrink), hx, hy);
      if (fits(c)) { clouds.push(c); break; }
    }
  }
  return clouds;
}

function cloudShape(x, y, Lc, T, hx, hy) {
  let h = k => hash2(hx, hy, 60 + k);
  let band = (xa, xb, yy, t, k) => ({xa, xb, y: yy, t, amp: 0.25 + 0.35 * h(k), freq: 0.09 + 0.07 * h(k + 1),
    phase: 6.283 * h(k + 2), arc: 1.5 + 0.9 * h(k + 3)});
  let off = (h(0) - 0.5) * 0.2 * Lc;
  let bands = [band(x - Lc / 2 + off, x + Lc / 2 + off, y, T, 10)];
  // a shorter band stepped above or below, overlapping one end; sometimes a third the other way
  let dir = h(1) < 0.5 ? -1 : 1, end = h(2) < 0.5 ? -1 : 1;
  let l2 = Lc * (0.32 + 0.24 * h(3));
  let c2 = x + off + end * (Lc / 2 - l2 * (0.15 + 0.3 * h(4)));
  bands.push(band(c2 - l2 / 2, c2 + l2 / 2, y + dir * T * 2.1, T * (0.75 + 0.2 * h(5)), 20));
  if (h(6) < 0.55) {
    let l3 = Lc * (0.2 + 0.18 * h(7));
    let c3 = x + off - end * (Lc / 2 - l3 * (0.1 + 0.4 * h(8)));
    bands.push(band(c3 - l3 / 2, c3 + l3 / 2, y - dir * T * 2.0, T * (0.65 + 0.2 * h(9)), 30));
  }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let b of bands) {
    let reach = b.t * (1 + b.amp + 0.3 + b.arc * 0.5);
    x0 = Math.min(x0, b.xa - b.t * 1.2); x1 = Math.max(x1, b.xb + b.t * 1.2);
    y0 = Math.min(y0, b.y - reach); y1 = Math.max(y1, b.y + reach);
  }
  return {bands, x0, x1, y0, y1, t: T};
}

// The lines as triangle strips (degenerate triangles join the lines of a strip), one strip per
// level and tile of the sea, so a redraw skips the levels that don't show and the tiles off
// screen. Per vertex: x, y, tx, ty, s, L, side, level + random / 2, distance to the coast.
export const STRIDE = 9;
const TILES = 8;
export function lineVertices(strokes, grid, domain) {
  let total = 0;
  for (let s of strokes) total += s.xy.length + 2;   // two vertices a point, two for the joint
  let out = new Float32Array(total * STRIDE);
  let o = 0, near = 0;
  let {n, cell} = grid, far = grid.far;
  let distAt = (x, y) => {
    let gx = (x - domain.x0) / cell - 0.5, gy = (y - domain.y0) / cell - 0.5;
    let c = Math.max(0, Math.min(n - 2, Math.floor(gx))), r = Math.max(0, Math.min(n - 2, Math.floor(gy)));
    let fx = Math.max(0, Math.min(1, gx - c)), fy = Math.max(0, Math.min(1, gy - r)), i = r * n + c, g = grid.near;
    return far / 255 * ((g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + n] * (1 - fx) + g[i + n + 1] * fx) * fy);
  };
  let put = (x, y, tx, ty, s, L, side, aux) => {
    out[o++] = x; out[o++] = y; out[o++] = tx; out[o++] = ty; out[o++] = s; out[o++] = L; out[o++] = side; out[o++] = aux; out[o++] = near;
  };
  // group the strokes by level and by the tile their middle falls in
  let tileOf = st => {
    let m = (st.xy.length >> 2) << 1;
    let tx = Math.max(0, Math.min(TILES - 1, Math.floor((st.xy[m] - domain.x0) / domain.side * TILES)));
    let ty = Math.max(0, Math.min(TILES - 1, Math.floor((st.xy[m + 1] - domain.y0) / domain.side * TILES)));
    return st.level * TILES * TILES + ty * TILES + tx;
  };
  let byKey = new Map();
  for (let st of strokes) {
    if (st.xy.length < 4) continue;
    let key = tileOf(st);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(st);
  }
  let groups = [];
  for (let key of Array.from(byKey.keys()).sort((a, b) => a - b)) {
    let first = o / STRIDE, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, lineNo = 0;
    for (let st of byKey.get(key)) {
      let xy = st.xy, m = xy.length / 2;
      let len = 0, sAt = new Float32Array(m);
      for (let i = 1; i < m; ++i) { len += Math.hypot(xy[2 * i] - xy[2 * i - 2], xy[2 * i + 1] - xy[2 * i - 1]); sAt[i] = len; }
      // a random shade per line, from its place (the same every time)
      let h = Math.sin(xy[0] * 12.9898 + xy[1] * 78.233) * 43758.5453;
      let aux = st.level + (h - Math.floor(h)) * 0.49;
      for (let i = 0; i < m; ++i) {
        let a = Math.max(0, i - 1), b = Math.min(m - 1, i + 1);
        let tx = xy[2 * b] - xy[2 * a], ty = xy[2 * b + 1] - xy[2 * a + 1], tl = Math.hypot(tx, ty) || 1;
        tx /= tl; ty /= tl;
        let x = xy[2 * i], y = xy[2 * i + 1];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        near = distAt(x, y);
        if (i === 0 && lineNo > 0) put(x, y, tx, ty, 0, len, -1, aux);   // degenerate joint
        put(x, y, tx, ty, sAt[i], len, -1, aux);
        put(x, y, tx, ty, sAt[i], len, 1, aux);
        if (i === m - 1) put(x, y, tx, ty, sAt[i], len, 1, aux);
      }
      lineNo++;
    }
    // room for the width of the strokes
    let pad = domain.span * 0.01;
    groups.push({level: Math.floor(key / (TILES * TILES)), first, count: o / STRIDE - first, x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad});
  }
  return {v: out.subarray(0, o), groups};
}
