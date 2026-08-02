/* ═══════════════════════════════════════════════════════════════════════════
   VECTOR — vista del pipeline (lienzo + editor)
   El protagonista de la app. Muestra el grafo, lo sigue en vivo mientras corre
   y — cuando no corre — deja construirlo con el mouse.

   Dos modos, uno solo activo por vez:
     · EDICIÓN   sin corrida en curso: arrastrar, conectar, borrar, configurar.
     · OBSERVACIÓN  con corrida en curso: todo bloqueado. Editar el grafo que se
       está ejecutando dejaría la corrida hablando de un pipeline que ya no existe.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';
import { Toast, Menu, Modal } from './overlays.js';
import { raf2, initScrollFades } from './motion.js';
import { markState, STATE_LABEL, fmtDur, fmtTokens } from './vocab.js';
import * as store from './store.js';
import {
  view, router, esc, mark, paint, head, attempt, bindEvents,
} from './ui.js';
import {
  NODE_W, KIND_LABEL, KIND_ICON, makeNode, autoLayout, wouldCycle,
  freeSpot, availableRefs, uniqueId, renameNode, groupBox, makeGroup, migrateGroups, BRANCHING,
} from './graph-util.js';

const { S, api } = store;

/* ── Estado del editor ───────────────────────────────────────────────────── */

let P = null;                  // copia de trabajo del pipeline
let zoom = 0.8;

/**
 * La corrida que el lienzo está MOSTRANDO — que no es lo mismo que una corrida
 * en curso. Cuando termina se conserva la foto final: acabás de ejecutar algo y
 * querés ver cómo fue, no un grafo en blanco. `live` es lo que bloquea la
 * edición; el resto del tiempo es solo una capa de información encima.
 * { runId, steps, branch, live }
 */
let shownRun = null;
let selectedNodeId = null;
let selectedEdgeIdx = null;
let selectedGroupId = null;
/** Selección adicional (shift+click). El "primario" sigue siendo selectedNodeId:
    es el que muestra el inspector, porque un formulario no puede editar cinco
    nodos a la vez sin volverse un misterio. */
let multi = new Set();
let userPickedNode = false;
let lastGraphId = null;

let undoStack = [];
let redoStack = [];
let saveTimer = null;
let saveState = 'saved';       // saved | dirty | saving | error
let checkTimer = null;

const editable = () => !shownRun?.live;

/* ── Montaje ─────────────────────────────────────────────────────────────── */

export function mountGraphView(pipelineId) {
  const source = store.pipeline(pipelineId);
  if (!source) { router.go('pipelines'); return; }

  if (lastGraphId !== pipelineId) {
    lastGraphId = pipelineId;
    selectedNodeId = null;
    selectedEdgeIdx = null;
    userPickedNode = false;
    undoStack = [];
    redoStack = [];
    saveState = 'saved';
    shownRun = null;
  }

  const live = store.liveRunOf(pipelineId);
  if (live) shownRun = { runId: live.runId, steps: live.steps, branch: live.branch, live: true };
  // Copia de trabajo: el editor muta libremente sin ensuciar el espejo del store
  // hasta que el guardado confirma.
  P = migrateGroups(structuredClone(source));

  render();
  bindEvents((ev) => onGraphEvent(ev));
  if (!live) loadLastRun(pipelineId);
}

/**
 * Trae la última corrida de este pipeline para pintar sus estados encima del
 * grafo. Va después del primer render y sin bloquear: abrir el lienzo tiene que
 * ser instantáneo aunque el historial tarde.
 */
async function loadLastRun(pipelineId) {
  const summary = S.runs.find((r) => r.pipelineId === pipelineId);
  if (!summary) return;
  const full = await api.runs.get(summary.id).catch(() => null);
  // Si mientras tanto arrancó una corrida o cambiaste de grafo, no pisamos nada.
  if (!full || lastGraphId !== pipelineId || shownRun?.live) return;
  shownRun = { runId: full.id, steps: full.steps, branch: full.branchResult || {}, live: false };
  render();
}

function render() {
  // El repintado es completo, así que hay que preservar dónde estaba mirando el
  // usuario: agregar un nodo no puede saltarle el lienzo a otro lado.
  const prev = document.getElementById('canvas');
  const keepScroll = prev ? { l: prev.scrollLeft, t: prev.scrollTop } : null;

  const live = shownRun?.live ? shownRun : null;
  const steps = shownRun?.steps || {};
  const hasRun = !!shownRun;
  const stage = P.stage || { w: 1760, h: 800 };

  const nodes = (P.nodes || []).map((n, i) => nodeHTML(n, i, steps[n.id], hasRun)).join('');
  const groups = (P.groups || []).map((g) => {
    const b = groupBox(P, g);
    if (!b) return '';                    // grupo sin miembros: no se dibuja
    return `
    <div class="vc-group${selectedGroupId === g.id ? ' is-selected' : ''}" data-group="${esc(g.id)}"
         style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px">
      <span class="vc-group__label" data-group-label="${esc(g.id)}">${esc(g.label)}</span>
    </div>`;
  }).join('');

  paint(head({
    crumbs: [{ label: 'Pipelines', view: 'pipelines' }, { label: P.name }],
    title: P.name,
    sub: live ? progressText(live)
      : shownRun ? `Última corrida ${shownRun.runId} · edición libre`
        : (P.desc || `${(P.nodes || []).length} pasos · edición libre`),
    actions: `
      <span id="save-state" class="vc-savestate">${saveStateHTML()}</span>
      <button class="vc-iconbtn" id="toggle-inspector" data-tip="Ocultar panel"><i data-icon="panel"></i></button>
      <button class="vc-iconbtn" data-menu="pipeline" data-menu-arg="${esc(P.id)}" data-tip="Más acciones"><i data-icon="more"></i></button>
      <span id="run-controls">${runControlsHTML(live)}</span>`,
  }) + `
    <div class="vc-viewbody">
      <div class="vc-viewbody__main">
        <div class="vc-canvas${editable() ? ' is-editable' : ''}" id="canvas" tabindex="0">
          <div class="vc-canvas__stage" id="stage"
               style="width:${stage.w}px;height:${stage.h}px;transform:scale(${zoom})">
            ${groups}
            <svg class="vc-edges" id="edges" width="${stage.w}" height="${stage.h}"></svg>
            ${nodes}
          </div>
        </div>

        <div class="vc-canvasbar">
          ${editable() ? `
            <button class="vc-iconbtn vc-iconbtn--sm" id="add-node" data-tip="Agregar paso"><i data-icon="plus"></i></button>
            <button class="vc-iconbtn vc-iconbtn--sm" id="auto-layout" data-tip="Ordenar el grafo"><i data-icon="fit"></i></button>
            <button class="vc-iconbtn vc-iconbtn--sm" id="undo" data-tip="Deshacer" data-tip-key="Ctrl Z"><i data-icon="undo"></i></button>
            <button class="vc-iconbtn vc-iconbtn--sm" id="redo" data-tip="Rehacer" data-tip-key="Ctrl Y"><i data-icon="redo"></i></button>
            <span class="vc-vr" style="margin:0 4px;height:16px"></span>` : `
            <span class="vc-chip" style="margin-right:4px">${Icons.svg('lock', 'vc-icon--sm')} en curso</span>`}
          <button class="vc-iconbtn vc-iconbtn--sm" data-zoom="-1" data-tip="Alejar"><i data-icon="zoomOut"></i></button>
          <span class="vc-canvasbar__zoom" id="zoom-label">${Math.round(zoom * 100)}%</span>
          <button class="vc-iconbtn vc-iconbtn--sm" data-zoom="1" data-tip="Acercar"><i data-icon="zoomIn"></i></button>
          <button class="vc-iconbtn vc-iconbtn--sm" data-zoom="fit" data-tip="Ajustar a la ventana"><i data-icon="fit"></i></button>
        </div>

        <div class="vc-validation" id="validation"></div>
      </div>
      ${inspectorHTML(pickNode(), steps, hasRun)}
    </div>`);

  raf2(() => { drawEdges(); paintEdges(); });
  wireCanvas(keepScroll);
  wireInspector();
  refreshUndoButtons();
  runValidation();
}

