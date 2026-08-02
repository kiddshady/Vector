/* ═══════════════════════════════════════════════════════════════════════════
   VECTOR — helpers de UI compartidos
   Lo que necesitan todas las vistas. Existe además para romper el ciclo de
   imports: `app.js` conoce al grafo y el grafo necesita navegar, así que en vez
   de importarse mutuamente los dos pasan por acá.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';
import { Toast } from './overlays.js';
import { initScrollFades } from './motion.js';
import { SHAPE, STATE_LABEL } from './vocab.js';
import * as store from './store.js';

export const view = document.getElementById('view');

/** El router lo completa app.js al arrancar; el grafo solo lo usa. */
export const router = { go: () => {} };

export function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function mark(kind, state) {
  return `<span class="vc-mark vc-mark--${SHAPE[kind] || 'circle'}" data-state="${state}">
    <span class="vc-mark__halo"></span><span class="vc-mark__core"></span></span>`;
}

export function status(kind, state) {
  return `<span class="vc-status" data-state="${state}">
    ${mark(kind, state)}<span>${STATE_LABEL[state] || state}</span></span>`;
}

export function paint(html) {
  view.innerHTML = html;
  Icons.mount(view);
  initScrollFades(view);
  return view;
}

export function head({ title, sub, crumbs, actions = '' }) {
  const crumbHTML = crumbs
    ? `<nav class="vc-crumbs">${crumbs
        .map((c, i) => (i ? '<i data-icon="chevronRight"></i>' : '')
          + `<span class="vc-crumbs__item"${c.view ? ` data-goto="${c.view}"` : ''}${c.param ? ` data-param="${esc(c.param)}"` : ''}>${esc(c.label)}</span>`)
        .join('')}</nav>`
    : '';
  return `
    <div class="vc-viewhead">
      <div class="vc-viewhead__text vc-grow">
        ${crumbHTML}
        <div class="vc-viewhead__title">${esc(title)}</div>
        ${sub ? `<div class="vc-viewhead__sub">${esc(sub)}</div>` : ''}
      </div>
      <div class="vc-viewhead__actions">${actions}</div>
    </div>`;
}

/** Toda acción que puede fallar pasa por acá: el error se ve, no se traga. */
export async function attempt(fn, { errorTitle = 'No se pudo completar' } = {}) {
  try {
    return await fn();
  } catch (err) {
    Toast.error(errorTitle, err.message);
    return null;
  }
}

/* ── Suscripción de la vista al motor ────────────────────────────────────── */

let viewCleanup = null;

/**
 * Suscribe la vista actual, REEMPLAZANDO la suscripción anterior. Las vistas se
 * repintan a sí mismas al recibir eventos, así que si cada repintado sumara un
 * suscriptor terminarían multiplicándose sin techo.
 */
export function bindEvents(fn) {
  viewCleanup?.();
  viewCleanup = store.onEvent(fn);
}

/** Lo llama el router antes de montar otra vista. */
export function releaseView() {
  viewCleanup?.();
  viewCleanup = null;
}
