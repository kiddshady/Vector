/* ═══════════════════════════════════════════════════════════════════════════
   VECTOR — utilidades del grafo (lado editor)
   Funciones puras: no tocan el DOM ni el disco. El motor tiene su propia copia
   de la validación en `src/engine/graph.js` porque es quien manda; esto es lo
   que el editor necesita para no dejarte armar algo imposible.
   ═══════════════════════════════════════════════════════════════════════════ */

export const NODE_W = 190;
export const COL = 296;    // ancho de nodo + 106 px de aire para que la bezier respire
export const ROW = 190;
export const ORIGIN_X = 40;
export const CENTER_Y = 420;

export const KIND_LABEL = {
  input: 'Entrada',
  agent: 'Agente',
  branch: 'Condición',
  fanout: 'Fan-out',
  approval: 'Aprobación',
  output: 'Salida',
};

export const KIND_ICON = {
  input: 'download',
  agent: 'agents',
  branch: 'branch',
  fanout: 'layers',
  approval: 'lock',
  output: 'save',
};

/** Tipos que bifurcan: sus aristas de salida llevan rama verdadera o falsa. */
export const BRANCHING = ['branch', 'approval'];

/* Marcas diacríticas (U+0300–U+036F). Se construye desde escapes en vez de
   escribir el rango literal: esos caracteres son invisibles en el fuente y
   cualquier copiar y pegar los corrompe sin que se note. */
const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');

/** Ids seguros para nombre de archivo y para referenciar en plantillas. */
export function slugify(text, fallback = 'sin-nombre') {
  const out = String(text || '')
    .normalize('NFD').replace(DIACRITICS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return out || fallback;
}

/** Un id libre dentro de una colección: "triage", "triage-2", "triage-3"… */
export function uniqueId(base, taken) {
  const seed = slugify(base, 'paso');
  if (!taken.includes(seed)) return seed;
  let n = 2;
  while (taken.includes(`${seed}-${n}`)) n++;
  return `${seed}-${n}`;
}

/* ── Ciclos ──────────────────────────────────────────────────────────────── */

/** ¿Agregar `from → to` cerraría un ciclo? (¿`from` ya es alcanzable desde `to`?) */
export function wouldCycle(edges, from, to) {
  if (from === to) return true;
  const out = new Map();
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push(e.to);
  }
  const seen = new Set([to]);
  const stack = [to];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === from) return true;
    for (const next of out.get(cur) || []) {
      if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
  }
  return false;
}

/* ── Fábrica de nodos ────────────────────────────────────────────────────── */

const DEFAULTS = {
  input: { title: 'Entrada' },
  agent: { title: 'Paso de agente', prompt: '' },
  branch: { title: 'Condición', when: '' },
  fanout: { title: 'Fan-out', over: '', prompt: '', concurrency: 3, itemErrors: 'skip' },
  output: { title: 'Salida', from: '' },
};

export function makeNode(kind, { id, x = 0, y = 0, taken = [] } = {}) {
  return {
    id: id || uniqueId(KIND_LABEL[kind] || kind, taken),
    kind,
    x: Math.round(x),
    y: Math.round(y),
    ...structuredClone(DEFAULTS[kind] || {}),
  };
}

/** Un pipeline nuevo: una entrada y una salida ya conectadas. Nunca un lienzo vacío. */
export function makePipeline(name) {
  const id = slugify(name, 'pipeline');
  return {
    id,
    name: name || 'Pipeline nuevo',
    desc: '',
    version: 1,
    retries: 0,
    input: { query: '' },
    nodes: [
      { ...makeNode('input', { id: 'entrada' }), x: ORIGIN_X, y: CENTER_Y, title: 'Entrada' },
      { ...makeNode('output', { id: 'salida' }), x: ORIGIN_X + COL, y: CENTER_Y, title: 'Salida', from: '{{input.query}}' },
    ],
    edges: [{ from: 'entrada', to: 'salida' }],
    groups: [],
  };
}

/* ── Renombrar un paso ───────────────────────────────────────────────────────
   El id de un paso no es una etiqueta: es cómo lo nombran las plantillas y las
   condiciones de todos los demás. Renombrarlo sin reescribir esas referencias
   deja el pipeline roto en silencio, así que las dos cosas van juntas o ninguna.
   ─────────────────────────────────────────────────────────────────────────── */

/** Campos de un nodo donde puede aparecer una referencia a otro paso. */
const REF_FIELDS = ['prompt', 'system', 'over', 'from', 'when'];

