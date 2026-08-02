/* ═══════════════════════════════════════════════════════════════════════════
   Genera build/icon.png (1024×1024) desde la marca de la app.

   La marca es la MISMA que pinta el splash y la titlebar (renderer/index.html):
   dos chevrones, el de atrás tenue. Si la cambiás allá, corré esto de nuevo:

     node_modules\.bin\electron build\make-icon.cjs

   Se renderiza con Electron en vez de con una librería de imágenes porque
   Electron ya está instalado y porque así el ícono sale del MISMO motor que
   dibuja la app: lo que ves en la ventana es lo que queda en el .png.
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const LADO = 1024;
const SALIDA = path.join(__dirname, 'icon.png');

/* El viewBox de la marca es 0 0 16 16, pero el trazo va de x=2.5 a x=12.5:
   su centro cae en 7.5, no en 8. Sin ese medio punto de corrección el ícono
   se ve pegado a la izquierda, que es el tipo de cosa que no se sabe nombrar
   pero se nota. */
const HTML = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: ${LADO}px; height: ${LADO}px; background: transparent; }
  .placa {
    width: ${LADO}px; height: ${LADO}px;
    box-sizing: border-box;
    background: #0a0b0d;
    border-radius: ${Math.round(LADO * 0.18)}px;
    display: grid; place-items: center;
  }
  svg { width: ${Math.round(LADO * 0.62)}px; height: ${Math.round(LADO * 0.62)}px;
        stroke: #f2f4f7; fill: none;
        stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
  .trail { opacity: .34 }
</style>
<div class="placa">
  <svg viewBox="0 0 16 16">
    <g transform="translate(0.5 0)">
      <path class="trail" d="M2.5 4 6 8l-3.5 4"/>
      <path d="M7.5 3.5 12.5 8l-5 4.5"/>
    </g>
  </svg>
</div>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: LADO, height: LADO, show: false,
    transparent: true, frame: false, backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: false },
  });

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
  await new Promise((r) => setTimeout(r, 700));   // que asiente el layout

  const img = await win.capturePage();
  const { width, height } = img.getSize();
  if (width !== LADO || height !== LADO) {
    console.log(`ABORTADO: la captura salió ${width}×${height}, se esperaba ${LADO}×${LADO}`);
    app.exit(1);
    return;
  }

  fs.mkdirSync(path.dirname(SALIDA), { recursive: true });
  fs.writeFileSync(SALIDA, img.toPNG());
  console.log(`ok  ${SALIDA}  ${width}×${height}  ${(fs.statSync(SALIDA).size / 1024).toFixed(1)} KB`);
  app.exit(0);
});

setTimeout(() => { console.log('timeout'); app.exit(3); }, 30000);
