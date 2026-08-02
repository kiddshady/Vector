'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   VECTOR — herramientas
   Lo que un agente puede hacer además de escribir. Cada herramienta declara su
   esquema (que es lo que ve el modelo) y su implementación.

   LOS LÍMITES, QUE SON LA PARTE IMPORTANTE
   · Las de disco viven confinadas a UNA carpeta de trabajo. Toda ruta se
     resuelve y se compara contra esa raíz: `../../` no sale de ahí.
   · `run_command` está detrás de DOS cerrojos — un ajuste global apagado de
     fábrica y un permiso por agente. Un modelo que alucina un `rm -rf` no
     debería poder ejecutarlo porque alguien se olvidó de un checkbox.
   · Toda llamada, con sus argumentos, queda en el registro de la corrida.
     Una herramienta que se ejecuta sin dejar rastro es una que no podés auditar.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs/promises');
const path = require('path');
const { exec } = require('child_process');

const MAX_OUTPUT = 20000;      // lo que devuelve una tool al modelo, en caracteres
const MAX_FILE = 512 * 1024;

/** Recorta y avisa: un archivo de 4 MB adentro del contexto es plata quemada. */
function clip(text, limit = MAX_OUTPUT) {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}\n\n[… recortado, ${s.length - limit} caracteres más]`;
}

/**
 * Resuelve una ruta DENTRO de la carpeta de trabajo o falla.
 * El chequeo es sobre la ruta ya resuelta y con separador final, para que
 * "/work-malicioso" no pase por ser prefijo textual de "/work".
 */
function safePath(root, rel) {
  const base = path.resolve(root);
  const target = path.resolve(base, String(rel || '').replace(/^[/\\]+/, ''));
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (target !== base && !target.startsWith(withSep)) {
    throw new Error(`Ruta fuera de la carpeta de trabajo: "${rel}"`);
  }
  return target;
}

/** HTML → texto legible. Un modelo no necesita las etiquetas ni los scripts. */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/* ── Catálogo ────────────────────────────────────────────────────────────── */

const TOOLS = {
  read_file: {
    label: 'Leer archivo',
    icon: 'file',
    danger: false,
    description: 'Lee un archivo de texto de la carpeta de trabajo y devuelve su contenido.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Ruta relativa a la carpeta de trabajo.' } },
      required: ['path'],
    },
    async run({ path: rel }, ctx) {
      const file = safePath(ctx.workspace, rel);
      const stat = await fs.stat(file);
      if (stat.size > MAX_FILE) throw new Error(`El archivo pesa ${Math.round(stat.size / 1024)} KB; el máximo es ${MAX_FILE / 1024} KB.`);
      return clip(await fs.readFile(file, 'utf8'));
    },
  },

  write_file: {
    label: 'Escribir archivo',
    icon: 'save',
    danger: false,
    description: 'Escribe (o reemplaza) un archivo de texto en la carpeta de trabajo.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta relativa a la carpeta de trabajo.' },
        content: { type: 'string', description: 'Contenido completo del archivo.' },
      },
      required: ['path', 'content'],
    },
    async run({ path: rel, content }, ctx) {
      const file = safePath(ctx.workspace, rel);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, String(content ?? ''), 'utf8');
      return `Escrito: ${path.relative(ctx.workspace, file)} (${String(content ?? '').length} caracteres)`;
    },
  },

  list_dir: {
    label: 'Listar carpeta',
    icon: 'layers',
    danger: false,
    description: 'Lista los archivos y subcarpetas de un directorio de la carpeta de trabajo.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Ruta relativa. Vacío = la raíz.' } },
      required: [],
    },
    async run({ path: rel = '.' }, ctx) {
      const dir = safePath(ctx.workspace, rel);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      if (!entries.length) return '(vacío)';
      return clip(entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort().join('\n'));
    },
  },

  fetch_url: {
    label: 'Traer una URL',
    icon: 'external',
    danger: false,
    description: 'Descarga una página o API por HTTP GET y devuelve su texto (el HTML se convierte a texto plano).',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL completa, con http:// o https://' } },
      required: ['url'],
    },
    async run({ url }, ctx) {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`Protocolo no permitido: ${parsed.protocol}`);
      }
      const res = await fetch(parsed.href, {
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)].filter(Boolean)),
        headers: { 'User-Agent': 'Vector/0.1 (orquestador local)' },
        redirect: 'follow',
      });
      const type = res.headers.get('content-type') || '';
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} — ${clip(body, 200)}`);
      return clip(type.includes('html') ? htmlToText(body) : body);
    },
  },

  run_command: {
    label: 'Ejecutar comando',
    icon: 'terminal',
    danger: true,
    description: 'Ejecuta un comando de shell en la carpeta de trabajo y devuelve su salida.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Comando completo a ejecutar.' } },
      required: ['command'],
    },
    async run({ command }, ctx) {
      // Los dos cerrojos. El del agente lo aplica `allowedFor`; este es el global,
      // y se vuelve a chequear acá por si alguien llama execute() directo.
      if (!ctx.allowShell) {
        throw new Error('La ejecución de comandos está desactivada. Se habilita en Ajustes → Motor.');
      }
      return new Promise((resolve, reject) => {
        const child = exec(String(command), {
          cwd: ctx.workspace,
          timeout: 60000,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        }, (err, stdout, stderr) => {
          const out = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean).join('\n\n');
          if (err && !stdout && !stderr) return reject(new Error(err.message));
          if (err) return resolve(clip(`${out}\n\n[salió con código ${err.code ?? '?'}]`));
          resolve(clip(out || '(sin salida)'));
        });
        ctx.signal?.addEventListener('abort', () => child.kill(), { once: true });
      });
    },
  },
};

/* ── API ─────────────────────────────────────────────────────────────────── */

/** Metadatos para la UI (sin las implementaciones). */
function catalog() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    label: t.label,
    icon: t.icon,
    danger: t.danger,
    description: t.description,
  }));
}

/**
 * Qué herramientas puede usar de verdad este paso: la intersección de lo que
 * pidió con lo que el sistema permite. `run_command` cae si falta el global.
 */
function allowedFor(requested, { allowShell }) {
  return (requested || []).filter((name) => {
    const t = TOOLS[name];
    if (!t) return false;
    if (t.danger && !allowShell) return false;
    return true;
  });
}

/** Definiciones en el formato que espera la API (OpenAI-compatible). */
function definitions(names) {
  return (names || []).filter((n) => TOOLS[n]).map((n) => ({
    type: 'function',
    function: { name: n, description: TOOLS[n].description, parameters: TOOLS[n].parameters },
  }));
}

/**
 * Ejecuta una llamada. NUNCA lanza: un error de herramienta es información que
 * el modelo tiene que poder leer y corregir en el turno siguiente, no algo que
 * deba tumbar la corrida entera.
 */
async function execute(name, args, ctx) {
  const t = TOOLS[name];
  if (!t) return { ok: false, output: `No existe la herramienta "${name}".` };
  try {
    const out = await t.run(args || {}, ctx);
    return { ok: true, output: String(out) };
  } catch (err) {
    return { ok: false, output: `Error de ${name}: ${err.message}` };
  }
}

module.exports = { TOOLS, catalog, definitions, execute, allowedFor, safePath, clip };
