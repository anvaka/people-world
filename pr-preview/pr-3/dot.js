// A DOT (Graphviz) file as the graph a map is drawn from: its nodes become the countries, its
// links their borders. parseDot reads the language; graphFromDot turns what it read into the
// document buildWorld takes (the shape of countries.json), with a size for every node.
//
// Read: graph and digraph (strict or not), node and edge statements, chains (a -- b -- c),
// groups as edge ends ({a b} -> c), subgraphs, the node/edge/graph defaults of each scope, ids
// that are names, numbers, "quoted" (joined with +) or <html>, ports, and the three kinds of
// comment. Only the first graph of a file is read.

function tokens(text) {
  const out = [];
  const n = text.length;
  let i = 0, line = 1, lineStart = true;
  const fail = what => { throw new Error(`line ${line}: ${what}`); };
  while (i < n) {
    const ch = text[i];
    if (ch === '\n') { line++; i++; lineStart = true; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\ufeff') { i++; continue; }
    // a line that starts with # is what a C preprocessor left behind
    if (ch === '#' && lineStart) { while (i < n && text[i] !== '\n') i++; continue; }
    lineStart = false;
    if (ch === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) fail('a comment is not closed');
      for (let k = i; k < end; ++k) if (text[k] === '\n') line++;
      i = end + 2;
      continue;
    }
    if (ch === '"') {
      let s = '', k = i + 1;
      const from = line;
      for (;; ++k) {
        if (k >= n) { line = from; fail('a quoted string is not closed'); }
        const c = text[k];
        if (c === '"') break;
        if (c === '\n') line++;
        if (c === '\\' && text[k + 1] === '"') { s += '"'; k++; }
        else if (c === '\\' && text[k + 1] === '\n') { k++; line++; }           // a line carried on
        else if (c === '\\' && text[k + 1] === '\r' && text[k + 2] === '\n') { k += 2; line++; }
        else if (c === '\\' && text[k + 1] === '\\') { s += '\\\\'; k++; }       // kept for the label
        else s += c;
      }
      out.push({id: s, quoted: true, line: from});
      i = k + 1;
      continue;
    }
    if (ch === '<') {
      let depth = 0, k = i;
      const from = line;
      for (;; ++k) {
        if (k >= n) { line = from; fail('an <html> label is not closed'); }
        if (text[k] === '\n') line++;
        if (text[k] === '<') depth++;
        else if (text[k] === '>' && --depth === 0) break;
      }
      out.push({id: text.slice(i + 1, k), html: true, line: from});
      i = k + 1;
      continue;
    }
    if (ch === '-' && (text[i + 1] === '-' || text[i + 1] === '>')) { out.push({op: '--', line}); i += 2; continue; }
    const number = /^-?(?:\.\d+|\d+(?:\.\d*)?)/.exec(text.slice(i, i + 64));
    if (number) { out.push({id: number[0], line}); i += number[0].length; continue; }
    if (/[A-Za-z_\u0080-\uffff]/.test(ch)) {
      let k = i + 1;
      while (k < n && /[A-Za-z0-9_\u0080-\uffff]/.test(text[k])) k++;
      out.push({id: text.slice(i, k), line});
      i = k;
      continue;
    }
    if ('{}[];,=:+'.includes(ch)) { out.push({op: ch, line}); i++; continue; }
    fail(`unexpected "${ch}"`);
  }
  return out;
}

