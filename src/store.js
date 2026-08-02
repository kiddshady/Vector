'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   VECTOR — almacenamiento
   JSON atómico sobre el disco. Nada de base de datos: los pipelines son
   archivos legibles que se pueden editar a mano y versionar en git.

   Los datos viven en el directorio del proyecto (`data/`), no en AppData:
   así se ven, se abren con un editor y no dependen de dónde quedó instalada
   la app. `VECTOR_DATA` lo puede mover.

   Escritura atómica: se escribe un `.tmp`, se fuerza el flush a disco y recién
   ahí se renombra encima del original. Un corte de luz a mitad de camino deja
   el archivo viejo intacto en vez de uno truncado.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ROOT = process.env.VECTOR_DATA || path.join(__dirname, '..', 'data');
const DIRS = {
  root: ROOT,
  pipelines: path.join(ROOT, 'pipelines'),
  runs: path.join(ROOT, 'runs'),
};
const CONFIG_FILE = path.join(ROOT, 'config.json');
const RUN_INDEX = path.join(ROOT, 'runs', 'index.json');

const SCHEMA = 1;

/* ── Primitivas ──────────────────────────────────────────────────────────── */

async function ensureDirs() {
  await fsp.mkdir(DIRS.pipelines, { recursive: true });
  await fsp.mkdir(DIRS.runs, { recursive: true });
  await fsp.mkdir(path.join(ROOT, 'workspace'), { recursive: true });
}

async function readJSON(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // Un JSON corrupto no puede hacer desaparecer los datos en silencio: se
    // aparta con marca de tiempo y se sigue con el fallback.
    if (err instanceof SyntaxError) {
      const dead = `${file}.corrupto-${Date.now()}`;
      await fsp.rename(file, dead).catch(() => {});
      console.error(`[store] ${path.basename(file)} ilegible → ${path.basename(dead)}`);
      return fallback;
    }
    throw err;
  }
}

/* Cola de escritura por archivo. Dos guardados del mismo destino no pueden
   correr a la vez: con un `.tmp` compartido, el primero en renombrar se lo
   lleva y el segundo falla con ENOENT — y esa escritura se pierde en silencio.
   Serializar además hace determinista quién queda último. */
const writeQueues = new Map();
let tmpCounter = 0;

function writeJSON(file, data) {
  const prev = writeQueues.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => writeJSONNow(file, data));
  writeQueues.set(file, next);
  // Limpiar la cola cuando se vacía, para no acumular una entrada por archivo.
  next.catch(() => {}).finally(() => {
    if (writeQueues.get(file) === next) writeQueues.delete(file);
  });
  return next;
}

async function writeJSONNow(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // Temporal único: aunque algo se cuele en paralelo, nadie pisa el .tmp ajeno.
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
  const text = JSON.stringify(data, null, 2);

  // El flush explícito es lo que hace la promesa atómica de verdad: sin él, el
  // rename puede llegar al disco antes que el contenido.
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await renameWithRetry(tmp, file);
}

/* En Windows el rename falla con EPERM/EBUSY si el destino está tomado en ese
   instante — otro proceso leyéndolo, un antivirus, otra instancia de la app
   sobre la misma carpeta de datos. Son bloqueos de milisegundos: reintentar es
   la diferencia entre una escritura que se pierde y una que llega tarde. */
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function renameWithRetry(tmp, file, intentos = 5) {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      if (i >= intentos - 1 || !TRANSIENT.has(err.code)) {
        await fsp.unlink(tmp).catch(() => {});   // no dejar basura si no hay vuelta
        throw err;
      }
      await new Promise((r) => setTimeout(r, 30 * 2 ** i));   // 30, 60, 120, 240 ms
    }
  }
}

/* ── Configuración (ajustes + agentes) ───────────────────────────────────── */

const DEFAULT_CONFIG = {
  schema: SCHEMA,
  settings: {
    concurrency: 4,
    defaultProvider: 'mock',
    /** Carpeta a la que quedan confinadas las herramientas de disco. null = data/workspace */
    workspaceDir: null,
    /** El cerrojo global del shell. Apagado de fábrica, a propósito. */
    allowShell: false,
    /** Tope de idas y vueltas con herramientas dentro de un mismo paso. */
    maxToolTurns: 5,
    /** pipelineId → timestamp del último disparo programado. */
    scheduleState: {},
    providers: {
      'ollama-cloud': { baseUrl: 'https://ollama.com/v1', key: null },
      openrouter: { baseUrl: 'https://openrouter.ai/api/v1', key: null },
      mock: { baseUrl: null, key: null },
    },
  },
  agents: [],
};

/** La carpeta de trabajo, resuelta a ruta absoluta. */
function workspacePath(cfg) {
  const dir = cfg?.settings?.workspaceDir;
  return dir ? path.resolve(dir) : path.join(ROOT, 'workspace');
}

