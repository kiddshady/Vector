/* ═══════════════════════════════════════════════════════════════════════════
   VECTOR — Design system (documentación viva)
   Todos los primitivos del sistema, funcionando. Vive en su propio módulo
   porque no es una vista del producto: es el catálogo contra el que se
   compara todo lo demás.

   Regla: si un primitivo no aparece acá, no existe en el sistema. Agregarlo
   acá es parte de crearlo.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';
import { Toast, Menu, Modal } from './overlays.js';
import Palette from './palette.js';
import { bindSwitcher } from './motion.js';
import { SHAPE, STATE_LABEL } from './vocab.js';

function mark(kind, state) {
  return `<span class="vc-mark vc-mark--${SHAPE[kind] || 'circle'}" data-state="${state}">
    <span class="vc-mark__halo"></span><span class="vc-mark__core"></span></span>`;
}

function status(kind, state) {
  return `<span class="vc-status" data-state="${state}">
    ${mark(kind, state)}<span>${STATE_LABEL[state] || state}</span></span>`;
}

const swatch = (name, varName) => `
  <div class="vc-col" style="gap:6px">
    <div style="height:52px;border-radius:8px;background:var(${varName});box-shadow:var(--vc-hairline)"></div>
    <span class="vc-meta">${name}</span>
    <span class="vc-mono vc-dim2" style="font-size:10px">${varName}</span>
  </div>`;

const section = (title, note, body) => `
  <section style="margin-bottom:40px">
    <div class="vc-row" style="margin-bottom:4px"><span class="vc-eyebrow">${title}</span></div>
    ${note ? `<p class="vc-meta vc-copyable" style="max-width:620px;line-height:1.65;margin-bottom:16px">${note}</p>` : '<div style="height:12px"></div>'}
    ${body}
  </section>`;

export function designHTML() {
  return `
    <div class="vc-scroll vc-grow" id="design-scroll" style="padding-left:24px;padding-right:24px">
    <div id="design-body" style="max-width:900px">

      ${section('Superficies', 'La jerarquía se construye por elevación, nunca con bordes marcados. Cada plano que flota sube un escalón y proyecta sombra.', `
        <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:12px">
          ${swatch('Base', '--vc-bg')}${swatch('Hundido', '--vc-sunken')}${swatch('Panel', '--vc-s2')}
          ${swatch('Flotante', '--vc-s3')}${swatch('Máximo', '--vc-s4')}${swatch('Acento', '--vc-accent')}
        </div>`)}

      ${section('Tipografía', 'Sans para toda la interfaz, mono solo para dato exacto: IDs, tokens, duraciones, rutas. El mono en texto corrido se ve técnico de más.', `
        <div class="vc-col" style="gap:10px">
          <div class="vc-display">Orquestación silenciosa</div>
          <div class="vc-title">Título de vista</div>
          <div class="vc-subtitle">Subtítulo de panel</div>
          <div>Cuerpo de la interfaz a 13 píxeles, que es la densidad de una herramienta profesional.</div>
          <div class="vc-meta">Metadato secundario · 11 px</div>
          <div class="vc-eyebrow">Versalita espaciada</div>
          <div class="vc-mono">r-0007 · 42.3k tokens · 1m 12s · sonnet-5</div>
        </div>`)}

      ${section('Estado', 'La pieza central. La <b>forma</b> dice qué es la cosa, la <b>luminancia</b> dice si está viva, y el <b>movimiento</b> es exclusivo de lo que corre. El rojo aparece una sola vez en toda la app: cuando algo falla.', `
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:20px 12px">
          ${['idle', 'queued', 'running', 'waiting', 'done', 'skipped', 'failed'].map((s) => `
            <div class="vc-col" style="gap:8px">${status('agent', s)}
              <div class="vc-row" style="gap:10px;padding-left:2px">
                ${mark('input', s)}${mark('agent', s)}${mark('branch', s)}${mark('fanout', s)}
              </div>
            </div>`).join('')}
        </div>
        <div class="vc-row vc-meta vc-dim2" style="gap:20px;margin-top:22px">
          ${[['input', 'entrada/salida'], ['agent', 'agente'], ['branch', 'decisión'], ['fanout', 'fan-out']]
            .map(([k, label]) => `<span class="vc-row" style="gap:7px">${mark(k, 'done')}${label}</span>`).join('')}
        </div>`)}

      ${section('Botones', 'Como máximo un primario por pantalla: en una paleta acromática el blanco pleno ES el acento, y dos blancos compitiendo destruyen la jerarquía.', `
        <div class="vc-row" style="flex-wrap:wrap;gap:8px">
          <button class="vc-btn vc-btn--primary vc-flashable"><i data-icon="play"></i> Correr pipeline</button>
          <button class="vc-btn vc-btn--secondary vc-flashable">Secundario</button>
          <button class="vc-btn vc-btn--ghost vc-flashable">Ghost</button>
          <button class="vc-btn vc-btn--danger vc-flashable"><i data-icon="trash"></i> Eliminar</button>
          <button class="vc-btn vc-btn--danger-solid vc-flashable">Abortar todo</button>
          <button class="vc-btn vc-btn--secondary" disabled>Deshabilitado</button>
          <button class="vc-iconbtn" data-tip="Botón de ícono"><i data-icon="settings"></i></button>
        </div>`)}

      ${section('Campos y controles', 'Ningún control nativo de Chromium sobrevive: el select abre un menú nuestro, el tilde se dibuja con stroke-dashoffset y la cápsula del segmentado viaja entre opciones.', `
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:20px">
          <div class="vc-field">
            <label class="vc-field__label">Nombre del pipeline</label>
            <input class="vc-input" value="Research Digest" spellcheck="false">
          </div>
          <div class="vc-field">
            <label class="vc-field__label">Modelo</label>
            <button class="vc-select" id="demo-select">
              <span class="vc-select__value">claude-sonnet-5</span><i data-icon="chevronDown"></i>
            </button>
          </div>
          <div class="vc-field">
            <label class="vc-field__label">Con error</label>
            <input class="vc-input is-invalid" value="temperatura = 3.4" spellcheck="false">
            <span class="vc-field__hint vc-field__hint--error">Tiene que estar entre 0 y 1.</span>
          </div>
          <div class="vc-field">
            <label class="vc-field__label">Temperatura</label>
            <input type="range" class="vc-slider" id="demo-slider" min="0" max="100" value="30">
          </div>
          <div class="vc-col" style="gap:12px">
            <label class="vc-row" style="gap:10px"><button class="vc-switch is-on" data-toggle></button> <span class="vc-label">Correr en paralelo</span></label>
            <label class="vc-row" style="gap:10px"><button class="vc-switch" data-toggle></button> <span class="vc-label">Pausar ante el primer fallo</span></label>
            <label class="vc-row" style="gap:10px"><button class="vc-check is-on" data-check><i data-icon="check"></i></button> <span class="vc-label">Guardar artefactos</span></label>
            <label class="vc-row" style="gap:10px"><button class="vc-check" data-check><i data-icon="check"></i></button> <span class="vc-label">Notificar al terminar</span></label>
          </div>
          <div class="vc-col" style="gap:12px;align-items:flex-start">
            <div class="vc-segmented" id="demo-seg">
              <button class="vc-segmented__opt is-active" data-value="a">Grafo</button>
              <button class="vc-segmented__opt" data-value="b">Código</button>
              <button class="vc-segmented__opt" data-value="c">Historial</button>
            </div>
            <div class="vc-row" style="gap:6px">
              <span class="vc-kbd">Ctrl</span><span class="vc-kbd">K</span>
              <span class="vc-meta">abre la paleta de comandos</span>
            </div>
          </div>
        </div>`)}

      ${section('Overlays', 'Todos entran <i>y salen</i> animados, y todos son nuestros: ni un title= amarillo, ni un confirm() del sistema.', `
        <div class="vc-row" style="flex-wrap:wrap;gap:8px">
          <button class="vc-btn vc-btn--secondary" data-tip="Así se ve un tooltip propio: portaleado, con entrada y salida animadas">Tooltip (hover)</button>
          <button class="vc-btn vc-btn--secondary vc-flashable" id="demo-menu">Menú</button>
          <button class="vc-btn vc-btn--secondary vc-flashable" id="demo-modal">Modal</button>
          <button class="vc-btn vc-btn--secondary vc-flashable" id="demo-confirm">Confirmación destructiva</button>
          <button class="vc-btn vc-btn--secondary vc-flashable" id="demo-toast">Toast</button>
          <button class="vc-btn vc-btn--secondary vc-flashable" id="demo-toast-err">Toast de error</button>
          <button class="vc-btn vc-btn--secondary vc-flashable" id="demo-palette">Command palette</button>
        </div>`)}

      ${section('Medidores y métricas', '', `
        <div class="vc-row" style="gap:40px;margin-bottom:20px">
          <div class="vc-stat"><span class="vc-stat__value">42.3<span class="vc-stat__unit">k</span></span><span class="vc-stat__label">Tokens</span></div>
          <div class="vc-stat"><span class="vc-stat__value">96<span class="vc-stat__unit">%</span></span><span class="vc-stat__label">Éxito</span></div>
          <div class="vc-stat"><span class="vc-stat__value"><span class="vc-stat__unit">USD </span>3.42</span><span class="vc-stat__label">Gasto</span></div>
        </div>
        <div class="vc-col" style="gap:14px;max-width:420px">
          <div class="vc-meter" style="--vc-pct:62%"><div class="vc-meter__fill"></div></div>
          <div class="vc-meter vc-meter--danger" style="--vc-pct:88%"><div class="vc-meter__fill"></div></div>
          <div class="vc-meter vc-meter--indeterminate"><div class="vc-meter__fill"></div></div>
        </div>`)}

      ${section('Chips y esqueletos', '', `
        <div class="vc-row" style="flex-wrap:wrap;gap:8px;margin-bottom:20px">
          <span class="vc-chip">7 pasos</span>
          <span class="vc-chip vc-chip--mono">claude-opus-5</span>
          <span class="vc-chip vc-chip--outline">Anthropic</span>
          <span class="vc-chip vc-chip--danger">2 fallos</span>
          <span class="vc-avatar">TR</span>
          <span class="vc-avatar vc-avatar--lg">SN</span>
        </div>
        <div class="vc-col" style="gap:8px;max-width:420px">
          <div class="vc-skeleton" style="height:12px;width:70%"></div>
          <div class="vc-skeleton" style="height:12px;width:92%"></div>
          <div class="vc-skeleton" style="height:12px;width:48%"></div>
        </div>`)}

      ${section('Esfumado del scroll', 'Donde el scroll recorta, el contenido se desvanece. Un corte duro se lee como un bug; el fade dice “hay más, seguí”. El contenedor lleva padding ≥ el tamaño del fade para que en reposo la banda no coma el primer ni el último ítem.', `
        <div class="vc-sunken" style="max-width:420px;height:180px;overflow:hidden">
          <div class="vc-scroll" style="height:100%;padding-left:14px;padding-right:14px">
            ${Array.from({ length: 14 }, (_, i) => `<div style="padding:7px 0;font-size:12px;color:var(--vc-text-2);box-shadow:inset 0 -1px 0 var(--vc-line)">Elemento de lista ${i + 1}</div>`).join('')}
          </div>
        </div>`)}

    </div>
    <div style="height:32px"></div>
    </div>`;
}

const DEMO_MENU = [
  { groupLabel: 'Acciones' },
  { label: 'Correr ahora', icon: 'play', key: 'Ctrl R' },
  { label: 'Editar', icon: 'edit' },
  { label: 'Duplicar', icon: 'duplicate', selected: true },
  { sep: true },
  { label: 'Eliminar', icon: 'trash', danger: true },
];

export function wireDesign(root) {
  root.querySelectorAll('[data-toggle]').forEach((b) =>
    b.addEventListener('click', () => b.classList.toggle('is-on')));
  root.querySelectorAll('[data-check]').forEach((b) =>
    b.addEventListener('click', () => b.classList.toggle('is-on')));

  const seg = root.querySelector('#demo-seg');
  if (seg) bindSwitcher(seg, () => {});

  const slider = root.querySelector('#demo-slider');
  if (slider) {
    const sync = () => slider.style.setProperty('--vc-pct', `${slider.value}%`);
    sync();
    slider.addEventListener('input', sync);
  }

  root.querySelector('#demo-select')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const val = btn.querySelector('.vc-select__value');
    Menu.show(btn, ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4.5', 'minimax-m3', 'qwen3.5-9b'].map((m) => ({
      label: m,
      selected: val.textContent === m,
      onSelect: () => { val.textContent = m; },
    })));
  });

  root.querySelector('#demo-menu')?.addEventListener('click', (e) => {
    e.stopPropagation();
    Menu.show(e.currentTarget, DEMO_MENU);
  });

  root.querySelector('#demo-modal')?.addEventListener('click', () => {
    Modal.show({
      title: 'Nuevo pipeline',
      sub: 'Un pipeline es una secuencia de pasos donde cada uno recibe la salida del anterior.',
      body: `
        <div class="vc-col" style="gap:16px">
          <div class="vc-field">
            <label class="vc-field__label">Nombre</label>
            <input class="vc-input" placeholder="Research Digest" spellcheck="false">
          </div>
          <div class="vc-field">
            <label class="vc-field__label">Descripción</label>
            <textarea class="vc-textarea" placeholder="Qué hace este pipeline…"></textarea>
          </div>
        </div>`,
      actions: [
        { label: 'Cancelar', value: null },
        { label: 'Crear pipeline', value: true, variant: 'primary', autofocus: true },
      ],
    }).then((v) => v && Toast.show({ title: 'Demostración', text: 'El editor visual llega en la fase 3.', icon: 'info' }));
  });

  root.querySelector('#demo-confirm')?.addEventListener('click', () => {
    Modal.confirm({
      title: '¿Eliminar “Code Review”?',
      sub: 'Se borran también sus corridas y los artefactos que dejaron. Esto no se puede deshacer.',
      confirmLabel: 'Eliminar pipeline',
      danger: true,
    }).then((ok) => ok && Toast.error('Demostración', 'No se borró nada: esto es el catálogo de primitivos.'));
  });

  root.querySelector('#demo-toast')?.addEventListener('click', () =>
    Toast.show({ title: 'Corrida completada', text: 'Research Digest terminó en 1m 51s · 61.2k tokens.', icon: 'check' }));

  root.querySelector('#demo-toast-err')?.addEventListener('click', () =>
    Toast.error('El paso “Síntesis” falló', 'context_length_exceeded tras 2 reintentos. La corrida quedó pausada.'));

  root.querySelector('#demo-palette')?.addEventListener('click', () => Palette.show());
}
