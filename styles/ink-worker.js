// The inked map's worker: surveys each world and draws its tiles on OffscreenCanvas, off the page's
// main thread, and keeps the tiles it drew (compressed) so a tile asked for again comes back fast.
// Messages from the page:
//   {type: 'init', id, packed, grid, seed, dev}  a world to survey; answers {type: 'init', id, spots, sea}
//   {type: 'palette', palette}                   the colours of a theme
//   {type: 'decor', id, decor}                   where the rose, the ship and the serpent go
//   {type: 'tiles', list}                        the tiles wanted now, most wanted first (replaces the
//                                                list before); answers each {type: 'tile', key, blob}
//                                                (a PNG; null for an empty tile)
//   {type: 'drop', id}                           a world no longer shown
// A worker that cannot draw answers {type: 'nodraw'} and the page draws the tiles itself.
import {createEngine} from './ink-engine.js';

let engine = null;
try {
  if (typeof OffscreenCanvas !== 'undefined' && typeof Path2D !== 'undefined' && typeof createImageBitmap !== 'undefined' && new OffscreenCanvas(1, 1).getContext('2d'))
    engine = createEngine((w, h) => new OffscreenCanvas(w, h));
} catch (e) { engine = null; }

const kept = new Map();   // key → Blob (PNG), or null for an empty tile; the most recent last
const KEEP = 100;   // (merge: was 700; about 4 MB of PNGs per worker)
function keep(key, blob) {
  kept.delete(key);
  kept.set(key, blob);
  while (kept.size > KEEP) kept.delete(kept.keys().next().value);
}

let queue = [], busy = false;
async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    let t = queue.shift();
    try {
      if (t.ahead && kept.has(t.key)) continue;
      // a tile goes to the page as a PNG, shown there as a plain svg image: no GPU texture of this
      // worker's is ever shown, so a tile can't come out black on a phone
      if (kept.has(t.key)) {
        let blob = kept.get(t.key);
        keep(t.key, blob);
        self.postMessage({type: 'tile', key: t.key, id: t.id, blob});
      } else {
        let canvas = engine.tile(t.id, t);
        if (!canvas) { keep(t.key, null); self.postMessage({type: 'tile', key: t.key, id: t.id, blob: null}); }
        else {
          let blob = await canvas.convertToBlob({type: 'image/png'});
          keep(t.key, blob);
          if (!t.ahead) self.postMessage({type: 'tile', key: t.key, id: t.id, blob});   // drawn ahead: kept, not sent
        }
      }
    } catch (e) {
      if (!e.unknown) self.postMessage({type: 'error', message: e.message});
      self.postMessage({type: 'tile', key: t.key, id: t.id, blob: null, failed: true, unknown: !!e.unknown});
      if (e.unknown) queue = queue.filter(q => q.id !== t.id);
    }
    // let a newer list of wanted tiles arrive between two tiles
    await new Promise(r => setTimeout(r, 0));
  }
  busy = false;
}

self.onmessage = ({data}) => {
  if (!engine) { self.postMessage({type: 'nodraw', id: data.id}); return; }
  try {
    if (data.type === 'init') {
      let r = engine.init(data.id, data);
      self.postMessage({type: 'init', id: data.id, spots: r.spots, sea: r.sea}, [r.sea.ids.buffer, r.sea.toLand.buffer]);
    } else if (data.type === 'palette') engine.palette(data.palette);
    else if (data.type === 'decor') engine.decor(data.id, data.decor);
    else if (data.type === 'drop') { engine.drop(data.id); for (let key of [...kept.keys()]) if (key.startsWith(data.id + '|')) kept.delete(key); }
    else if (data.type === 'tiles') { queue = data.list; drain(); }
  } catch (e) {
    self.postMessage({type: 'error', id: data.id, message: e.message + '\n' + e.stack});
  }
};