/** Migraciones: cada función lleva el archivo de la versión N a la N+1. */
const MIGRATIONS = {
  // 0 → 1: primera versión con esquema declarado.
  0: (data) => ({ ...DEFAULT_CONFIG, ...data, schema: 1 }),
};

function migrate(data) {
  let out = data;
  let v = out.schema ?? 0;
  while (v < SCHEMA) {
    const step = MIGRATIONS[v];
    if (!step) break;
    out = step(out);
    v = out.schema ?? v + 1;
  }
  return out;
}

/** Completa claves nuevas sin pisar lo que el usuario ya configuró. */
function withDefaults(cfg) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...cfg,
    settings: {
      ...DEFAULT_CONFIG.settings,
      ...(cfg.settings || {}),
      providers: { ...DEFAULT_CONFIG.settings.providers },
    },
  };
  for (const [id, p] of Object.entries(cfg.settings?.providers || {})) {
    merged.settings.providers[id] = { ...merged.settings.providers[id], ...p };
  }
  return merged;
}

async function loadConfig() {
  await ensureDirs();
  const raw = await readJSON(CONFIG_FILE, null);
  if (!raw) {
    await writeJSON(CONFIG_FILE, DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }
  return withDefaults(migrate(raw));
}

async function saveConfig(cfg) {
  await writeJSON(CONFIG_FILE, { ...cfg, schema: SCHEMA });
  return cfg;
}

/* ── Pipelines: un archivo por pipeline ──────────────────────────────────── */

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** El id viaja desde el renderer y se usa como nombre de archivo: se valida. */
function assertId(id) {
  if (!SAFE_ID.test(String(id))) throw new Error(`id inválido: ${id}`);
  return id;
}

async function listPipelines() {
  await ensureDirs();
  const files = (await fsp.readdir(DIRS.pipelines)).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    const p = await readJSON(path.join(DIRS.pipelines, f), null);
    if (p?.id) out.push(p);
  }
  return out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

async function getPipeline(id) {
  return readJSON(path.join(DIRS.pipelines, `${assertId(id)}.json`), null);
}

async function savePipeline(pipeline) {
  assertId(pipeline.id);
  await writeJSON(path.join(DIRS.pipelines, `${pipeline.id}.json`), pipeline);
  return pipeline;
}

async function deletePipeline(id) {
  await fsp.unlink(path.join(DIRS.pipelines, `${assertId(id)}.json`)).catch(() => {});
}

/* ── Corridas: un archivo por corrida + un índice liviano ────────────────── */

async function listRuns(limit = 100) {
  const idx = await readJSON(RUN_INDEX, []);
  return idx.slice(0, limit);
}

async function getRun(id) {
  return readJSON(path.join(DIRS.runs, `${assertId(id)}.json`), null);
}

async function saveRun(run) {
  assertId(run.id);
  await writeJSON(path.join(DIRS.runs, `${run.id}.json`), run);

  // El índice guarda solo el resumen: la tabla de Corridas no necesita abrir
  // 500 archivos para dibujarse.
  const idx = await readJSON(RUN_INDEX, []);
  const summary = {
    id: run.id,
    pipelineId: run.pipelineId,
    pipelineName: run.pipelineName,
    state: run.state,
    startedAt: run.startedAt,
    endedAt: run.endedAt || null,
    durMs: run.durMs || null,
    stepsDone: run.stepsDone || 0,
    stepsTotal: run.stepsTotal || 0,
    tokensIn: run.totals?.tokensIn || 0,
    tokensOut: run.totals?.tokensOut || 0,
    costUsd: run.totals?.costUsd || 0,
  };
  const at = idx.findIndex((r) => r.id === run.id);
  if (at >= 0) idx[at] = summary;
  else idx.unshift(summary);

  await writeJSON(RUN_INDEX, idx.slice(0, 500));
  return run;
}

async function deleteRun(id) {
  await fsp.unlink(path.join(DIRS.runs, `${assertId(id)}.json`)).catch(() => {});
  const idx = await readJSON(RUN_INDEX, []);
  await writeJSON(RUN_INDEX, idx.filter((r) => r.id !== id));
}

/** Id incremental legible: r-0001. Se deriva del índice, no de un contador suelto. */
async function nextRunId() {
  const idx = await readJSON(RUN_INDEX, []);
  const max = idx.reduce((m, r) => {
    const n = Number(String(r.id).replace(/^r-/, ''));
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
  return `r-${String(max + 1).padStart(4, '0')}`;
}

module.exports = {
  DIRS, CONFIG_FILE, SCHEMA,
  ensureDirs, readJSON, writeJSON, workspacePath,
  loadConfig, saveConfig,
  listPipelines, getPipeline, savePipeline, deletePipeline,
  listRuns, getRun, saveRun, deleteRun, nextRunId,
};
