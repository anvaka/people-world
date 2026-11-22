// Screenshots of People World itself for the explainer: world 1 in a style and theme, at a view
// given as a box in map units (x0, y0, x1, y1, y down as drawn), the page's own controls hidden.
// Written into how-it-works/ next to the page. Only needed again when a style changes.
//   npm start            (in the project: serves it at http://127.0.0.1:8080/)
//   node shots.mjs [spec ...]
//   spec: name:style:theme:width:height:scale[:x0,y0,x1,y1]; with no spec, the five the page uses
// Chrome is looked for where macOS keeps it; set CHROME to use another.
import {mkdirSync, writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'how-it-works');
const SITE = process.env.SITE || 'http://127.0.0.1:8080/';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT = [
  'hero-light:ink:light:1600:960:1.125:-76,-54,106,53',
  'hero-dark:ink:dark:1600:960:1.125:-76,-54,106,53',
  'style-ink:ink:light:900:600:2:2,-26,35,-4',
  'style-realm:realm:light:900:600:2:2,-26,35,-4',
  'style-atlas:atlas:light:900:600:2:2,-26,35,-4',
];
const specs = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
mkdirSync(OUT, {recursive: true});
const PORT = 9351;
const profile = join(HERE, '.chrome');
mkdirSync(profile, {recursive: true});
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1600,1000',
  '--no-first-run', '--no-default-browser-check', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', 'about:blank'], {stdio: 'ignore'});
const wait = ms => new Promise(r => setTimeout(r, ms));
try {
  let target;
  for (let i = 0; i < 50 && !target; ++i) { await wait(200); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch {} }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, {once: true}));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { const k = ++id; pending.set(k, r); ws.send(JSON.stringify({id: k, method, params})); });
  const evaluate = async expr => {
    const m = await send('Runtime.evaluate', {expression: expr, awaitPromise: true, returnByValue: true});
    if (m.result.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400));
    return m.result.result.value;
  };
  await send('Network.enable');
  await send('Network.setCacheDisabled', {cacheDisabled: true});
  let script = null;
  for (const spec of specs) {
    const [name, style, theme, width, height, scale, boxText] = spec.split(':');
    await send('Emulation.setDeviceMetricsOverride', {width: +width, height: +height, deviceScaleFactor: +scale, mobile: false});
    await send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value: theme}]});
    if (script) await send('Page.removeScriptToEvaluateOnNewDocument', {identifier: script});
    script = (await send('Page.addScriptToEvaluateOnNewDocument', {source: `try { localStorage.setItem('peopled-style', ${JSON.stringify(style)}); localStorage.setItem('peopled-theme', ${JSON.stringify(theme)}); } catch (e) {}`})).result.identifier;
    // the style goes in the address too: a stored style alone was not always taken
    await send('Page.navigate', {url: `${SITE}${style === 'realm' ? '?realm-gl' : ''}#world-1${style === 'ink' ? '' : '-' + style}`});
    await wait(800);
    const ready = `document.documentElement.dataset.mapState === 'ready' && !!window.peopledMap && !!peopledMap.world && peopledMap.style === ${JSON.stringify(style)}`;
    for (let i = 0; i < 240 && !(await evaluate(ready).catch(() => false)); ++i) await wait(500);
    await evaluate(`(() => { const s = document.createElement('style'); s.textContent = 'header, #controls, #credit, #dock, #tip, #ux-stamp { display: none !important }'; document.head.append(s); })()`);
    if (boxText) {
      const [x0, y0, x1, y1] = boxText.split(',').map(Number);
      const k = Math.min(+width / (x1 - x0), +height / (y1 - y0));
      const x = +width / 2 - k * (x0 + x1) / 2, y = +height / 2 - k * (y0 + y1) / 2;
      await evaluate(`peopledMap.setView({k: ${k}, x: ${x}, y: ${y}})`);
    }
    await wait(6000);
    for (let i = 0; i < 60 && !(await evaluate(`document.documentElement.dataset.mapState === 'ready'`).catch(() => false)); ++i) await wait(500);
    await wait(3000);
    const s = await send('Page.captureScreenshot', {format: 'webp', quality: 82});
    const out = join(OUT, name + '.webp');
    writeFileSync(out, Buffer.from(s.result.data, 'base64'));
    console.log('saved', out, (s.result.data.length * 0.75 / 1024).toFixed(0) + ' KB');
  }
  ws.close();
} finally {
  chrome.kill();
}
