'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   VECTOR — scheduler
   Ejecuta el DAG. No recorre una lista: en cada vuelta pregunta qué pasos
   quedaron habilitados y arranca todos los que pueda a la vez, hasta el límite
   de concurrencia.

   SEMÁNTICA DE LAS UNIONES (lo que más confunde de un orquestador)
   Un paso espera a que TODAS sus entradas queden resueltas (terminadas,
   omitidas o falladas) — eso es el tiempo. Después corre si AL MENOS UNA de
   esas entradas quedó activa — eso es la habilitación. Un rombo que se fue por
   la rama "no" deja su otra rama omitida, y lo que venía después de esa rama se
   omite en cascada, pero un paso que junta las dos ramas igual corre.

   Un paso que falla apaga sus salidas: todo lo que dependía de él se omite y la
   corrida termina en `failed`. Los pasos que ya habían terminado se conservan.
   ═══════════════════════════════════════════════════════════════════════════ */

const { EventEmitter } = require('events');
const graph = require('./graph');
const template = require('./template');
const expr = require('./expr');
const providers = require('../providers');
const tools = require('../tools');

const TOKEN_THROTTLE_MS = 90;

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
});

function abortError() {
  const e = new Error('Cancelado');
  e.name = 'AbortError';
  return e;
}

const isAbort = (err) => err?.name === 'AbortError';

