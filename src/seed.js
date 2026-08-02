'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   VECTOR — semilla
   Lo que se escribe en `data/` la primera vez. El pipeline de ejemplo corre
   entero contra el proveedor `mock`, así que la app hace algo real desde el
   minuto cero, sin clave y sin gastar nada.

   Está armado a propósito para ejercitar TODO el motor: una condición que
   omite una rama, un fan-out en paralelo, un paso que falla y se recupera con
   reintento, y una segunda condición al final.
   ═══════════════════════════════════════════════════════════════════════════ */

const AGENTS = [
  {
    id: 'triage',
    name: 'Triage',
    mono: 'TR',
    role: 'Clasifica y puntúa entradas por relevancia',
    provider: 'mock',
    model: 'mock-fast',
    system: 'Sos un clasificador. Respondé solo con JSON.',
    temperature: 0.2,
    maxTokens: 1024,
  },
  {
    id: 'reader',
    name: 'Lector',
    mono: 'LP',
    role: 'Lee en profundidad y extrae tesis y evidencia',
    provider: 'mock',
    model: 'mock-slow',
    temperature: 0.3,
    maxTokens: 4096,
  },
  {
    id: 'synth',
    name: 'Sintetizador',
    mono: 'SN',
    role: 'Cruza fuentes y redacta el resumen final',
    provider: 'mock',
    model: 'mock-fast',
    temperature: 0.5,
    maxTokens: 4096,
  },
];

const DEMO_ITEMS = [
  'Escalado de contexto largo en modelos abiertos',
  'Cuantización de 4 bits sin pérdida medible',
  'Enrutamiento de agentes por costo',
  'Memoria episódica en asistentes personales',
  'Evaluación adversarial de resúmenes',
  'Inferencia local en GPUs de consumo',
];

const DEMO_PIPELINE = {
  id: 'research-digest',
  name: 'Research Digest',
  desc: 'Barre feeds, filtra por relevancia, lee en profundidad y arma el resumen diario.',
  version: 1,
  // Programado pero apagado: que corra solo tiene que ser una decisión tuya.
  schedule: { enabled: false, kind: 'daily', at: '07:00' },
  retries: 0,
  input: { query: 'novedades de la semana en modelos locales' },

  nodes: [
    {
      id: 'src', kind: 'input', title: 'Fuentes', sub: '12 feeds RSS',
      x: 40, y: 420,
    },
    {
      id: 'triage', kind: 'agent', title: 'Triage', agent: 'triage',
      prompt: 'Clasificá estos resultados para la consulta: {{input.query}}\n\nDevolvé JSON con "score" (0 a 1) e "items" (lista de títulos).',
      x: 336, y: 420,
      mock: { delayMs: 900, json: { score: 0.82, kept: DEMO_ITEMS.length, items: DEMO_ITEMS } },
    },
    {
      id: 'gate', kind: 'branch', title: '¿Relevante?', sub: 'score ≥ 0.7',
      when: 'steps.triage.json.score >= 0.7',
      x: 632, y: 420,
    },
    {
      id: 'deep', kind: 'fanout', title: 'Lectura profunda', agent: 'reader',
      over: '{{steps.triage.json.items | json}}',
      prompt: 'Leé en profundidad y extraé tesis, evidencia y contradicciones de:\n{{item}}',
      concurrency: 3,
      itemErrors: 'skip',
      x: 928, y: 320,
      mock: { delayMs: 1300, output: 'Tesis principal, evidencia citada y una contradicción sin resolver.' },
    },
    {
      id: 'archive', kind: 'output', title: 'Archivar', sub: 'descartados',
      from: '{{steps.triage.output}}',
      x: 928, y: 520,
    },
    {
      id: 'synth', kind: 'agent', title: 'Síntesis', agent: 'synth',
      prompt: 'Escribí el resumen del día cruzando estas lecturas:\n\n{{steps.deep.output}}',
      retries: 2,
      x: 1224, y: 320,
      // Falla la primera vez a propósito: así se ve un reintento de verdad.
      mock: { delayMs: 1100, failTimes: 1, output: 'Resumen del día: seis lecturas cruzadas, dos tesis convergentes y una contradicción abierta sobre cuantización.' },
    },
    {
      id: 'check', kind: 'branch', title: '¿Pasa control?', sub: 'tiene resumen',
      when: "steps.synth.output contains 'Resumen'",
      // Si no pasa el control, no se publica y listo: el corte es intencional.
      allowDeadEnd: true,
      x: 1520, y: 320,
    },
    {
      id: 'publish', kind: 'output', title: 'Publicar', sub: 'markdown + mail',
      from: '{{steps.synth.output}}',
      x: 1520, y: 520,
    },
  ],

  edges: [
    { from: 'src', to: 'triage' },
    { from: 'triage', to: 'gate' },
    { from: 'gate', to: 'deep', branch: true, label: 'sí' },
    { from: 'gate', to: 'archive', branch: false, label: 'no' },
    { from: 'deep', to: 'synth' },
    { from: 'synth', to: 'check' },
    { from: 'check', to: 'publish', branch: true, label: 'aprobado' },
  ],

  // El marco abraza miembros, no coordenadas: se reacomoda solo si movés el nodo.
  groups: [{ id: 'g-fanout', label: 'fan-out ×6', nodes: ['deep'] }],
};

