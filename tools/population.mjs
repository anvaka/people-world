// Makes population.json: every country's population for each year from 1960, for the map that
// plays through time.
//
//   node tools/population.mjs            asks the World Bank
//   node tools/population.mjs pop.json   reads its answer from a file instead, where Node can't
//                                        reach the World Bank itself:
//     curl -o pop.json "https://api.worldbank.org/v2/country/all/indicator/SP.POP.TOTL?format=json&date=1960:2024&per_page=20000"
//
// The World Bank's series (indicator SP.POP.TOTL, CC BY 4.0) covers most countries. For the rest:
//   - Taiwan, Reunion, and the Palestinian Territory before 1990: Gapminder's five-year figures
//     (tools/population-others.json), the years between filled in a straight line, and joined to
//     today's figure, or to the World Bank's where its series begins;
//   - Jersey and Guernsey: the World Bank's Channel Islands, shared as their people are today;
//   - small territories with no history anywhere: today's people, changing as the world's did.
//     Those are listed under "estimated".
// The page uses only how each country changed (a year's figure over the last year's), on the
// populations the map is drawn with.
import {readFileSync, writeFileSync} from 'node:fs';

const FIRST = 1960, LAST = 2024;
const URL_ = `https://api.worldbank.org/v2/country/all/indicator/SP.POP.TOTL?format=json&date=${FIRST}:${LAST}&per_page=20000`;
const [file] = process.argv.slice(2);
const [info, rows] = file ? JSON.parse(readFileSync(file, 'utf8')) : await (await fetch(URL_)).json();
const wb = new Map();
for (const r of rows) if (r.value !== null) { if (!wb.has(r.country.id)) wb.set(r.country.id, new Map()); wb.get(r.country.id).set(+r.date, r.value); }
const countries = JSON.parse(readFileSync(new URL('../countries.json', import.meta.url), 'utf8'));
const others = JSON.parse(readFileSync(new URL('./population-others.json', import.meta.url), 'utf8'));
const years = Array.from({length: LAST - FIRST + 1}, (_, i) => FIRST + i);
const world = wb.get('1W');
const full = m => m && years.every(y => m.has(y));
// a series through known points (year → people), straight between them
const through = points => {
  const ks = [...points.keys()].sort((a, b) => a - b);
  return years.map(y => {
    if (y <= ks[0]) return points.get(ks[0]);
    if (y >= ks.at(-1)) return points.get(ks.at(-1));
    const hi = ks.findIndex(k => k >= y), a = ks[hi - 1], b = ks[hi];
    return points.get(a) + (points.get(b) - points.get(a)) * (y - a) / (b - a);
  });
};
const series = {}, estimated = [], elsewhere = {};
for (const r of countries.nodes) {
  const [id, , , , people] = r, m = wb.get(id), g = others.series[id];
  if (!(people > 0)) continue;
  if (full(m)) series[id] = years.map(y => m.get(y));
  else if (g) {
    // Gapminder's years, then the World Bank's own where it has them, or today's figure at the end
    const pts = new Map(Object.entries(g).map(([y, v]) => [+y, v]).filter(([y]) => y >= FIRST - 8));
    if (m) { const first = Math.min(...m.keys()); const k = m.get(first) / through(pts)[first - FIRST]; for (const [y, v] of pts) if (y < first) pts.set(y, v * k); else pts.delete(y); for (const [y, v] of m) pts.set(y, v); }
    else pts.set(LAST, people);
    series[id] = through(pts);
    elsewhere[id] = 'Gapminder' + (m ? ` before ${Math.min(...m.keys())}, then the World Bank` : '');
  } else if ((id === 'JE' || id === 'GG') && full(wb.get('JG'))) {
    const both = countries.nodes.filter(n => n[0] === 'JE' || n[0] === 'GG').reduce((s, n) => s + n[4], 0);
    series[id] = years.map(y => wb.get('JG').get(y) * people / both);
    elsewhere[id] = 'World Bank, Channel Islands, shared as the islands\' people are today';
  } else { series[id] = years.map(y => people * world.get(y) / world.get(LAST)); estimated.push(id); }
  series[id] = series[id].map(v => Math.round(v));
}
writeFileSync(new URL('../population.json', import.meta.url), JSON.stringify({
  title: 'Population by year',
  about: `People in each country, ${FIRST} to ${LAST}.`,
  source: 'https://data.worldbank.org/indicator/SP.POP.TOTL',
  license: 'CC BY 4.0 (World Bank; Gapminder for the series named under "others")',
  updated: info.lastupdated,
  first: FIRST, last: LAST,
  world: years.map(y => world.get(y)),
  estimate: 'No history for these: their people today, changing as the world\'s did.',
  estimated, others: elsewhere, series,
}) + '\n');
console.log(`population.json: ${Object.keys(series).length} series, ${years.length} years; ${Object.keys(elsewhere).length} from elsewhere (${Object.keys(elsewhere).join(' ')}); ${estimated.length} estimated`);
