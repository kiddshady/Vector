'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   VECTOR — puente IPC
   Todo lo que el renderer puede pedirle al proceso principal. La superficie es
   chica y explícita a propósito: el renderer no toca el disco, no sale a la red
   y **nunca ve una clave de API en claro** — de las claves solo recibe si están
   puestas y sus últimos cuatro caracteres.

   Las corridas viven acá, en el proceso principal: si el renderer se recarga o
   se cuelga, la corrida sigue y el grafo se reengancha al volver.
   ═══════════════════════════════════════════════════════════════════════════ */

const { ipcMain, BrowserWindow } = require('electron');
const store = require('./store');
const secrets = require('./secrets');
const providers = require('./providers');
const graph = require('./engine/graph');
const { Run } = require('./engine/scheduler');
const { ensureSeed } = require('./seed');
const toolkit = require('./tools');
const schedules = require('./schedules');

/** runId → Run en curso */
const active = new Map();
/** Guardado con freno: una corrida emite cientos de eventos por segundo. */
const savePending = new Map();
const SAVE_EVERY_MS = 900;

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function scheduleSave(run, { now = false } = {}) {
  if (now) {
    clearTimeout(savePending.get(run.id));
    savePending.delete(run.id);
    return store.saveRun(run.toJSON()).catch((e) => console.error('[ipc] no se pudo guardar la corrida:', e.message));
  }
  if (savePending.has(run.id)) return Promise.resolve();
  savePending.set(run.id, setTimeout(() => {
    savePending.delete(run.id);
    store.saveRun(run.toJSON()).catch((e) => console.error('[ipc] no se pudo guardar la corrida:', e.message));
  }, SAVE_EVERY_MS));
  return Promise.resolve();
}

/** Envuelve un handler para que un error viaje como dato y no como excepción cruda. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      console.error(`[ipc] ${channel}:`, err);
      return { ok: false, error: err.message || String(err) };
    }
  });
}

/** Los ajustes que SÍ puede ver el renderer: las claves salen enmascaradas. */
function publicSettings(cfg) {
  const out = { ...cfg.settings, providers: {} };
  for (const [id, p] of Object.entries(cfg.settings.providers || {})) {
    const meta = providers.meta(id);
    out.providers[id] = {
      baseUrl: p.baseUrl ?? meta?.defaultBaseUrl ?? null,
      key: secrets.check(p.key),         // { set, tail, plain, readable } | null
    };
  }
  return {
    settings: out,
    catalog: Object.values(providers.PROVIDERS).map((p) => ({
      id: p.id, label: p.label, defaultBaseUrl: p.defaultBaseUrl,
      needsKey: p.needsKey, keyHint: p.keyHint, reportsCost: p.reportsCost,
    })),
    encryption: secrets.available(),
  };
}

/**
 * Arranca una corrida. Vive fuera de los handlers porque el programador de
 * horarios también la usa: una corrida disparada por reloj tiene que ser
 * exactamente igual a una disparada por vos.
 */
async function startRun(pipelineId, input, { source = 'user' } = {}) {
  const [pipeline, cfg] = await Promise.all([store.getPipeline(pipelineId), store.loadConfig()]);
  if (!pipeline) throw new Error(`No existe el pipeline "${pipelineId}".`);

  const check = graph.validate(pipeline, cfg.agents || []);
  if (!check.ok) throw new Error(check.errors.join(' · '));

  const id = await store.nextRunId();
  const run = new Run({
    pipeline,
    agents: cfg.agents || [],
    settings: { ...cfg.settings, workspace: store.workspacePath(cfg) },
    // La clave se descifra acá adentro y no sale nunca de este proceso.
    resolveKey: (providerId) => {
      const rec = cfg.settings.providers?.[providerId]?.key;
      if (!rec?.enc) return null;
      const plain = secrets.open(rec);
      // Que el paso falle diciendo QUÉ pasa. "Falta la clave" sobre una clave
      // que está ahí manda a buscar en el lugar equivocado.
      if (!plain) throw new Error(`La clave de ${providerId} está guardada pero ya no se puede descifrar. Volvé a pegarla en Ajustes.`);
      return plain;
    },
    id,
  });
  run.source = source;

  active.set(id, run);
  run.on('event', async (ev) => {
    // El registro final se escribe ANTES de avisar que la corrida terminó.
    // Al revés hay carrera: el renderer relee el índice al recibir `run:done`
    // y se lleva la foto de mitad de corrida, dejando la fila en "corriendo"
    // para siempre aunque en disco figure completa.
    if (ev.type === 'run:done') await scheduleSave(run, { now: true });

    broadcast('run:event', ev);

    if (['step:done', 'step:fail', 'step:skip', 'step:waiting', 'step:approved'].includes(ev.type)) scheduleSave(run);
  });

  // Arranca en segundo plano: el renderer recibe el id enseguida y sigue el
  // avance por eventos en vez de quedarse esperando el final.
  run.start(input || pipeline.input || {})
    .then(() => scheduleSave(run, { now: true }))
    .catch((err) => console.error('[ipc] la corrida explotó:', err))
    .finally(() => { active.delete(id); });

  await store.saveRun(run.toJSON());
  return { runId: id };
}

let stopSchedules = null;

