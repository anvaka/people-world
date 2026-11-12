// The world in other years, worked out off the page's thread (time.js). The page sends the world
// it has drawn and each country's people by year; then asks for
//   frames: the positions of every point of the map at some years, for playing through them
//           (each is worked out from the year after it, which is close);
//   year:   one year as a whole world, with its mountains, rivers and climate made for its
//           shapes (addons.js), to be drawn like any other.
// Jobs wait in a line and a `year` goes to its head: a year asked for while frames are being
// worked out is not kept waiting for all of them.
import {throughYears} from './time.js';
import {addAddons} from './addons.js';

let S = null;
const jobs = [];
let running = false;
function run() {
  if (running) return;
  running = true;
  const next = () => {
    const job = jobs.shift();
    if (!job) { running = false; return; }
    try { job(); } catch (error) { self.postMessage({type: 'error', message: error.message}); }
    setTimeout(next, 0);
  };
  next();
}

self.onmessage = ({data}) => {
  if (data.type === 'init') {
    S = {years: throughYears(data.result, data.history, {extra: data.extra}), seed: data.seed, addons: data.addons};
    // how the points are laid out, and where they are now
    const prep = S.years.prep;
    self.postMessage({type: 'ready', rings: prep.flat.rings, lines: data.result.lines.map((l, i) => ({kind: l.kind, start: prep.lineAt[i], len: l.points.length})),
      extraAt: prep.extraAt, year: data.history.last, pts: Float32Array.from(prep.all)});
  } else if (data.type === 'frames') {
    for (const y of data.years) jobs.push(() => self.postMessage({type: 'frame', year: y, pts: Float32Array.from(S.years.keep(y))}));
    run();
  } else if (data.type === 'year') {
    jobs.unshift(() => {
      const world = S.years.world(data.year);
      addAddons(world, S.seed, S.addons);
      self.postMessage({type: 'world', year: data.year, id: data.id, result: world});
    });
    run();
  }
};