function progressText(live) {
  const done = Object.values(live.steps).filter((s) => ['done', 'skipped', 'failed'].includes(s.state)).length;
  const total = S.live.get(live.runId)?.stepsTotal ?? (P.nodes || []).length;
  return `Corrida ${live.runId} en curso · ${done} de ${total} pasos`;
}

function runControlsHTML(live) {
  if (!live || live.state !== 'running') {
    return '<button class="vc-btn vc-btn--primary vc-flashable" data-action="run"><i data-icon="play"></i> Correr</button>';
  }
  return `
    <button class="vc-btn vc-btn--secondary vc-flashable" data-action="${live.paused ? 'resume' : 'pause'}">
      <i data-icon="${live.paused ? 'play' : 'pause'}"></i> ${live.paused ? 'Reanudar' : 'Pausar'}
    </button>
    <button class="vc-btn vc-btn--danger vc-flashable" data-action="abort"><i data-icon="stop"></i> Abortar</button>`;
}

function saveStateHTML() {
  if (saveState === 'saving') return `${Icons.spinner('vc-icon--sm')}<span>guardando</span>`;
  if (saveState === 'error') return `${Icons.svg('alert', 'vc-icon--sm')}<span>no se guardó</span>`;
  if (saveState === 'dirty') return `${Icons.svg('edit', 'vc-icon--sm')}<span>sin guardar</span>`;
  return `${Icons.svg('check', 'vc-icon--sm')}<span>guardado</span>`;
}

function nodeHTML(n, i, step, hasRun) {
  const st = markState(step?.state, hasRun);
  const agent = n.agent ? store.agent(n.agent) : null;
  const meta = agent
    ? `<span class="vc-node__model vc-truncate">${esc(n.model || agent.model)}</span>`
    : `<span class="vc-truncate">${esc(n.sub || KIND_LABEL[n.kind] || n.kind)}</span>`;

  const pct = step?.progress?.total ? Math.round((step.progress.done / step.progress.total) * 100) : 0;
  const incomplete = isIncomplete(n);

  return `
    <div class="vc-node${selectedNodeId === n.id || multi.has(n.id) ? ' is-selected' : ''}${incomplete ? ' is-incomplete' : ''}"
         data-node="${esc(n.id)}" data-state="${st}" data-kind="${n.kind}"
         style="left:${n.x || 0}px;top:${n.y || 0}px;--i:${i}">
      <span class="vc-node__port vc-node__port--in" data-port="in"></span>
      <span class="vc-node__port vc-node__port--out" data-port="out"></span>
      <div class="vc-node__head">
        ${mark(n.kind, st)}
        <span class="vc-node__title">${esc(n.title || n.id)}</span>
        <span class="vc-node__idx">${String(i + 1).padStart(2, '0')}</span>
      </div>
      <div class="vc-node__meta">
        ${meta}
        <div class="vc-spacer"></div>
        <span class="vc-mono vc-node__dur" style="font-size:10px">${step?.durMs != null ? esc(fmtDur(step.durMs)) : ''}</span>
      </div>
      <div class="vc-meter vc-node__meter" style="--vc-pct:${pct}%;${st === 'running' ? '' : 'display:none'}">
        <div class="vc-meter__fill"></div>
      </div>
    </div>`;
}

/** Un paso al que le falta lo mínimo para poder correr se marca sin esperar al motor. */
function isIncomplete(n) {
  if (n.kind === 'agent') return !n.agent || !n.prompt;
  if (n.kind === 'fanout') return !n.agent || !n.prompt || !n.over;
  if (n.kind === 'branch') return !n.when;
  if (n.kind === 'output') return !n.from;
  return false;   // entrada y aprobación funcionan sin configurar nada
}

/* ══ Aristas ═════════════════════════════════════════════════════════════════ */

function nodeBox(id) {
  const stage = document.getElementById('stage');
  const el = stage?.querySelector(`[data-node="${CSS.escape(id)}"]`);
  return el ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : null;
}

