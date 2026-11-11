// Makes gdp.json: every country's GDP in current US dollars, for the map sized by GDP.
//
//   node tools/gdp.mjs                          asks the World Bank
//   node tools/gdp.mjs gdp.json countries.json  reads the two answers from files instead, where
//                                               Node can't reach the World Bank itself:
//     curl -o gdp.json "https://api.worldbank.org/v2/country/all/indicator/NY.GDP.MKTP.CD?format=json&mrnev=1&per_page=400"
//     curl -o countries.json "https://api.worldbank.org/v2/country?format=json&per_page=400"
//
// The figure is the most recent one the World Bank has for each country (indicator
// NY.GDP.MKTP.CD, CC BY 4.0). Countries and territories it has none for (North Korea, Taiwan and
// some small territories among them) get an estimate: their population times the median GDP per
// person of the countries that have a figure. Those are listed under "estimated", and the page
// says so wherever it shows one.
import {readFileSync, writeFileSync} from 'node:fs';

const API = 'https://api.worldbank.org/v2/';
const GDP = API + 'country/all/indicator/NY.GDP.MKTP.CD?format=json&mrnev=1&per_page=400';
const LIST = API + 'country?format=json&per_page=400';
const [gdpFile, listFile] = process.argv.slice(2);
const answer = async (file, url) => file ? JSON.parse(readFileSync(file, 'utf8')) : (await fetch(url)).json();
const [info, rows] = await answer(gdpFile, GDP);
const [, list] = await answer(listFile, LIST);

// (the list tells countries from the regions and income groups the World Bank also reports on)
const real = new Set(list.filter(c => c.region.id !== 'NA').map(c => c.iso2Code));
const figure = new Map(rows.filter(r => r.value > 0 && real.has(r.country.id)).map(r => [r.country.id, {value: r.value, year: +r.date}]));
const countries = JSON.parse(readFileSync(new URL('../countries.json', import.meta.url), 'utf8'));
const known = countries.nodes.filter(r => figure.has(r[0]) && r[4] > 0);
const perPerson = known.map(r => figure.get(r[0]).value / r[4]).sort((a, b) => a - b);
const median = perPerson[perPerson.length >> 1];

const values = {}, years = {}, estimated = [];
for (const r of countries.nodes) {
  const f = figure.get(r[0]);
  values[r[0]] = Math.round(f ? f.value : r[4] * median);
  if (f) years[f.year] = (years[f.year] || 0) + 1;
  else estimated.push(r[0]);
}
writeFileSync(new URL('../gdp.json', import.meta.url), JSON.stringify({
  title: 'GDP',
  about: 'Gross domestic product in current US dollars: the most recent figure the World Bank has for each country.',
  source: 'https://data.worldbank.org/indicator/NY.GDP.MKTP.CD',
  license: 'CC BY 4.0 (World Bank)',
  updated: info.lastupdated,
  years,
  estimate: `No figure for these: their population times the median GDP per person (${Math.round(median).toLocaleString('en-US')} US$).`,
  estimated,
  values,
}, null, 1) + '\n');
console.log(`gdp.json: ${figure.size} World Bank figures, ${known.length} of them for the ${countries.nodes.length} countries here; ` +
  `${estimated.length} estimated at ${Math.round(median).toLocaleString('en-US')} US$ a person; years ${JSON.stringify(years)}`);
