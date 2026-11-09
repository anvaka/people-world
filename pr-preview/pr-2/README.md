# The Peopled World

A fantasy world map drawn from one graph: the world's countries, linked when they share a land
border. The map keeps three rules:

1. Countries that are neighbours in the graph share a border.
2. Countries that are not neighbours never touch.
3. Every country's area is proportional to its population.

Nothing else comes from the real world. Where countries sit, their shapes and the coasts are made
up, so each world number gives a different map of the same graph.

![World 1](docs/world-1.jpg)

## Using the map

- Drag, pinch, scroll or double-click to move around; the buttons at the right edge zoom in, out
  and back to the whole world. Tap a country to see its neighbours. **Find a country** takes a
  name, the start of one or a two-letter code.
- **Another world** draws the same graph again with the next world number.
- **Change borders.** In a country's panel, **Remove** takes a border away and the field below (or
  "pick it on the map") adds one. The map is then redrawn starting from the world as it was, so the
  countries an edit doesn't touch stay where they were. While it is redrawn the old map stays in
  use, and a note at the bottom right says what is being drawn and can cancel it. Afterwards the
  map lights the countries you edited and fades those that kept their shape.
- **Show before** switches between the map before your changes and after; holding it (or the B
  key) shows the map before only while held. Every change can be undone on its own; Undo, Ctrl+Z
  and the browser's Back are instant for the last few maps drawn.
- **Style** draws the map as Ink (a book's endpapers: pen, parchment, hatched coasts, mountains and
  woods), Realm (a painted game world: terrain, shallows and rivers under the countries) or
  Kinpeki (a gold-leaf folding screen: flat mineral colours on a sea of gold waves). Switching
  doesn't build the world again. The browser remembers the choice.
- **Share a map.** The address holds the world number and the edits, so a link opens the same
  map. `#world-1-cut-FR-ES-add-JP-KR` is world 1 without the France–Spain border and with a
  Japan–South Korea one. Countries are named by their two-letter codes. Past four edits the link
  switches to a compact code of four letters or digits per edit (`#world-1-e-0PLu1pIL…`), so a
  long editing session still fits in a link you can paste. A style other than Ink ends the link
  (`#world-1-cut-FR-ES-realm`). **Share** copies the link, or opens a phone's share sheet.
- Keys: `/` finds, arrows move the map, `+` `−` zoom, `0` shows the whole world, Enter picks the
  country under the ring in the middle, B shows before, Ctrl+Z undoes, Escape closes.

A world takes about 5 seconds to build on a laptop, longer on a phone; an edit about 4. A link with
edits first builds the world without them, so it takes about twice as long.

## Running it

It is a static page with no build step and no dependencies. Serve the folder with any file server,
for example:

```
python3 -m http.server 8080
```

and open http://localhost:8080. (Opening `index.html` straight from disk does not work: the page
loads ES modules and a module worker.) The same works on GitHub Pages.

## Previews

GitHub Actions publish `main` to the `gh-pages` branch, which GitHub Pages serves. Every pull
request from a branch of this repository is published next to it, at
`https://anvaka.github.io/people-world/pr-preview/pr-<number>/`, and a comment on the pull request
links to it with a QR code, so a change can be tried on a phone before it is merged. Pushing to the
branch updates the preview; closing or merging the pull request removes it. Pull requests from
forks get no preview.

## How a world is made

1. **Layout.** Each country is a disc of its size. Neighbours are pulled together and other
   countries pushed apart: stress majorization on graph distances, then constraint projection.
2. **Exclaves.** The graph is not planar: it can't be drawn flat with every link as a border.
   `planar.js` finds the fewest links it can that have to go. Each of those becomes an exclave, a
   detached piece of one country that touches the other (Kaliningrad-style).
3. **Mesh.** About 50,000 cells: jittered quadtree points, finer where small countries sit, and
   the dual of their Delaunay triangulation.
4. **Growth and annealing.** Countries grow from their discs at a speed set by their size, then
   Metropolis annealing makes them compact. Hard rules hold at every step: a cell may touch a cell
   of another country only if the two are neighbours, a country stays in one piece, and a border
   never shrinks below a minimum length.
5. **Repairs.** Missing borders are bridged, long arms and ribbons are cut back, long water
   channels between countries that must not touch are widened into seas, and exclaves are carved.
6. **Geometry.** Cell boundaries become smooth, slightly rough hand-drawn lines. Areas are then
   fitted exactly, and the tiniest countries shrink to their true size.
7. **Islands.** Countries with no neighbours are blobs of exact area, placed in archipelagos off
   the coast of their continent.

**Edited maps** start from the world without edits. Countries start where they were, with a weak
pull back to that spot. The earlier exclaves are kept, and only the edited links get a new
decision. The mesh and every random choice are tied to positions on the map, not to the order in
which the work happens, so places an edit doesn't reach come out much the same. Some borders still
shift a little everywhere. An edit too big for this, such as a border across an ocean, breaks a
rule or takes too long; the page then draws the edited graph from scratch and says that countries
moved.