function edgePath(a, b) {
  const sameCol = Math.abs(a.x - b.x) < 20;
  if (sameCol) {
    const x = a.x + a.w / 2;
    const y1 = a.y + a.h; const y2 = b.y;
    const dy = (y2 - y1) * 0.42;
    return { d: `M ${x} ${y1} C ${x} ${y1 + dy}, ${x} ${y2 - dy}, ${x} ${y2 - 6}`, angle: 90, tx: b.x + b.w / 2, ty: b.y - 5 };
  }
  const x1 = a.x + a.w; const y1 = a.y + a.h / 2;
  const x2 = b.x; const y2 = b.y + b.h / 2;
  const dx = Math.max(46, (x2 - x1) * 0.46);
  return {
    d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2 - 7} ${y2}`,
    angle: 0, tx: b.x - 6, ty: b.y + b.h / 2,
  };
}

function drawEdges() {
  const svg = document.getElementById('edges');
  if (!svg) return;
  const parts = [];

  (P.edges || []).forEach((e, i) => {
    const a = nodeBox(e.from); const b = nodeBox(e.to);
    if (!a || !b) return;
    const { d, angle, tx, ty } = edgePath(a, b);

    // Trazo grueso e invisible: una bezier de 1.5 px es imposible de clickear.
    parts.push(`<path class="vc-edge-hit" data-edge="${i}" d="${d}"/>`);
    parts.push(`<path class="vc-edge vc-edge--idle" data-edge="${i}" d="${d}"/>`);
    parts.push(`<path class="vc-arrow" data-edge="${i}" data-state="idle"
      d="M 0 -3.6 L 5.2 0 L 0 3.6 Z" transform="translate(${tx} ${ty}) rotate(${angle})"/>`);

    if (e.label) {
      const sameCol = Math.abs(a.x - b.x) < 20;
      const lx = sameCol ? a.x + a.w / 2 : (a.x + a.w + b.x) / 2;
      const ly = sameCol ? (a.y + a.h + b.y) / 2 : (a.y + a.h / 2 + b.y + b.h / 2) / 2;
      parts.push(`<foreignObject x="${lx - 40}" y="${ly - 11}" width="80" height="22">
        <div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;justify-content:center">
          <span class="vc-edgelabel" style="position:static;transform:none">${esc(e.label)}</span>
        </div></foreignObject>`);
    }
  });

  parts.push('<path id="temp-edge" class="vc-edge vc-edge--pending" d=""/>');
  svg.innerHTML = parts.join('');
}

function edgeState(e, steps, branch, hasRun) {
  if (!hasRun) return 'idle';
  const src = steps[e.from]?.state;
  const dst = steps[e.to]?.state;
  const settled = ['done', 'skipped', 'failed'].includes(src);
  const taken = src === 'done' && (e.branch == null || Boolean(e.branch) === Boolean(branch[e.from]));
  if (settled && !taken) return 'muted';
  if (dst === 'running') return 'live';
  if (dst === 'failed') return 'failed';
  if (taken) return 'done';
  return 'idle';
}

function paintEdges() {
  const steps = shownRun?.steps || {};
  const branch = shownRun?.branch || {};

  (P.edges || []).forEach((e, i) => {
    const st = edgeState(e, steps, branch, !!shownRun);
    const path = document.querySelector(`.vc-edge[data-edge="${i}"]`);
    const arrow = document.querySelector(`.vc-arrow[data-edge="${i}"]`);
    const selected = selectedEdgeIdx === i ? ' is-selected' : '';
    if (path) path.setAttribute('class', `vc-edge vc-edge--${st === 'muted' ? 'idle' : st}${st === 'muted' ? ' is-dim' : ''}${selected}`);
    if (arrow) arrow.setAttribute('data-state', st === 'muted' ? 'idle' : st);
  });
}

/* ══ Mutaciones ══════════════════════════════════════════════════════════════ */

/**
 * Toda modificación pasa por acá: guarda el estado anterior para deshacer,
 * aplica, y agenda el guardado. Es el único camino a `P`.
 */
function mutate(fn, { rerender = true } = {}) {
  if (!editable()) {
    Toast.show({ title: 'El pipeline está corriendo', text: 'Esperá a que termine o abortá la corrida para editarlo.', icon: 'lock' });
    return false;
  }
  undoStack.push(structuredClone(P));
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];

  fn(P);
  scheduleSave();
  if (rerender) render(); else { refreshUndoButtons(); runValidation(); }
  return true;
}

function undo() {
  if (!undoStack.length || !editable()) return;
  redoStack.push(structuredClone(P));
  P = undoStack.pop();
  scheduleSave();
  render();
}

function redo() {
  if (!redoStack.length || !editable()) return;
  undoStack.push(structuredClone(P));
  P = redoStack.pop();
  scheduleSave();
  render();
}

function refreshUndoButtons() {
  const u = document.getElementById('undo');
  const r = document.getElementById('redo');
  if (u) u.disabled = !undoStack.length;
  if (r) r.disabled = !redoStack.length;
  if (u) u.style.opacity = undoStack.length ? '' : '.4';
  if (r) r.style.opacity = redoStack.length ? '' : '.4';
}

function setSaveState(next) {
  saveState = next;
  const el = document.getElementById('save-state');
  if (el) { el.innerHTML = saveStateHTML(); el.dataset.state = next; }
}

/** Autoguardado con freno: escribir en cada tecla castigaría el disco sin sentido. */
function scheduleSave() {
  setSaveState('dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    setSaveState('saving');
    try {
      await api.pipelines.save(structuredClone(P));
      await store.refreshPipelines();
      setSaveState('saved');
      runValidation();
    } catch (err) {
      setSaveState('error');
      Toast.error('No se pudo guardar el pipeline', err.message);
    }
  }, 500);
}

/** El chequeo del motor, no una copia: es la misma validación que corre al ejecutar. */
async function runValidation() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(async () => {
    const host = document.getElementById('validation');
    if (!host) return;
    let res;
    try { res = await api.pipelines.validate(P.id); } catch { return; }
    if (!host.isConnected) return;

    const items = [
      ...res.errors.map((m) => ({ level: 'error', m })),
      ...res.warnings.map((m) => ({ level: 'warn', m })),
    ];
    if (!items.length) { host.innerHTML = ''; host.classList.remove('is-open'); return; }

    host.innerHTML = `
      <div class="vc-validation__inner">
        ${items.slice(0, 4).map((it) => `
          <div class="vc-validation__row vc-validation__row--${it.level}">
            ${Icons.svg(it.level === 'error' ? 'alert' : 'info', 'vc-icon--sm')}
            <span>${esc(it.m)}</span>
          </div>`).join('')}
        ${items.length > 4 ? `<div class="vc-validation__row"><span class="vc-dim2">y ${items.length - 4} más…</span></div>` : ''}
      </div>`;
    host.classList.add('is-open');
  }, 260);
}

/* ══ Interacción del lienzo ══════════════════════════════════════════════════ */

function setZoom(next) {
  zoom = Math.min(1.6, Math.max(0.35, next));
  const stage = document.getElementById('stage');
  const label = document.getElementById('zoom-label');
  if (stage) stage.style.transform = `scale(${zoom})`;
  if (label) label.textContent = `${Math.round(zoom * 100)}%`;
}

/** Coordenadas del puntero en el sistema del stage (deshaciendo el zoom). */
function toStage(e) {
  const stage = document.getElementById('stage');
  const r = stage.getBoundingClientRect();
  return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
}

function wireCanvas(keepScroll) {
  const canvas = document.getElementById('canvas');
  if (!canvas) return;

  view.querySelectorAll('[data-zoom]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.zoom;
      if (v === 'fit') {
        setZoom(Math.min(1, (canvas.clientWidth - 48) / (P.stage?.w || 1760)));
        canvas.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
      } else setZoom(zoom + Number(v) * 0.15);
    });
  });

  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(zoom - Math.sign(e.deltaY) * 0.08);
  }, { passive: false });

  document.getElementById('add-node')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const items = [
      { groupLabel: 'Agregar paso' },
      ...Object.keys(KIND_LABEL).map((kind) => ({
        label: KIND_LABEL[kind],
        icon: KIND_ICON[kind],
        onSelect: () => addNode(kind),
      })),
      { sep: true },
      {
        label: `Agrupar seleccionados (${selection().length})`,
        icon: 'layers',
        key: 'Ctrl G',
        disabled: selection().length < 2,
        onSelect: groupSelected,
      },
    ];
    Menu.show(e.currentTarget, items, { align: 'start' });
  });

  document.getElementById('auto-layout')?.addEventListener('click', () => {
    mutate((p) => autoLayout(p));
    Toast.show({ title: 'Grafo ordenado', text: 'Los pasos se acomodaron por dependencias.', icon: 'fit' });
  });
  document.getElementById('undo')?.addEventListener('click', undo);
  document.getElementById('redo')?.addEventListener('click', redo);

  document.getElementById('toggle-inspector')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const insp = document.getElementById('inspector-host');
    const hidden = insp.classList.toggle('is-collapsed');
    btn.classList.toggle('is-active', !hidden);
    btn.dataset.tip = hidden ? 'Mostrar panel' : 'Ocultar panel';
  });
  document.getElementById('toggle-inspector')?.classList.add('is-active');

  wirePointer(canvas);
  wireKeys(canvas);

  raf2(() => {
    // Repintado: se restaura la vista tal cual estaba.
    if (keepScroll) {
      canvas.scrollLeft = keepScroll.l;
      canvas.scrollTop = keepScroll.t;
      return;
    }
    // Primer montaje: se abre mirando lo que está pasando.
    const target = canvas.querySelector('.vc-node[data-state="running"]') || canvas.querySelector('.vc-node');
    if (!target) return;
    canvas.scrollLeft = Math.max(0, target.offsetLeft * zoom - canvas.clientWidth / 2 + (target.offsetWidth * zoom) / 2);
    canvas.scrollTop = Math.max(0, target.offsetTop * zoom - canvas.clientHeight / 2);
  });
}

/** Capturar el puntero es una optimización, no un requisito: si el id ya no
    está activo (o el evento es sintético) el gesto igual tiene que funcionar. */
function capture(el, e) {
  try { el.setPointerCapture(e.pointerId); } catch { /* seguimos sin captura */ }
}

/** Pan del lienzo, arrastre de nodos y tirado de aristas, en un solo gesto. */
function wirePointer(canvas) {
  let mode = null;        // 'pan' | 'drag' | 'link'
  let ctx = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const port = e.target.closest('.vc-node__port');
    const node = e.target.closest('.vc-node');

    if (port && node && editable() && port.dataset.port === 'out') {
      mode = 'link';
      ctx = { from: node.dataset.node, box: nodeBox(node.dataset.node) };
      capture(canvas, e);
      canvas.classList.add('is-linking');
      e.preventDefault();
      return;
    }

    if (node) {
      if (!editable()) { selectNode(node.dataset.node); return; }
      const id = node.dataset.node;
      // Arrastrar uno de varios elegidos los mueve a todos: es lo que espera la
      // mano después de haber hecho el trabajo de seleccionarlos.
      const group = selection().includes(id) ? selection() : [id];
      mode = 'drag';
      ctx = {
        el: node, id, shift: e.shiftKey, moved: false, sx: e.clientX, sy: e.clientY,
        items: group.map((nid) => {
          const n = P.nodes.find((x) => x.id === nid);
          return { n, el: canvas.querySelector(`[data-node="${CSS.escape(nid)}"]`), ox: n.x, oy: n.y };
        }),
      };
      capture(canvas, e);
      e.preventDefault();
      return;
    }

    mode = 'pan';
    ctx = { x: e.clientX, y: e.clientY, l: canvas.scrollLeft, t: canvas.scrollTop };
    canvas.classList.add('is-panning');
    canvas.setPointerCapture(e.pointerId);
    // Click en el vacío: se suelta la selección.
    selectedEdgeIdx = null;
    paintEdges();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!mode) return;

    if (mode === 'pan') {
      canvas.scrollLeft = ctx.l - (e.clientX - ctx.x);
      canvas.scrollTop = ctx.t - (e.clientY - ctx.y);
      return;
    }

    if (mode === 'drag') {
      const dx = (e.clientX - ctx.sx) / zoom;
      const dy = (e.clientY - ctx.sy) / zoom;
      if (!ctx.moved && Math.hypot(dx, dy) < 4) return;   // todavía es un click
      ctx.moved = true;
      for (const it of ctx.items) {
        // Snap a 10: los números redondos hacen que el JSON quede legible.
        const nx = Math.max(0, Math.round((it.ox + dx) / 10) * 10);
        const ny = Math.max(0, Math.round((it.oy + dy) / 10) * 10);
        if (it.el) { it.el.style.left = `${nx}px`; it.el.style.top = `${ny}px`; }
        it.nx = nx; it.ny = ny;
        it.n.x = nx; it.n.y = ny;          // provisional, para redibujar
      }
      drawEdges(); paintEdges(); repositionGroups();
      return;
    }

    if (mode === 'link') {
      const p = toStage(e);
      const a = ctx.box;
      const temp = document.getElementById('temp-edge');
      if (!temp || !a) return;
      const x1 = a.x + a.w; const y1 = a.y + a.h / 2;
      const dx = Math.max(40, (p.x - x1) * 0.5);
      temp.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${p.x - dx} ${p.y}, ${p.x} ${p.y}`);
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.vc-node');
      canvas.querySelectorAll('.vc-node').forEach((n) => n.classList.toggle('is-linktarget', n === over && n.dataset.node !== ctx.from));
    }
  });

  const finish = (e) => {
    if (!mode) return;
    const wasMode = mode;
    const c = ctx;
    mode = null; ctx = null;
    canvas.classList.remove('is-panning', 'is-linking');

    if (wasMode === 'drag') {
      if (!c.moved) { selectNode(c.id, { additive: c.shift }); return; }
      // Confirmar el movimiento como una mutación deshacible. Los nodos ya están
      // donde van, así que se restaura el origen y se re-aplica por `mutate`.
      const moves = c.items.map((it) => ({ id: it.n.id, x: it.nx, y: it.ny }));
      c.items.forEach((it) => { it.n.x = it.ox; it.n.y = it.oy; });
      mutate((p) => {
        for (const m of moves) {
          const n = p.nodes.find((x) => x.id === m.id);
          if (n) { n.x = m.x; n.y = m.y; }
        }
      }, { rerender: false });
      drawEdges(); paintEdges(); repositionGroups();
      return;
    }

    if (wasMode === 'link') {
      document.getElementById('temp-edge')?.setAttribute('d', '');
      canvas.querySelectorAll('.is-linktarget').forEach((n) => n.classList.remove('is-linktarget'));
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.vc-node');
      if (over && over.dataset.node !== c.from) connect(c.from, over.dataset.node);
    }
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', () => { mode = null; ctx = null; canvas.classList.remove('is-panning', 'is-linking'); });

  // Selección de aristas por su trazo grueso invisible.
  canvas.addEventListener('click', (e) => {
    const label = e.target.closest('[data-group-label]');
    if (label) {
      selectGroup(label.dataset.groupLabel);
      canvas.focus();
      return;
    }
    const hit = e.target.closest('.vc-edge-hit');
    if (!hit) return;
    selectedEdgeIdx = Number(hit.dataset.edge);
    selectedNodeId = null;
    selectedGroupId = null;
    multi.clear();
    canvas.querySelectorAll('.vc-node, .vc-group').forEach((n) => n.classList.remove('is-selected'));
    paintEdges();
    canvas.focus();
  });

  canvas.addEventListener('dblclick', (e) => {
    const label = e.target.closest('[data-group-label]');
    if (label) renameGroup(label.dataset.groupLabel);
  });
}

