/* ═══════════════════════════════════════════════════════════════════════════
   VECTOR — estado del renderer
   Espejo local de lo que vive en el proceso principal, más el bus de eventos
   de las corridas.

   Una corrida activa se sigue por EVENTOS, no por polling: el motor avisa
   cuando pasa algo. Igual guardamos una foto (`live`) de cada corrida en curso,
   porque una vista recién montada necesita saber en qué estado están los pasos
   sin esperar al próximo evento.
   ═══════════════════════════════════════════════════════════════════════════ */

const api = window.vector;

export const S = {
  pipelines: [],
  agents: [],
  runs: [],            // resúmenes del índice, más nuevo primero
  settings: null,
  catalog: [],         // proveedores disponibles
  tools: [],           // herramientas que puede usar un agente
  encryption: false,
  dataDir: '',
  workspace: '',
  /** runId → { pipelineId, state, paused, steps: { nodeId → {...} }, branch: {} } */
  live: new Map(),
  ready: false,
};

const listeners = new Set();

/** Suscripción al stream del motor. Devuelve el des-suscriptor. */
export function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(ev) {
  // Snapshot antes de recorrer: un Set de JS SÍ visita lo que se agrega durante
  // la iteración, así que un suscriptor que se resuscribe al reaccionar (una
  // vista que se repinta) se llamaría a sí mismo para siempre con este evento.
  for (const fn of [...listeners]) {
    try { fn(ev); } catch (err) { console.error('[store] un suscriptor explotó:', err); }
  }
}

/** Mantiene la foto local al día para que una vista nueva no arranque a ciegas. */
function applyToLive(ev) {
  if (ev.type === 'run:start') {
    S.live.set(ev.runId, {
      runId: ev.runId, pipelineId: ev.pipelineId, pipelineName: ev.pipelineName,
      state: 'running', paused: false, startedAt: ev.at,
      stepsTotal: ev.stepsTotal, steps: {}, branch: {},
      totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    });
    return;
  }

  const live = S.live.get(ev.runId);
  if (!live) return;

  const step = (id) => (live.steps[id] ||= { state: 'pending' });

  switch (ev.type) {
    case 'step:start':   step(ev.nodeId).state = 'running'; step(ev.nodeId).startedAt = ev.at; break;
    case 'step:token':   step(ev.nodeId).len = ev.len; break;
    case 'step:progress':step(ev.nodeId).progress = { done: ev.done, total: ev.total }; break;
    case 'step:skip':    step(ev.nodeId).state = 'skipped'; break;
    case 'step:waiting':
      Object.assign(step(ev.nodeId), { state: 'waiting', question: ev.question, preview: ev.preview });
      live.waiting = [...(live.waiting || []).filter((w) => w.nodeId !== ev.nodeId),
        { nodeId: ev.nodeId, title: ev.title, question: ev.question, preview: ev.preview }];
      break;
    case 'step:approved':
      live.waiting = (live.waiting || []).filter((w) => w.nodeId !== ev.nodeId);
      live.branch[ev.nodeId] = !!ev.approved;
      break;
    case 'step:tool':
      if (ev.phase === 'start') step(ev.nodeId).tool = ev.tool;
      else step(ev.nodeId).tool = null;
      break;
    case 'step:done':
      Object.assign(step(ev.nodeId), { state: 'done', durMs: ev.durMs, tokens: ev.tokens, output: ev.output });
      // La salida de un rombo ES su resultado: sirve para saber qué arista quedó viva.
      if (ev.output === 'true' || ev.output === 'false') live.branch[ev.nodeId] = ev.output === 'true';
      break;
    case 'step:fail':
      if (!ev.willRetry) Object.assign(step(ev.nodeId), { state: 'failed', error: ev.error });
      else step(ev.nodeId).retrying = ev.attempt;
      break;
    case 'run:paused':   live.paused = true; break;
    case 'run:resumed':  live.paused = false; break;
    case 'run:done':
      live.state = ev.state;
      live.totals = ev.totals || live.totals;
      live.durMs = ev.durMs;
      // Se saca de las vivas después de que las vistas hayan podido reaccionar.
      setTimeout(() => S.live.delete(ev.runId), 1500);
      // El índice del disco se relee y recién ahí se avisa: si emitiéramos
      // antes, los contadores mostrarían el historial sin la corrida que
      // acaba de terminar.
      refreshRuns().then(() => emit({ type: 'runs:refreshed', runId: ev.runId })).catch(() => {});
      break;
  }
}

