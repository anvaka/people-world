// Small shared helpers: seeded random numbers, value noise, polygon geometry.

export function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Math.hypot(x, y), computed the way V8 computes it (both scaled by the larger, Kahan-summed),
// so the results are the same bit for bit, without the cost of calling the builtin (about ten
// times faster), and the same in every browser
export function hypot(x, y) {
  const ax = Math.abs(x), ay = Math.abs(y);
  if (ax !== ax || ay !== ay) return ax === Infinity || ay === Infinity ? Infinity : NaN;
  const max = ax > ay ? ax : ay;
  if (max === Infinity) return Infinity;
  if (max === 0) return 0;
  const n0 = ax / max, n1 = ay / max;
  const s0 = n0 * n0;
  const comp = s0 - n0 * n0;
  return Math.sqrt(s0 + (n1 * n1 - comp)) * max;
}

// a random number in [0, 1) from three integers
export function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// smooth value noise in [-1, 1]
export function noise2(x, y, seed) {
  let ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  let sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  let a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  let c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return 2 * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) - 1;
}

// fractal noise, roughly in [-1, 1]
const ROT_C = Array.from({length: 16}, (_, o) => Math.cos(o * 1.3)), ROT_S = Array.from({length: 16}, (_, o) => Math.sin(o * 1.3));
export function fbm2(x, y, seed, octaves = 5, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; ++o) {
    // rotate each octave a little so the grid does not show
    let c = o < 16 ? ROT_C[o] : Math.cos(o * 1.3), s = o < 16 ? ROT_S[o] : Math.sin(o * 1.3);
    sum += amp * noise2((x * c - y * s) * f + o * 17.1, (x * s + y * c) * f - o * 9.7, seed + o * 101);
    norm += amp;
    amp *= gain;
    f *= 2.03;
  }
  return sum / norm;
}

export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

export function orient(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

// proper or touching intersection of segments ab and cd
export function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  let d1 = orient(cx, cy, dx, dy, ax, ay), d2 = orient(cx, cy, dx, dy, bx, by);
  let d3 = orient(ax, ay, bx, by, cx, cy), d4 = orient(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return false;
}

export function pointSegDist2(px, py, ax, ay, bx, by) {
  let dx = bx - ax, dy = by - ay;
  let l = dx * dx + dy * dy;
  let t = l > 0 ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  let ex = ax + t * dx - px, ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

export function segSegDist2(ax, ay, bx, by, cx, cy, dx, dy) {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(pointSegDist2(ax, ay, cx, cy, dx, dy), pointSegDist2(bx, by, cx, cy, dx, dy),
    pointSegDist2(cx, cy, ax, ay, bx, by), pointSegDist2(dx, dy, ax, ay, bx, by));
}

// the same as segSegDist2 for segments already known not to cross
export function segSegDist2NoCross(ax, ay, bx, by, cx, cy, dx, dy) {
  return Math.min(pointSegDist2(ax, ay, cx, cy, dx, dy), pointSegDist2(bx, by, cx, cy, dx, dy),
    pointSegDist2(cx, cy, ax, ay, bx, by), pointSegDist2(dx, dy, ax, ay, bx, by));
}

export const pause = () => new Promise(r => setTimeout(r, 0));