/** Reacomoda los marcos mientras se arrastra, sin repintar el grafo entero. */
function repositionGroups() {
  for (const g of P.groups || []) {
    const el = document.querySelector(`.vc-group[data-group="${CSS.escape(g.id)}"]`);
    const b = groupBox(P, g);
    if (!el || !b) continue;
    el.style.left = `${b.x}px`;
    el.style.top = `${b.y}px`;
    el.style.width = `${b.w}px`;
    el.style.height = `${b.h}px`;
  }
}

function wireKeys(canvas) {
  canvas.addEventListener('keydown', (e) => {
    // Nunca robar teclas mientras se está escribiendo en un campo.
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (selectedEdgeIdx != null) deleteEdge(selectedEdgeIdx);
      else if (selectedGroupId) ungroup(selectedGroupId);
      else if (selectedNodeId) deleteNode(selectedNodeId);
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      groupSelected();
    }
  });
}

/* ══ Operaciones del editor ══════════════════════════════════════════════════ */

function addNode(kind) {
  const canvas = document.getElementById('canvas');
  const cx = (canvas.scrollLeft + canvas.clientWidth / 2) / zoom - NODE_W / 2;
  const cy = (canvas.scrollTop + canvas.clientHeight / 2) / zoom - 35;
  const spot = freeSpot(P.nodes, cx, cy);
  const id = uniqueId(KIND_LABEL[kind], P.nodes.map((n) => n.id));

  mutate((p) => {
    p.nodes.push(makeNode(kind, { id, x: spot.x, y: spot.y }));
  });
  selectNode(id);
  Toast.show({ title: `${KIND_LABEL[kind]} agregado`, text: 'Configuralo en el panel de la derecha.', icon: 'plus' });
}

function connect(from, to) {
  const dup = (P.edges || []).some((e) => e.from === from && e.to === to);
  if (dup) { Toast.show({ title: 'Ya están conectados', text: 'Esa arista existe.', icon: 'info' }); return; }
  if (wouldCycle(P.edges || [], from, to)) {
    Toast.error('Eso haría un ciclo', `"${to}" ya depende de "${from}", así que el grafo nunca podría arrancar.`);
    return;
  }

  const src = P.nodes.find((n) => n.id === from);
  const edge = { from, to };

  // Desde un rombo (condición o aprobación), la arista necesita saber de qué
  // rama sale. Se asigna la que falte; si ya están las dos, se pregunta.
  if (BRANCHING.includes(src?.kind)) {
    const labels = (P.edges || []).filter((e) => e.from === from).map((e) => String(e.branch));
    if (!labels.includes('true')) { edge.branch = true; edge.label = 'sí'; }
    else if (!labels.includes('false')) { edge.branch = false; edge.label = 'no'; }
    else {
      const node = document.querySelector(`.vc-node[data-node="${CSS.escape(to)}"]`);
      Menu.show(node, [
        { groupLabel: 'Sale por la rama' },
        { label: 'sí (verdadero)', icon: 'check', onSelect: () => mutate((p) => p.edges.push({ from, to, branch: true, label: 'sí' })) },
        { label: 'no (falso)', icon: 'close', onSelect: () => mutate((p) => p.edges.push({ from, to, branch: false, label: 'no' })) },
      ]);
      return;
    }
  }

  mutate((p) => p.edges.push(edge));
}