// → {name, directed, attrs, nodes: [{id, attrs, group}], edges: [{a, b, attrs}]}, the nodes in the
// order the file names them. A node's group is the cluster it is first put in: {id, label}.
export function parseDot(text) {
  const toks = tokens(String(text));
  let p = 0;
  const here = () => toks[p] || {end: true, line: toks.length ? toks[toks.length - 1].line : 1};
  const fail = what => {
    const t = here();
    throw new Error(`line ${t.line}: ${what}${t.end ? ', but the file ends' : `, not "${t.op || t.id}"`}`);
  };
  const isOp = op => here().op === op;
  const take = op => { if (!isOp(op)) fail(`expected "${op === '--' ? '-- or ->' : op}"`); p++; };
  const isWord = word => { const t = here(); return t.id !== undefined && !t.quoted && !t.html && t.id.toLowerCase() === word; };
  const id = () => {
    const t = here();
    if (t.id === undefined) fail('expected a name');
    p++;
    let s = t.id;
    // "one" + "two"
    while (t.quoted && isOp('+') && toks[p + 1] && toks[p + 1].quoted) { s += toks[p + 1].id; p += 2; }
    return t.html ? {html: s} : s;
  };
  const text1 = v => typeof v === 'string' ? v : v.html;

  if (isWord('strict')) p++;
  const directed = isWord('digraph');
  if (!directed && !isWord('graph')) fail('expected "graph" or "digraph"');
  p++;
  const name = isOp('{') ? '' : text1(id());
  take('{');

  const nodes = new Map(), edges = [];
  const attrList = into => {
    while (isOp('[')) {
      p++;
      while (!isOp(']')) {
        const key = text1(id());
        take('=');
        into[key] = id();
        if (isOp(';') || isOp(',')) p++;
      }
      p++;
    }
    return into;
  };
  const touch = (name, scope) => {
    let node = nodes.get(name);
    if (!node) { node = {id: name, attrs: {...scope.node}, group: null}; nodes.set(name, node); }
    if (!node.group && scope.group) node.group = scope.group;
    scope.members.add(name);
    return node;
  };
  // one end of a link: a node (its port skipped) or a subgraph; → the ids it stands for
  const end = scope => {
    if (isOp('{') || isWord('subgraph')) return [...subgraph(scope)];
    const name = text1(id());
    for (let k = 0; k < 2 && isOp(':'); ++k) { p++; id(); }
    touch(name, scope);
    return [name];
  };
  function subgraph(parent) {
    let name = '';
    if (isWord('subgraph')) { p++; if (!isOp('{')) name = text1(id()); }
    take('{');
    const scope = {node: {...parent.node}, edge: {...parent.edge}, attrs: {}, members: new Set(),
      group: /^cluster/.test(name) ? {id: name, label: ''} : parent.group};
    statements(scope);
    take('}');
    if (scope.group !== parent.group) {
      const label = scope.attrs.label;
      scope.group.label = label !== undefined ? labelText(label, name) : name.replace(/^cluster_?/, '') || name;
    }
    scope.members.forEach(m => parent.members.add(m));
    return scope.members;
  }
  function statements(scope) {
    while (!isOp('}')) {
      if (here().end) fail('expected "}"');
      if (isOp(';')) { p++; continue; }
      const next = toks[p + 1] || {};
      if ((isWord('graph') || isWord('node') || isWord('edge')) && next.op === '[') {
        const kind = here().id.toLowerCase();
        p++;
        attrList(kind === 'graph' ? scope.attrs : scope[kind]);
        continue;
      }
      if (here().id !== undefined && next.op === '=' && !isWord('subgraph')) {   // an attribute of the graph
        const key = text1(id());
        p++;
        scope.attrs[key] = id();
        continue;
      }
      const single = !(isOp('{') || isWord('subgraph'));
      const ends = [end(scope)];
      while (isOp('--')) { p++; ends.push(end(scope)); }
      if (ends.length === 1) {
        if (single) attrList(nodes.get(ends[0][0]).attrs);
        continue;
      }
      const attrs = attrList({...scope.edge});
      for (let k = 0; k + 1 < ends.length; ++k) for (const a of ends[k]) for (const b of ends[k + 1]) edges.push({a, b, attrs});
    }
  }
  const root = {node: {}, edge: {}, attrs: {}, members: new Set(), group: null};
  statements(root);
  take('}');
  return {name, directed, attrs: root.attrs, nodes: [...nodes.values()], edges};
}

// A label as plain words: the escapes of a quoted one, the tags of an <html> one
function labelText(value, nodeId) {
  let s;
  if (typeof value === 'string') s = value.replace(/\\[NG]/g, nodeId).replace(/\\[nlr]/g, ' ').replace(/\\(.)/g, '$1');
  else s = value.html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|nbsp|#\d+);/g, (m, e) => e[0] === '#' ? String.fromCodePoint(+e.slice(1)) : {amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' '}[e]);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 60 ? s.slice(0, 59).trimEnd() + '…' : s;
}

const number = v => { const x = typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(x) ? x : NaN; };

// The attributes that say how large a node is, the most telling first. One counts when most nodes
// carry it as a positive number and it tells them apart.
const SIZE_ATTRIBUTES = ['population', 'size', 'weight', 'value', 'count', 'area'];
function sizesFromAttributes(nodes) {
  const usable = values => {
    const have = values.filter(v => v > 0);
    return have.length * 2 >= values.length && Math.min(...have) < Math.max(...have);
  };
  for (const key of SIZE_ATTRIBUTES) {
    const values = nodes.map(nd => number(nd.attrs[key]));
    if (usable(values)) return {measure: key, values};
  }
  // Graphviz's own: width and height in inches. A file that went through a layout has them on
  // every node, set from the length of the label, which says nothing: those have a pos as well.
  if (!nodes.some(nd => nd.attrs.pos !== undefined)) {
    const values = nodes.map(nd => {
      const w = number(nd.attrs.width), h = number(nd.attrs.height);
      return w > 0 && h > 0 ? w * h : w > 0 ? w * w : h > 0 ? h * h : NaN;
    });
    if (usable(values)) return {measure: 'width × height', values};
  }
  return null;
}

