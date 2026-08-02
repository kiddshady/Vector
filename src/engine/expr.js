'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   VECTOR — expresiones de condición
   Lo que evalúan los nodos `branch`. Un parser descendente recursivo chiquito,
   deliberadamente limitado: **sin eval, sin new Function, sin acceso a nada que
   no sea el contexto de la corrida.** Un pipeline es un archivo JSON que puede
   venir de cualquier lado; darle un intérprete de JavaScript sería regalarle la
   máquina.

   Gramática soportada:
     or   → and ('||' and)*
     and  → not ('&&' not)*
     not  → '!' not | cmp
     cmp  → primary (OP primary)?
     primary → '(' or ')' | literal | ruta

   OP: == != > >= < <= contains startsWith endsWith matches in
   Literales: números, 'texto', "texto", true, false, null
   Todo lo demás es una ruta al contexto: steps.triage.json.score
   ═══════════════════════════════════════════════════════════════════════════ */

const { readPath } = require('./template');

const OPS = ['>=', '<=', '==', '!=', '>', '<'];
const WORD_OPS = ['contains', 'startsWith', 'endsWith', 'matches', 'in'];

/* ── Tokenizer ───────────────────────────────────────────────────────────── */

function tokenize(src) {
  const tokens = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (/\s/.test(c)) { i++; continue; }

    if (c === '(' || c === ')') { tokens.push({ t: c }); i++; continue; }

    if (src.startsWith('&&', i)) { tokens.push({ t: '&&' }); i += 2; continue; }
    if (src.startsWith('||', i)) { tokens.push({ t: '||' }); i += 2; continue; }

    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) { tokens.push({ t: 'op', v: op }); i += op.length; continue; }

    if (c === '!') { tokens.push({ t: '!' }); i++; continue; }

    if (c === '"' || c === "'") {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; continue; }
        out += src[j]; j++;
      }
      if (j >= src.length) throw new Error('Falta cerrar la comilla en la condición.');
      tokens.push({ t: 'lit', v: out });
      i = j + 1;
      continue;
    }

    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i + 1;
      while (j < src.length && /[0-9._]/.test(src[j])) j++;
      tokens.push({ t: 'lit', v: Number(src.slice(i, j).replace(/_/g, '')) });
      i = j;
      continue;
    }

    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$.[\]]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (WORD_OPS.includes(word)) tokens.push({ t: 'op', v: word });
      else if (word === 'true') tokens.push({ t: 'lit', v: true });
      else if (word === 'false') tokens.push({ t: 'lit', v: false });
      else if (word === 'null') tokens.push({ t: 'lit', v: null });
      else tokens.push({ t: 'path', v: word.replace(/\[(\d+)\]/g, '.$1') });
      i = j;
      continue;
    }

    throw new Error(`Carácter inesperado en la condición: "${c}"`);
  }

  return tokens;
}

/* ── Parser ──────────────────────────────────────────────────────────────── */

function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (t) => (peek()?.t === t ? tokens[pos++] : null);

  function parseOr() {
    let left = parseAnd();
    while (eat('||')) left = { k: 'or', left, right: parseAnd() };
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (eat('&&')) left = { k: 'and', left, right: parseNot() };
    return left;
  }
  function parseNot() {
    if (eat('!')) return { k: 'not', node: parseNot() };
    return parseCmp();
  }
  function parseCmp() {
    const left = parsePrimary();
    const op = peek()?.t === 'op' ? tokens[pos++].v : null;
    if (!op) return left;
    return { k: 'cmp', op, left, right: parsePrimary() };
  }
  function parsePrimary() {
    if (eat('(')) {
      const inner = parseOr();
      if (!eat(')')) throw new Error('Falta cerrar el paréntesis en la condición.');
      return inner;
    }
    const tok = peek();
    if (!tok) throw new Error('La condición termina antes de tiempo.');
    pos++;
    if (tok.t === 'lit') return { k: 'lit', v: tok.v };
    if (tok.t === 'path') return { k: 'path', v: tok.v };
    throw new Error(`No se esperaba "${tok.v ?? tok.t}" en la condición.`);
  }

  const ast = parseOr();
  if (pos < tokens.length) throw new Error(`Sobra "${tokens[pos].v ?? tokens[pos].t}" al final de la condición.`);
  return ast;
}

/* ── Evaluación ──────────────────────────────────────────────────────────── */

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return !!v;
}

const nullish = (v) => v === null || v === undefined;

/** Una ruta que no existe y una que vale null son la misma cosa: "no hay valor".
    Distinguirlas obligaría a escribir condiciones defensivas para nada. */
function looseEq(a, b) {
  const na = nullish(a);
  const nb = nullish(b);
  if (na || nb) return na && nb;
  return a === b || String(a) === String(b);
}

/** Para operaciones de texto, "no hay valor" es cadena vacía — nunca la palabra
    "undefined", que haría que `contains 'defin'` diera verdadero de la nada. */
const str = (v) => (nullish(v) ? '' : String(v));

function compare(op, a, b) {
  switch (op) {
    case '==': return looseEq(a, b);
    case '!=': return !looseEq(a, b);
    case '>': return Number(a) > Number(b);
    case '>=': return Number(a) >= Number(b);
    case '<': return Number(a) < Number(b);
    case '<=': return Number(a) <= Number(b);
    case 'contains':
      if (Array.isArray(a)) return a.some((x) => looseEq(x, b));
      return str(a).toLowerCase().includes(str(b).toLowerCase());
    case 'startsWith': return str(a).toLowerCase().startsWith(str(b).toLowerCase());
    case 'endsWith': return str(a).toLowerCase().endsWith(str(b).toLowerCase());
    case 'matches': return new RegExp(str(b), 'i').test(str(a));
    case 'in':
      if (Array.isArray(b)) return b.some((x) => looseEq(x, a));
      return str(b).toLowerCase().includes(str(a).toLowerCase());
    default: throw new Error(`Operador desconocido: ${op}`);
  }
}

function evalNode(node, ctx) {
  switch (node.k) {
    case 'lit': return node.v;
    case 'path': return readPath(ctx, node.v).value;
    case 'not': return !truthy(evalNode(node.node, ctx));
    case 'and': return truthy(evalNode(node.left, ctx)) && truthy(evalNode(node.right, ctx));
    case 'or': return truthy(evalNode(node.left, ctx)) || truthy(evalNode(node.right, ctx));
    case 'cmp': return compare(node.op, evalNode(node.left, ctx), evalNode(node.right, ctx));
    default: throw new Error(`Nodo de expresión desconocido: ${node.k}`);
  }
}

/** true/false para una condición de rama. */
function evaluate(source, ctx) {
  if (source == null || source === '') return true;
  if (typeof source === 'boolean') return source;
  return truthy(evalNode(parse(tokenize(String(source))), ctx));
}

/** Valida la sintaxis sin correr nada (para el chequeo previo del pipeline). */
function check(source) {
  try {
    if (source == null || source === '' || typeof source === 'boolean') return { ok: true };
    parse(tokenize(String(source)));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { evaluate, check, tokenize, parse };
