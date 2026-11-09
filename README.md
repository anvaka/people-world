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

- Drag, pinch, scroll or double-click to move around. Tap a country to see its neighbours.
- **Another world** draws the same graph again with the next world number.
- **Change borders.** In a country's panel, × removes a border and the field below adds one.
  The map is then redrawn starting from the world as it was, so the countries an edit doesn't
  touch stay where they were. **Show before** flips between the two maps; each edit can be undone.
- **Share a map.** The address holds the world number and the edits, so a link opens the same
  map. `#world-1-cut-FR-ES-add-JP-KR` is world 1 without the France–Spain border and with a
  Japan–South Korea one. Countries are named by their two-letter codes.

A world takes 10–15 seconds to build on a laptop, longer on a phone. A link with edits first builds
the world without them, so it takes about twice as long.

## Running it

It is a static page with no build step and no dependencies. Serve the folder with any file server,
for example:

```
python3 -m http.server 8080
```

and open http://localhost:8080. (Opening `index.html` straight from disk does not work: the page
loads ES modules and a module worker.) The same works on GitHub Pages.

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
- At whole-world zoom many countries are smaller than a pixel. That is rule 3: populations range
  from a few dozen people to 1.4 billion. A small ring marks each country too small to see.

## Files

| file | what it does |
| --- | --- |
| `index.html` | the page: drawing, pan and zoom, border editing |
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
| `vendor/` | Delaunator and the `orient2d` predicate from robust-predicates |
| `tools/check.mjs` | builds worlds and checks the rules |

## Credits

- Countries, populations and land neighbours: [GeoNames](https://www.geonames.org/)
  ([countryInfo.txt](https://download.geonames.org/export/dump/countryInfo.txt)), CC BY 4.0.
- [Delaunator](https://github.com/mapbox/delaunator) by Mapbox, ISC license.
- [robust-predicates](https://github.com/mourner/robust-predicates) by Vladimir Agafonkin, after
  Jonathan Shewchuk's predicates, public domain (Unlicense).

## License

MIT, see [LICENSE](LICENSE).