/** Intenta leer la salida como JSON; si no lo es, devuelve null sin drama. */
function tryJSON(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Los modelos suelen envolver el JSON en un bloque de código.
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;
  if (!/^[[{]/.test(candidate)) return null;
  try { return JSON.parse(candidate); } catch { return null; }
}

class Run extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.pipeline
   * @param {Array}  o.agents
   * @param {object} o.settings   config.settings
   * @param {(providerId:string)=>string|null} o.resolveKey  descifra la clave (solo main)
   * @param {string} o.id
   */
  constructor({ pipeline, agents, settings, resolveKey, id }) {
    super();
    this.pipeline = pipeline;
    this.agents = new Map(agents.map((a) => [a.id, a]));
    this.settings = settings;
    this.resolveKey = resolveKey;
    this.id = id;

    this.controller = new AbortController();
    this.paused = false;
    this._resumeWaiters = [];

    this.state = 'idle';
    this.startedAt = null;
    this.endedAt = null;
    this.input = {};
    this.result = null;
    this.error = null;

    this.steps = new Map();       // nodeId → registro del paso
    this.branchResult = new Map();
    /** nodeId → resolver de la compuerta de aprobación que está esperando. */
    this.pendingApprovals = new Map();
    this.log = [];
    this.totals = { tokensIn: 0, tokensOut: 0, costUsd: 0, estimated: false };

    const { incoming, outgoing, nodes } = graph.index(pipeline);
    this.nodes = nodes;
    this.incoming = incoming;
    this.outgoing = outgoing;

    for (const n of pipeline.nodes) {
      this.steps.set(n.id, {
        id: n.id, kind: n.kind, title: n.title || n.id,
        state: 'pending', startedAt: null, endedAt: null, durMs: null,
        attempts: 0, tokens: { in: 0, out: 0 }, costUsd: 0,
        output: null, json: null, items: null, error: null,
        progress: null, model: null, estimated: false,
        toolCalls: [], approval: null,
      });
    }
  }

  /* ── Emisión ───────────────────────────────────────────────────────────── */

  emitEvent(type, payload = {}) {
    this.emit('event', { runId: this.id, type, at: Date.now(), ...payload });
  }

  addLog(src, msg, level = 'info') {
    const entry = { t: new Date().toISOString(), src, msg, level };
    this.log.push(entry);
    // El registro no puede crecer sin techo en una corrida larga.
    if (this.log.length > 5000) this.log.splice(0, this.log.length - 5000);
    this.emitEvent('log', { entry });
  }

  /* ── Control ───────────────────────────────────────────────────────────── */

  pause() {
    if (this.state !== 'running' || this.paused) return;
    this.paused = true;
    this.addLog('orquestador', 'Pausado: no se lanzan pasos nuevos; los que ya corren terminan.', 'muted');
    this.emitEvent('run:paused');
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.addLog('orquestador', 'Reanudado.');
    this.emitEvent('run:resumed');
    this._resumeWaiters.splice(0).forEach((fn) => fn());
  }

  abort(reason = 'Abortado por el usuario') {
    if (['done', 'failed', 'aborted'].includes(this.state)) return;
    this.aborting = reason;
    this.paused = false;
    this._resumeWaiters.splice(0).forEach((fn) => fn());
    // Una compuerta esperando decisión no puede quedar colgada para siempre.
    this.pendingApprovals.forEach((r) => r.reject(abortError()));
    this.pendingApprovals.clear();
    this.controller.abort();
    this.addLog('orquestador', reason, 'error');
  }

  /**
   * Resuelve una compuerta humana. Devuelve false si esa compuerta ya no está
   * esperando (llegó tarde, o se abortó la corrida).
   */
  resolveApproval(nodeId, approved, note = '') {
    const pending = this.pendingApprovals.get(nodeId);
    if (!pending) return false;
    this.pendingApprovals.delete(nodeId);
    pending.resolve({ approved: !!approved, note });
    return true;
  }

  /** Las compuertas que están esperando ahora mismo (para reenganchar la UI). */
  waitingApprovals() {
    return [...this.pendingApprovals.keys()].map((id) => ({
      nodeId: id,
      title: this.steps.get(id)?.title || id,
      question: this.steps.get(id)?.approval?.question || '',
    }));
  }

  _waitResume() {
    return new Promise((resolve) => this._resumeWaiters.push(resolve));
  }

  /* ── Contexto para plantillas y condiciones ────────────────────────────── */

  context(extra = {}) {
    const steps = {};
    for (const [id, s] of this.steps) {
      steps[id] = { output: s.output ?? '', json: s.json, items: s.items, state: s.state };
    }
    return { input: this.input, steps, run: { id: this.id }, ...extra };
  }

  /* ── Topología ─────────────────────────────────────────────────────────── */

  settled(id) {
    return ['done', 'skipped', 'failed'].includes(this.steps.get(id)?.state);
  }

  edgeActive(e) {
    const src = this.steps.get(e.from);
    if (src?.state !== 'done') return false;
    if (e.branch == null) return true;
    return String(e.branch) === String(this.branchResult.get(e.from));
  }

  /** 'run' | 'skip' | 'wait' */
  readiness(id) {
    const inc = this.incoming.get(id) || [];
    if (!inc.length) return 'run';                       // raíz
    if (!inc.every((e) => this.settled(e.from))) return 'wait';
    return inc.some((e) => this.edgeActive(e)) ? 'run' : 'skip';
  }

  markSkipped(id, reason) {
    const s = this.steps.get(id);
    s.state = 'skipped';
    s.endedAt = Date.now();
    this.emitEvent('step:skip', { nodeId: id, reason });
    this.addLog(id, reason || 'Omitido: ninguna entrada quedó activa.', 'muted');
  }

  /* ── Ejecución ─────────────────────────────────────────────────────────── */

  async start(input = {}) {
    this.input = input || {};
    this.state = 'running';
    this.startedAt = Date.now();
    providers.resetMock();

    const check = graph.validate(this.pipeline, [...this.agents.values()]);
    check.warnings.forEach((w) => this.addLog('validación', w, 'muted'));
    if (!check.ok) {
      this.state = 'failed';
      this.error = check.errors.join(' · ');
      this.endedAt = Date.now();
      check.errors.forEach((e) => this.addLog('validación', e, 'error'));
      this.emitEvent('run:done', { state: this.state, error: this.error });
      return this.toJSON();
    }

    this.emitEvent('run:start', {
      pipelineId: this.pipeline.id,
      pipelineName: this.pipeline.name,
      stepsTotal: this.steps.size,
    });
    this.addLog('orquestador', `Corrida ${this.id} iniciada — ${this.pipeline.name} (${this.steps.size} pasos)`);

    try {
      await this._loop();
    } catch (err) {
      if (!isAbort(err)) {
        this.error = err.message;
        this.addLog('orquestador', `Error del motor: ${err.message}`, 'error');
      }
    }

    const failed = [...this.steps.values()].filter((s) => s.state === 'failed');
    if (this.aborting) this.state = 'aborted';
    else if (failed.length) { this.state = 'failed'; this.error = this.error || failed[0].error; }
    else this.state = 'done';

    this.endedAt = Date.now();
    this.durMs = this.endedAt - this.startedAt;

    // Recolectar el resultado de los nodos de salida.
    const outs = this.pipeline.nodes.filter((n) => n.kind === 'output' && this.steps.get(n.id).state === 'done');
    this.result = outs.length === 1 ? this.steps.get(outs[0].id).output
      : outs.length ? Object.fromEntries(outs.map((n) => [n.id, this.steps.get(n.id).output]))
        : null;

    const verb = { done: 'completada', failed: 'fallida', aborted: 'abortada' }[this.state];
    this.addLog('orquestador', `Corrida ${verb} en ${(this.durMs / 1000).toFixed(1)}s — ${this.totals.tokensIn + this.totals.tokensOut} tokens`,
      this.state === 'done' ? 'info' : 'error');
    this.emitEvent('run:done', { state: this.state, durMs: this.durMs, totals: this.totals, error: this.error });

    return this.toJSON();
  }

  async _loop() {
    const limit = Math.max(1, Number(this.settings?.concurrency) || 4);
    const inflight = new Map();

    while (true) {
      // 1. Propagar omisiones hasta que no cambie nada más. Es un punto fijo:
      //    omitir un paso puede habilitar la omisión del que le sigue.
      let changed = true;
      while (changed) {
        changed = false;
        for (const id of this.steps.keys()) {
          if (this.steps.get(id).state !== 'pending') continue;
          if (this.readiness(id) !== 'skip') continue;
          this.markSkipped(id);
          changed = true;
        }
      }

      // 2. Lanzar lo que esté habilitado, hasta el límite.
      if (!this.paused && !this.aborting) {
        for (const id of this.steps.keys()) {
          if (inflight.size >= limit) break;
          if (this.steps.get(id).state !== 'pending') continue;
          if (this.readiness(id) !== 'run') continue;

          const p = this._runNode(this.nodes.get(id))
            .catch(() => {})            // el estado del paso ya quedó registrado
            .finally(() => inflight.delete(id));
          inflight.set(id, p);
        }
      }

      if (inflight.size) {
        await Promise.race([...inflight.values()]);
        continue;
      }

      // 3. Nada corriendo. ¿Queda algo por hacer?
      const pending = [...this.steps.values()].some((s) => s.state === 'pending');
      if (!pending) break;
      if (this.aborting) {
        for (const [id, s] of this.steps) {
          if (s.state === 'pending') this.markSkipped(id, 'Omitido: la corrida se abortó.');
        }
        break;
      }
      if (this.paused) { await this._waitResume(); continue; }

      // Quedaron pendientes sin nadie que los habilite: un deadlock lógico.
      // Mejor decirlo que colgarse esperando para siempre.
      const stuck = [...this.steps.entries()].filter(([, s]) => s.state === 'pending').map(([id]) => id);
      this.addLog('orquestador', `Pasos bloqueados sin poder avanzar: ${stuck.join(', ')}`, 'error');
      stuck.forEach((id) => this.markSkipped(id, 'Omitido: sus dependencias nunca se resolvieron.'));
      break;
    }
  }

  async _runNode(node) {
    const s = this.steps.get(node.id);
    s.state = 'running';
    s.startedAt = Date.now();
    this.emitEvent('step:start', { nodeId: node.id, kind: node.kind, title: s.title });

    const retries = Number(node.retries ?? this.pipeline.retries ?? 0);
    let lastErr = null;

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      s.attempts = attempt;
      try {
        await this._executeKind(node, s, attempt);
        s.state = 'done';
        s.endedAt = Date.now();
        s.durMs = s.endedAt - s.startedAt;
        this.emitEvent('step:done', {
          nodeId: node.id, durMs: s.durMs, tokens: s.tokens,
          output: typeof s.output === 'string' ? s.output.slice(0, 4000) : s.output,
        });
        return;
      } catch (err) {
        lastErr = err;
        if (isAbort(err) || this.aborting) {
          s.state = 'failed';
          s.error = 'Cancelado';
          s.endedAt = Date.now();
          s.durMs = s.endedAt - s.startedAt;
          this.emitEvent('step:fail', { nodeId: node.id, error: s.error, attempt, willRetry: false });
          return;
        }
        const willRetry = attempt <= retries;
        this.addLog(node.id, `${err.message}${willRetry ? ` — reintento ${attempt} de ${retries}` : ''}`,
          willRetry ? 'muted' : 'error');
        this.emitEvent('step:fail', { nodeId: node.id, error: err.message, attempt, willRetry });
        if (!willRetry) break;
        // Backoff exponencial con techo: no tiene sentido castigar 30s por un 429.
        await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)), this.controller.signal);
      }
    }

    s.state = 'failed';
    s.error = lastErr?.message || 'Falló sin mensaje.';
    s.endedAt = Date.now();
    s.durMs = s.endedAt - s.startedAt;
  }

  async _executeKind(node, s, attempt) {
    switch (node.kind) {
      case 'input': {
        s.json = this.input;
        s.output = template.stringify(this.input);
        this.addLog(node.id, `Entrada: ${Object.keys(this.input).length} campo(s)`);
        return;
      }

      case 'output': {
        const value = node.from ? template.render(node.from, this.context()) : '';
        s.output = value;
        s.json = tryJSON(value);
        this.addLog(node.id, `Salida recolectada (${value.length} caracteres)`);
        return;
      }

      case 'branch': {
        const result = expr.evaluate(node.when, this.context());
        this.branchResult.set(node.id, !!result);
        s.output = String(!!result);
        s.json = { result: !!result, when: node.when };
        this.addLog(node.id, `${node.when} → ${result ? 'verdadero' : 'falso'}`);
        return;
      }

      /* Compuerta humana: la corrida se queda esperando acá hasta que alguien
         decide. No hay timeout — un paso que se auto-aprueba por cansancio no
         es una aprobación. Si querés cortar, abortás la corrida. */
      case 'approval': {
        const question = node.question ? template.render(node.question, this.context()) : '';
        const preview = node.preview ? template.render(node.preview, this.context()) : '';
        s.state = 'waiting';
        s.approval = { question, preview, since: Date.now() };

        this.emitEvent('step:waiting', { nodeId: node.id, title: s.title, question, preview });
        this.addLog(node.id, `Esperando aprobación${question ? `: ${question}` : ''}`);

        const decision = await new Promise((resolve, reject) => {
          this.pendingApprovals.set(node.id, { resolve, reject });
        });

        this.branchResult.set(node.id, decision.approved);
        s.approval = { ...s.approval, ...decision, at: Date.now() };
        s.output = String(decision.approved);
        s.json = { approved: decision.approved, note: decision.note || '' };
        this.emitEvent('step:approved', { nodeId: node.id, approved: decision.approved, note: decision.note });
        this.addLog(node.id, `${decision.approved ? 'Aprobado' : 'Rechazado'}${decision.note ? ` — ${decision.note}` : ''}`);
        return;
      }

      case 'agent': {
        const out = await this._callAgent(node, this.context(), `${this.id}:${node.id}`, (delta, acc) => {
          s.progress = acc.length;
          this._emitToken(node.id, delta, acc.length);
        });
        s.output = out.text;
        s.json = tryJSON(out.text);
        s.model = out.model;
        this._account(s, out);
        this.addLog(node.id, `${out.model} · ${out.usage.in + out.usage.out} tokens${out.estimated ? ' (estimado)' : ''}`);
        return;
      }

      case 'fanout': {
        const raw = template.render(node.over, this.context());
        let items = tryJSON(raw);
        if (!Array.isArray(items)) {
          // Si `over` no dio un array, aceptamos una lista por líneas antes de
          // rendirnos: es lo que devuelve un modelo la mitad de las veces.
          items = String(raw).split('\n').map((l) => l.trim()).filter(Boolean);
        }
        if (!items.length) throw new Error(`El fan-out no recibió nada sobre qué iterar ("${node.over}").`);

        const limit = Math.max(1, Number(node.concurrency) || 4);
        const onItemError = node.itemErrors === 'skip' ? 'skip' : 'fail';
        const results = new Array(items.length).fill(null);
        const failures = [];
        let done = 0;

        this.addLog(node.id, `fan-out ×${items.length} · concurrencia ${limit}`);
        s.progress = { done: 0, total: items.length };
        this.emitEvent('step:progress', { nodeId: node.id, done: 0, total: items.length });

        let cursor = 0;
        const worker = async () => {
          while (true) {
            const i = cursor++;
            if (i >= items.length) return;
            if (this.aborting) throw abortError();
            try {
              const out = await this._callAgent(
                node,
                this.context({ item: items[i], index: i }),
                `${this.id}:${node.id}:${i}`,
              );
              results[i] = out.text;
              this._account(s, out);
              s.model = out.model;
            } catch (err) {
              if (isAbort(err)) throw err;
              failures.push({ index: i, error: err.message });
              this.addLog(`${node.id}[${i}]`, err.message, onItemError === 'skip' ? 'muted' : 'error');
              if (onItemError === 'fail') throw err;
            } finally {
              done++;
              s.progress = { done, total: items.length };
              this.emitEvent('step:progress', { nodeId: node.id, done, total: items.length });
            }
          }
        };

        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));

        const kept = results.filter((r) => r != null);
        if (!kept.length) throw new Error(`Las ${items.length} ramas del fan-out fallaron.`);
        if (failures.length) {
          this.addLog(node.id, `${failures.length} de ${items.length} ramas fallaron y se descartaron.`, 'muted');
        }

        s.items = kept;
        s.output = kept.join('\n\n---\n\n');
        s.json = kept;
        this.addLog(node.id, `${kept.length} de ${items.length} ramas completas`);
        return;
      }

      default:
        throw new Error(`Tipo de paso no implementado: ${node.kind}`);
    }
  }

  /**
   * Una llamada al proveedor, con su bucle de herramientas.
   *
   * El bucle es: el modelo responde, y si en vez de texto pidió herramientas se
   * ejecutan, se le devuelven los resultados y se le vuelve a preguntar. Tiene
   * tope de turnos porque un modelo que se queda en loop pidiendo la misma
   * herramienta consumiría tokens hasta vaciarte la cuenta.
   */
  async _callAgent(node, ctx, attemptKey, onToken) {
    const agent = this.agents.get(node.agent);
    if (!agent) throw new Error(`El agente "${node.agent}" no existe.`);

    const providerId = agent.provider || this.settings.defaultProvider || 'mock';
    const providerCfg = this.settings.providers?.[providerId] || {};
    const meta = providers.meta(providerId);
    if (!meta) throw new Error(`Proveedor desconocido: ${providerId}`);

    const key = meta.needsKey ? this.resolveKey(providerId) : null;
    if (meta.needsKey && !key) {
      throw new Error(`No hay clave configurada para ${meta.label}. Cargala en Ajustes.`);
    }

    const system = node.system || agent.system;
    const messages = [];
    if (system) messages.push({ role: 'system', content: template.render(system, ctx) });
    messages.push({ role: 'user', content: template.render(node.prompt, ctx) });

    const wanted = node.tools || agent.tools || [];
    const allowed = tools.allowedFor(wanted, { allowShell: !!this.settings.allowShell });
    const dropped = wanted.filter((t) => !allowed.includes(t));
    if (dropped.length) {
      this.addLog(node.id, `Herramientas no disponibles y descartadas: ${dropped.join(', ')}`, 'muted');
    }
    const toolDefs = tools.definitions(allowed);
    const maxTurns = Number(node.maxToolTurns ?? this.settings.maxToolTurns ?? 5);

    const timeoutMs = Number(node.timeoutMs ?? agent.timeoutMs ?? 120000);
    const totals = { in: 0, out: 0 };
    let cost = 0;
    let estimated = false;
    let resolvedModel = node.model || agent.model;

    for (let turn = 0; ; turn++) {
      // El timeout es POR LLAMADA, no por el bucle entero: un paso con tres
      // idas y vueltas legítimas no tiene por qué morir a los 120 s.
      const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeoutMs)]);
      let res;
      try {
        res = await providers.chat(providerId, providerCfg, {
          key,
          model: resolvedModel,
          messages,
          temperature: node.temperature ?? agent.temperature ?? 0.7,
          maxTokens: node.maxTokens ?? agent.maxTokens ?? 2048,
          tools: toolDefs.length ? toolDefs : undefined,
          signal,
          onToken,
          mock: node.mock || agent.mock,
          attemptKey: `${attemptKey}#${turn}`,
        });
      } catch (err) {
        // AbortSignal.timeout produce un TimeoutError; el abort del usuario, un
        // AbortError. Distinguirlos importa: uno es un fallo, el otro no.
        if (err?.name === 'TimeoutError') throw new Error(`Timeout de ${timeoutMs / 1000}s sin respuesta.`);
        if (isAbort(err) && !this.controller.signal.aborted) throw new Error(`Timeout de ${timeoutMs / 1000}s sin respuesta.`);
        throw err;
      }

      totals.in += res.usage?.in || 0;
      totals.out += res.usage?.out || 0;
      cost += res.costUsd || 0;
      estimated = estimated || !!res.estimated;
      resolvedModel = res.model || resolvedModel;

      if (!res.toolCalls?.length) {
        return { text: res.text, usage: totals, costUsd: cost, model: resolvedModel, estimated, turns: turn + 1 };
      }

      if (turn + 1 >= maxTurns) {
        throw new Error(`El paso pidió herramientas ${turn + 1} veces sin llegar a una respuesta (tope: ${maxTurns}).`);
      }

      messages.push({ role: 'assistant', content: res.text || null, tool_calls: res.toolCalls });

      for (const call of res.toolCalls) {
        if (this.aborting) throw abortError();
        const name = call.function?.name;
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch {
          // Argumentos ilegibles: se le devuelve el error al modelo para que
          // reintente bien, en vez de romper la corrida.
          messages.push({ role: 'tool', tool_call_id: call.id, content: `Error: los argumentos no son JSON válido.` });
          this.addLog(node.id, `${name}: argumentos ilegibles`, 'error');
          continue;
        }

        const brief = JSON.stringify(args).slice(0, 160);
        this.emitEvent('step:tool', { nodeId: node.id, tool: name, args, phase: 'start' });
        this.addLog(node.id, `→ ${name}(${brief})`);

        const out = await tools.execute(name, args, {
          workspace: this.settings.workspace,
          allowShell: !!this.settings.allowShell,
          signal: this.controller.signal,
        });

        const step = this.steps.get(node.id);
        step.toolCalls.push({ tool: name, args, ok: out.ok, output: tools.clip(out.output, 2000), at: Date.now() });
        this.emitEvent('step:tool', { nodeId: node.id, tool: name, ok: out.ok, phase: 'done' });
        this.addLog(node.id, `← ${name}: ${out.ok ? `${out.output.length} caracteres` : out.output}`, out.ok ? 'muted' : 'error');

        messages.push({ role: 'tool', tool_call_id: call.id, content: out.output });
      }
    }
  }

  _account(s, out) {
    s.tokens.in += out.usage?.in || 0;
    s.tokens.out += out.usage?.out || 0;
    s.costUsd += out.costUsd || 0;
    if (out.estimated) { s.estimated = true; this.totals.estimated = true; }
    this.totals.tokensIn += out.usage?.in || 0;
    this.totals.tokensOut += out.usage?.out || 0;
    this.totals.costUsd += out.costUsd || 0;
  }

  /** Los tokens llegan de a decenas por segundo; al renderer le mandamos ~11/s. */
  _emitToken(nodeId, delta, len) {
    const now = Date.now();
    this._lastToken = this._lastToken || new Map();
    if (now - (this._lastToken.get(nodeId) || 0) < TOKEN_THROTTLE_MS) return;
    this._lastToken.set(nodeId, now);
    this.emitEvent('step:token', { nodeId, len, delta });
  }

  /* ── Serialización ─────────────────────────────────────────────────────── */

  toJSON() {
    const steps = {};
    for (const [id, s] of this.steps) steps[id] = { ...s, tokens: { ...s.tokens } };
    const settledCount = [...this.steps.values()].filter((s) => s.state === 'done').length;

    return {
      id: this.id,
      pipelineId: this.pipeline.id,
      pipelineName: this.pipeline.name,
      state: this.state,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      durMs: this.durMs ?? (this.startedAt ? Date.now() - this.startedAt : null),
      input: this.input,
      result: this.result,
      error: this.error,
      stepsDone: settledCount,
      stepsTotal: this.steps.size,
      steps,
      branchResult: Object.fromEntries(this.branchResult),
      totals: { ...this.totals },
      log: this.log,
    };
  }
}

module.exports = { Run };