/**
 * El límite tiene que ser estricto: `\b` después de "triage" daría verdadero
 * dentro de "triage-2", porque el guion no es carácter de palabra. Con
 * `(?![\w-])` solo matchea el id completo.
 */
function refPattern(id) {
  return new RegExp(`steps\\.${id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?![\\w-])`, 'g');
}

export function renameNode(pipeline, oldId, newId) {
  if (oldId === newId) return { ok: true, rewrites: 0 };
  const clean = slugify(newId, '');
  if (!clean) return { ok: false, error: 'El identificador no puede quedar vacío.' };
  if (clean !== newId) return { ok: false, error: `Solo minúsculas, números y guiones. Quedaría "${clean}".` };
  if ((pipeline.nodes || []).some((n) => n.id === newId)) {
    return { ok: false, error: `Ya hay un paso con el identificador "${newId}".` };
  }

  const node = (pipeline.nodes || []).find((n) => n.id === oldId);
  if (!node) return { ok: false, error: `No existe el paso "${oldId}".` };

  let rewrites = 0;
  const pattern = refPattern(oldId);

  for (const n of pipeline.nodes) {
    for (const f of REF_FIELDS) {
      if (typeof n[f] !== 'string') continue;
      const next = n[f].replace(pattern, () => { rewrites++; return `steps.${newId}`; });
      if (next !== n[f]) n[f] = next;
    }
  }
  for (const e of pipeline.edges || []) {
    if (e.from === oldId) { e.from = newId; rewrites++; }
    if (e.to === oldId) { e.to = newId; rewrites++; }
  }
  for (const g of pipeline.groups || []) {
    if (!Array.isArray(g.nodes)) continue;
    g.nodes = g.nodes.map((id) => (id === oldId ? newId : id));
  }

  node.id = newId;
  return { ok: true, rewrites };
}

/* ── Grupos ──────────────────────────────────────────────────────────────────
   Un marco no guarda coordenadas: guarda a QUIÉNES abraza. El rectángulo se
   calcula del bounding box de sus miembros, así que mover un nodo o reordenar
   el grafo lo reacomoda solo en vez de dejarlo apuntando al vacío.
   ─────────────────────────────────────────────────────────────────────────── */

const GROUP_PAD = { x: 24, top: 34, bottom: 22 };

export function groupBox(pipeline, group) {
  const members = (pipeline.nodes || []).filter((n) => (group.nodes || []).includes(n.id));
  if (!members.length) return null;
  const x1 = Math.min(...members.map((n) => n.x));
  const y1 = Math.min(...members.map((n) => n.y));
  const x2 = Math.max(...members.map((n) => n.x + NODE_W));
  // El alto real del nodo depende de su contenido; 78 es el caso más alto.
  const y2 = Math.max(...members.map((n) => n.y + 78));
  return {
    x: x1 - GROUP_PAD.x,
    y: y1 - GROUP_PAD.top,
    w: x2 - x1 + GROUP_PAD.x * 2,
    h: y2 - y1 + GROUP_PAD.top + GROUP_PAD.bottom,
  };
}

export function makeGroup(pipeline, nodeIds, label = 'Grupo') {
  const taken = (pipeline.groups || []).map((g) => g.id);
  return { id: uniqueId('grupo', taken), label, nodes: [...nodeIds] };
}

/** Migra los grupos viejos (x/y/w/h sueltos) al modelo por miembros. */
export function migrateGroups(pipeline) {
  for (const g of pipeline.groups || []) {
    if (Array.isArray(g.nodes)) continue;
    g.nodes = (pipeline.nodes || [])
      .filter((n) => n.x >= g.x && n.x <= g.x + g.w && n.y >= g.y && n.y <= g.y + g.h)
      .map((n) => n.id);
    delete g.x; delete g.y; delete g.w; delete g.h;
    g.id ||= uniqueId('grupo', (pipeline.groups || []).map((x) => x.id).filter(Boolean));
  }
  return pipeline;
}

/* ── Layout automático ───────────────────────────────────────────────────────
   Sugiyama simplificado: capas por camino más largo (garantiza que todo nodo
   quede a la derecha de sus dependencias) y orden dentro de cada capa por
   baricentro de sus vecinos, que es lo que descruza las aristas.
   ─────────────────────────────────────────────────────────────────────────── */

