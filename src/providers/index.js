'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   VECTOR — registro de proveedores
   Ollama Cloud y OpenRouter comparten adaptador. El tercero es `mock`: un
   proveedor local que no sale a la red.

   El mock no es un juguete: es lo que permite probar el motor —orden
   topológico, fan-out, ramas, reintentos, cancelación— sin clave, sin latencia
   de red y sin gastar un centavo. Un pipeline que anda contra el mock y falla
   contra la nube tiene un problema de proveedor, no de motor.
   ═══════════════════════════════════════════════════════════════════════════ */

const compat = require('./openai-compat');

const PROVIDERS = {
  'ollama-cloud': {
    id: 'ollama-cloud',
    label: 'Ollama Cloud',
    defaultBaseUrl: 'https://ollama.com/v1',
    needsKey: true,
    keyHint: 'Se crea en ollama.com/settings/keys',
    // Suscripción: no se paga por token, así que no mostramos costo inventado.
    reportsCost: false,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    keyHint: 'Se crea en openrouter.ai/keys',
    reportsCost: true,
    headers: { 'HTTP-Referer': 'https://local.vector', 'X-OpenRouter-Title': 'Vector' },
    // Pedirle el costo real a OpenRouter en vez de estimarlo con una tabla de
    // precios que se desactualiza sola.
    body: { usage: { include: true } },
  },
  mock: {
    id: 'mock',
    label: 'Mock (local)',
    defaultBaseUrl: null,
    needsKey: false,
    keyHint: 'No necesita clave: responde desde la propia app.',
    reportsCost: false,
  },
};

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
});

function abortError() {
  const e = new Error('Cancelado');
  e.name = 'AbortError';
  return e;
}

/* ── Proveedor mock ───────────────────────────────────────────────────────
   Se maneja con el bloque `mock` del agente:
     { output, json, delayMs, failTimes, failWith }
   `failTimes` falla las primeras N veces y después anda: es exactamente lo que
   hace falta para ver un reintento funcionar de verdad. */

const mockAttempts = new Map();

async function mockChat({ model, messages, signal, onToken, mock = {}, attemptKey, tools }) {
  const {
    output, json, delayMs = 600, failTimes = 0,
    failWith = 'El proveedor devolvió 503 (simulado)',
    toolCalls,
  } = mock;

  if (failTimes > 0 && attemptKey) {
    const seen = mockAttempts.get(attemptKey) || 0;
    mockAttempts.set(attemptKey, seen + 1);
    if (seen < failTimes) {
      await sleep(Math.min(delayMs, 400), signal);
      throw new Error(failWith);
    }
  }

  const prompt = messages.map((m) => m.content).join('\n');

  /* Simulación de tool-calling: pide herramientas durante `toolLoops` turnos
     (uno por defecto) y después responde con texto. Poder pedir varias veces no
     es un capricho — es lo único que permite probar que el tope de turnos corta
     de verdad un modelo que se queda en loop. */
  const roundsSoFar = messages.filter((m) => m.role === 'assistant' && m.tool_calls).length;
  if (toolCalls?.length && tools?.length && roundsSoFar < (mock.toolLoops ?? 1)) {
    await sleep(Math.min(delayMs, 300), signal);
    return {
      text: '',
      toolCalls: toolCalls.map((c, i) => ({
        id: `mock-call-${i}`,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
      })),
      usage: { in: Math.ceil(prompt.length / 4), out: 12 },
      costUsd: 0,
      finishReason: 'tool_calls',
      model,
      estimated: true,
    };
  }

  const text = json != null
    ? JSON.stringify(json, null, 2)
    : output ?? `[mock:${model}] ${prompt.slice(0, 120).replace(/\s+/g, ' ')}…`;

  // Emitir de a pedacitos para que el streaming del grafo sea real y no un
  // salto de 0 a 100 al final.
  const chunks = text.match(/.{1,24}/gs) || [text];
  const per = Math.max(12, Math.round(delayMs / chunks.length));
  let acc = '';
  for (const c of chunks) {
    await sleep(per, signal);
    acc += c;
    onToken?.(c, acc);
  }

  // ~4 caracteres por token: alcanza para que los contadores se muevan con
  // sentido. Es una estimación y la UI la marca como tal.
  return {
    text,
    toolCalls: [],
    usage: { in: Math.ceil(prompt.length / 4), out: Math.ceil(text.length / 4) },
    costUsd: 0,
    finishReason: 'stop',
    model,
    estimated: true,
  };
}

/* ── API pública ─────────────────────────────────────────────────────────── */

function meta(id) {
  return PROVIDERS[id] || null;
}

/**
 * @param {object} cfg  el bloque del proveedor en config.settings.providers
 * @param {string} key  clave ya descifrada (solo el proceso principal la tiene)
 */
async function chat(providerId, cfg, opts) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error(`Proveedor desconocido: ${providerId}`);

  if (providerId === 'mock') return mockChat(opts);

  return compat.chat({
    baseUrl: cfg?.baseUrl || p.defaultBaseUrl,
    key: opts.key,
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    tools: opts.tools,
    signal: opts.signal,
    onToken: opts.onToken,
    headers: p.headers || {},
    body: p.body || {},
  });
}

async function testConnection(providerId, cfg, key, signal) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error(`Proveedor desconocido: ${providerId}`);
  if (providerId === 'mock') return { ok: true, models: ['mock-fast', 'mock-slow', 'mock-flaky'] };
  if (p.needsKey && !key) throw new Error('Falta la clave de API.');

  const models = await compat.listModels({
    baseUrl: cfg?.baseUrl || p.defaultBaseUrl,
    key,
    signal,
    headers: p.headers || {},
  });
  return { ok: true, models };
}

/** Entre corridas hay que olvidar los intentos simulados del mock. */
function resetMock() { mockAttempts.clear(); }

module.exports = { PROVIDERS, meta, chat, testConnection, resetMock };
