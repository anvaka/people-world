// Seeded noise for the inked map's own terrain marks. Everything that decides where a wood, a
// marsh or a dune goes is a function of the world number and of a position on the map (world
// units), never of a random number drawn at load time: the same world gives the same marks, and
// an edit that leaves a region alone leaves them alone. (The mountains and rivers are the world's:
// terrain.js.)

// A 32-bit hash of integers, as a number in [0, 1)
export function hash(a, b, c, d) {
  let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 1274126177) + Math.imul(d | 0, 1911520717) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// Gradient (Perlin) noise and its fractal sums, from a seed
export function makeNoise(seed) {
  const perm = new Uint16Array(512);
  const p = Array.from({length: 256}, (_, i) => i);
  for (let i = 255; i > 0; --i) {
    let j = Math.floor(hash(seed, i, 7, 11) * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; ++i) perm[i] = p[i & 255];
  const GX = [1, -1, 1, -1, 1.4142, -1.4142, 0, 0], GY = [1, 1, -1, -1, 0, 0, 1.4142, -1.4142];
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  function noise(x, y) {
    let xi = Math.floor(x), yi = Math.floor(y);
    let xf = x - xi, yf = y - yi;
    xi &= 255; yi &= 255;
    let g = (i, j, dx, dy) => { let h = perm[i + perm[j]] & 7; return GX[h] * dx + GY[h] * dy; };
    let u = fade(xf), v = fade(yf);
    let a = g(xi, yi, xf, yf), b = g(xi + 1, yi, xf - 1, yf);
    let c = g(xi, yi + 1, xf, yf - 1), d = g(xi + 1, yi + 1, xf - 1, yf - 1);
    let ab = a + (b - a) * u, cd = c + (d - c) * u;
    return (ab + (cd - ab) * v) * 0.7071;   // about [-1, 1]
  }
  function fbm(x, y, octaves = 3) {
    let s = 0, amp = 1, norm = 0, f = 1;
    for (let o = 0; o < octaves; ++o) {
      s += amp * noise(x * f + o * 17.1, y * f - o * 9.3);
      norm += amp; amp *= 0.5; f *= 2.03;
    }
    return s / norm;
  }
  return {noise, fbm};
}

export const smoothstep = (a, b, x) => { let t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// The fields the style's own marks are read from, all in world units (a world is about 180
// across). Each is a smooth function of position: thresholds on them give regions, not scattered
// marks. (Where the mountains stand, and their foothills, is the world's terrain: see terrain.js.)
export function makeTerrain(seed) {
  const {fbm, noise} = makeNoise(seed * 7919 + 13);
  return {
    fbm, noise,
    // a few downs and wolds that stand on their own
    downs: (x, y) => 0.8 * smoothstep(0.4, 0.64, fbm(x / 13 + 5.3, y / 13 + 3.1, 2)),
    forest: (x, y) => fbm(x / 15 + 100.3, y / 15 - 40.7, 3) + 0.1 * fbm(x / 4 + 9, y / 4 - 3, 2),
    dry: (x, y) => fbm(x / 40 - 70.1, y / 40 + 20.9, 2),
    wet: (x, y) => fbm(x / 6 + 200.7, y / 6 + 0.3, 2),
  };
}
