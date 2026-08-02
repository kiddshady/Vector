/* ═══════════════════════════════════════════════════════════════════════════
   Humo del renderer: monta la app de verdad y la recorre.

   Se corre con `npm run smoke` (necesita Electron, por eso no está en el
   `npm test`, que es node pelado y tiene que seguir siendo instantáneo).

   Lo que busca es lo que un test de unidad NO ve: overlays que aterrizan fuera
   de pantalla, vistas que no montan, la tipografía empaquetada que dejó de
   cargar, glifos unicode que se colaron. La regla que lo guía: **medí dónde
   CAE una cosa, no solo si existe.**

   No toca `data/`: apunta VECTOR_DATA a un temporal ANTES de cargar el store
   (lo lee al requerirse) y lo borra al terminar. El smoke no puede ensuciar
   los datos de la app que está probando.
   ═══════════════════════════════════════════════════════════════════════════ */

const os = require('os');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-smoke-'));
process.env.VECTOR_DATA = DATA;          // antes del require de electron/ipc

const { app, BrowserWindow } = require('electron');

const W = 1440; const H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const limpiar = () => { try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {} };
const bail = (w, e) => { console.log(`ABORTADO ${w}`, e?.stack || e || ''); limpiar(); app.exit(3); };
process.on('unhandledRejection', (e) => bail('rechazo', e));
process.on('uncaughtException', (e) => bail('excepción', e));
setTimeout(() => bail('timeout de 120s'), 120000);