function deleteEdge(idx) {
  const e = P.edges[idx];
  if (!e) return;
  selectedEdgeIdx = null;
  mutate((p) => p.edges.splice(idx, 1));
  Toast.show({ title: 'Conexión eliminada', text: `${e.from} → ${e.to}`, icon: 'trash' });
}

async function deleteNode(id) {
  const n = P.nodes.find((x) => x.id === id);
  if (!n) return;
  const attached = (P.edges || []).filter((e) => e.from === id || e.to === id).length;

  const ok = await Modal.confirm({
    title: `¿Eliminar "${n.title || n.id}"?`,
    sub: attached
      ? `Se borran también sus ${attached} conexión(es). Se puede deshacer con Ctrl+Z.`
      : 'Se puede deshacer con Ctrl+Z.',
    confirmLabel: 'Eliminar paso',
    danger: true,
  });
  if (!ok) return;

  selectedNodeId = null;
  mutate((p) => {
    p.nodes = p.nodes.filter((x) => x.id !== id);
    p.edges = (p.edges || []).filter((e) => e.from !== id && e.to !== id);
  });
}

/* ══ Inspector ═══════════════════════════════════════════════════════════════ */

function pickNode() {
  const found = (P.nodes || []).find((n) => n.id === selectedNodeId);
  if (found) return found;
  const running = (P.nodes || []).find((n) => shownRun?.steps?.[n.id]?.state === 'running');
  const pick = running || (P.nodes || [])[0];
  selectedNodeId = pick?.id || null;
  return pick;
}

function selectNode(id, { additive = false } = {}) {
  if (additive) {
    // Shift suma o saca de la selección, dejando el primario donde está.
    if (id === selectedNodeId) return;
    multi.has(id) ? multi.delete(id) : multi.add(id);
  } else {
    multi.clear();
    selectedNodeId = id;
  }
  selectedEdgeIdx = null;
  selectedGroupId = null;
  userPickedNode = true;
  document.querySelectorAll('.vc-node').forEach((n) =>
    n.classList.toggle('is-selected', n.dataset.node === selectedNodeId || multi.has(n.dataset.node)));
  document.querySelectorAll('.vc-group').forEach((g) => g.classList.remove('is-selected'));
  paintEdges();
  refreshInspector();
}

/** Todos los pasos elegidos: el primario más los sumados con shift. */
function selection() {
  return [...new Set([selectedNodeId, ...multi].filter(Boolean))];
}

function selectGroup(id) {
  selectedGroupId = id;
  selectedEdgeIdx = null;
  document.querySelectorAll('.vc-group').forEach((g) => g.classList.toggle('is-selected', g.dataset.group === id));
}

function groupSelected() {
  const ids = selection();
  if (ids.length < 2) {
    Toast.show({ title: 'Elegí al menos dos pasos', text: 'Sumá pasos a la selección con Shift + click.', icon: 'info' });
    return;
  }
  const g = makeGroup(P, ids, `Grupo de ${ids.length}`);
  mutate((p) => { p.groups = [...(p.groups || []), g]; });
  selectedGroupId = g.id;
  Toast.show({ title: 'Marco creado', text: `Abraza ${ids.length} pasos y los sigue si los movés.`, icon: 'layers' });
}

function renameGroup(id) {
  const g = (P.groups || []).find((x) => x.id === id);
  if (!g || !editable()) return;
  Modal.show({
    title: 'Renombrar marco',
    body: `<div class="vc-field"><label class="vc-field__label">Etiqueta</label>
      <input class="vc-input" id="gr-label" value="${esc(g.label)}" spellcheck="false"></div>`,
    actions: [{ label: 'Cancelar', value: null }, { label: 'Guardar', value: 'go', variant: 'primary', autofocus: true }],
  }).then((v) => {
    if (v !== 'go') return;
    const label = document.getElementById('gr-label')?.value.trim();
    if (label) mutate((p) => { p.groups.find((x) => x.id === id).label = label; });
  });
}

function ungroup(id) {
  const g = (P.groups || []).find((x) => x.id === id);
  if (!g) return;
  selectedGroupId = null;
  mutate((p) => { p.groups = (p.groups || []).filter((x) => x.id !== id); });
  Toast.show({ title: 'Marco eliminado', text: `Los ${g.nodes.length} pasos siguen donde estaban.`, icon: 'trash' });
}

function refreshInspector() {
  const host = document.getElementById('inspector-host');
  if (!host) return;
  const collapsed = host.classList.contains('is-collapsed');
  host.outerHTML = inspectorHTML(pickNode(), shownRun?.steps || {}, !!shownRun);
  const fresh = document.getElementById('inspector-host');
  if (collapsed) {
    fresh.style.transition = 'none';
    fresh.classList.add('is-collapsed');
    raf2(() => { fresh.style.transition = ''; });
  }
  Icons.mount(view);
  initScrollFades(view);
  wireInspector();
}

const field = (label, control, hint = '') => `
  <div class="vc-field" style="margin-bottom:14px">
    <label class="vc-field__label">${esc(label)}</label>
    ${control}
    ${hint ? `<span class="vc-field__hint">${hint}</span>` : ''}
  </div>`;

const num = (key, value, { min, max, step = 1, ph = '' } = {}) =>
  `<input class="vc-input vc-input--mono" type="number" data-edit="${key}" value="${value ?? ''}"
     placeholder="${esc(ph)}"${min != null ? ` min="${min}"` : ''}${max != null ? ` max="${max}"` : ''} step="${step}">`;

/** Los chips de referencia insertan en el cursor: escribir {{steps.x.output}} a mano es pedir errores. */
function refChips(node, targetKey) {
  const refs = availableRefs(P, node.id, { inFanout: node.kind === 'fanout' });
  if (!refs.length) return '<span class="vc-field__hint vc-dim2">Sin pasos previos que referenciar.</span>';
  return `<div class="vc-refchips">${refs.map((r) =>
    `<button class="vc-chip vc-chip--mono vc-refchip" data-insert="${esc(r)}" data-target="${esc(targetKey)}">${esc(r)}</button>`).join('')}</div>`;
}

function inspectorHTML(node, steps, hasRun) {
  if (!node) return '<aside class="vc-inspector" id="inspector-host"></aside>';
  const step = steps[node.id] || {};
  const st = markState(step.state, hasRun);
  const agent = node.agent ? store.agent(node.agent) : null;
  const tokens = (step.tokens?.in || 0) + (step.tokens?.out || 0);
  const ro = !editable();

  const agentPicker = `
    <button class="vc-select" data-pick="agent"${ro ? ' disabled' : ''}>
      <span class="vc-select__value" data-placeholder="elegir agente">${esc(agent?.name || '')}</span>
      <i data-icon="chevronDown"></i>
    </button>`;

  const body = ro ? readOnlyBody(node, step, hasRun, tokens, agent) : editBody(node, agent, agentPicker);
  const waiting = step.state === 'waiting' && shownRun?.live;

  return `
    <aside class="vc-inspector" id="inspector-host">
      <div class="vc-inspector__head">
        ${mark(node.kind, st)}
        <div class="vc-grow" style="min-width:0">
          <div class="vc-truncate" style="font-weight:500">${esc(node.title || node.id)}</div>
          <div class="vc-meta">${KIND_LABEL[node.kind]}${hasRun ? ` · ${STATE_LABEL[st]}` : ''}${step.durMs != null ? ` · ${fmtDur(step.durMs)}` : ''}</div>
        </div>
        ${ro ? '' : `<button class="vc-iconbtn vc-iconbtn--sm" data-del-node data-tip="Eliminar paso" data-tip-key="Supr"><i data-icon="trash"></i></button>`}
      </div>
      <div class="vc-inspector__body vc-scroll">
        ${waiting ? approvalPanel(node, step) : ''}
        ${body}
      </div>
      ${waiting ? `
        <div class="vc-inspector__foot">
          <button class="vc-btn vc-btn--danger vc-flashable" data-decide="no"><i data-icon="close"></i> Rechazar</button>
          <button class="vc-btn vc-btn--primary vc-flashable vc-grow" data-decide="si"><i data-icon="check"></i> Aprobar</button>
        </div>` : ''}
    </aside>`;
}