/* ── Carga ───────────────────────────────────────────────────────────────── */

export async function boot() {
  const data = await api.bootstrap();
  S.pipelines = data.pipelines;
  S.agents = data.agents;
  S.runs = data.runs;
  S.settings = data.settings;
  S.catalog = data.catalog;
  S.tools = data.tools || [];
  S.encryption = data.encryption;
  S.dataDir = data.dataDir;
  S.workspace = data.workspace || '';
  S.ready = true;

  api.runs.onEvent((ev) => { applyToLive(ev); emit(ev); });

  // Si quedó una corrida en curso de antes de recargar la ventana, la
  // reenganchamos: el motor vive en el proceso principal, no acá.
  const activos = await api.runs.active();
  for (const a of activos) {
    if (S.live.has(a.id)) continue;
    const full = await api.runs.get(a.id).catch(() => null);
    if (!full) continue;
    S.live.set(a.id, {
      runId: a.id, pipelineId: a.pipelineId, pipelineName: a.pipelineName,
      state: full.state, paused: a.paused, startedAt: full.startedAt,
      stepsTotal: full.stepsTotal, steps: full.steps, branch: full.branchResult || {},
      totals: full.totals, waiting: a.waiting || [],
    });
  }
  return S;
}

export async function refreshRuns() {
  S.runs = await api.runs.list(60);
  return S.runs;
}

export async function refreshPipelines() {
  S.pipelines = await api.pipelines.list();
  return S.pipelines;
}

export async function refreshSettings() {
  const data = await api.settings.get();
  S.settings = data.settings;
  S.catalog = data.catalog;
  S.encryption = data.encryption;
  return data;
}

/* ── Consultas derivadas ─────────────────────────────────────────────────── */

export const pipeline = (id) => S.pipelines.find((p) => p.id === id) || null;
export const agent = (id) => S.agents.find((a) => a.id === id) || null;

/** La corrida viva de un pipeline, si la hay. */
export function liveRunOf(pipelineId) {
  for (const live of S.live.values()) {
    if (live.pipelineId === pipelineId && ['running', 'idle'].includes(live.state)) return live;
  }
  return null;
}

/** La última corrida registrada de un pipeline (viva o no). */
export function lastRunOf(pipelineId) {
  const live = liveRunOf(pipelineId);
  if (live) return { id: live.runId, state: 'running', startedAt: live.startedAt, live: true };
  return S.runs.find((r) => r.pipelineId === pipelineId) || null;
}

/** Métricas del día para la statusbar. */
export function todayTotals() {
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const today = S.runs.filter((r) => Number(r.startedAt) >= since.getTime());
  return {
    runs: today.length,
    tokens: today.reduce((n, r) => n + (r.tokensIn || 0) + (r.tokensOut || 0), 0),
    costUsd: today.reduce((n, r) => n + (r.costUsd || 0), 0),
    active: [...S.live.values()].filter((l) => l.state === 'running').length,
    ok: today.length ? Math.round((today.filter((r) => r.state === 'done').length / today.length) * 100) : 100,
  };
}

/** ¿Hay algún proveedor real configurado, o solo el mock? */
export function hasRealProvider() {
  return Object.entries(S.settings?.providers || {})
    .some(([id, p]) => id !== 'mock' && p.key?.set);
}

export { api };