## Styles

Each style is three files in `styles/`: `<name>.css`, with every rule under
`html[data-style="<name>"]`; `<name>.js`, a module that registers `window.mapStyles[<name>]`; and
`<name>.fonts`, the Google Fonts address it needs. Only the chosen style loads with the page; the
others load the first time they are picked. The page calls a style's hooks: `render(world)` once
for each world drawn, `view(world, state, selected)` after each redraw, `settled(world)` before it
calls the map ready, and `unmount()` when another style is picked. A style's canvases sit in
`#plate` with the map, so a gesture moves them together. The comment above `skin()` in
`index.html` lists the hooks.

Switching styles draws the worlds on hand (and the map before your edits, when there is one)
again from what the generator returned, at the same view and with the same country picked.

The heavy work of each style runs off the page's thread: Ink draws its terrain and seas in a
worker, in tiles kept per zoom level (one worker on a phone, two elsewhere); Kinpeki traces its
waves in a worker and draws them with WebGL; Realm prepares its terrain in a worker and paints it
with WebGL 2. On a software renderer (no GPU) Realm keeps its flat colours, which is what headless
test browsers show; `?realm-gl` in the address paints anyway.

## What makes it fast

- The generator: a faster `Math.hypot`, grids and bucket queues instead of searches over
  everything, typed arrays, and an area fit that leaves alone countries already within tolerance.
  World 1 went from about 13 to about 5 seconds, an edit from about 12 to about 4.
- Drawing a world is cut into slices of about 12 ms, so a phone keeps answering while it happens;
  the outlines, name positions and simplified lines are worked out once per world and kept.
- During a pan, pinch or wheel turn the picture already drawn (`#plate`) is moved as one bitmap
  and drawn properly when the gesture rests. Only lines on screen get a new level of detail.
- Lines, ripples and rings don't answer the pointer, so taps and hovers don't hit-test them.

## Checking the rules

```
node tools/check.mjs                               # worlds 1, 2 and 3
node tools/check.mjs 1 --edits cut-FR-ES-add-JP-KR # world 1, then world 1 with those edits
```

builds the worlds in Node (tested with Node 22) and checks all three rules on each, with areas
within 1% of their share of the population. It exits with 1 when a rule fails.

## Known flaws

- Some worlds have long, thin water channels where wide seas would look better.
- In the most crowded regions (the Balkans, the Caucasus, Central Africa) a few countries come out
  stretched, and there are 14–18 exclaves per world.
- An edit reshapes many countries, not only the ones edited: the warm start is not local.
- On a phone held upright the whole world is a band across the middle of the screen: it is about
  twice as wide as it is tall.
- At whole-world zoom many countries are smaller than a pixel. That is rule 3: populations range
  from a few dozen people to 1.4 billion. A small ring marks each country too small to see.

## Files

| file | what it does |
| --- | --- |
| `index.html` | the page: drawing, pan and zoom, border editing, the style picker |
| `styles/` | the three styles: `ink`, `realm`, `kinpeki` (`.css`, `.js`, `.fonts` and helpers) |
| `worker.js` | runs the generator off the main thread |
| `world.js` | the pipeline, `buildWorld(graph, {seed, base})` |
| `layout.js` | country discs: stress majorization and constraint projection |
| `planar.js` | planarity test and the fewest-removal planar subgraph |
| `mesh.js` | the cell mesh |
| `label.js` | which country each cell belongs to: growth, annealing, repairs |
| `geom.js` | boundary lines from the cells |
| `process.js` | smoothing, roughening, exact area fitting |
| `islands.js` | island countries |
| `util.js` | seeded random numbers, noise, polygon helpers |
| `countries.json` | the graph |
| `vendor/` | Delaunator, the `orient2d` predicate from robust-predicates, earcut (Realm's triangles) |
| `tools/check.mjs` | builds worlds and checks the rules |

## Credits

- Countries, populations and land neighbours: [GeoNames](https://www.geonames.org/)
  ([countryInfo.txt](https://download.geonames.org/export/dump/countryInfo.txt)), CC BY 4.0.
- [Delaunator](https://github.com/mapbox/delaunator) by Mapbox, ISC license.
- [robust-predicates](https://github.com/mourner/robust-predicates) by Vladimir Agafonkin, after
  Jonathan Shewchuk's predicates, public domain (Unlicense).
- [earcut](https://github.com/mapbox/earcut) by Mapbox, ISC license (`vendor/LICENSE-earcut`).
- Fonts from [Google Fonts](https://fonts.google.com/), SIL Open Font License: Eagle Lake,
  Fondamento and Sorts Mill Goudy (Ink), Alegreya and Alegreya SC (Realm), Shippori Mincho B1
  (Kinpeki).

## License

MIT, see [LICENSE](LICENSE).