app.whenReady().then(async () => {
  require(path.join(ROOT, 'src', 'ipc')).register();

  const win = new BrowserWindow({
    x: -20000, y: -20000, width: W, height: H,
    frame: false, show: false, paintWhenInitiallyHidden: true, backgroundColor: '#000',
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true },
  });
  const errores = [];
  win.webContents.on('console-message', (e) => { if (e.level >= 2) errores.push(`${e.level}: ${e.message}`); });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  win.show();
  await sleep(2400);

  const js = (c) => win.webContents.executeJavaScript(c);
  // Clickear sin explotar si el selector no existe: un elemento faltante tiene
  // que reportarse como falla del test, no como excepción que aborta todo.
  const click = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false; el.click(); return true; })()`);
  // Un click real es pointerdown → pointerup → click, y varios overlays se
  // cierran en pointerdown. Con `el.click()` solo, el orden nunca se prueba.
  const tap = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true }));
    el.click(); return true; })()`);
  const caja = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null;
    const r = el.getBoundingClientRect();
    return { t:Math.round(r.top), l:Math.round(r.left), b:Math.round(r.bottom), rt:Math.round(r.right),
             cx:Math.round(r.left+r.width/2), cy:Math.round(r.top+r.height/2) }; })()`);

  console.log('\n1. Arranque');
  ok('el splash se fue', !(await js(`!!document.getElementById('boot-splash')`)));
  ok('el shell está montado', await js(`!!document.querySelector('.vc-titlebar') && !!document.querySelector('.vc-rail')`));
  ok('los <i data-icon> se reemplazaron por SVG', !(await js(`!!document.querySelector('i[data-icon]')`)));
  ok('la vista inicial pintó algo', (await js(`document.getElementById('view').children.length`)) > 0);
  ok('el preload expuso window.vector', await js(`typeof window.vector === 'object' && window.vector !== null`));

  console.log('\n2. Todas las vistas montan');
  for (const v of ['runs', 'agents', 'tools', 'library', 'design', 'settings', 'pipelines']) {
    await click(`.vc-navitem[data-view="${v}"]`);
    await sleep(650);
    const hijos = await js(`document.getElementById('view').children.length`);
    const activo = await js(`!!document.querySelector('.vc-navitem[data-view="${v}"].is-active')`);
    ok(`${v}: pinta y queda activa en el rail`, hijos > 0 && activo, `hijos=${hijos} activo=${activo}`);
  }

  console.log('\n3. Overlays: dónde caen, no solo si existen');
  await click('#btn-palette');
  await sleep(500);
  const pal = await caja('.vc-palette');
  ok('la paleta abre centrada en horizontal y visible',
    pal && pal.t > 0 && pal.b <= H && Math.abs(pal.cx - W / 2) < 4, JSON.stringify(pal));

  // Volver a tocar el botón que la abrió TIENE que cerrarla. Si no, se ve como
  // un rebote: el click-afuera la cierra y el handler del botón la reabre en el
  // mismo gesto. Por eso acá va `tap` y no `click`: reproduce el orden real.
  await tap('#btn-palette');
  await sleep(500);
  ok('volver a tocar el botón la CIERRA (no rebota)', !(await js(`!!document.querySelector('.vc-palette')`)));

  // El modal se abre y se descarta sin confirmar: el smoke no crea pipelines.
  await click('#btn-new');
  await sleep(600);
  const modal = await caja('.vc-modal');
  ok('el modal queda CENTRADO en la ventana',
    modal && Math.abs(modal.cx - W / 2) < 4 && Math.abs(modal.cy - H / 2) < 4 && modal.t > 0,
    JSON.stringify(modal));
  await click('.vc-modal [data-dismiss]');
  await sleep(500);
  ok('y el descarte lo saca del DOM (terminó su animación de salida)',
    !(await js(`!!document.querySelector('.vc-modal')`)));
  ok('y no dejó el scrim huérfano', !(await js(`!!document.querySelector('.vc-scrim')`)));

  console.log('\n4. La fuente empaquetada carga de verdad');
  /* Éste es el chequeo que evita el fracaso silencioso: con CSP estricta y
     protocolo file://, un @font-face con la ruta mal puesta no tira error —
     el navegador cae a la de respaldo y todo "se ve bien". Por eso no alcanza
     con preguntar por --vc-mono: hay que confirmar que la familia cargó, que
     realmente cambia el ancho del texto, y que las reglas que la usan la
     heredan hasta el final.

     Los asserts de acá abajo son de dos clases y conviene saber cuál es cuál
     cuando el run sale rojo:
       · CARGA (document.fonts, ancho vs serif) → el archivo está y se pintó.
       · CABLEADO (--vc-mono, .vc-*--mono) → el CSS apunta a donde debe.
     Solo cableado en rojo = tocaste un token o un selector.
     Solo carga en rojo   = el .woff2 no está o la ruta del @font-face cambió;
                            el CSS sigue *declarando* la familia y por eso el
                            cableado da verde. Ése es el fracaso silencioso. */
  const fuente = await js(`(async () => {
    const medir = (fam, peso) => { const s = document.createElement('span');
      s.style.cssText = 'position:fixed;left:-9999px;font-size:64px;white-space:pre;font-weight:' + peso + ';font-family:' + fam;
      s.textContent = 'MMMiiilll0O1'; document.body.appendChild(s);
      const w = s.getBoundingClientRect().width; s.remove(); return Math.round(w); };
    medir("'Roboto Mono'", 400); medir("'Roboto Mono'", 500);   // fuerza la carga
    await document.fonts.ready;

    // La cadena entera, por cada regla que usa la mono: el selector resuelve
    // var(--vc-mono) y termina en la familia empaquetada.
    const cadena = ['vc-chip vc-chip--mono', 'vc-input vc-input--mono', 'vc-refchip'].map((cls) => {
      const el = document.createElement('div'); el.className = cls; document.body.appendChild(el);
      const fam = getComputedStyle(el).fontFamily; el.remove();
      return { cls: cls.split(' ').pop(), ok: fam.includes('Roboto Mono'), fam };
    });

    return {
      cargadas:  [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family + ':' + f.weight),
      declarada: getComputedStyle(document.documentElement).getPropertyValue('--vc-mono').trim(),
      check400:  document.fonts.check('400 13px "Roboto Mono"'),
      check500:  document.fonts.check('500 13px "Roboto Mono"'),
      roboto400: medir("'Roboto Mono'", 400),
      roboto500: medir("'Roboto Mono'", 500),
      serif:     medir('serif', 400),
      cadena,
    };
  })()`);
  ok('el @font-face resolvió a archivos reales', fuente.cargadas.length > 0, JSON.stringify(fuente.cargadas));
  ok('el peso 400 está disponible para pintar', fuente.check400, JSON.stringify(fuente.cargadas));
  // El 500 no es un lujo: `.vc-chip--mono` hereda el peso medio del chip. Sin
  // el archivo, el navegador falsea la negrita engordando el trazo del 400, y
  // en una monoespaciada eso se nota enseguida.
  ok('el peso 500 está disponible (lo usa .vc-chip--mono)', fuente.check500, JSON.stringify(fuente.cargadas));
  ok('y NO está cayendo a la de respaldo', fuente.roboto400 !== fuente.serif,
    `roboto=${fuente.roboto400} serif=${fuente.serif}`);
  // El `&& check500` no es redundante: si la fuente falta, los dos pesos caen al
  // MISMO respaldo y los anchos coinciden por accidente. Sin esa condición este
  // assert daba verde justo cuando no había ninguna fuente que medir.
  ok('el 500 es el archivo real, no un 400 engordado',
    fuente.check500 && fuente.roboto500 === fuente.roboto400,
    `400=${fuente.roboto400} 500=${fuente.roboto500}`);
  ok('--vc-mono apunta a la empaquetada', fuente.declarada.includes('Roboto Mono'), fuente.declarada);
  for (const c of fuente.cadena) ok(`.${c.cls} la hereda hasta el final`, c.ok, c.fam);

  console.log('\n5. Las reglas de oro');
  const glifos = await js(`(() => {
    const malo = /[\\u2190-\\u21FF\\u2300-\\u23FF\\u25A0-\\u27BF\\u2B00-\\u2BFF\\uFE0F\\u{1F300}-\\u{1FAFF}]/u;
    const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) if (malo.test(n.nodeValue)) out.push(n.nodeValue.trim().slice(0, 40));
    return out;
  })()`);
  ok('cero emojis y glifos unicode en la UI', glifos.length === 0, JSON.stringify(glifos));
  ok('cero title= nativo', (await js(`document.querySelectorAll('[title]').length`)) === 0);
  const reglas = await js(`(() => { const r = [...document.styleSheets]
      .flatMap(ss => { try { return [...ss.cssRules] } catch { return [] } })
      .map(x => x.selectorText).filter(Boolean).join(' ');
    return { scrollbar: r.includes('::-webkit-scrollbar'), seleccion: r.includes('::selection'), focus: r.includes(':focus-visible') }; })()`);
  ok('scrollbar propia', reglas.scrollbar);
  ok('::selection propia', reglas.seleccion);
  ok('focus ring propio (:focus-visible)', reglas.focus);

  limpiar();
  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
  console.log(errores.length ? `CONSOLA:\n  ${errores.join('\n  ')}` : 'CONSOLA: limpia');
  app.exit(fail || errores.length ? 1 : 0);
});
