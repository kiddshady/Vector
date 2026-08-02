'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   VECTOR — plantillas
   Interpolación `{{ruta}}` para pasar la salida de un paso al prompt del
   siguiente. Es un lector de rutas, no un evaluador: **nunca** hay eval ni
   `new Function`. Un pipeline es un archivo de datos, y un archivo de datos no
   tiene que poder ejecutar código.

   Contexto disponible dentro de un prompt:
     {{input.loQueSea}}          la entrada de la corrida
     {{steps.triage.output}}     el texto que produjo un paso
     {{steps.triage.json.items}} ese texto parseado como JSON, si lo era
     {{item}} / {{index}}        dentro de un fan-out, el elemento y su posición
   ═══════════════════════════════════════════════════════════════════════════ */

/** Lee `a.b.c` (con índices `a.0.b`) sin tocar el prototipo. */
function readPath(ctx, path) {
  const parts = String(path).split('.').map((p) => p.trim()).filter(Boolean);
  let cur = ctx;
  for (const part of parts) {
    // Cortar __proto__/constructor/prototype: una ruta que viene de un archivo
    // no debería poder trepar a la cadena de prototipos.
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') {
      return { found: false, value: undefined };
    }
    if (cur == null) return { found: false, value: undefined };
    if (!(part in Object(cur))) return { found: false, value: undefined };
    cur = cur[part];
  }
  return { found: true, value: cur };
}

function stringify(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

/**
 * Reemplaza cada {{ruta}} por su valor.
 * Una ruta inexistente es un ERROR, no un hueco vacío: un prompt con la palabra
 * "undefined" adentro se ejecuta igual, cuesta plata y devuelve basura. Mejor
 * que reviente acá con el nombre exacto de lo que falta.
 */
function render(template, ctx) {
  if (typeof template !== 'string') return template;
  const missing = [];

  const out = template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, expr) => {
    const [pathRaw, ...filters] = String(expr).split('|').map((s) => s.trim());
    const { found, value } = readPath(ctx, pathRaw);
    if (!found) { missing.push(pathRaw); return ''; }

    let v = value;
    for (const f of filters) {
      if (f === 'json') v = JSON.stringify(v, null, 2);
      else if (f === 'trim') v = stringify(v).trim();
      else if (f === 'upper') v = stringify(v).toUpperCase();
      else if (f === 'lower') v = stringify(v).toLowerCase();
      else throw new Error(`Filtro desconocido en la plantilla: "${f}"`);
    }
    return stringify(v);
  });

  if (missing.length) {
    throw new Error(`La plantilla referencia algo que no existe: ${[...new Set(missing)].map((m) => `{{${m}}}`).join(', ')}`);
  }
  return out;
}

/** Qué rutas usa una plantilla — sirve para validar el pipeline antes de correr. */
function refs(template) {
  if (typeof template !== 'string') return [];
  return [...template.matchAll(/\{\{\s*([^}|]+?)\s*(?:\|[^}]*)?\}\}/g)].map((m) => m[1].trim());
}

module.exports = { render, refs, readPath, stringify };
