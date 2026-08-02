/* ═══════════════════════════════════════════════════════════════════════════
   VECTOR — app
   Router y vistas que no son el grafo. El lienzo del pipeline vive en
   `graph-view.js` porque trae el editor entero adentro.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';
import { Tooltip, Toast, Menu, Modal } from './overlays.js';
import Palette from './palette.js';
import { raf2, initClickFlash, initScrollFades, bindSwitcher, countTo } from './motion.js';
import {
  fmtDur, fmtTokens, fmtUsd, fmtClock, relTime, monogram, markState, STATE_LABEL, describeSchedule,
} from './vocab.js';
import * as store from './store.js';
import { view, router, esc, mark, status, paint, head, attempt, bindEvents, releaseView } from './ui.js';
import { mountGraphView, relayoutEdges, currentPipelineId } from './graph-view.js';
import { designHTML, wireDesign } from './design-view.js';
import { makePipeline, slugify, autoLayout } from './graph-util.js';

const { S, api } = store;

/* ══ Correr ══════════════════════════════════════════════════════════════════ */

async function startRun(pipelineId, input) {
  const p = store.pipeline(pipelineId);
  const res = await attempt(() => api.runs.start(pipelineId, input), { errorTitle: 'No se pudo arrancar la corrida' });
  if (!res) return null;
  Toast.show({ title: 'Corrida iniciada', text: `${p?.name || pipelineId} · ${res.runId}`, icon: 'play' });
  if (currentView !== 'pipeline' || currentParam !== pipelineId) go('pipeline', pipelineId);
  return res.runId;
}

function askInputAndRun(pipelineId) {
  const p = store.pipeline(pipelineId);
  const pre = JSON.stringify(p?.input || {}, null, 2);
  Modal.show({
    title: 'Correr con entrada',
    sub: 'Lo que escribas acá queda disponible en los prompts como {{input.loQueSea}}.',
    body: `<div class="vc-field">
        <label class="vc-field__label">Entrada (JSON)</label>
        <textarea class="vc-textarea vc-textarea--mono" id="run-input" rows="6" spellcheck="false">${esc(pre)}</textarea>
      </div>`,
    actions: [
      { label: 'Cancelar', value: null },
      { label: 'Correr', value: 'go', variant: 'primary', autofocus: true },
    ],
  }).then((v) => {
    if (v !== 'go') return;
    const raw = document.getElementById('run-input')?.value ?? '{}';
    try {
      startRun(pipelineId, JSON.parse(raw));
    } catch (err) {
      Toast.error('La entrada no es JSON válido', err.message);
    }
  });
}

/* ══ CRUD de pipelines ═══════════════════════════════════════════════════════ */

function newPipelineModal() {
  const form = document.createElement('div');
  form.className = 'vc-col';
  form.style.gap = '16px';
  form.innerHTML = `
    <div class="vc-field">
      <label class="vc-field__label">Nombre</label>
      <input class="vc-input" id="np-name" placeholder="Research Digest" spellcheck="false">
    </div>
    <div class="vc-field">
      <label class="vc-field__label">Identificador</label>
      <input class="vc-input vc-input--mono" id="np-id" placeholder="research-digest" spellcheck="false">
      <span class="vc-field__hint" id="np-hint">Es el nombre del archivo en data/pipelines.</span>
    </div>
    <div class="vc-field">
      <label class="vc-field__label">Descripción (opcional)</label>
      <textarea class="vc-textarea" id="np-desc" rows="2" placeholder="Qué hace este pipeline…"></textarea>
    </div>`;

  const name = form.querySelector('#np-name');
  const id = form.querySelector('#np-id');
  const hint = form.querySelector('#np-hint');
  let idTouched = false;

  const check = () => {
    const taken = S.pipelines.some((p) => p.id === id.value.trim());
    id.classList.toggle('is-invalid', taken);
    hint.textContent = taken ? 'Ya existe un pipeline con ese identificador.' : 'Es el nombre del archivo en data/pipelines.';
    hint.parentElement.classList.toggle('vc-field__hint--error', taken);
  };
  // El id se deriva del nombre hasta que lo tocás a mano; ahí deja de seguirlo.
  name.addEventListener('input', () => { if (!idTouched) { id.value = slugify(name.value); check(); } });
  id.addEventListener('input', () => { idTouched = true; check(); });

  Modal.show({
    title: 'Nuevo pipeline',
    sub: 'Arranca con una entrada y una salida ya conectadas. Los pasos se agregan desde el lienzo.',
    body: form,
    actions: [
      { label: 'Cancelar', value: null },
      { label: 'Crear', value: 'go', variant: 'primary' },
    ],
  }).then(async (v) => {
    if (v !== 'go') return;
    const finalName = name.value.trim() || 'Pipeline nuevo';
    const finalId = slugify(id.value.trim() || finalName);
    if (S.pipelines.some((p) => p.id === finalId)) {
      Toast.error('Ese identificador ya existe', 'Elegí otro.');
      return;
    }
    const p = makePipeline(finalName);
    p.id = finalId;
    p.desc = form.querySelector('#np-desc').value.trim();
    autoLayout(p);
    if (!await attempt(() => api.pipelines.save(p), { errorTitle: 'No se pudo crear' })) return;
    await store.refreshPipelines();
    registerCommands();
    updateStatusbar();
    go('pipeline', p.id);
    Toast.show({ title: 'Pipeline creado', text: 'Agregá pasos con el + de la barra del lienzo.', icon: 'plus' });
  });
}

async function duplicatePipeline(id) {
  const src = store.pipeline(id);
  if (!src) return;
  const copy = structuredClone(src);
  let n = 2;
  while (S.pipelines.some((p) => p.id === `${src.id}-${n}`)) n++;
  copy.id = `${src.id}-${n}`;
  copy.name = `${src.name} (copia)`;
  if (!await attempt(() => api.pipelines.save(copy))) return;
  await store.refreshPipelines();
  registerCommands();
  updateStatusbar();
  viewPipelines();
  Toast.show({ title: 'Pipeline duplicado', text: copy.name, icon: 'duplicate' });
}

function renamePipeline(id) {
  const p = store.pipeline(id);
  if (!p) return;
  Modal.show({
    title: 'Renombrar pipeline',
    sub: 'El identificador no cambia: lo usan las corridas ya guardadas.',
    body: `<div class="vc-field">
        <label class="vc-field__label">Nombre</label>
        <input class="vc-input" id="rn-name" value="${esc(p.name)}" spellcheck="false">
      </div>
      <div class="vc-field" style="margin-top:14px">
        <label class="vc-field__label">Descripción</label>
        <textarea class="vc-textarea" id="rn-desc" rows="2">${esc(p.desc || '')}</textarea>
      </div>`,
    actions: [{ label: 'Cancelar', value: null }, { label: 'Guardar', value: 'go', variant: 'primary' }],
  }).then(async (v) => {
    if (v !== 'go') return;
    const next = structuredClone(p);
    next.name = document.getElementById('rn-name').value.trim() || p.name;
    next.desc = document.getElementById('rn-desc').value.trim();
    if (!await attempt(() => api.pipelines.save(next))) return;
    await store.refreshPipelines();
    registerCommands();
    if (currentView === 'pipeline' && currentParam === id) mountGraphView(id);
    else viewPipelines();
  });
}

async function removePipeline(id) {
  const p = store.pipeline(id);
  const runs = S.runs.filter((r) => r.pipelineId === id).length;
  const ok = await Modal.confirm({
    title: `¿Eliminar "${p?.name || id}"?`,
    sub: runs
      ? `Se borra su definición. Sus ${runs} corrida(s) quedan en el historial, huérfanas.`
      : 'Se borra el archivo de data/pipelines. Esto no se puede deshacer.',
    confirmLabel: 'Eliminar pipeline',
    danger: true,
  });
  if (!ok) return;
  if (!await attempt(() => api.pipelines.remove(id))) return;
  await store.refreshPipelines();
  registerCommands();
  updateStatusbar();
  go('pipelines');
  Toast.show({ title: 'Pipeline eliminado', text: p?.name || id, icon: 'trash' });
}

/* ══ CRUD de agentes ═════════════════════════════════════════════════════════ */

