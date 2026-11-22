# People World, step by step

These scripts build [how-it-works/](../../how-it-works/), the page that follows world 1 through
the generator, with every figure drawn from a real build. The page is generated: edit
`page.html` here, not `how-it-works/index.html`.

To rebuild it after the code changes, from this folder:

```
node capture.mjs     # builds world 1 and saves each stage to data/ (about 30 MB, not in git)
node figs.mjs        # draws the figures from data/ into figs.json
node build.mjs       # writes how-it-works/index.html
```

`capture.mjs` copies the project's files into `.engine/` and adds two snapshot hooks there, one
at every stage of `buildWorld` and one where growth paints a cell. The engine itself has no hooks.
If an edit to `world.js` or `label.js` moves the lines the hooks hang on, the script stops and
names the line.

The screenshots of the map (the opening picture and the three styles) only need taking again when
a style changes. Serve the project (`npm start` in its root), then run `node shots.mjs`.

## Files

- `page.html`: the text and the page's styles, with placeholders for what the build fills in.
- `algorithms.json`: all 138 algorithms, one line each, with links into the code. Line numbers
  are at the commit in `base`; `build.mjs` finds each line again at the current commit by its
  text, and reports any it can't find.
- `figs.mjs`, `render.mjs`, `png.mjs`: the figures, as SVG the page's colours theme. Mountains
  and climate are small PNGs inside the SVG.
- `capture.mjs`, `shots.mjs`, `build.mjs`: as above.
