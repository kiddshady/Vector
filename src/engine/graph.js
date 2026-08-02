'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   VECTOR — el grafo
   Validación y topología. Todo lo que se puede detectar leyendo el pipeline se
   detecta ACÁ, antes de gastar un token: un ciclo, una arista rota, un agente
   que no existe, una condición mal escrita, una plantilla que apunta a un paso
   que corre después.

   Un orquestador que descubre estos errores en el paso 6 ya te cobró los cinco
   anteriores.
   ═══════════════════════════════════════════════════════════════════════════ */

const template = require('./template');
const expr = require('./expr');

const KINDS = ['input', 'agent', 'branch', 'fanout', 'approval', 'output'];

/** Forma con la que la UI dibuja cada tipo de nodo. */
const SHAPE = {
  input: 'square',
  output: 'square',
  agent: 'circle',
  branch: 'diamond',
  approval: 'diamond',   // también es una bifurcación; la decide una persona
  fanout: 'hex',
};

/** Tipos cuya salida depende de una rama verdadera/falsa. */
const BRANCHING = ['branch', 'approval'];

function index(pipeline) {
  const nodes = new Map();
  for (const n of pipeline.nodes || []) nodes.set(n.id, n);

  const incoming = new Map();
  const outgoing = new Map();
  for (const n of nodes.keys()) { incoming.set(n, []); outgoing.set(n, []); }

  for (const e of pipeline.edges || []) {
    if (outgoing.has(e.from)) outgoing.get(e.from).push(e);
    if (incoming.has(e.to)) incoming.get(e.to).push(e);
  }
  return { nodes, incoming, outgoing };
}

