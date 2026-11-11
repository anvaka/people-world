// The generator's addons: what is worked out about a world once its countries are drawn. Each adds
// one part to the build's result, under its own name, and every style draws from the parts it
// finds: the mountains and rivers of `terrain`, the valleys of `valleys`, the woods, deserts and
// marshes of `climate`.
//
// Every addon is on unless it is turned off where the world is built:
//
//   buildWorld(doc, {addons: {climate: false}})
//
// A style copes with a part that is not there: without `terrain` it draws no mountains or rivers,
// without `climate` woods of its own invention (which then differ from style to style), without
// `valleys` rivers that lie on the ground and not in it.
//
// To add one: a module with a function (world, seed) -> its part, and a line in the list below.
// `world` is the result so far ({countries, lines, ...} and the parts added before it); `seed`
// the world's number. What an addon makes should be a function of those two alone, on the grid of
// the world's land (land.js), as the others are: then the same world always gets the same, and
// every style can read it. `needs` names the parts it cannot do without: where one of them is off,
// so is the addon.
import {makeTerrain} from './terrain.js';
import {makeValleys} from './valleys.js';
import {makeClimate} from './climate.js';

export const ADDONS = [
  {name: 'terrain', make: makeTerrain},                       // mountains and rivers
  {name: 'valleys', make: makeValleys, needs: ['terrain']},   // the valleys the rivers have cut
  {name: 'climate', make: makeClimate},                       // warmth, rain, and what grows where
];

// Adds to `world` every addon that `off` does not turn off ({name: false}); `stage(name)` is told
// as each is done (the build's timings)
export function addAddons(world, seed, off, stage) {
  for (const {name, make, needs} of ADDONS) {
    if (off && off[name] === false) continue;
    if (needs && needs.some(part => !world[part])) continue;
    world[name] = make(world, seed);
    if (stage) stage(name);
  }
  return world;
}