/* ── Segundo ejemplo: herramientas + compuerta humana ──────────────────────
   Lee un archivo de la carpeta de trabajo con una herramienta real, lo resume,
   y frena esperando que decidas si se publica. Corre contra el mock, así que
   funciona sin clave — pero la lectura del archivo SÍ es de verdad.
   ─────────────────────────────────────────────────────────────────────────── */

const SAMPLE_NOTE = `Notas de la semana

- El escalado de contexto largo sigue costando memoria, no cómputo.
- La cuantización de 4 bits ya no pierde calidad medible en tareas cortas.
- Enrutar por costo antes que por capacidad baja el gasto sin que se note.
`;

const TOOLS_PIPELINE = {
  id: 'revision-con-aprobacion',
  name: 'Revisión con aprobación',
  desc: 'Lee un archivo real de la carpeta de trabajo, lo resume y espera tu visto bueno antes de guardarlo.',
  version: 1,
  schedule: { enabled: false, kind: 'daily', at: '09:00' },
  retries: 0,
  input: { archivo: 'notas.md' },

  nodes: [
    { id: 'entrada', kind: 'input', title: 'Entrada', sub: 'archivo a leer', x: 40, y: 420 },
    {
      id: 'leer', kind: 'agent', title: 'Leer archivo', agent: 'triage',
      prompt: 'Leé el archivo {{input.archivo}} de la carpeta de trabajo y contame qué dice.',
      tools: ['list_dir', 'read_file'],
      x: 336, y: 420,
      mock: {
        delayMs: 500,
        toolCalls: [{ name: 'read_file', args: { path: 'notas.md' } }],
        output: 'El archivo tiene tres apuntes sobre modelos locales.',
      },
    },
    {
      id: 'resumen', kind: 'agent', title: 'Resumir', agent: 'synth',
      prompt: 'Escribí un resumen de dos líneas a partir de esto:\n\n{{steps.leer.output}}',
      x: 632, y: 420,
      mock: { delayMs: 700, output: 'Resumen: el costo de los modelos locales se está moviendo de cómputo a memoria, y enrutar por precio rinde más que buscar el modelo más capaz.' },
    },
    {
      id: 'revision', kind: 'approval', title: 'Revisión', sub: 'humana',
      question: '¿Guardamos este resumen?',
      preview: '{{steps.resumen.output}}',
      x: 928, y: 420,
    },
    { id: 'guardar', kind: 'output', title: 'Guardar', sub: 'aprobado', from: '{{steps.resumen.output}}', x: 1224, y: 320 },
    { id: 'descartar', kind: 'output', title: 'Descartar', sub: 'rechazado', from: 'descartado por revisión', x: 1224, y: 520 },
  ],

  edges: [
    { from: 'entrada', to: 'leer' },
    { from: 'leer', to: 'resumen' },
    { from: 'resumen', to: 'revision' },
    { from: 'revision', to: 'guardar', branch: true, label: 'aprobado' },
    { from: 'revision', to: 'descartar', branch: false, label: 'rechazado' },
  ],

  groups: [],
};

/** Escribe la semilla solo si falta; nunca pisa lo que el usuario ya tiene. */
async function ensureSeed(store) {
  const fsp = require('fs/promises');
  const path = require('path');

  const cfg = await store.loadConfig();
  if (!cfg.agents?.length) {
    cfg.agents = AGENTS;
    await store.saveConfig(cfg);
  }

  const existing = await store.listPipelines();
  const have = new Set(existing.map((p) => p.id));
  if (!have.has(DEMO_PIPELINE.id) && !existing.length) await store.savePipeline(DEMO_PIPELINE);
  if (!have.has(TOOLS_PIPELINE.id) && !existing.length) await store.savePipeline(TOOLS_PIPELINE);

  // Un archivo de ejemplo para que la herramienta de lectura tenga qué leer.
  const sample = path.join(store.workspacePath(cfg), 'notas.md');
  try {
    await fsp.access(sample);
  } catch {
    await fsp.mkdir(path.dirname(sample), { recursive: true });
    await fsp.writeFile(sample, SAMPLE_NOTE, 'utf8');
  }

  return { agents: cfg.agents.length, pipelines: (await store.listPipelines()).length };
}

module.exports = { AGENTS, DEMO_PIPELINE, TOOLS_PIPELINE, ensureSeed };