export function autoLayout(pipeline) {
  const nodes = pipeline.nodes || [];
  const edges = pipeline.edges || [];
  if (!nodes.length) return pipeline;

  const inc = new Map(nodes.map((n) => [n.id, []]));
  const out = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (out.has(e.from)) out.get(e.from).push(e.to);
    if (inc.has(e.to)) inc.get(e.to).push(e.from);
  }

  // Capa = camino más largo desde una raíz. Memoizado con guarda de ciclo, por
  // si el grafo quedó mal: el layout nunca debería colgarse.
  const layer = new Map();
  const visiting = new Set();
  const depth = (id) => {
    if (layer.has(id)) return layer.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = inc.get(id) || [];
    const d = parents.length ? Math.max(...parents.map(depth)) + 1 : 0;
    visiting.delete(id);
    layer.set(id, d);
    return d;
  };
  nodes.forEach((n) => depth(n.id));

  const columns = [];
  for (const n of nodes) {
    const d = layer.get(n.id) || 0;
    (columns[d] ||= []).push(n.id);
  }

  // Baricentro: cada nodo se acomoda a la altura promedio de sus vecinos ya
  // ubicados. Dos pasadas hacia adelante y una hacia atrás alcanzan de sobra.
  const pos = new Map();
  columns.forEach((col) => col.forEach((id, i) => pos.set(id, i)));

  const sweep = (dir) => {
    const order = dir > 0 ? columns : [...columns].reverse();
    for (const col of order) {
      const neighborsOf = (id) => (dir > 0 ? inc.get(id) : out.get(id)) || [];
      const scored = col.map((id) => {
        const ns = neighborsOf(id).filter((n) => pos.has(n));
        const bary = ns.length ? ns.reduce((a, n) => a + pos.get(n), 0) / ns.length : pos.get(id);
        return { id, bary };
      });
      scored.sort((a, b) => a.bary - b.bary);
      scored.forEach((s, i) => pos.set(s.id, i));
      col.sort((a, b) => pos.get(a) - pos.get(b));
    }
  };
  sweep(1); sweep(-1); sweep(1);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  let maxRows = 1;
  columns.forEach((col, c) => {
    maxRows = Math.max(maxRows, col.length);
    const top = CENTER_Y - ((col.length - 1) * ROW) / 2;
    col.forEach((id, i) => {
      const n = byId.get(id);
      n.x = ORIGIN_X + c * COL;
      n.y = Math.round(top + i * ROW);
    });
  });

  pipeline.stage = {
    w: Math.max(900, ORIGIN_X * 2 + columns.length * COL + NODE_W),
    h: Math.max(800, CENTER_Y + (maxRows * ROW) / 2 + 220),
  };
  // Los grupos sobreviven: su rectángulo sale de dónde quedaron sus miembros.
  return pipeline;
}

/** Un hueco libre cerca de un punto, para que un nodo nuevo no caiga encima de otro. */
export function freeSpot(nodes, x, y) {
  const collides = (px, py) => nodes.some((n) => Math.abs(n.x - px) < NODE_W + 24 && Math.abs(n.y - py) < 110);
  let px = Math.round(x);
  let py = Math.round(y);
  let guard = 0;
  while (collides(px, py) && guard++ < 40) py += 120;
  return { x: px, y: py };
}

/* ── Referencias disponibles para las plantillas ─────────────────────────── */

/** Los pasos que corren ANTES que `id`: lo único que su prompt puede referenciar. */
export function ancestorsOf(pipeline, id) {
  const inc = new Map((pipeline.nodes || []).map((n) => [n.id, []]));
  for (const e of pipeline.edges || []) if (inc.has(e.to)) inc.get(e.to).push(e.from);

  const seen = new Set();
  const stack = [...(inc.get(id) || [])];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const p of inc.get(cur) || []) stack.push(p);
  }
  return seen;
}

/** Chips que el editor ofrece insertar en un prompt. */
export function availableRefs(pipeline, nodeId, { inFanout = false } = {}) {
  const refs = [];
  for (const k of Object.keys(pipeline.input || {})) refs.push(`input.${k}`);
  if (inFanout) refs.push('item', 'index');
  for (const anc of ancestorsOf(pipeline, nodeId)) {
    const node = (pipeline.nodes || []).find((n) => n.id === anc);
    if (!node || node.kind === 'branch') continue;      // un rombo solo da true/false
    refs.push(`steps.${anc}.output`);
    if (node.kind === 'fanout') refs.push(`steps.${anc}.items`);
  }
  return refs;
}