/** Lo que se ve cuando la corrida está frenada esperando tu decisión. */
function approvalPanel(node, step) {
  const a = step.approval || {};
  return `
    <div class="vc-approval">
      <div class="vc-approval__head">
        ${Icons.svg('lock', 'vc-icon--sm')}
        <span>La corrida está esperando tu decisión</span>
      </div>
      ${a.question || step.question ? `<p class="vc-approval__q vc-copyable">${esc(a.question || step.question)}</p>` : ''}
      ${a.preview || step.preview ? `
        <div class="vc-sunken vc-copyable" style="padding:10px;font-size:11.5px;line-height:1.6;white-space:pre-wrap;max-height:220px;overflow:auto;margin-top:10px">${esc(a.preview || step.preview)}</div>` : ''}
      <div class="vc-field" style="margin-top:12px">
        <label class="vc-field__label">Nota (opcional)</label>
        <input class="vc-input" id="approval-note" placeholder="queda en el registro de la corrida" spellcheck="false">
      </div>
    </div>`;
}

function editBody(node, agent, agentPicker) {
  const rows = [];

  rows.push(field('Título', `<input class="vc-input" data-edit="title" value="${esc(node.title || '')}" spellcheck="false">`));
  rows.push(field('Identificador', `<input class="vc-input vc-input--mono" data-rename value="${esc(node.id)}" spellcheck="false">`,
    '<span data-rename-hint>Al cambiarlo se reescriben solas las referencias de los otros pasos.</span>'));

  if (node.kind === 'agent' || node.kind === 'fanout') {
    rows.push(field('Agente', agentPicker));
    rows.push(field('Modelo', `<input class="vc-input vc-input--mono" data-edit="model" value="${esc(node.model || '')}" placeholder="${esc(agent?.model || 'el del agente')}" spellcheck="false">`,
      'Vacío = el que trae el agente.'));
  }

  if (node.kind === 'fanout') {
    rows.push(field('Iterar sobre', `<input class="vc-input vc-input--mono" data-edit="over" value="${esc(node.over || '')}" placeholder="{{steps.triage.json.items | json}}" spellcheck="false">`,
      'Tiene que resolver a una lista. Si no lo es, se parte por líneas.'));
    rows.push(refChips(node, 'over'));
  }

  if (node.kind === 'agent' || node.kind === 'fanout') {
    rows.push(field('Prompt', `<textarea class="vc-textarea vc-textarea--mono" data-edit="prompt" rows="7" spellcheck="false">${esc(node.prompt || '')}</textarea>`));
    rows.push(refChips(node, 'prompt'));
    rows.push(field('System (opcional)', `<textarea class="vc-textarea vc-textarea--mono" data-edit="system" rows="3" placeholder="${esc(agent?.system || 'el del agente')}" spellcheck="false">${esc(node.system || '')}</textarea>`));
  }

  if (node.kind === 'branch') {
    rows.push(field('Condición', `<input class="vc-input vc-input--mono" data-edit="when" data-check-expr value="${esc(node.when || '')}" placeholder="steps.triage.json.score >= 0.7" spellcheck="false">`,
      '<span data-expr-hint>Comparaciones, contains, matches, &amp;&amp; || ! y paréntesis.</span>'));
    rows.push(refChips(node, 'when'));
    rows.push(`<label class="vc-row" style="gap:10px;margin-bottom:14px">
      <button class="vc-switch${node.allowDeadEnd ? ' is-on' : ''}" data-edit-bool="allowDeadEnd"></button>
      <span class="vc-label">El corte es intencional</span>
    </label>
    <span class="vc-field__hint vc-dim2" style="display:block;margin:-8px 0 14px">Silencia el aviso de que a esta condición le falta una salida.</span>`);
  }

  if (node.kind === 'approval') {
    rows.push(field('Pregunta', `<input class="vc-input" data-edit="question" value="${esc(node.question || '')}" placeholder="¿Publicamos este resumen?" spellcheck="false">`,
      'Lo que vas a leer cuando la corrida se frene acá.'));
    rows.push(field('Vista previa', `<textarea class="vc-textarea vc-textarea--mono" data-edit="preview" rows="4" placeholder="{{steps.synth.output}}" spellcheck="false">${esc(node.preview || '')}</textarea>`,
      'El contenido sobre el que estás decidiendo.'));
    rows.push(refChips(node, 'preview'));
    rows.push(`<label class="vc-row" style="gap:10px;margin-bottom:14px">
      <button class="vc-switch${node.allowDeadEnd ? ' is-on' : ''}" data-edit-bool="allowDeadEnd"></button>
      <span class="vc-label">El rechazo corta el flujo</span>
    </label>`);
  }

  if (node.kind === 'output') {
    rows.push(field('Recolectar', `<input class="vc-input vc-input--mono" data-edit="from" value="${esc(node.from || '')}" placeholder="{{steps.synth.output}}" spellcheck="false">`));
    rows.push(refChips(node, 'from'));
  }

  if (node.kind === 'agent' || node.kind === 'fanout') {
    rows.push(toolsPicker(node));
  }

  if (node.kind === 'agent' || node.kind === 'fanout') {
    rows.push(`<div class="vc-section"><div class="vc-section__head"><span class="vc-section__title">Ajustes finos</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        ${field('Temperatura', num('temperature', node.temperature, { min: 0, max: 2, step: 0.1, ph: agent?.temperature ?? '0.7' }))}
        ${field('Máx. tokens', num('maxTokens', node.maxTokens, { min: 1, step: 256, ph: agent?.maxTokens ?? '2048' }))}
        ${field('Reintentos', num('retries', node.retries, { min: 0, max: 8, ph: '0' }))}
        ${field('Timeout (s)', num('timeoutSec', node.timeoutMs ? node.timeoutMs / 1000 : '', { min: 1, ph: '120' }))}
        ${node.kind === 'fanout' ? field('Concurrencia', num('concurrency', node.concurrency, { min: 1, max: 16, ph: '4' })) : ''}
      </div>
      ${node.kind === 'fanout' ? `
        <div class="vc-field">
          <label class="vc-field__label">Si falla una rama</label>
          <div class="vc-segmented" data-edit-seg="itemErrors">
            <button class="vc-segmented__opt${node.itemErrors !== 'skip' ? ' is-active' : ''}" data-value="fail">Cortar todo</button>
            <button class="vc-segmented__opt${node.itemErrors === 'skip' ? ' is-active' : ''}" data-value="skip">Descartarla</button>
          </div>
        </div>` : ''}
    </div>`);
  }

  return rows.join('');
}

/**
 * Qué puede hacer este paso además de escribir. Las peligrosas se muestran
 * siempre, pero deshabilitadas mientras el cerrojo global esté puesto: esconder
 * la opción haría creer que no existe en vez de que está apagada.
 */
function toolsPicker(node) {
  const chosen = node.tools || [];
  const shellOff = !S.settings?.allowShell;

  return `
    <div class="vc-section">
      <div class="vc-section__head"><span class="vc-section__title">Herramientas</span></div>
      <div class="vc-col" style="gap:10px">
        ${S.tools.map((t) => {
    const blocked = t.danger && shellOff;
    return `
        <label class="vc-row vc-toolrow${blocked ? ' is-blocked' : ''}" style="gap:10px;align-items:flex-start">
          <button class="vc-check${chosen.includes(t.name) ? ' is-on' : ''}" data-tool="${esc(t.name)}"${blocked ? ' disabled' : ''}>
            <i data-icon="check"></i>
          </button>
          <span style="min-width:0">
            <span class="vc-row" style="gap:6px">
              ${Icons.svg(t.icon, 'vc-icon--sm')}
              <span class="vc-label">${esc(t.label)}</span>
              ${t.danger ? '<span class="vc-chip vc-chip--danger">shell</span>' : ''}
            </span>
            <span class="vc-field__hint" style="display:block;margin-top:2px">${blocked
    ? 'Desactivada en Ajustes → Motor.'
    : esc(t.description)}</span>
          </span>
        </label>`;
  }).join('')}
      </div>
      ${chosen.length ? `<span class="vc-field__hint vc-dim2" style="display:block;margin-top:10px">Los archivos se leen y escriben solo dentro de <span class="vc-mono">${esc(S.workspace)}</span>.</span>` : ''}
    </div>`;
}

