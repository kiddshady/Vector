'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   VECTOR — preload
   La única puerta entre el renderer y el sistema. `contextIsolation` está
   activo, así que el renderer no tiene require, ni fs, ni red directa: solo
   estas funciones.

   Nada de lo que se expone acá devuelve una clave de API en claro.
   ═══════════════════════════════════════════════════════════════════════════ */

const { contextBridge, ipcRenderer } = require('electron');

/** Desenvuelve {ok,data|error} y convierte el error en una excepción real. */
const call = async (channel, ...args) => {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res?.ok) throw new Error(res?.error || `Falló ${channel}`);
  return res.data;
};

contextBridge.exposeInMainWorld('vector', {
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    close: () => ipcRenderer.send('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
    onMaximized: (cb) => {
      const handler = (_e, value) => cb(value);
      ipcRenderer.on('win:maximized', handler);
      return () => ipcRenderer.off('win:maximized', handler);
    },
  },

  bootstrap: () => call('app:bootstrap'),

  pipelines: {
    list: () => call('pipelines:list'),
    get: (id) => call('pipelines:get', id),
    save: (p) => call('pipelines:save', p),
    remove: (id) => call('pipelines:delete', id),
    validate: (id) => call('pipelines:validate', id),
  },

  engine: {
    /** Valida una condición de rombo sin correr nada. */
    checkExpr: (source) => call('engine:check-expr', source),
    /** Catálogo de herramientas disponibles para los agentes. */
    tools: () => call('engine:tools'),
  },

  agents: {
    list: () => call('agents:list'),
    save: (a) => call('agents:save', a),
    remove: (id) => call('agents:delete', id),
  },

  runs: {
    list: (limit) => call('runs:list', limit),
    get: (id) => call('runs:get', id),
    remove: (id) => call('runs:delete', id),
    active: () => call('runs:active'),
    start: (pipelineId, input) => call('run:start', pipelineId, input),
    pause: (id) => call('run:pause', id),
    resume: (id) => call('run:resume', id),
    abort: (id) => call('run:abort', id),
    /** Resuelve una compuerta humana que está esperando decisión. */
    approve: (runId, nodeId, approved, note) => call('run:approve', runId, nodeId, approved, note),
    /** Suscripción al stream de eventos del motor. Devuelve el des-suscriptor. */
    onEvent: (cb) => {
      const handler = (_e, ev) => cb(ev);
      ipcRenderer.on('run:event', handler);
      return () => ipcRenderer.off('run:event', handler);
    },
    /** Avisos del programador de horarios. */
    onScheduled: (cb) => {
      const handler = (_e, info) => cb(info);
      ipcRenderer.on('schedule:fired', handler);
      return () => ipcRenderer.off('schedule:fired', handler);
    },
  },

  settings: {
    get: () => call('settings:get'),
    save: (patch) => call('settings:save', patch),
    setKey: (providerId, key) => call('settings:set-key', providerId, key),
    test: (providerId) => call('settings:test', providerId),
  },
});