function register() {
  // El reloj arranca con la app y se apaga con ella.
  stopSchedules?.();
  stopSchedules = schedules.start({
    store,
    startRun,
    onFired: (info) => broadcast('schedule:fired', info),
  });

  /* ── Pipelines ───────────────────────────────────────────────────────── */
  handle('pipelines:list', () => store.listPipelines());
  handle('pipelines:get', (id) => store.getPipeline(id));
  handle('pipelines:save', (p) => store.savePipeline(p));
  handle('pipelines:delete', (id) => store.deletePipeline(id));
  handle('pipelines:validate', async (id) => {
    const [p, cfg] = await Promise.all([store.getPipeline(id), store.loadConfig()]);
    if (!p) throw new Error(`No existe el pipeline "${id}".`);
    return graph.validate(p, cfg.agents || []);
  });

  /* ── Motor: chequeos sueltos para el editor ──────────────────────────────
     La condición se valida con el MISMO parser que la va a ejecutar. Una copia
     en el renderer se desincronizaría y aprobaría cosas que después fallan. */
  handle('engine:check-expr', (source) => require('./engine/expr').check(source));
  handle('engine:tools', () => toolkit.catalog());

  /* ── Agentes ─────────────────────────────────────────────────────────── */
  handle('agents:list', async () => (await store.loadConfig()).agents || []);
  handle('agents:save', async (agent) => {
    const cfg = await store.loadConfig();
    const at = (cfg.agents || []).findIndex((a) => a.id === agent.id);
    if (at >= 0) cfg.agents[at] = agent;
    else cfg.agents = [...(cfg.agents || []), agent];
    await store.saveConfig(cfg);
    return cfg.agents;
  });
  handle('agents:delete', async (id) => {
    const cfg = await store.loadConfig();
    cfg.agents = (cfg.agents || []).filter((a) => a.id !== id);
    await store.saveConfig(cfg);
    return cfg.agents;
  });

  /* ── Corridas ────────────────────────────────────────────────────────── */
  handle('runs:list', (limit) => store.listRuns(limit));
  handle('runs:get', async (id) => {
    // Una corrida viva se lee de memoria: el archivo puede ir hasta un segundo
    // atrás por el freno de guardado.
    const live = active.get(id);
    return live ? live.toJSON() : store.getRun(id);
  });
  handle('runs:delete', (id) => store.deleteRun(id));
  handle('runs:active', () => [...active.values()].map((r) => ({
    id: r.id, pipelineId: r.pipeline.id, pipelineName: r.pipeline.name,
    state: r.state, paused: r.paused, startedAt: r.startedAt,
    waiting: r.waitingApprovals(),
  })));

  handle('run:start', (pipelineId, input) => startRun(pipelineId, input));

  handle('run:approve', (runId, nodeId, approved, note) => {
    const run = active.get(runId);
    if (!run) throw new Error('Esa corrida ya no está activa.');
    if (!run.resolveApproval(nodeId, approved, note)) {
      throw new Error('Ese paso ya no está esperando una decisión.');
    }
    return true;
  });

  handle('run:pause', (id) => { active.get(id)?.pause(); return true; });
  handle('run:resume', (id) => { active.get(id)?.resume(); return true; });
  handle('run:abort', (id) => {
    const run = active.get(id);
    if (!run) throw new Error('Esa corrida ya no está activa.');
    run.abort();
    return true;
  });

  /* ── Ajustes y claves ────────────────────────────────────────────────── */
  handle('settings:get', async () => publicSettings(await store.loadConfig()));

  handle('settings:save', async (patch) => {
    const cfg = await store.loadConfig();
    const { providers: patchProviders, ...rest } = patch || {};
    cfg.settings = { ...cfg.settings, ...rest };
    // Las URLs base se pueden tocar; las claves NO viajan por acá.
    for (const [id, p] of Object.entries(patchProviders || {})) {
      cfg.settings.providers[id] = {
        ...cfg.settings.providers[id],
        baseUrl: p.baseUrl ?? cfg.settings.providers[id]?.baseUrl ?? null,
      };
    }
    await store.saveConfig(cfg);
    return publicSettings(cfg);
  });

  handle('settings:set-key', async (providerId, plaintext) => {
    if (!providers.meta(providerId)) throw new Error(`Proveedor desconocido: ${providerId}`);
    const cfg = await store.loadConfig();
    cfg.settings.providers[providerId] = {
      ...cfg.settings.providers[providerId],
      key: plaintext ? secrets.seal(String(plaintext).trim()) : null,
    };
    await store.saveConfig(cfg);
    return publicSettings(cfg);
  });

  handle('settings:test', async (providerId) => {
    const cfg = await store.loadConfig();
    const p = cfg.settings.providers?.[providerId] || {};
    const key = secrets.open(p.key);
    // Distinguir "no cargaste clave" de "hay una guardada que ya no se puede
    // leer" ahorra media hora de buscar en el lugar equivocado.
    if (!key && p.key?.enc) {
      throw new Error('Hay una clave guardada pero ya no se puede descifrar (se perdió la clave maestra del userData). Volvé a pegarla.');
    }
    const res = await providers.testConnection(providerId, p, key, AbortSignal.timeout(15000));
    // La lista completa la usa el selector de modelos del editor de agentes.
    return { ok: true, count: res.models.length, sample: res.models.slice(0, 8), models: res.models };
  });

  /* ── Arranque ────────────────────────────────────────────────────────── */
  handle('app:bootstrap', async () => {
    await ensureSeed(store);
    const cfg = await store.loadConfig();
    const [pipelines, runs] = await Promise.all([store.listPipelines(), store.listRuns(60)]);
    return {
      pipelines,
      agents: cfg.agents || [],
      runs,
      ...publicSettings(cfg),
      tools: toolkit.catalog(),
      dataDir: store.DIRS.root,
      workspace: store.workspacePath(cfg),
      activeRuns: [...active.keys()],
    };
  });
}

/** Cortar todo lo vivo antes de cerrar: nada de corridas zombis. */
async function shutdown() {
  stopSchedules?.();
  stopSchedules = null;
  for (const run of active.values()) run.abort('La aplicación se está cerrando.');
  await Promise.allSettled([...active.values()].map((r) => store.saveRun(r.toJSON())));
  active.clear();
}

module.exports = { register, shutdown, active };