// PageRank with the links read both ways (a border has no direction): a node is as central as the
// nodes it is linked to. Links carry their weight; a node with none shares its rank with all.
export function pageRank(n, links, weights, damping = 0.85, rounds = 100) {
  const total = new Float64Array(n);
  for (let k = 0; k < weights.length; ++k) { total[links[2 * k]] += weights[k]; total[links[2 * k + 1]] += weights[k]; }
  let rank = new Float64Array(n).fill(1 / n), next = new Float64Array(n);
  for (let round = 0; round < rounds; ++round) {
    let loose = 0;
    for (let i = 0; i < n; ++i) if (!(total[i] > 0)) loose += rank[i];
    next.fill((1 - damping) / n + damping * loose / n);
    for (let k = 0; k < weights.length; ++k) {
      const a = links[2 * k], b = links[2 * k + 1], w = weights[k];
      next[b] += damping * rank[a] * w / total[a];
      next[a] += damping * rank[b] * w / total[b];
    }
    let moved = 0;
    for (let i = 0; i < n; ++i) moved += Math.abs(next[i] - rank[i]);
    [rank, next] = [next, rank];
    if (moved < 1e-10) break;
  }
  return rank;
}

// Two capital letters for the first 676 nodes (AA, AB, …), three after: what a map's address
// names its countries by
const codeOf = i => { let s = ''; do { s = String.fromCharCode(65 + i % 26) + s; i = Math.floor(i / 26); } while (i > 0); return s.padStart(2, 'A'); };

// The map is as large as the world's: its land is this many "people", whatever the file counts in
export const LAND = 8e9;
export const MAX_NODES = 500;
// How buildWorld is asked to draw such a graph. The countries are nearly flat (a few links in
// hundreds can't be borders); a graph from a file may be far from it. So: a few seconds, not a
// minute, for choosing which links become exclaves; a longer first annealing, which evens out the
// areas of countries the layout left crowded; and a link that finds no room even as an exclave
// is left out (the map's check then counts it as missing), where the countries would give up.
export const BUILD = {planarBudget: 4000, sweeps: 100, lenient: true};

// DOT text → the document buildWorld draws: nodes as [code, label, id in the file, group, size on
// the map, size in the file], links as index pairs (each pair once, no loops), and
//   measure: what the sizes are ('PageRank', or the name of the attribute they were read from),
//   title, about: the graph's name and a line on what was read,
//   build: the options buildWorld draws it with (BUILD).
export function graphFromDot(text, fileName = '') {
  const g = parseDot(text);
  const n = g.nodes.length;
  if (!n) throw new Error('the file names no nodes');
  if (n > MAX_NODES) throw new Error(`the file has ${n.toLocaleString('en-US')} nodes, and a map of more than ${MAX_NODES} takes too long to draw`);
  const index = new Map(g.nodes.map((nd, i) => [nd.id, i]));
  const pairs = new Map();
  for (const e of g.edges) {
    const a = index.get(e.a), b = index.get(e.b);
    if (a === b) continue;
    const key = a < b ? a * n + b : b * n + a, w = number(e.attrs.weight);
    pairs.set(key, (pairs.get(key) || 0) + (w > 0 ? w : 1));
  }
  if (!pairs.size) throw new Error('the file links no two nodes, so there are no borders to draw');
  const links = [], weights = [];
  pairs.forEach((w, key) => { links.push(Math.floor(key / n), key % n); weights.push(w); });

  let sizes = sizesFromAttributes(g.nodes);
  if (!sizes) sizes = {measure: 'PageRank', values: Array.from(pageRank(n, links, weights))};
  // a node without a size of its own is as small as the smallest
  const least = Math.min(...sizes.values.filter(v => v > 0));
  const values = sizes.values.map(v => v > 0 ? v : least);
  const sum = values.reduce((s, v) => s + v, 0);

  // names: the labels, and where two nodes carry the same one, their ids with it (the map finds
  // countries by name)
  const names = g.nodes.map(nd => (nd.attrs.label !== undefined && labelText(nd.attrs.label, nd.id)) || labelText(nd.id, nd.id) || nd.id);
  const times = new Map();
  names.forEach(name => times.set(name, (times.get(name) || 0) + 1));
  const taken = new Set(names.filter(name => times.get(name) === 1));
  names.forEach((name, i) => {
    if (times.get(name) === 1) return;
    let own = `${name} (${labelText(g.nodes[i].id, '') || i + 1})`;
    for (let k = 2; taken.has(own); ++k) own = `${name} (${k})`;
    taken.add(own);
    names[i] = own;
  });
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.(dot|gv|txt)$/i, '');
  const title = labelText(g.attrs.label !== undefined ? g.attrs.label : '', g.name) || labelText(g.name, '') || base || 'A graph';
  return {
    title,
    about: `${n.toLocaleString('en-US')} nodes and ${(links.length / 2).toLocaleString('en-US')} links` + (fileName ? ` from ${fileName}` : ''),
    fields: ['code', 'label', 'id', 'group', 'size on the map', sizes.measure],
    nodes: g.nodes.map((nd, i) => [codeOf(i), names[i], nd.id, nd.group ? nd.group.label : labelText(typeof nd.attrs.group === 'string' ? nd.attrs.group : '', ''),
      Math.max(1, Math.round(values[i] / sum * LAND)), values[i]]),
    links,
    measure: sizes.measure,
    directed: g.directed,
    build: BUILD,
  };
}