function agentModal(existing = null) {
  const a = existing || { provider: 'mock', model: 'mock-fast', temperature: 0.7, maxTokens: 2048 };
  const form = document.createElement('div');
  form.className = 'vc-col';
  form.style.gap = '14px';
  form.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div class="vc-field">
        <label class="vc-field__label">Nombre</label>
        <input class="vc-input" id="ag-name" value="${esc(a.name || '')}" placeholder="Triage" spellcheck="false">
      </div>
      <div class="vc-field">
        <label class="vc-field__label">Identificador</label>
        <input class="vc-input vc-input--mono" id="ag-id" value="${esc(a.id || '')}" placeholder="triage"
               spellcheck="false"${existing ? ' disabled' : ''}>
      </div>
    </div>
    <div class="vc-field">
      <label class="vc-field__label">Rol</label>
      <input class="vc-input" id="ag-role" value="${esc(a.role || '')}" placeholder="Clasifica y puntúa entradas por relevancia" spellcheck="false">
    </div>
    <div style="display:grid;grid-template-columns:1fr 1.4fr;gap:14px">
      <div class="vc-field">
        <label class="vc-field__label">Proveedor</label>
        <button class="vc-select" id="ag-provider">
          <span class="vc-select__value">${esc(S.catalog.find((c) => c.id === a.provider)?.label || a.provider)}</span>
          <i data-icon="chevronDown"></i>
        </button>
      </div>
      <div class="vc-field">
        <label class="vc-field__label">Modelo</label>
        <div class="vc-row" style="gap:6px">
          <input class="vc-input vc-input--mono vc-grow" id="ag-model" value="${esc(a.model || '')}" spellcheck="false">
          <button class="vc-iconbtn" id="ag-load" data-tip="Traer los modelos del proveedor"><i data-icon="download"></i></button>
        </div>
      </div>
    </div>
    <div class="vc-field">
      <label class="vc-field__label">Prompt de sistema (opcional)</label>
      <textarea class="vc-textarea vc-textarea--mono" id="ag-system" rows="3" spellcheck="false">${esc(a.system || '')}</textarea>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div class="vc-field">
        <label class="vc-field__label">Temperatura</label>
        <input class="vc-input vc-input--mono" type="number" id="ag-temp" value="${a.temperature ?? 0.7}" min="0" max="2" step="0.1">
      </div>
      <div class="vc-field">
        <label class="vc-field__label">Máx. tokens</label>
        <input class="vc-input vc-input--mono" type="number" id="ag-max" value="${a.maxTokens ?? 2048}" min="1" step="256">
      </div>
    </div>`;

  Icons.mount(form);

  let provider = a.provider;
  const nameEl = form.querySelector('#ag-name');
  const idEl = form.querySelector('#ag-id');
  if (!existing) nameEl.addEventListener('input', () => { idEl.value = slugify(nameEl.value); });

  form.querySelector('#ag-provider').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    Menu.show(btn, S.catalog.map((c) => ({
      label: c.label,
      selected: provider === c.id,
      onSelect: () => { provider = c.id; btn.querySelector('.vc-select__value').textContent = c.label; },
    })));
  });

  form.querySelector('#ag-load').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.innerHTML = Icons.spinner('vc-icon--sm');
    try {
      const res = await api.settings.test(provider);
      const modelEl = form.querySelector('#ag-model');
      Menu.show(btn, res.models.slice(0, 60).map((m) => ({
        label: m,
        selected: modelEl.value === m,
        onSelect: () => { modelEl.value = m; },
      })), { align: 'end' });
    } catch (err) {
      Toast.error('No se pudieron traer los modelos', err.message);
    } finally {
      btn.innerHTML = Icons.svg('download');
    }
  });

  return Modal.show({
    title: existing ? `Editar ${existing.name}` : 'Nuevo agente',
    sub: 'Un agente es un modelo con un rol. Los pasos del grafo lo eligen por su identificador.',
    body: form,
    width: 620,
    actions: [{ label: 'Cancelar', value: null }, { label: existing ? 'Guardar' : 'Crear', value: 'go', variant: 'primary' }],
  }).then(async (v) => {
    if (v !== 'go') return null;
    const id = existing ? existing.id : slugify(idEl.value.trim() || nameEl.value.trim(), 'agente');
    if (!existing && S.agents.some((x) => x.id === id)) {
      Toast.error('Ese identificador ya existe', 'Elegí otro.');
      return null;
    }
    const next = {
      ...(existing || {}),
      id,
      name: nameEl.value.trim() || id,
      mono: monogram(nameEl.value.trim() || id),
      role: form.querySelector('#ag-role').value.trim(),
      provider,
      model: form.querySelector('#ag-model').value.trim(),
      system: form.querySelector('#ag-system').value.trim() || undefined,
      temperature: Number(form.querySelector('#ag-temp').value),
      maxTokens: Number(form.querySelector('#ag-max').value),
    };
    if (!await attempt(() => api.agents.save(next), { errorTitle: 'No se pudo guardar el agente' })) return null;
    S.agents = await api.agents.list();
    updateStatusbar();
    Toast.show({ title: existing ? 'Agente actualizado' : 'Agente creado', text: next.name, icon: 'check' });
    return next;
  });
}

async function removeAgent(id) {
  const a = store.agent(id);
  const used = S.pipelines.flatMap((p) => (p.nodes || []).filter((n) => n.agent === id).map((n) => `${p.name} → ${n.title || n.id}`));
  const ok = await Modal.confirm({
    title: `¿Eliminar "${a?.name || id}"?`,
    sub: used.length
      ? `Lo usan ${used.length} paso(s): ${used.slice(0, 3).join(', ')}${used.length > 3 ? '…' : ''}. Esos pasos van a fallar hasta que les asignes otro.`
      : 'No lo usa ningún paso.',
    confirmLabel: 'Eliminar agente',
    danger: true,
  });
  if (!ok) return;
  if (!await attempt(() => api.agents.remove(id))) return;
  S.agents = await api.agents.list();
  updateStatusbar();
  viewAgents();
}

/* ══ Vista: Pipelines ════════════════════════════════════════════════════════ */

function viewPipelines() {
  const newBtn = '<button class="vc-btn vc-btn--primary vc-flashable" data-action="new-pipeline"><i data-icon="plus"></i> Nuevo pipeline</button>';

  if (!S.pipelines.length) {
    paint(head({ title: 'Pipelines', sub: 'Todavía no hay ninguno', actions: newBtn }) + `
      <div class="vc-grow" style="display:grid;place-items:center">
        <div class="vc-empty">
          ${Icons.svg('pipeline')}
          <div class="vc-empty__title">Sin pipelines</div>
          <div class="vc-empty__text">Un pipeline es una secuencia de pasos donde cada uno recibe la salida del anterior. Creá el primero y armalo en el lienzo.</div>
          <button class="vc-btn vc-btn--secondary vc-flashable" data-action="new-pipeline" style="margin-top:4px">
            <i data-icon="plus"></i> Crear el primero
          </button>
        </div>
      </div>`);
    return;
  }

  const cards = S.pipelines.map((p, i) => {
    const live = store.liveRunOf(p.id);
    const last = store.lastRunOf(p.id);
    const st = live ? 'running' : (last?.state === 'failed' ? 'failed' : last ? 'done' : 'idle');
    const when = live ? 'ahora' : relTime(last?.startedAt);

    return `
    <article class="vc-card vc-card--interactive vc-in-rise" style="--i:${i}" data-pipeline="${esc(p.id)}">
      <div class="vc-card__head">
        <div class="vc-grow" style="min-width:0">
          <div class="vc-subtitle vc-truncate">${esc(p.name)}</div>
          <div class="vc-meta" style="margin-top:2px">${esc(describeSchedule(p.schedule))}</div>
        </div>
        <button class="vc-iconbtn vc-iconbtn--sm" data-menu="pipeline" data-menu-arg="${esc(p.id)}" data-tip="Más acciones">
          <i data-icon="more"></i>
        </button>
      </div>
      <div class="vc-card__body">
        <p class="vc-meta vc-copyable" style="line-height:1.6;color:var(--vc-text-3);min-height:38px">${esc(p.desc || '')}</p>
        <div class="vc-row" style="gap:6px;margin-top:12px">
          <span class="vc-chip">${(p.nodes || []).length} pasos</span>
          ${(p.nodes || []).some((n) => n.kind === 'fanout') ? '<span class="vc-chip">fan-out</span>' : ''}
          ${(p.nodes || []).some((n) => n.kind === 'branch') ? '<span class="vc-chip">condicional</span>' : ''}
        </div>
      </div>
      <div class="vc-card__foot">
        ${status('agent', st)}
        <div class="vc-spacer"></div>
        <span class="vc-meta">${esc(when)}</span>
        <button class="vc-iconbtn vc-iconbtn--sm" data-run="${esc(p.id)}" data-tip="Correr ahora"><i data-icon="play"></i></button>
      </div>
    </article>`;
  }).join('');

  paint(head({
    title: 'Pipelines',
    sub: `${S.pipelines.length} definidos · ${[...S.live.values()].filter((l) => l.state === 'running').length} corriendo`,
    actions: newBtn,
  }) + `
    <div class="vc-scroll vc-grow" style="padding-left:24px;padding-right:24px">
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(296px,1fr));gap:16px">${cards}</div>
    </div>`);

  view.querySelectorAll('[data-pipeline]').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-menu]') || e.target.closest('[data-run]')) return;
      go('pipeline', card.dataset.pipeline);
    });
  });
  view.querySelectorAll('[data-run]').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); startRun(b.dataset.run); });
  });

  bindEvents((ev) => {
    if (['run:start', 'run:done'].includes(ev.type) && currentView === 'pipelines') viewPipelines();
  });
}

/* ══ Vista: Corridas ═════════════════════════════════════════════════════════ */

function viewRuns(filter = 'all') {
  const liveRows = [...S.live.values()]
    .filter((l) => l.state === 'running')
    .map((l) => ({
      id: l.runId, pipelineId: l.pipelineId, pipelineName: l.pipelineName, state: 'running',
      startedAt: l.startedAt, durMs: Date.now() - l.startedAt,
      stepsDone: Object.values(l.steps).filter((s) => s.state === 'done').length,
      stepsTotal: l.stepsTotal,
      tokensIn: l.totals?.tokensIn || 0, tokensOut: l.totals?.tokensOut || 0, costUsd: l.totals?.costUsd || 0,
    }));

  const all = [...liveRows, ...S.runs.filter((r) => !S.live.has(r.id))];
  const shown = all.filter((r) => filter === 'all'
    || (filter === 'active' && r.state === 'running')
    || (filter === 'failed' && ['failed', 'aborted'].includes(r.state)));

  const rows = shown.map((r) => `
    <tr class="vc-tr${['failed', 'aborted'].includes(r.state) ? ' is-failed' : ''}" data-run="${esc(r.id)}">
      <td class="vc-td--tight"><span class="vc-mono">${esc(r.id)}</span></td>
      <td>${esc(r.pipelineName || r.pipelineId)}</td>
      <td class="vc-td--tight">${status('agent', r.state)}</td>
      <td class="vc-td--tight vc-mono">${esc(fmtClock(r.startedAt))}</td>
      <td class="vc-td--num vc-mono">${esc(fmtDur(r.durMs))}</td>
      <td class="vc-td--num vc-mono">${r.stepsDone}/${r.stepsTotal}</td>
      <td class="vc-td--num vc-mono">${esc(fmtTokens((r.tokensIn || 0) + (r.tokensOut || 0)))}</td>
      <td class="vc-td--num vc-mono">${esc(fmtUsd(r.costUsd))}</td>
      <td class="vc-td--tight">
        <div class="vc-rowactions">
          <button class="vc-iconbtn vc-iconbtn--sm" data-rerun="${esc(r.pipelineId || '')}" data-tip="Volver a correr"><i data-icon="retry"></i></button>
          <button class="vc-iconbtn vc-iconbtn--sm" data-menu="run" data-menu-arg="${esc(r.id)}" data-tip="Más"><i data-icon="more"></i></button>
        </div>
      </td>
    </tr>`).join('');

  const k = store.todayTotals();

  paint(head({
    title: 'Corridas',
    sub: `${all.length} en el historial · ${k.active} activa${k.active === 1 ? '' : 's'}`,
    actions: `
      <div class="vc-segmented" id="run-filter">
        <button class="vc-segmented__opt ${filter === 'all' ? 'is-active' : ''}" data-value="all">Todas</button>
        <button class="vc-segmented__opt ${filter === 'active' ? 'is-active' : ''}" data-value="active">Activas</button>
        <button class="vc-segmented__opt ${filter === 'failed' ? 'is-active' : ''}" data-value="failed">Fallidas</button>
      </div>`,
  }) + `
    <div style="padding:0 24px 16px">
      <div class="vc-row" style="gap:40px">
        <div class="vc-stat"><span class="vc-stat__value vc-num"><span id="k-runs">0</span></span><span class="vc-stat__label">Corridas hoy</span></div>
        <div class="vc-stat"><span class="vc-stat__value vc-num"><span id="k-ok">0</span><span class="vc-stat__unit">%</span></span><span class="vc-stat__label">Éxito</span></div>
        <div class="vc-stat"><span class="vc-stat__value">${esc(fmtTokens(k.tokens))}</span><span class="vc-stat__label">Tokens hoy</span></div>
        <div class="vc-stat"><span class="vc-stat__value"><span class="vc-stat__unit">USD </span>${esc(fmtUsd(k.costUsd))}</span><span class="vc-stat__label">Gasto</span></div>
      </div>
    </div>

    <div class="vc-scroll vc-grow" style="padding-left:24px;padding-right:24px">
      ${shown.length ? `
      <table class="vc-table">
        <thead><tr>
          <th>Corrida</th><th>Pipeline</th><th>Estado</th><th>Inicio</th>
          <th style="text-align:right">Duración</th><th style="text-align:right">Pasos</th>
          <th style="text-align:right">Tokens</th><th style="text-align:right">USD</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>` : `
      <div class="vc-empty">
        ${Icons.svg('inbox')}
        <div class="vc-empty__title">${all.length ? 'Nada por acá' : 'Todavía no corriste nada'}</div>
        <div class="vc-empty__text">${all.length
          ? 'Ninguna corrida coincide con este filtro.'
          : 'Abrí un pipeline y apretá Correr: acá va a quedar el historial con sus tiempos, tokens y registro.'}</div>
      </div>`}
    </div>`);

  countTo(document.getElementById('k-runs'), k.runs);
  countTo(document.getElementById('k-ok'), k.ok);

  bindSwitcher(document.getElementById('run-filter'), (v) => viewRuns(v));
  view.querySelectorAll('[data-run]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      go('run', tr.dataset.run);
    });
  });

  // `runs:refreshed` llega DESPUÉS de releer el índice del disco: sin él la
  // tabla se repinta con los datos viejos y se queda así.
  bindEvents((ev) => {
    if (['run:start', 'run:done', 'runs:refreshed'].includes(ev.type) && currentView === 'runs') viewRuns(filter);
  });
}

/* ══ Vista: una corrida ══════════════════════════════════════════════════════ */

async function viewRun(runId) {
  paint(head({ crumbs: [{ label: 'Corridas', view: 'runs' }, { label: runId }], title: 'Cargando…' })
    + '<div class="vc-grow" style="padding:24px"><div class="vc-skeleton" style="height:180px"></div></div>');

  const run = await attempt(() => api.runs.get(runId), { errorTitle: 'No se pudo abrir la corrida' });
  if (!run) { go('runs'); return; }

  const t0 = run.startedAt;
  const t1 = run.endedAt || Date.now();
  const span = Math.max(1, t1 - t0);

  const rows = Object.values(run.steps).map((s, i) => {
    const from = s.startedAt ? ((s.startedAt - t0) / span) * 100 : 0;
    const width = s.startedAt ? (((s.endedAt || t1) - s.startedAt) / span) * 100 : 0;
    return `
    <div class="vc-tlrow" data-step="${esc(s.id)}">
      <div class="vc-tlrow__label">
        ${mark(s.kind, markState(s.state, true))}
        <span class="vc-tlrow__name">${esc(s.title)}</span>
      </div>
      <div class="vc-tlrow__track">
        <div class="vc-tlbar" data-state="${markState(s.state, true)}"
             style="--x:${from.toFixed(2)}%;--w:${Math.max(width, 0.6).toFixed(2)}%;--i:${i}"></div>
      </div>
      <div class="vc-tlrow__dur">${esc(fmtDur(s.durMs))}</div>
    </div>`;
  }).join('');

  const log = (run.log || []).map((l, i) => `
    <div class="vc-log__line ${l.level === 'muted' ? 'vc-log__line--muted' : ''}${l.level === 'error' ? ' vc-log__line--error' : ''}" style="animation-delay:${Math.min(i, 20) * 30}ms">
      <span class="vc-log__time">${esc(fmtClock(l.t))}</span>
      <span class="vc-log__src">${esc(l.src)}</span>
      <span class="vc-log__msg">${esc(l.msg)}</span>
    </div>`).join('');

  const ticks = [0, 25, 50, 75, 100].map((pct) =>
    `<span class="vc-tlaxis__tick" style="--x:${pct}%">${fmtDur((span * pct) / 100)}</span>`).join('');

  const isLive = run.state === 'running';
  const tokens = (run.totals?.tokensIn || 0) + (run.totals?.tokensOut || 0);

  paint(head({
    crumbs: [{ label: 'Corridas', view: 'runs' }, { label: run.id }],
    title: run.pipelineName || run.pipelineId,
    sub: `Corrida ${run.id} · ${fmtClock(run.startedAt)} · ${fmtDur(run.durMs)}${run.totals?.estimated ? ' · tokens estimados (mock)' : ''}`,
    actions: `
      <button class="vc-btn vc-btn--ghost vc-flashable" data-copy="${esc(run.id)}"><i data-icon="copy"></i> Copiar ID</button>
      ${isLive
        ? `<button class="vc-btn vc-btn--danger vc-flashable" data-action="abort" data-arg="${esc(run.id)}"><i data-icon="stop"></i> Abortar</button>`
        : `<button class="vc-btn vc-btn--secondary vc-flashable" data-rerun="${esc(run.pipelineId)}"><i data-icon="retry"></i> Volver a correr</button>`}`,
  }) + `
    <div class="vc-scroll vc-grow" style="padding-left:24px;padding-right:24px">
      ${run.error ? `
      <div class="vc-card" style="margin-bottom:16px;box-shadow:inset 0 0 0 1px var(--vc-danger-ring), var(--vc-e2)">
        <div class="vc-card__head">${Icons.svg('alert', 'vc-icon--sm')}<span class="vc-eyebrow" style="color:var(--vc-danger)">Falló</span></div>
        <div class="vc-card__body"><p class="vc-copyable vc-mono" style="font-size:11px;line-height:1.6;color:var(--vc-danger)">${esc(run.error)}</p></div>
      </div>` : ''}

      <div class="vc-card" style="padding:16px 12px;margin-bottom:16px">
        <div class="vc-tlaxis"><div></div><div class="vc-tlaxis__track">${ticks}</div><div></div></div>
        <div class="vc-timeline">${rows}</div>
      </div>

      <div class="vc-row" style="align-items:flex-start;gap:16px">
        <div class="vc-card vc-grow" style="min-width:0">
          <div class="vc-card__head">
            <span class="vc-eyebrow">Registro${isLive ? ' en vivo' : ''}</span>
            <div class="vc-spacer"></div>
            <button class="vc-iconbtn vc-iconbtn--sm" id="copy-log" data-tip="Copiar todo"><i data-icon="copy"></i></button>
          </div>
          <div class="vc-card__body">
            <div class="vc-sunken vc-log vc-scroll" style="padding-left:14px;padding-right:14px;max-height:280px;--vc-fade:16px">${log}</div>
          </div>
        </div>

        <div class="vc-card" style="width:260px;flex:0 0 auto">
          <div class="vc-card__head"><span class="vc-eyebrow">Consumo</span></div>
          <div class="vc-card__body">
            <div class="vc-col" style="gap:16px">
              <div class="vc-stat"><span class="vc-stat__value">${esc(fmtTokens(tokens))}</span><span class="vc-stat__label">Tokens</span></div>
              <div>
                <div class="vc-row" style="justify-content:space-between;margin-bottom:6px">
                  <span class="vc-meta">Progreso</span><span class="vc-meta vc-mono">${run.stepsDone}/${run.stepsTotal}</span>
                </div>
                <div class="vc-meter" style="--vc-pct:${Math.round((run.stepsDone / Math.max(1, run.stepsTotal)) * 100)}%"><div class="vc-meter__fill"></div></div>
              </div>
              <div class="vc-kv">
                <span class="vc-kv__k">Estado</span><span class="vc-kv__v">${STATE_LABEL[run.state] || run.state}</span>
                <span class="vc-kv__k">Costo</span><span class="vc-kv__v vc-mono">USD ${esc(fmtUsd(run.totals?.costUsd))}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      ${run.result ? `
      <div class="vc-card" style="margin-top:16px">
        <div class="vc-card__head"><span class="vc-eyebrow">Resultado</span></div>
        <div class="vc-card__body">
          <div class="vc-sunken vc-copyable" style="padding:12px 14px;font-size:12px;line-height:1.7;white-space:pre-wrap">${esc(typeof run.result === 'string' ? run.result : JSON.stringify(run.result, null, 2))}</div>
        </div>
      </div>` : ''}
      <div style="height:24px"></div>
    </div>`);

  document.getElementById('copy-log')?.addEventListener('click', () => {
    navigator.clipboard.writeText((run.log || []).map((l) => `${fmtClock(l.t)} ${l.src}  ${l.msg}`).join('\n'));
    Toast.show({ title: 'Registro copiado', text: `${(run.log || []).length} líneas al portapapeles.`, icon: 'copy' });
  });

  if (isLive) {
    bindEvents((ev) => {
      if (ev.runId !== runId) return;
      if (['step:done', 'step:fail', 'step:skip', 'run:done'].includes(ev.type) && currentView === 'run') viewRun(runId);
    });
  }
}

/* ══ Vista: Agentes ══════════════════════════════════════════════════════════ */

function viewAgents() {
  const newBtn = '<button class="vc-btn vc-btn--primary vc-flashable" data-action="new-agent"><i data-icon="plus"></i> Nuevo agente</button>';

  if (!S.agents.length) {
    paint(head({ title: 'Agentes', sub: 'Todavía no hay ninguno', actions: newBtn }) + `
      <div class="vc-grow" style="display:grid;place-items:center">
        <div class="vc-empty">${Icons.svg('agents')}
          <div class="vc-empty__title">Sin agentes</div>
          <div class="vc-empty__text">Un agente es un modelo con un rol y una configuración. Los pasos del grafo lo eligen por su identificador.</div>
          <button class="vc-btn vc-btn--secondary vc-flashable" data-action="new-agent" style="margin-top:4px"><i data-icon="plus"></i> Crear el primero</button>
        </div>
      </div>`);
    return;
  }

  const usage = new Map();
  for (const p of S.pipelines) {
    for (const n of p.nodes || []) if (n.agent) usage.set(n.agent, (usage.get(n.agent) || 0) + 1);
  }

  const rows = S.agents.map((a, i) => `
    <div class="vc-listitem vc-in-rise" role="button" tabindex="0" style="--i:${i}" data-agent="${esc(a.id)}">
      <span class="vc-avatar">${esc(a.mono || monogram(a.name))}</span>
      <span class="vc-listitem__main">
        <span class="vc-listitem__title">${esc(a.name)}</span>
        <span class="vc-listitem__sub">${esc(a.role || '')}</span>
      </span>
      <span class="vc-listitem__aside">
        <span class="vc-chip vc-chip--mono">${esc(a.model)}</span>
        <span class="vc-chip vc-chip--outline">${esc(S.catalog.find((c) => c.id === a.provider)?.label || a.provider)}</span>
        <span class="vc-meta" style="width:74px;text-align:right">${usage.get(a.id) || 0} paso${usage.get(a.id) === 1 ? '' : 's'}</span>
        <span class="vc-rowactions">
          <button class="vc-iconbtn vc-iconbtn--sm" data-edit-agent="${esc(a.id)}" data-tip="Editar"><i data-icon="edit"></i></button>
          <button class="vc-iconbtn vc-iconbtn--sm" data-menu="agent" data-menu-arg="${esc(a.id)}" data-tip="Más"><i data-icon="more"></i></button>
        </span>
      </span>
    </div>`).join('');

  paint(head({
    title: 'Agentes',
    sub: `${S.agents.length} definidos · ${new Set(S.agents.map((a) => a.provider)).size} proveedor(es)`,
    actions: newBtn,
  }) + `
    <div class="vc-scroll vc-grow" style="padding-left:24px;padding-right:24px">
      <div class="vc-list">${rows}</div>
    </div>`);

  view.querySelectorAll('[data-agent]').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      agentModal(store.agent(row.dataset.agent)).then((saved) => saved && viewAgents());
    });
  });
  view.querySelectorAll('[data-edit-agent]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      agentModal(store.agent(b.dataset.editAgent)).then((saved) => saved && viewAgents());
    });
  });
}

/* ══ Vista: Ajustes ══════════════════════════════════════════════════════════ */

function viewSettings() {
  const s = S.settings || { providers: {} };

  const providerCards = S.catalog.map((c) => {
    const cfg = s.providers[c.id] || {};
    const keyState = cfg.key;
    return `
    <div class="vc-card" style="margin-bottom:12px" data-provider="${esc(c.id)}">
      <div class="vc-card__head">
        <div class="vc-grow">
          <div class="vc-subtitle">${esc(c.label)}</div>
          <div class="vc-meta" style="margin-top:2px">${esc(c.keyHint)}</div>
        </div>
        ${keyState?.set
          ? (keyState.readable === false
            ? '<span class="vc-chip vc-chip--danger">clave ilegible</span>'
            : `<span class="vc-chip">clave ••••${esc(keyState.tail)}</span>`)
          : (c.needsKey ? '<span class="vc-chip vc-chip--danger">sin clave</span>' : '<span class="vc-chip vc-chip--outline">listo</span>')}
      </div>
      <div class="vc-card__body">
        ${keyState?.readable === false ? `
        <p class="vc-meta" style="color:var(--vc-danger);line-height:1.6;margin-bottom:14px">
          Hay una clave guardada pero ya no se puede descifrar. Pasa cuando se borra o se renombra
          la carpeta de datos de la app: la clave maestra que la protegía vivía ahí. Pegala de nuevo.
        </p>` : ''}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          ${c.defaultBaseUrl ? `
          <div class="vc-field">
            <label class="vc-field__label">URL base</label>
            <input class="vc-input vc-input--mono" data-baseurl="${esc(c.id)}" value="${esc(cfg.baseUrl || c.defaultBaseUrl)}" spellcheck="false">
          </div>` : '<div></div>'}
          ${c.needsKey ? `
          <div class="vc-field">
            <label class="vc-field__label">${keyState?.set ? 'Reemplazar clave' : 'Clave de API'}</label>
            <input class="vc-input vc-input--mono" type="password" data-key="${esc(c.id)}"
                   placeholder="${keyState?.set ? 'dejar vacío para conservar la actual' : 'pegá la clave acá'}"
                   autocomplete="off" spellcheck="false">
          </div>` : '<div></div>'}
        </div>
        <div class="vc-row" style="gap:8px;margin-top:14px">
          <button class="vc-btn vc-btn--secondary vc-flashable" data-save-provider="${esc(c.id)}"><i data-icon="save"></i> Guardar</button>
          <button class="vc-btn vc-btn--ghost vc-flashable" data-test="${esc(c.id)}"><i data-icon="zap"></i> Probar conexión</button>
          ${keyState?.set ? `<button class="vc-btn vc-btn--danger vc-flashable" data-clear-key="${esc(c.id)}"><i data-icon="trash"></i> Borrar clave</button>` : ''}
          <div class="vc-spacer"></div>
          <span class="vc-meta" data-test-result="${esc(c.id)}"></span>
        </div>
      </div>
    </div>`;
  }).join('');

  paint(head({ title: 'Ajustes', sub: 'Proveedores, claves y límites del motor' }) + `
    <div class="vc-scroll vc-grow" style="padding-left:24px;padding-right:24px">
      <div style="max-width:760px">
        ${!S.encryption ? `
        <div class="vc-card" style="margin-bottom:16px;box-shadow:inset 0 0 0 1px var(--vc-danger-ring), var(--vc-e2)">
          <div class="vc-card__head">${Icons.svg('alert', 'vc-icon--sm')}<span class="vc-eyebrow" style="color:var(--vc-danger)">Sin cifrado del sistema</span></div>
          <div class="vc-card__body"><p class="vc-meta">Windows no ofreció cifrado, así que las claves se guardan en texto plano dentro de <span class="vc-mono">data/config.json</span>. Tenelo en cuenta antes de cargar una clave real.</p></div>
        </div>` : ''}

        <section style="margin-bottom:32px">
          <div class="vc-eyebrow" style="margin-bottom:12px">Proveedores</div>
          ${providerCards}
          <p class="vc-meta vc-dim2" style="line-height:1.7">
            Las claves se guardan cifradas con DPAPI, atadas a tu cuenta de Windows: el archivo copiado a otra máquina no sirve.
            Nunca salen del proceso principal — la interfaz solo ve si están puestas y sus últimos cuatro caracteres.
          </p>
        </section>

        <section style="margin-bottom:32px">
          <div class="vc-eyebrow" style="margin-bottom:12px">Motor</div>
          <div class="vc-card"><div class="vc-card__body" style="padding-top:16px">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
              <div class="vc-field">
                <label class="vc-field__label">Pasos en paralelo: <span class="vc-mono" id="conc-label">${s.concurrency || 4}</span></label>
                <input type="range" class="vc-slider" id="conc" min="1" max="12" value="${s.concurrency || 4}">
                <span class="vc-field__hint">Cuántos pasos puede lanzar el motor a la vez en todo el grafo.</span>
              </div>
              <div class="vc-field">
                <label class="vc-field__label">Proveedor por defecto</label>
                <button class="vc-select" id="default-provider">
                  <span class="vc-select__value">${esc(S.catalog.find((c) => c.id === s.defaultProvider)?.label || s.defaultProvider)}</span>
                  <i data-icon="chevronDown"></i>
                </button>
                <span class="vc-field__hint">Se usa cuando un agente no dice cuál quiere.</span>
              </div>
              <div class="vc-field">
                <label class="vc-field__label">Turnos de herramientas por paso</label>
                <input class="vc-input vc-input--mono" type="number" id="max-turns" value="${s.maxToolTurns ?? 5}" min="1" max="20">
                <span class="vc-field__hint">Tope de idas y vueltas antes de cortar. Evita que un modelo en loop consuma tokens sin fin.</span>
              </div>
              <div class="vc-field">
                <label class="vc-field__label">Carpeta de trabajo</label>
                <input class="vc-input vc-input--mono" id="workspace-dir" value="${esc(s.workspaceDir || '')}" placeholder="${esc(S.workspace)}" spellcheck="false">
                <span class="vc-field__hint">Las herramientas de archivo no salen de acá. Vacío = la de por defecto.</span>
              </div>
            </div>
          </div></div>
        </section>

        <section style="margin-bottom:32px">
          <div class="vc-eyebrow" style="margin-bottom:12px">Herramientas</div>
          <div class="vc-card"><div class="vc-card__body" style="padding-top:16px">
            <label class="vc-row" style="gap:12px;align-items:flex-start">
              <button class="vc-switch${s.allowShell ? ' is-on' : ''}" id="allow-shell"></button>
              <span>
                <span class="vc-label">Permitir que los agentes ejecuten comandos</span>
                <span class="vc-field__hint" style="display:block;margin-top:4px;max-width:520px;line-height:1.6">
                  Con esto apagado, <span class="vc-mono">run_command</span> queda bloqueada aunque un agente
                  la tenga tildada. Es el cerrojo global: el segundo es el permiso por agente.
                  Los comandos corren en la carpeta de trabajo y quedan en el registro de la corrida.
                </span>
              </span>
            </label>
          </div></div>
        </section>

        <section style="margin-bottom:32px">
          <div class="vc-eyebrow" style="margin-bottom:12px">Datos</div>
          <div class="vc-card"><div class="vc-card__body" style="padding-top:16px">
            <div class="vc-kv">
              <span class="vc-kv__k">Carpeta</span><span class="vc-kv__v vc-mono vc-copyable">${esc(S.dataDir)}</span>
              <span class="vc-kv__k">Trabajo</span><span class="vc-kv__v vc-mono vc-copyable">${esc(S.workspace)}</span>
              <span class="vc-kv__k">Pipelines</span><span class="vc-kv__v">${S.pipelines.length} archivo(s) JSON, editables a mano</span>
              <span class="vc-kv__k">Corridas</span><span class="vc-kv__v">${S.runs.length} guardadas</span>
            </div>
          </div></div>
        </section>
        <div style="height:24px"></div>
      </div>
    </div>`);

  wireSettings();
}

function wireSettings() {
  const conc = document.getElementById('conc');
  const concLabel = document.getElementById('conc-label');
  const syncConc = () => {
    conc.style.setProperty('--vc-pct', `${((conc.value - 1) / 11) * 100}%`);
    concLabel.textContent = conc.value;
  };
  syncConc();
  conc.addEventListener('input', syncConc);
  conc.addEventListener('change', async () => {
    await attempt(() => api.settings.save({ concurrency: Number(conc.value) }));
    await store.refreshSettings();
    Toast.show({ title: 'Concurrencia actualizada', text: `Hasta ${conc.value} pasos en paralelo.`, icon: 'check' });
  });

  document.getElementById('max-turns')?.addEventListener('change', async (e) => {
    await attempt(() => api.settings.save({ maxToolTurns: Number(e.target.value) }));
    await store.refreshSettings();
  });

  document.getElementById('workspace-dir')?.addEventListener('change', async (e) => {
    await attempt(() => api.settings.save({ workspaceDir: e.target.value.trim() || null }));
    await store.refreshSettings();
    Toast.show({ title: 'Carpeta de trabajo actualizada', text: 'Aplica desde la próxima corrida.', icon: 'check' });
  });

  document.getElementById('allow-shell')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const turningOn = !btn.classList.contains('is-on');
    if (turningOn) {
      const ok = await Modal.confirm({
        title: '¿Permitir ejecución de comandos?',
        sub: 'Los agentes que tengan la herramienta tildada van a poder correr comandos de shell en la carpeta de trabajo. Un modelo que se equivoca ejecuta igual: dejalo apagado si no lo necesitás ahora mismo.',
        confirmLabel: 'Permitir',
      });
      if (!ok) return;
    }
    btn.classList.toggle('is-on', turningOn);
    await attempt(() => api.settings.save({ allowShell: turningOn }));
    await store.refreshSettings();
    Toast.show({
      title: turningOn ? 'Comandos habilitados' : 'Comandos bloqueados',
      text: turningOn ? 'Cada agente igual necesita tener la herramienta tildada.' : 'run_command queda inhabilitada en todos los pasos.',
      icon: turningOn ? 'terminal' : 'lock',
    });
  });

  document.getElementById('default-provider')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    Menu.show(btn, S.catalog.map((c) => ({
      label: c.label,
      selected: S.settings.defaultProvider === c.id,
      onSelect: async () => {
        await attempt(() => api.settings.save({ defaultProvider: c.id }));
        await store.refreshSettings();
        btn.querySelector('.vc-select__value').textContent = c.label;
      },
    })));
  });

  view.querySelectorAll('[data-save-provider]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.saveProvider;
      const urlEl = view.querySelector(`[data-baseurl="${CSS.escape(id)}"]`);
      const keyEl = view.querySelector(`[data-key="${CSS.escape(id)}"]`);
      if (urlEl) await attempt(() => api.settings.save({ providers: { [id]: { baseUrl: urlEl.value.trim() } } }));
      if (keyEl?.value.trim()) {
        await attempt(() => api.settings.setKey(id, keyEl.value.trim()));
        keyEl.value = '';
      }
      await store.refreshSettings();
      updateStatusbar();
      Toast.show({ title: 'Proveedor guardado', text: S.catalog.find((c) => c.id === id)?.label, icon: 'check' });
      viewSettings();
    });
  });

  view.querySelectorAll('[data-clear-key]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.clearKey;
      const ok = await Modal.confirm({
        title: '¿Borrar la clave?',
        sub: `Los pipelines que usen ${S.catalog.find((c) => c.id === id)?.label} van a fallar hasta que cargues otra.`,
        confirmLabel: 'Borrar clave',
        danger: true,
      });
      if (!ok) return;
      await attempt(() => api.settings.setKey(id, null));
      await store.refreshSettings();
      updateStatusbar();
      viewSettings();
    });
  });

  view.querySelectorAll('[data-test]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.test;
      const out = view.querySelector(`[data-test-result="${CSS.escape(id)}"]`);
      out.textContent = 'probando…';
      out.style.color = 'var(--vc-text-3)';
      try {
        const res = await api.settings.test(id);
        out.textContent = `${res.count} modelos disponibles`;
        out.style.color = 'var(--vc-text-2)';
        Toast.show({ title: 'Conexión OK', text: res.sample.slice(0, 4).join(' · '), icon: 'check' });
      } catch (err) {
        out.textContent = 'falló';
        out.style.color = 'var(--vc-danger)';
        Toast.error('No se pudo conectar', err.message);
      }
    });
  });
}

/* ══ Programación ════════════════════════════════════════════════════════════ */

function scheduleModal(pipelineId) {
  const p = store.pipeline(pipelineId);
  if (!p) return;
  const sc = typeof p.schedule === 'object' && p.schedule ? p.schedule : { enabled: false, kind: 'daily', at: '08:00' };
  const days = new Set(sc.days || [1, 2, 3, 4, 5]);

  const form = document.createElement('div');
  form.className = 'vc-col';
  form.style.gap = '16px';
  form.innerHTML = `
    <label class="vc-row" style="gap:12px">
      <button class="vc-switch${sc.enabled ? ' is-on' : ''}" id="sc-enabled"></button>
      <span class="vc-label">Correr automáticamente</span>
    </label>
    <div class="vc-field">
      <label class="vc-field__label">Cada cuánto</label>
      <div class="vc-segmented" id="sc-kind">
        <button class="vc-segmented__opt${sc.kind === 'interval' ? ' is-active' : ''}" data-value="interval">Intervalo</button>
        <button class="vc-segmented__opt${sc.kind === 'daily' ? ' is-active' : ''}" data-value="daily">Diario</button>
        <button class="vc-segmented__opt${sc.kind === 'weekly' ? ' is-active' : ''}" data-value="weekly">Semanal</button>
      </div>
    </div>
    <div class="vc-field" id="sc-interval-wrap">
      <label class="vc-field__label">Minutos entre corridas</label>
      <input class="vc-input vc-input--mono" type="number" id="sc-every" value="${sc.everyMin || 60}" min="1" max="10080">
    </div>
    <div class="vc-field" id="sc-at-wrap">
      <label class="vc-field__label">Hora</label>
      <input class="vc-input vc-input--mono" id="sc-at" value="${esc(sc.at || '08:00')}" placeholder="07:00" spellcheck="false">
    </div>
    <div class="vc-field" id="sc-days-wrap">
      <label class="vc-field__label">Días</label>
      <div class="vc-row" style="gap:6px" id="sc-days">
        ${['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'].map((d, i) =>
    `<button class="vc-chip${days.has(i) ? '' : ' vc-chip--outline'}" data-day="${i}" style="cursor:default">${d}</button>`).join('')}
      </div>
    </div>
    <p class="vc-meta vc-dim2" style="line-height:1.6">
      El reloj corre mientras Vector esté abierto. No es un servicio de Windows: si la app está
      cerrada no dispara, y al volver a abrirla tampoco recupera las corridas que se perdieron.
    </p>`;

  const kindSeg = form.querySelector('#sc-kind');
  let kind = sc.kind || 'daily';
  const syncVisibility = () => {
    form.querySelector('#sc-interval-wrap').style.display = kind === 'interval' ? '' : 'none';
    form.querySelector('#sc-at-wrap').style.display = kind === 'interval' ? 'none' : '';
    form.querySelector('#sc-days-wrap').style.display = kind === 'weekly' ? '' : 'none';
  };
  syncVisibility();
  bindSwitcher(kindSeg, (v) => { kind = v; syncVisibility(); });

  form.querySelector('#sc-enabled').addEventListener('click', (e) => e.currentTarget.classList.toggle('is-on'));
  form.querySelectorAll('[data-day]').forEach((b) => {
    b.addEventListener('click', () => {
      const d = Number(b.dataset.day);
      days.has(d) ? days.delete(d) : days.add(d);
      b.classList.toggle('vc-chip--outline', !days.has(d));
    });
  });

  Modal.show({
    title: `Programar "${p.name}"`,
    sub: 'Una corrida disparada por reloj es idéntica a una que arrancás vos.',
    body: form,
    width: 520,
    actions: [{ label: 'Cancelar', value: null }, { label: 'Guardar', value: 'go', variant: 'primary' }],
  }).then(async (v) => {
    if (v !== 'go') return;
    const next = structuredClone(p);
    next.schedule = {
      enabled: form.querySelector('#sc-enabled').classList.contains('is-on'),
      kind,
      everyMin: Number(form.querySelector('#sc-every').value) || 60,
      at: form.querySelector('#sc-at').value.trim() || '08:00',
      days: [...days].sort(),
    };
    if (!await attempt(() => api.pipelines.save(next))) return;
    await store.refreshPipelines();
    Toast.show({
      title: next.schedule.enabled ? 'Programado' : 'Programación desactivada',
      text: describeSchedule(next.schedule),
      icon: 'clock',
    });
    if (currentView === 'pipelines') viewPipelines();
  });
}

/* ══ Vista: Herramientas ═════════════════════════════════════════════════════ */

function viewTools() {
  const usage = new Map();
  for (const p of S.pipelines) {
    for (const n of p.nodes || []) {
      for (const t of n.tools || []) usage.set(t, [...(usage.get(t) || []), `${p.name} → ${n.title || n.id}`]);
    }
  }
  const shellOn = !!S.settings?.allowShell;

  const cards = S.tools.map((t, i) => {
    const used = usage.get(t.name) || [];
    const blocked = t.danger && !shellOn;
    return `
    <div class="vc-card vc-in-rise" style="--i:${i};margin-bottom:12px">
      <div class="vc-card__head">
        ${Icons.svg(t.icon, 'vc-icon--lg')}
        <div class="vc-grow" style="min-width:0">
          <div class="vc-row" style="gap:8px">
            <span class="vc-subtitle">${esc(t.label)}</span>
            <span class="vc-chip vc-chip--mono">${esc(t.name)}</span>
            ${t.danger ? '<span class="vc-chip vc-chip--danger">shell</span>' : ''}
          </div>
          <div class="vc-meta" style="margin-top:4px;line-height:1.6">${esc(t.description)}</div>
        </div>
        ${blocked
    ? '<span class="vc-chip vc-chip--danger">bloqueada</span>'
    : `<span class="vc-chip">${used.length} paso${used.length === 1 ? '' : 's'}</span>`}
      </div>
      ${used.length ? `<div class="vc-card__body">
        <div class="vc-row" style="flex-wrap:wrap;gap:6px">
          ${used.map((u) => `<span class="vc-chip vc-chip--outline">${esc(u)}</span>`).join('')}
        </div>
      </div>` : ''}
    </div>`;
  }).join('');

  paint(head({
    title: 'Herramientas',
    sub: 'Lo que un agente puede hacer además de escribir',
    actions: '<button class="vc-btn vc-btn--ghost vc-flashable" data-goto="settings"><i data-icon="settings"></i> Ajustes</button>',
  }) + `
    <div class="vc-scroll vc-grow" style="padding-left:24px;padding-right:24px">
      <div style="max-width:760px">
        <p class="vc-meta vc-copyable" style="line-height:1.7;margin-bottom:20px;max-width:620px">
          Se activan por paso, desde el inspector del lienzo. Las de archivo quedan confinadas a
          <span class="vc-mono">${esc(S.workspace)}</span> — una ruta que intente salir de ahí falla.
          ${shellOn
    ? 'La ejecución de comandos está <b>habilitada</b>: cada agente igual necesita tenerla tildada.'
    : 'La ejecución de comandos está <b>bloqueada</b> globalmente; se habilita en Ajustes.'}
        </p>
        ${cards}
        <div style="height:24px"></div>
      </div>
    </div>`);
}

/* ══ Vistas menores ══════════════════════════════════════════════════════════ */

const EMPTY = {
  library: { icon: 'library', title: 'Biblioteca', text: 'Prompts reutilizables, esquemas de salida y artefactos que dejan las corridas. Todavía no está implementado.' },
};

function viewEmpty(key) {
  const e = EMPTY[key];
  paint(head({ title: e.title, sub: 'Próxima fase' }) + `
    <div class="vc-grow" style="display:grid;place-items:center">
      <div class="vc-empty">${Icons.svg(e.icon)}
        <div class="vc-empty__title">${esc(e.title)}</div>
        <div class="vc-empty__text">${esc(e.text)}</div>
      </div>
    </div>`);
}

function viewDesign() {
  paint(head({
    title: 'Design system',
    sub: 'Todos los primitivos del sistema, vivos',
    actions: '<button class="vc-btn vc-btn--ghost vc-flashable" id="replay"><i data-icon="retry"></i> Repetir entradas</button>',
  }) + designHTML());

  wireDesign(view);
  document.getElementById('replay')?.addEventListener('click', () => {
    const body = document.getElementById('design-body');
    body.style.animation = 'none';
    void body.offsetWidth;
    body.style.animation = 'vc-glide-in 420ms var(--vc-ease) both';
  });
}

/* ══ Router ══════════════════════════════════════════════════════════════════ */

const VIEWS = {
  pipelines: viewPipelines,
  pipeline: mountGraphView,
  runs: () => viewRuns('all'),
  run: viewRun,
  agents: viewAgents,
  tools: viewTools,
  library: () => viewEmpty('library'),
  design: viewDesign,
  settings: viewSettings,
};

const NAV_OF = { pipeline: 'pipelines', run: 'runs' };

let currentView = null;
let currentParam = null;

function go(name, param = null) {
  if (!VIEWS[name]) return;
  if (name === currentView && param === currentParam) return;

  releaseView();
  currentView = name;
  currentParam = param;

  const navKey = NAV_OF[name] || name;
  document.querySelectorAll('.vc-navitem').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.view === navKey));

  VIEWS[name](param);
  updateTitlebarContext();

  view.classList.remove('vc-view');
  void view.offsetWidth;
  view.classList.add('vc-view');
}
router.go = go;

function updateTitlebarContext() {
  const ctx = document.getElementById('titlebar-context');
  const live = [...S.live.values()].find((l) => l.state === 'running');
  ctx.innerHTML = live
    ? `${Icons.svg('runs', 'vc-icon--sm')}<span>${esc(live.pipelineName)} · ${esc(live.runId)}</span>`
    : '';
}

/* ══ Shell ═══════════════════════════════════════════════════════════════════ */

const MENUS = {
  pipeline: (id) => [
    { label: 'Correr ahora', icon: 'play', onSelect: () => startRun(id) },
    { label: 'Correr con entrada…', icon: 'edit', onSelect: () => askInputAndRun(id) },
    { sep: true },
    { label: 'Abrir el lienzo', icon: 'pipeline', onSelect: () => go('pipeline', id) },
    { label: 'Programar…', icon: 'clock', onSelect: () => scheduleModal(id) },
    { label: 'Renombrar…', icon: 'edit', onSelect: () => renamePipeline(id) },
    { label: 'Duplicar', icon: 'duplicate', onSelect: () => duplicatePipeline(id) },
    { label: 'Validar', icon: 'check', onSelect: () => validatePipeline(id) },
    { sep: true },
    { label: 'Eliminar', icon: 'trash', danger: true, onSelect: () => removePipeline(id) },
  ],
  run: (id) => [
    { label: 'Ver detalle', icon: 'eye', onSelect: () => go('run', id) },
    { label: 'Copiar id', icon: 'copy', onSelect: () => navigator.clipboard.writeText(id) },
    { sep: true },
    {
      label: 'Borrar corrida',
      icon: 'trash',
      danger: true,
      onSelect: async () => {
        const ok = await Modal.confirm({ title: `¿Borrar ${id}?`, sub: 'Se elimina su registro y su línea de tiempo.', confirmLabel: 'Borrar', danger: true });
        if (!ok) return;
        await attempt(() => api.runs.remove(id));
        await store.refreshRuns();
        viewRuns('all');
      },
    },
  ],
  agent: (id) => [
    { label: 'Editar…', icon: 'edit', onSelect: () => agentModal(store.agent(id)).then((s) => s && viewAgents()) },
    { label: 'Duplicar', icon: 'duplicate', onSelect: () => agentModal({ ...store.agent(id), id: '', name: `${store.agent(id).name} copia` }).then((s) => s && viewAgents()) },
    { sep: true },
    { label: 'Eliminar', icon: 'trash', danger: true, onSelect: () => removeAgent(id) },
  ],
};

async function validatePipeline(id) {
  const res = await attempt(() => api.pipelines.validate(id), { errorTitle: 'No se pudo validar' });
  if (!res) return;
  if (res.ok && !res.warnings.length) Toast.show({ title: 'Pipeline válido', text: 'Sin errores ni advertencias.', icon: 'check' });
  else if (res.ok) Toast.show({ title: `Válido, con ${res.warnings.length} advertencia(s)`, text: res.warnings.join(' · '), icon: 'alert' });
  else Toast.error(`${res.errors.length} error(es)`, res.errors.join(' · '));
}

function wireShell() {
  const w = window.vector?.win;
  document.getElementById('win-min')?.addEventListener('click', () => w?.minimize());
  document.getElementById('win-close')?.addEventListener('click', () => w?.close());
  const maxBtn = document.getElementById('win-max');
  maxBtn?.addEventListener('click', () => w?.toggleMaximize());
  w?.onMaximized((isMax) => {
    maxBtn.innerHTML = Icons.svg(isMax ? 'winRestore' : 'winMax');
    maxBtn.setAttribute('aria-label', isMax ? 'Restaurar' : 'Maximizar');
  });

  document.querySelectorAll('.vc-navitem').forEach((b) =>
    b.addEventListener('click', () => go(b.dataset.view)));

  document.getElementById('btn-palette')?.addEventListener('click', () => Palette.toggle());
  document.getElementById('btn-new')?.addEventListener('click', newPipelineModal);

  // El editor del grafo pide crear un agente desde su selector.
  window.addEventListener('vector:new-agent', () => {
    agentModal().then((saved) => { if (saved && currentView === 'pipeline') mountGraphView(currentParam); });
  });

  view.addEventListener('click', (e) => {
    const crumb = e.target.closest('[data-goto]');
    if (crumb) go(crumb.dataset.goto, crumb.dataset.param || null);
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      navigator.clipboard.writeText(copy.dataset.copy);
      Toast.show({ title: 'Copiado', text: copy.dataset.copy, icon: 'copy' });
    }
  });

  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-menu]');
    if (!trigger) return;
    e.stopPropagation();
    const build = MENUS[trigger.dataset.menu];
    if (build) Menu.show(trigger, build(trigger.dataset.menuArg), { align: 'end' });
  });

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (el) {
      const a = el.dataset.action;
      const arg = el.dataset.arg;
      if (a === 'new-pipeline') newPipelineModal();
      if (a === 'new-agent') agentModal().then((s) => s && viewAgents());
      if (a === 'run' && currentParam) startRun(currentParam);
      if (a === 'pause' || a === 'resume' || a === 'abort') {
        const live = [...S.live.values()].find((l) => l.pipelineId === currentPipelineId() || l.runId === arg);
        const id = arg || live?.runId;
        if (!id) return;
        if (a === 'pause') await attempt(() => api.runs.pause(id));
        if (a === 'resume') await attempt(() => api.runs.resume(id));
        if (a === 'abort') {
          const ok = await Modal.confirm({
            title: `¿Abortar ${id}?`,
            sub: 'Los pasos ya terminados se conservan; el resto no se ejecuta.',
            confirmLabel: 'Abortar corrida',
            danger: true,
          });
          if (ok) await attempt(() => api.runs.abort(id));
        }
      }
    }
    const rerun = e.target.closest('[data-rerun]');
    if (rerun?.dataset.rerun) { e.stopPropagation(); startRun(rerun.dataset.rerun); }
  });
}

function updateStatusbar() {
  const k = store.todayTotals();
  document.getElementById('stat-active').textContent = k.active;
  document.getElementById('stat-tokens').textContent = fmtTokens(k.tokens);
  document.getElementById('stat-cost').textContent = fmtUsd(k.costUsd);

  const real = store.hasRealProvider();
  document.getElementById('stat-providers').innerHTML =
    `${mark('agent', real ? 'done' : 'waiting')}<span>${real ? 'proveedor configurado' : 'solo mock'}</span>`;

  document.querySelector('[data-view="pipelines"] .vc-navitem__count').textContent = S.pipelines.length;
  document.querySelector('[data-view="runs"] .vc-navitem__count').textContent = k.active || S.runs.length;
  document.querySelector('[data-view="agents"] .vc-navitem__count').textContent = S.agents.length;

  updateTitlebarContext();
}

function registerCommands() {
  Palette.clear();
  Palette.register([
    { id: 'new-pipeline', group: 'Crear', icon: 'plus', label: 'Nuevo pipeline', run: newPipelineModal },
    { id: 'new-agent', group: 'Crear', icon: 'plus', label: 'Nuevo agente', run: () => agentModal().then((s) => s && viewAgents()) },
    { id: 'nav-pipelines', group: 'Ir a', icon: 'pipeline', label: 'Pipelines', run: () => go('pipelines') },
    { id: 'nav-runs', group: 'Ir a', icon: 'runs', label: 'Corridas', run: () => go('runs') },
    { id: 'nav-agents', group: 'Ir a', icon: 'agents', label: 'Agentes', run: () => go('agents') },
    { id: 'nav-settings', group: 'Ir a', icon: 'settings', label: 'Ajustes', run: () => go('settings') },
    { id: 'nav-design', group: 'Ir a', icon: 'design', label: 'Design system', run: () => go('design') },
    ...S.pipelines.flatMap((p) => [
      { id: `run-${p.id}`, group: 'Correr', icon: 'play', label: `Correr ${p.name}`, hint: 'pipeline', run: () => startRun(p.id) },
      { id: `open-${p.id}`, group: 'Abrir', icon: 'pipeline', label: `Abrir ${p.name}`, hint: 'lienzo', run: () => go('pipeline', p.id) },
    ]),
  ]);
}

/* ══ Arranque ════════════════════════════════════════════════════════════════ */

async function boot() {
  Icons.mount(document);
  Tooltip.init();
  Palette.init();
  initClickFlash();
  initScrollFades();
  wireShell();

  try {
    await store.boot();
  } catch (err) {
    paint(`<div class="vc-grow" style="display:grid;place-items:center">
      <div class="vc-empty">${Icons.svg('alert')}
        <div class="vc-empty__title">No se pudo iniciar</div>
        <div class="vc-empty__text vc-copyable">${esc(err.message)}</div>
      </div></div>`);
    return;
  }

  registerCommands();
  updateStatusbar();

  store.onEvent((ev) => {
    if (['run:start', 'run:done', 'runs:refreshed'].includes(ev.type)) {
      updateStatusbar();
      registerCommands();
    }
  });

  // El reloj disparó algo mientras mirabas otra cosa: hay que enterarse.
  api.runs.onScheduled((info) => {
    Toast.show({
      title: 'Corrida programada',
      text: `${info.pipelineName} arrancó sola · ${info.runId}`,
      icon: 'clock',
    });
  });

  go(S.pipelines.length ? 'pipelines' : 'settings');

  raf2(() => {
    const splash = document.getElementById('boot-splash');
    if (!splash) return;
    splash.style.opacity = '0';
    splash.addEventListener('transitionend', () => splash.remove(), { once: true });
    setTimeout(() => splash.remove(), 600);
  });

  window.addEventListener('resize', () => {
    if (currentView === 'pipeline') relayoutEdges();
  });
}

boot();
