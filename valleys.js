// The valleys the rivers run in. Nothing here wears the land down grain by grain (that would take
// longer than drawing the countries does); a river is given the valley it would have cut: wider
// and deeper the more water it carries, from a furrow at its source to a broad vale at its mouth.
// A style that shows the ground's height lowers it by this, so its rivers lie in the land and not
// on it. One of the generator's addons (addons.js); it needs the terrain's rivers.
//
//   makeValleys({countries, lines, terrain}) -> {
//     grid    the land's (land.js)
//     depth   Float32Array, w * h: how far the ground is cut down, 0 (not at all) to 1 (the floor
//             of the largest valleys), falling smoothly from a river to the valley's rim
//   }
import {landOf, dab} from './land.js';

const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function makeValleys(world) {
  const T = world.terrain, L = landOf(world), G = T.grid, depth = new Float32Array(G.w * G.h);
  if (!L) return {grid: G, depth};
  for (const r of T.rivers) {
    let lx = Infinity, ly = Infinity;
    for (let k = 0; k < r.flow.length; ++k) {
      const x = r.points[2 * k], y = r.points[2 * k + 1], f = r.flow[k] / T.riverMin;
      // (a dab every half cell is as smooth as one at every point of the line)
      if (f < 0.2 || (Math.abs(x - lx) < 0.5 * G.cell && Math.abs(y - ly) < 0.5 * G.cell && k < r.flow.length - 1)) continue;
      lx = x; ly = y;
      // from a stream (a fifth of a river's water) to a great river (a dozen times it): half the
      // valley's width, in the land's units, and its depth
      const half = (0.55 + 0.42 * Math.sqrt(Math.min(f, 12))) / L.K;
      dab(depth, G, x, y, half, 0.25 + 0.75 * smoothstep(0.2, 8, f));
    }
  }
  // (the sea has no valleys: a river's mouth opens on the shore)
  for (let i = 0; i < depth.length; ++i) if (L.ids[i] < 0) depth[i] = 0;
  return {grid: G, depth};
}
