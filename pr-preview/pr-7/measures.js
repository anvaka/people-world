// What the countries are sized by. countries.json carries each country's population and its land
// area; GDP comes from gdp.json (tools/gdp.mjs makes it). Population is the map the page opens
// with. Each other measure is the same graph with another number per country: a document like the
// countries' own, which the generator draws the same way.

// name: in a list of choices. its: "every country is as large as …". whole: "its share of …".
export const MEASURES = {
  '': {name: 'population', its: 'its population', whole: 'the world’s people', legend: 'people'},
  land: {name: 'land area', its: 'its land area', whole: 'the world’s land', legend: 'real land'},
  gdp: {name: 'GDP', its: 'its GDP', whole: 'the world’s GDP', legend: 'GDP', data: './gdp.json'},
};

// The countries' document sized by a measure. A row is [id, name, capital, continent, size on the
// map, the measure's own number, people, 1 when that number is an estimate]. Sizes are scaled so
// that they add up to the world's people: the map then has the land it has by population, and the
// generator works at the scale it was made for. A country with nothing of the measure is not drawn.
export function measureDoc(countries, by, data) {
  const m = MEASURES[by];
  if (!by || !m) return countries;
  const people = countries.nodes.map(r => +r[4] || 0);
  const total = people.reduce((a, b) => a + b, 0);
  const raw = countries.nodes.map(r => Math.max(0, by === 'land' ? +r[5] || 0 : +(data.values[r[0]] || 0)));
  const sum = raw.reduce((a, b) => a + b, 0);
  const guessed = new Set(data && data.estimated || []);
  return {
    ...countries,
    title: 'the world by ' + m.name,
    fields: ['id', 'label', 'capital', 'continent', 'size on the map', m.name, 'population', 'estimate'],
    nodes: countries.nodes.map((r, i) => [r[0], r[1], r[2], r[3], raw[i] > 0 ? Math.max(1, Math.round(raw[i] / sum * total)) : 0,
      raw[i], people[i], guessed.has(r[0]) ? 1 : 0]),
    measure: m.name,
    by,
    scale: sum / total,      // how much of the measure one unit of size on the map stands for
    importance: m.name,
    // (by land area a few states are far smaller than by people, and one that can't be drawn down
    // to its size is left a little large and said to be so, where the population map would stop)
    build: {lenient: true},
  };
}

const BIG = [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
// 1,463,865,525 people; 3,287,263 km²; $3.91 trillion; about $2.2 billion (estimate)
export function sizeWords(by, value, estimate) {
  if (by === 'land') return (value >= 10 ? Math.round(value) : +value.toPrecision(2)).toLocaleString('en-US') + ' km²';
  if (by === 'gdp') {
    let text = '$' + Math.round(value).toLocaleString('en-US');
    for (const [unit, word] of BIG.slice(0, 3)) if (value >= unit) { text = '$' + (+(value / unit).toPrecision(3)) + ' ' + word; break; }
    return estimate ? `about ${text} (estimate)` : text;
  }
  return Math.round(value).toLocaleString('en-US') + ' people';
}

// For a legend: round amounts of a measure and what to call them, each with its size on the map
export function legendOf(doc) {
  if (!doc.by) return null;
  const steps = [];
  for (let e = doc.by === 'gdp' ? 7 : 1; e <= (doc.by === 'gdp' ? 13 : 7); ++e) for (const d of [1, 2, 5]) {
    const n = d * 10 ** e;
    let words = String(n);
    for (const [unit, word] of BIG) if (n >= unit) { words = n / unit + ' ' + word; break; }
    steps.push({n: n / doc.scale, words: doc.by === 'gdp' ? '$' + words : words + ' km²'});
  }
  return {cap: 'Land is ' + MEASURES[doc.by].legend, steps};
}
