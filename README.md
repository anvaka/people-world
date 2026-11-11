# People World

A fantasy map of the world where every country is as large as its population:
https://anvaka.github.io/people-world/

[![People World](docs/world-1.jpg)](https://anvaka.github.io/people-world/)

The input is one graph: the world's countries, linked when they share a land border. The map
keeps three rules:

1. Neighbours share a border.
2. Countries that are not neighbours never touch.
3. Every country's area is proportional to its population.

Nothing else comes from the real world. Where countries sit, their shapes and the coasts are made
up.

## What can you do?

- Click a country to see its neighbours.
- Remove or add a border, and the world is drawn again. It takes about 4 seconds on a laptop.
- Size the countries by something else: `Customize...` has land area and GDP next to population.
- Switch between two styles, `ink` and `realm`. Both draw the same mountains, rivers and climate.
- Send someone the address. It holds the world and your edits: `#world-1-cut-FR-ES-add-JP-KR` is
  world 1 without the France-Spain border and with a Japan-South Korea one.
- Drop a Graphviz `.dot` file onto the page to see your own graph as a map. Small graphs that are
  close to planar work best. A graph with large hubs breaks the size rule, and the page tells you.

## How it is made?

I've been making maps for years ([map of GitHub](https://github.com/anvaka/map-of-github),
[map of reddit](https://github.com/anvaka/map-of-reddit),
[city roads](https://github.com/anvaka/city-roads)). This one I made together with an AI
assistant: Claude wrote the code, and the commit history says so. The map itself is drawn by a
deterministic algorithm, not by an image model: the same world number always gives the same map.

Here is what happens when a world is made:

1. **Layout.** Each country starts as a disc of its size. Neighbours are pulled together, other
   countries are pushed apart.
2. **Exclaves.** The border graph is not planar, so not every border can be drawn on a flat map.
   The fewest links that don't fit become exclaves: a detached piece of one country that touches
   the other, like Kaliningrad.
3. **Mesh.** The world is cut into about 50,000 cells.
4. **Growth.** Countries grow from their discs over the cells, then simulated annealing makes
   them compact. The three rules hold at every step.
5. **Geometry.** Cell edges become hand-drawn lines, and the areas are fitted exactly.
6. **Terrain and climate.** The ground rises inland, rain run off it gives the rivers, and
   mountain ranges stand on the divides. Winds carry the sea's moisture inland, ranges cast rain
   shadows, and warmth and moisture decide what grows.

An edited map starts from the world as it was, so countries that the edit doesn't touch stay
roughly where they were.

There is a longer description of every step, the styles and the files in
[docs/internals.md](docs/internals.md).

## Local development

It is a static page with no build step. Serve the folder with any file server:

```
python3 -m http.server 8080
```

and open http://localhost:8080. To build a few worlds in Node and check the three rules on each:

```
node tools/check.mjs
```

## Limitations

- Most worlds have 9 to 16 exclaves, and in crowded regions (the Balkans, the Caucasus) a few
  countries come out stretched. By GDP the first three worlds have 24 to 29.
- By land area Saint Martin (53 km², half of a small island) is too small to draw to its size:
  it comes out up to twice as large, and the page says so.
- The World Bank has no GDP figure for 37 countries and territories. For 22 of them (Taiwan and
  North Korea among them) the figure is from another source, listed in `gdp.json`. The other 15
  are small territories with no figure anywhere, or with nobody living there: they get an
  estimate, their population times the median GDP per person, and the page marks it as one.
- An edit reshapes many countries, not only the edited ones.
- At whole-world zoom many countries are smaller than a pixel: populations range from a few dozen
  people to 1.4 billion. A small ring marks each country that is too small to see.
- On a phone held upright the world is a narrow band: it is about twice as wide as it is tall.

## Credits

- Countries, populations, land areas and land neighbours: [GeoNames](https://www.geonames.org/),
  CC BY 4.0.
- GDP: [World Bank](https://data.worldbank.org/indicator/NY.GDP.MKTP.CD), CC BY 4.0. Where it
  has no figure: Taiwan's and North Korea's statistics as reported, INSEE and IEDOM for the
  French territories, the UN, and the territories' own statistics offices (each is named in
  [gdp.json](gdp.json)).
- [Delaunator](https://github.com/mapbox/delaunator) and [earcut](https://github.com/mapbox/earcut)
  by Mapbox, [robust-predicates](https://github.com/mourner/robust-predicates) by Vladimir
  Agafonkin.
- The map's lettering is set in fonts from [Google Fonts](https://fonts.google.com/).

## Support

If you love this website you can [buy me a coffee](https://ko-fi.com/anvaka) or
[sponsor me on GitHub](https://github.com/sponsors/anvaka), but you don't have to.

## License

MIT, see [LICENSE](LICENSE).