/** Detecta ciclos con DFS de tres colores; devuelve el ciclo si lo encuentra. */
function findCycle(pipeline) {
  const { nodes, outgoing } = index(pipeline);
  const color = new Map();   // 0 sin visitar · 1 en la pila · 2 terminado
  const stack = [];

  function visit(id) {
    color.set(id, 1);
    stack.push(id);
    for (const e of outgoing.get(id) || []) {
      const c = color.get(e.to) || 0;
      if (c === 1) return [...stack.slice(stack.indexOf(e.to)), e.to];
      if (c === 0) {
        const found = visit(e.to);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  }

  for (const id of nodes.keys()) {
    if ((color.get(id) || 0) === 0) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

/** Orden topológico (Kahn). Solo tiene sentido si no hay ciclos. */
function topoOrder(pipeline) {
  const { nodes, incoming, outgoing } = index(pipeline);
  const deg = new Map([...nodes.keys()].map((id) => [id, (incoming.get(id) || []).length]));
  const queue = [...deg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  const order = [];

  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const e of outgoing.get(id) || []) {
      const d = deg.get(e.to) - 1;
      deg.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }
  return order;
}

/** Todos los nodos que corren ANTES que `id` (para validar plantillas). */
function ancestors(pipeline, id) {
  const { incoming } = index(pipeline);
  const seen = new Set();
  const stack = [...(incoming.get(id) || []).map((e) => e.from)];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const e of incoming.get(cur) || []) stack.push(e.from);
  }
  return seen;
}

/**
 * Chequeo completo. `errors` impide correr; `warnings` no.
 * @param {object} pipeline
 * @param {Array}  agents  catálogo de agentes disponibles
 */
function validate(pipeline, agents = []) {
  const errors = [];
  const warnings = [];
  const agentIds = new Set(agents.map((a) => a.id));

  if (!pipeline || typeof pipeline !== 'object') return { ok: false, errors: ['El pipeline está vacío.'], warnings };
  if (!Array.isArray(pipeline.nodes) || !pipeline.nodes.length) {
    return { ok: false, errors: ['El pipeline no tiene ningún paso.'], warnings };
  }

  const { nodes, incoming, outgoing } = index(pipeline);

  // Ids: únicos y presentes.
  const seen = new Set();
  for (const n of pipeline.nodes) {
    if (!n.id) { errors.push('Hay un paso sin id.'); continue; }
    if (seen.has(n.id)) errors.push(`Id de paso repetido: "${n.id}".`);
    seen.add(n.id);
    if (!KINDS.includes(n.kind)) {
      errors.push(`El paso "${n.id}" tiene un tipo desconocido: "${n.kind}". Válidos: ${KINDS.join(', ')}.`);
    }
  }

  // Aristas: extremos existentes.
  for (const e of pipeline.edges || []) {
    if (!nodes.has(e.from)) errors.push(`Una arista sale de un paso inexistente: "${e.from}".`);
    if (!nodes.has(e.to)) errors.push(`Una arista entra a un paso inexistente: "${e.to}".`);
  }

  // Ciclos.
  const cycle = findCycle(pipeline);
  if (cycle) errors.push(`El grafo tiene un ciclo: ${cycle.join(' → ')}.`);

  // Raíces y alcanzabilidad.
  const roots = [...nodes.keys()].filter((id) => (incoming.get(id) || []).length === 0);
  if (!roots.length && !cycle) errors.push('Ningún paso puede arrancar: todos tienen dependencias.');

  if (!cycle) {
    const reachable = new Set(roots);
    const stack = [...roots];
    while (stack.length) {
      for (const e of outgoing.get(stack.pop()) || []) {
        if (!reachable.has(e.to)) { reachable.add(e.to); stack.push(e.to); }
      }
    }
    for (const id of nodes.keys()) {
      if (!reachable.has(id)) warnings.push(`El paso "${id}" no es alcanzable desde ninguna raíz: nunca va a correr.`);
    }
  }

  // Reglas por tipo de nodo.
  for (const n of pipeline.nodes) {
    if (!n.id) continue;

    if (n.kind === 'agent' || n.kind === 'fanout') {
      if (!n.agent) errors.push(`El paso "${n.id}" no tiene agente asignado.`);
      else if (!agentIds.has(n.agent)) errors.push(`El paso "${n.id}" usa el agente "${n.agent}", que no existe.`);
      if (!n.prompt) errors.push(`El paso "${n.id}" no tiene prompt.`);
    }

    if (n.kind === 'fanout' && !n.over) {
      errors.push(`El fan-out "${n.id}" no dice sobre qué iterar (falta "over").`);
    }

    if (n.kind === 'branch') {
      if (!n.when) errors.push(`La condición "${n.id}" no tiene expresión ("when").`);
      else {
        const chk = expr.check(n.when);
        if (!chk.ok) errors.push(`La condición "${n.id}" no se entiende — ${chk.error}`);
      }
    }

    if (BRANCHING.includes(n.kind)) {
      const labels = (outgoing.get(n.id) || []).map((e) => String(e.branch));
      // `allowDeadEnd` es para las compuertas que terminan el flujo a propósito
      // (un control de calidad que, si no pasa, simplemente no publica nada).
      // Sin la opción, el aviso saldría en cada corrida y se volvería ruido.
      if (!labels.includes('true') && !n.allowDeadEnd) {
        warnings.push(`La condición "${n.id}" no tiene salida para el caso verdadero.`);
      }
      if (!labels.includes('false') && !n.allowDeadEnd) {
        warnings.push(`La condición "${n.id}" no tiene salida para el caso falso: si da falso, el flujo se corta ahí.`);
      }
    }

    if (n.kind === 'output' && !n.from) {
      warnings.push(`La salida "${n.id}" no dice qué recolectar (falta "from").`);
    }

    // Plantillas: que no referencien un paso que corre después (o inexistente).
    const before = cycle ? null : ancestors(pipeline, n.id);
    for (const field of ['prompt', 'system', 'over', 'from', 'question', 'preview']) {
      if (typeof n[field] !== 'string') continue;
      for (const ref of template.refs(n[field])) {
        const m = /^steps\.([^.]+)/.exec(ref);
        if (!m) continue;
        const target = m[1];
        if (!nodes.has(target)) {
          errors.push(`El paso "${n.id}" usa {{${ref}}}, pero "${target}" no existe.`);
        } else if (before && !before.has(target)) {
          errors.push(`El paso "${n.id}" usa {{${ref}}}, pero "${target}" no corre antes que él.`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { KINDS, SHAPE, BRANCHING, index, validate, findCycle, topoOrder, ancestors };