function readOnlyBody(node, step, hasRun, tokens, agent) {
  const cfg = [
    ['Tipo', KIND_LABEL[node.kind]],
    agent && ['Agente', agent.name],
    ['Modelo', node.model || agent?.model || '—'],
  ].filter(Boolean);

  return `
    ${step.error ? `<div class="vc-section">
      <div class="vc-section__head"><span class="vc-section__title" style="color:var(--vc-danger)">Error</span></div>
      <p class="vc-copyable vc-mono" style="font-size:11px;line-height:1.6;color:var(--vc-danger);word-break:break-word">${esc(step.error)}</p>
    </div>` : ''}
    ${node.when ? `<div class="vc-section">
      <div class="vc-section__head"><span class="vc-section__title">Condición</span></div>
      <div class="vc-sunken vc-mono vc-copyable" style="padding:8px 10px;font-size:11px;word-break:break-word">${esc(node.when)}</div>
      ${step.output ? `<div class="vc-meta" style="margin-top:8px">Resultado: <span class="vc-mono">${esc(step.output)}</span></div>` : ''}
    </div>` : ''}
    ${node.prompt ? `<div class="vc-section">
      <div class="vc-section__head"><span class="vc-section__title">Prompt</span></div>
      <div class="vc-sunken vc-mono vc-copyable" style="padding:10px;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:150px;overflow:auto">${esc(node.prompt)}</div>
    </div>` : ''}
    <div class="vc-section">
      <div class="vc-section__head"><span class="vc-section__title">Configuración</span></div>
      <div class="vc-kv">${cfg.map(([k, v]) => `<span class="vc-kv__k">${esc(k)}</span><span class="vc-kv__v vc-mono">${esc(v)}</span>`).join('')}</div>
    </div>
    ${hasRun && (tokens || step.durMs != null) ? `<div class="vc-section">
      <div class="vc-section__head"><span class="vc-section__title">Esta corrida</span></div>
      <div class="vc-row" style="gap:24px">
        <div class="vc-stat"><span class="vc-stat__value">${esc(fmtTokens(tokens))}</span><span class="vc-stat__label">Tokens</span></div>
        ${step.progress?.total ? `<div class="vc-stat"><span class="vc-stat__value">${step.progress.done}/${step.progress.total}</span><span class="vc-stat__label">Ramas</span></div>` : ''}
        <div class="vc-stat"><span class="vc-stat__value">${esc(fmtDur(step.durMs))}</span><span class="vc-stat__label">Duración</span></div>
      </div>
    </div>` : ''}
    ${step.output && node.kind !== 'branch' ? `<div class="vc-section">
      <div class="vc-section__head"><span class="vc-section__title">Salida</span></div>
      <div class="vc-sunken vc-mono vc-copyable" style="padding:10px;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto">${esc(step.output)}</div>
    </div>` : ''}`;
}

/** Aplica un cambio de campo sin repintar todo: repintar mataría el foco al tipear. */
function editField(key, value) {
  const node = P.nodes.find((n) => n.id === selectedNodeId);
  if (!node) return;

  undoStack.push(structuredClone(P));
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];

  if (key === 'timeoutSec') {
    node.timeoutMs = value === '' ? undefined : Math.round(Number(value) * 1000);
  } else if (['temperature', 'maxTokens', 'retries', 'concurrency'].includes(key)) {
    node[key] = value === '' ? undefined : Number(value);
  } else {
    node[key] = value === '' ? undefined : value;
  }

  // El título y el estado de "incompleto" sí se ven en el nodo del lienzo.
  const el = document.querySelector(`.vc-node[data-node="${CSS.escape(node.id)}"]`);
  if (el) {
    if (key === 'title') el.querySelector('.vc-node__title').textContent = node.title || node.id;
    el.classList.toggle('is-incomplete', isIncomplete(node));
    const modelEl = el.querySelector('.vc-node__model');
    if (modelEl && (key === 'model' || key === 'agent')) {
      modelEl.textContent = node.model || store.agent(node.agent)?.model || '';
    }
  }

  scheduleSave();
  refreshUndoButtons();
  runValidation();
}

function wireInspector() {
  const host = document.getElementById('inspector-host');
  if (!host) return;

  host.querySelectorAll('[data-edit]').forEach((el) => {
    el.addEventListener('input', () => editField(el.dataset.edit, el.value));
  });

  host.querySelectorAll('[data-edit-bool]').forEach((el) => {
    el.addEventListener('click', () => {
      el.classList.toggle('is-on');
      editField(el.dataset.editBool, el.classList.contains('is-on') ? true : undefined);
    });
  });

  host.querySelectorAll('[data-edit-seg]').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const opt = e.target.closest('.vc-segmented__opt');
      if (!opt) return;
      seg.querySelectorAll('.vc-segmented__opt').forEach((o) => o.classList.toggle('is-active', o === opt));
      editField(seg.dataset.editSeg, opt.dataset.value);
    });
  });

  host.querySelector('[data-pick="agent"]')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const node = P.nodes.find((n) => n.id === selectedNodeId);
    const items = S.agents.map((a) => ({
      label: `${a.name} · ${a.model}`,
      icon: 'agents',
      selected: node?.agent === a.id,
      onSelect: () => {
        btn.querySelector('.vc-select__value').textContent = a.name;
        editField('agent', a.id);
        refreshInspector();
      },
    }));
    items.push({ sep: true }, { label: 'Crear agente nuevo…', icon: 'plus', onSelect: () => window.dispatchEvent(new CustomEvent('vector:new-agent')) });
    Menu.show(btn, items);
  });

  // Insertar una referencia en el cursor del campo de destino.
  host.querySelectorAll('.vc-refchip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const target = host.querySelector(`[data-edit="${CSS.escape(chip.dataset.target)}"]`);
      if (!target) return;
      const snippet = `{{${chip.dataset.insert}}}`;
      const at = target.selectionStart ?? target.value.length;
      target.value = target.value.slice(0, at) + snippet + target.value.slice(target.selectionEnd ?? at);
      target.focus();
      target.setSelectionRange(at + snippet.length, at + snippet.length);
      editField(target.dataset.edit, target.value);
    });
  });

  // La condición se valida contra el parser real del motor, con freno.
  const exprInput = host.querySelector('[data-check-expr]');
  if (exprInput) {
    let t = null;
    const check = async () => {
      const hint = host.querySelector('[data-expr-hint]');
      if (!hint) return;
      if (!exprInput.value.trim()) {
        exprInput.classList.remove('is-invalid');
        hint.textContent = 'Comparaciones, contains, matches, && || ! y paréntesis.';
        hint.parentElement.classList.remove('vc-field__hint--error');
        return;
      }
      const res = await api.engine.checkExpr(exprInput.value).catch(() => null);
      if (!res) return;
      exprInput.classList.toggle('is-invalid', !res.ok);
      hint.textContent = res.ok ? 'La condición se entiende.' : res.error;
      hint.parentElement.classList.toggle('vc-field__hint--error', !res.ok);
    };
    exprInput.addEventListener('input', () => { clearTimeout(t); t = setTimeout(check, 320); });
    check();
  }

  host.querySelectorAll('[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const node = P.nodes.find((n) => n.id === selectedNodeId);
      if (!node) return;
      const name = btn.dataset.tool;
      const on = !btn.classList.contains('is-on');
      btn.classList.toggle('is-on', on);
      const next = new Set(node.tools || []);
      on ? next.add(name) : next.delete(name);
      editField('tools', next.size ? [...next] : undefined);
    });
  });

  host.querySelectorAll('[data-decide]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const approved = btn.dataset.decide === 'si';
      const note = host.querySelector('#approval-note')?.value.trim() || '';
      host.querySelectorAll('[data-decide]').forEach((b) => { b.disabled = true; });
      const ok = await attempt(() => api.runs.approve(shownRun.runId, selectedNodeId, approved, note),
        { errorTitle: 'No se pudo registrar la decisión' });
      if (ok === null) host.querySelectorAll('[data-decide]').forEach((b) => { b.disabled = false; });
    });
  });

  host.querySelector('[data-del-node]')?.addEventListener('click', () => deleteNode(selectedNodeId));

  /* Renombrar el id. Se confirma al salir del campo o con Enter, nunca al
     tipear: a mitad de escribir "sintesis" pasaríamos por "s", "si", "sin"… y
     cada paso reescribiría las referencias de todo el pipeline. */
  const renameEl = host.querySelector('[data-rename]');
  if (renameEl) {
    const hint = host.querySelector('[data-rename-hint]');
    const restore = () => {
      renameEl.value = selectedNodeId || '';
      renameEl.classList.remove('is-invalid');
      if (hint) {
        hint.textContent = 'Al cambiarlo se reescriben solas las referencias de los otros pasos.';
        hint.parentElement.classList.remove('vc-field__hint--error');
      }
    };

    const commit = () => {
      const from = selectedNodeId;
      const to = renameEl.value.trim();
      if (!from || to === from) { renameEl.classList.remove('is-invalid'); return; }

      const probe = renameNode(structuredClone(P), from, to);
      if (!probe.ok) {
        // Volver al valor real: un campo vacío con un error al lado deja al
        // usuario sin saber qué había ni cómo salir. El aviso explica por qué.
        renameEl.value = from;
        renameEl.classList.add('is-invalid');
        if (hint) {
          hint.textContent = `${probe.error} Se dejó "${from}".`;
          hint.parentElement.classList.add('vc-field__hint--error');
        }
        return;
      }
      renameEl.classList.remove('is-invalid');
      let rewrites = 0;
      const applied = mutate((p) => { rewrites = renameNode(p, from, to).rewrites; }, { rerender: false });
      if (!applied) { renameEl.value = from; return; }

      selectedNodeId = to;
      if (multi.delete(from)) multi.add(to);
      render();
      Toast.show({
        title: 'Paso renombrado',
        text: rewrites ? `${from} → ${to} · ${rewrites} referencia(s) reescritas.` : `${from} → ${to}`,
        icon: 'edit',
      });
    };
    renameEl.addEventListener('change', commit);
    renameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); renameEl.blur(); }
      // Escape cancela la edición sin tocar nada, como en cualquier campo.
      if (e.key === 'Escape') { e.preventDefault(); restore(); renameEl.blur(); }
    });
  }
}

