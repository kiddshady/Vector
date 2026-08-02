'use strict';

const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const path = require('path');
const ipc = require('./src/ipc');

// Color base de la app. Tiene que ser IDÉNTICO a --vc-bg en tokens.css:
// Electron 40 lo usa para teñir el frame fantasma del compositor de Windows
// (minimizar → restaurar) y para matar el flash de contenido del arranque.
const BG = '#0a0b0d';

const WIN_W = 1360;
const WIN_H = 880;

/** @type {BrowserWindow | null} */
let win = null;

function createWindow() {
  // Centrado a mano sobre el área útil (descuenta la taskbar): como pasamos
  // x/y explícitos off-screen, Electron ya no auto-centra.
  const { x: waX, y: waY, width: waW, height: waH } = screen.getPrimaryDisplay().workArea;
  const winX = Math.round(waX + (waW - WIN_W) / 2);
  const winY = Math.round(waY + (waH - WIN_H) / 2);

  win = new BrowserWindow({
    // Nace fuera de pantalla: el flash del compositor DWM en el primer show()
    // ocurre donde nadie lo ve. La snapeamos al centro 200 ms después.
    x: -20000,
    y: -20000,
    width: WIN_W,
    height: WIN_H,
    minWidth: 1040,
    minHeight: 640,
    frame: false,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: BG,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    // Dejar que DWM asiente la superficie off-screen antes de mover.
    // 200 ms es el número validado; bajarlo reintroduce el flash de forma intermitente.
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.setPosition(winX, winY);
    }, 200);
  });

  // En dev, la consola del renderer sale por la terminal: si un módulo no carga
  // o una vista revienta, se ve acá sin tener que abrir devtools.
  if (process.argv.includes('--dev')) {
    win.webContents.on('console-message', (e) => {
      const level = ['debug', 'info', 'warn', 'error'][e.level] ?? e.level;
      console.log(`[renderer:${level}] ${e.message}`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[renderer] no cargó (${code} ${desc}) → ${url}`);
    });
  }

  const pushMaximized = () => {
    if (win && !win.isDestroyed()) win.webContents.send('win:maximized', win.isMaximized());
  };
  win.on('maximize', pushMaximized);
  win.on('unmaximize', pushMaximized);

  // Nada de navegación fuera de la app; los links externos van al navegador.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:toggle-maximize', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('win:close', () => win && win.close());
ipcMain.handle('win:is-maximized', () => (win ? win.isMaximized() : false));

app.whenReady().then(() => {
  ipc.register();
  createWindow();
});

// Una corrida a medias no puede sobrevivir al cierre: se aborta y se guarda.
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !ipc.active.size) return;
  e.preventDefault();
  quitting = true;
  ipc.shutdown().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
