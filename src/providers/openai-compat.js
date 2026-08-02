'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   VECTOR — adaptador OpenAI-compatible
   Ollama Cloud (https://ollama.com/v1) y OpenRouter (https://openrouter.ai/api/v1)
   hablan el mismo dialecto, así que un solo adaptador cubre a los dos. Cambia
   la URL base, la clave y un par de headers de cortesía.

   Streaming por SSE: los tokens llegan de a poco y se reenvían por `onToken`
   para que el nodo del grafo muestre progreso real y no una barra inventada.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Parsea un stream SSE y va entregando los eventos `data:` ya deserializados.
 * Un chunk de red puede cortar un evento por la mitad, así que se acumula en un
 * buffer y solo se procesa lo que está delimitado por la línea en blanco.
 */
async function* sseEvents(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        for (const line of block.split('\n')) {
          // Los comentarios keep-alive (`: ping`) hay que ignorarlos.
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;
          if (!payload) continue;
          try {
            yield JSON.parse(payload);
          } catch {
            // Un evento ilegible no debe tumbar la corrida entera.
          }
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function abortError() {
  const e = new Error('Cancelado');
  e.name = 'AbortError';
  return e;
}

/** Saca el mensaje útil de un error de la API en vez de tirar "500". */
async function describeError(res) {
  let detail = '';
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body);
      detail = j.error?.message || j.error?.code || j.message || body.slice(0, 200);
    } catch {
      detail = body.slice(0, 200);
    }
  } catch { /* cuerpo ilegible */ }

  const hint = {
    401: 'clave inválida o ausente',
    402: 'sin saldo o fuera del plan',
    403: 'la clave no tiene permiso para este modelo',
    404: 'modelo o endpoint inexistente — revisá la URL base',
    429: 'límite de tasa alcanzado',
  }[res.status];

  return new Error(`HTTP ${res.status}${hint ? ` (${hint})` : ''}${detail ? `: ${detail}` : ''}`);
}

/**
 * Una llamada de chat.
 * @returns {{ text, usage:{in,out}, costUsd, finishReason, model }}
 */
async function chat({
  baseUrl, key, model, messages,
  temperature = 0.7, maxTokens = 2048, tools,
  signal, onToken, headers: extraHeaders = {}, body: extraBody = {},
}) {
  if (!key) throw new Error('Falta la clave de API para este proveedor.');
  if (!model) throw new Error('El agente no tiene modelo asignado.');

  const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
      // Sin esto el chunk final no trae el uso y nos quedamos sin contador real.
      stream_options: { include_usage: true },
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
      ...extraBody,
    }),
  });

  if (!res.ok) throw await describeError(res);
  if (!res.body) throw new Error('El proveedor no devolvió cuerpo de respuesta.');

  let text = '';
  let usage = { in: 0, out: 0 };
  let costUsd = 0;
  let finishReason = null;
  let resolvedModel = model;
  const calls = [];   // tool_calls en construcción, indexadas por posición

  for await (const ev of sseEvents(res, signal)) {
    if (ev.model) resolvedModel = ev.model;

    const choice = ev.choices?.[0];
    const piece = choice?.delta?.content;
    if (piece) {
      text += piece;
      onToken?.(piece, text);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;

    // Las tool_calls llegan partidas: el nombre en un chunk y los argumentos
    // goteando en varios. Se acumulan por índice hasta el final del stream.
    const deltaCalls = choice?.delta?.tool_calls || choice?.message?.tool_calls;
    for (const part of deltaCalls || []) {
      const i = part.index ?? calls.length;
      calls[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (part.id) calls[i].id = part.id;
      if (part.function?.name) calls[i].function.name += part.function.name;
      if (part.function?.arguments) calls[i].function.arguments += part.function.arguments;
    }

    // El uso llega una sola vez, en el chunk final, con `choices` vacío.
    if (ev.usage) {
      usage = {
        in: ev.usage.prompt_tokens || 0,
        out: ev.usage.completion_tokens || 0,
      };
      if (typeof ev.usage.cost === 'number') costUsd = ev.usage.cost;
    }
  }

  const toolCalls = calls.filter((c) => c?.function?.name);
  if (!text && !toolCalls.length && finishReason === 'length') {
    // El caso típico: un modelo de razonamiento gastó todo el presupuesto
    // pensando y no le quedó nada para escribir. El síntoma —respuesta vacía—
    // no sugiere la causa, así que el mensaje la nombra.
    throw new Error(
      `El modelo se quedó sin tokens antes de escribir nada (máx. ${maxTokens}). `
      + 'Suele pasar con modelos de razonamiento, que gastan presupuesto pensando: '
      + 'subí "Máx. tokens" en el agente.',
    );
  }

  return { text, toolCalls, usage, costUsd, finishReason, model: resolvedModel };
}

/** Ping de configuración: ¿la URL base responde y la clave sirve? */
async function listModels({ baseUrl, key, signal, headers: extraHeaders = {} }) {
  const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/models`, {
    signal,
    headers: { Authorization: `Bearer ${key}`, ...extraHeaders },
  });
  if (!res.ok) throw await describeError(res);
  const json = await res.json();
  return (json.data || json.models || [])
    .map((m) => m.id || m.name)
    .filter(Boolean)
    .sort();
}

module.exports = { chat, listModels };
