// Island countries (no neighbours): organic blobs of exact area, gathered into archipelagos off
// the coasts of the continent they belong to.
import {fbm2, ringArea, hypot} from './util.js';

// occupied: function(x, y, r) -> true if land (or another island) lies within r of (x, y)
// opts.keep: an island goes exactly to its anchor when no land is in the way (a warm start's
// islands stay put); opts.angle(it): where its search starts, instead of a random angle
export function placeIslands(list, anchorOf, occupied, rng, opts = {}) {
  // list: [{index, area, continent}] ; returns [{index, x, y, R}]
  const placed = [];
  let sorted = list.slice().sort((a, b) => b.area - a.area);
  if (opts.keep) {
    // first every island whose spot is still clear, so one that must move can't take another's
    const kept = new Set();
    for (const it of sorted) {
      const R = Math.sqrt(it.area / Math.PI) * 1.3;
      const [ax, ay] = anchorOf(it);
      if (occupied(ax, ay, R + 0.3) || placed.some(p => hypot(p.x - ax, p.y - ay) < p.R + R + 0.3)) continue;
      placed.push({index: it.index, x: ax, y: ay, R, area: it.area});
      kept.add(it);
    }
    sorted = sorted.filter(it => !kept.has(it));
  }
  for (const it of sorted) {
    const R = Math.sqrt(it.area / Math.PI) * 1.3;
    const gap = Math.max(0.5 * R, 0.6);
    const [ax, ay] = anchorOf(it);
    const ang0 = (opts.angle ? opts.angle(it) : rng()) * Math.PI * 2;
    let done = false;
    for (let d = 0; d < 400 && !done; d += 0.4 + d * 0.02) {
      const steps = Math.max(8, Math.ceil(2 * Math.PI * d / Math.max(0.5, R)));
      for (let k = 0; k < steps; ++k) {
        const ang = ang0 + (k / steps) * Math.PI * 2;
        const x = ax + Math.cos(ang) * d, y = ay + Math.sin(ang) * d;
        if (occupied(x, y, R + gap)) continue;
        if (placed.some(p => hypot(p.x - x, p.y - y) < p.R + R + Math.max(gap, 0.5 * p.R, 0.6))) continue;
        placed.push({index: it.index, x, y, R, area: it.area});
        done = true;
        break;
      }
    }
  }
  return placed;
}

// a blob of exactly `area` around (x, y)
export function islandRing(x, y, area, seed) {
  const r0 = Math.sqrt(area / Math.PI);
  const K = Math.max(28, Math.min(220, Math.round(40 + 30 * Math.log10(1 + area * 50))));
  const ring = [];
  const sx = (seed * 0.61803) % 7, sy = (seed * 0.31) % 5;
  for (let k = 0; k < K; ++k) {
    const t = (k / K) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    // low-frequency lobes plus detail; elongate a little
    const f = 1 + 0.32 * fbm2(sx + c * 1.2, sy + s * 1.2, seed, 5, 0.55) + 0.12 * fbm2(sx + c * 4, sy + s * 4, seed + 9, 3, 0.5);
    ring.push([c * f * 1.15, s * f * 0.87]);
  }
  // rotate, scale to exact area
  const th = (seed * 2.399) % (Math.PI * 2);
  const ct = Math.cos(th), st = Math.sin(th);
  let pts = ring.map(([a, b]) => [a * ct - b * st, a * st + b * ct]);
  const A = Math.abs(ringArea(pts));
  const k = r0 * Math.sqrt(Math.PI / A);
  pts = pts.map(([a, b]) => [x + a * k, y + b * k]);
  if (ringArea(pts) < 0) pts.reverse();
  return pts;
}