/* ══ Eventos del motor ═══════════════════════════════════════════════════════ */

function onGraphEvent(ev) {
  if (ev.type === 'run:start' && ev.pipelineId === P.id) {
    const live = S.live.get(ev.runId);
    shownRun = { runId: ev.runId, steps: live.steps, branch: live.branch, live: true };
    userPickedNode = false;
    render();                       // pasa a modo observación: edición bloqueada
    return;
  }
  if (ev.runId !== shownRun?.runId) return;

  const live = S.live.get(ev.runId);

  if (['run:done', 'run:paused', 'run:resumed'].includes(ev.type)) {
    if (ev.type === 'run:done') {
      const okState = ev.state === 'done';
      Toast.show({
        title: okState ? 'Corrida completada' : `Corrida ${ev.state === 'aborted' ? 'abortada' : 'fallida'}`,
        text: `${P.name} · ${fmtDur(ev.durMs)} · ${fmtTokens((ev.totals?.tokensIn || 0) + (ev.totals?.tokensOut || 0))} tokens`,
        icon: okState ? 'check' : 'alert',
        tone: okState ? 'default' : 'error',
      });
      // Se congela la foto final ANTES de que el store descarte la corrida viva,
      // y se desbloquea la edición conservando los estados en pantalla.
      shownRun = {
        runId: ev.runId,
        steps: structuredClone(live?.steps || shownRun.steps),
        branch: { ...(live?.branch || shownRun.branch) },
        live: false,
      };
      setTimeout(() => { if (lastGraphId === P.id) render(); }, 700);
      return;
    }
    const host = document.getElementById('run-controls');
    if (host) { host.innerHTML = runControlsHTML(live); Icons.mount(host); }
    return;
  }

  if (!ev.nodeId) return;

  const subEl = view.querySelector('.vc-viewhead__sub');
  if (subEl && live) subEl.textContent = progressText(live);

  // Una compuerta esperando es lo más importante que puede estar pasando: se
  // salta a ella y se avisa, aunque estuvieras mirando otro paso.
  if (ev.type === 'step:waiting') {
    selectedNodeId = ev.nodeId;
    userPickedNode = false;
    document.querySelectorAll('.vc-node').forEach((n) => n.classList.toggle('is-selected', n.dataset.node === ev.nodeId));
    document.getElementById('inspector-host')?.classList.remove('is-collapsed');
    document.getElementById('toggle-inspector')?.classList.add('is-active');
    refreshInspector();
    Toast.show({
      title: 'Esperando tu aprobación',
      text: ev.question || `El paso "${ev.title}" frenó la corrida.`,
      icon: 'lock',
      duration: 0,
    });
  }

  if (ev.type === 'step:approved') {
    Toast.show({
      title: ev.approved ? 'Aprobado' : 'Rechazado',
      text: ev.note || (ev.approved ? 'La corrida sigue.' : 'La corrida no sigue por esa rama.'),
      icon: ev.approved ? 'check' : 'close',
    });
    refreshInspector();
  }

  if (!userPickedNode && ev.type === 'step:start') {
    selectedNodeId = ev.nodeId;
    document.querySelectorAll('.vc-node').forEach((n) => n.classList.toggle('is-selected', n.dataset.node === ev.nodeId));
    refreshInspector();
  }

  const el = view.querySelector(`.vc-node[data-node="${CSS.escape(ev.nodeId)}"]`);
  if (!el) return;
  const step = live?.steps?.[ev.nodeId] || {};
  const st = markState(step.state, true);

  el.dataset.state = st;
  el.querySelector('.vc-mark')?.setAttribute('data-state', st);
  const dur = el.querySelector('.vc-node__dur');
  if (dur) dur.textContent = step.durMs != null ? fmtDur(step.durMs) : '';

  const meter = el.querySelector('.vc-node__meter');
  if (meter) {
    meter.style.display = st === 'running' ? '' : 'none';
    if (step.progress?.total) {
      meter.style.setProperty('--vc-pct', `${Math.round((step.progress.done / step.progress.total) * 100)}%`);
    } else if (ev.type === 'step:token') {
      meter.style.setProperty('--vc-pct', `${Math.min(92, Math.round((ev.len / 900) * 100))}%`);
    }
  }

  if (ev.type === 'step:fail' && !ev.willRetry) {
    el.classList.remove('vc-shaking'); void el.offsetWidth; el.classList.add('vc-shaking');
  }

  paintEdges();
  if (selectedNodeId === ev.nodeId && ['step:done', 'step:fail', 'step:skip'].includes(ev.type)) refreshInspector();
}

/** Lo usa app.js para redibujar cuando cambia el tamaño de la ventana. */
export function relayoutEdges() {
  if (!P) return;
  drawEdges();
  paintEdges();
}

export function currentPipelineId() { return P?.id || null; }
