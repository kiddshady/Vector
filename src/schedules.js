'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   VECTOR — programación por horario
   Un ticker que revisa cada medio minuto qué pipeline le toca correr.

   Deliberadamente NO es cron. Cron es un lenguaje entero con su propia sintaxis
   y sus propios errores silenciosos; para una app de escritorio personal,
   "cada N minutos", "todos los días a las HH:MM" y "estos días de la semana a
   las HH:MM" cubren todo lo que se necesita y no se escriben mal.

   LÍMITE HONESTO: esto corre mientras la app está abierta. No es un servicio de
   Windows. Si Vector está cerrado, no dispara nada — y al abrir tampoco recupera
   las corridas que se perdieron, porque ejecutar de golpe ocho digests atrasados
   sería peor que no ejecutarlos.
   ═══════════════════════════════════════════════════════════════════════════ */

const TICK_MS = 30000;

/** { enabled, kind: 'interval'|'daily'|'weekly', everyMin, at:'HH:MM', days:[0-6] } */
function describe(schedule) {
  if (!schedule?.enabled) return 'Manual';
  const dayNames = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  if (schedule.kind === 'interval') {
    const m = Number(schedule.everyMin) || 15;
    return m % 60 === 0 ? `Cada ${m / 60} h` : `Cada ${m} min`;
  }
  if (schedule.kind === 'daily') return `Diario ${schedule.at || '08:00'}`;
  if (schedule.kind === 'weekly') {
    const days = (schedule.days || []).map((d) => dayNames[d]).join(', ') || 'sin días';
    return `${days} ${schedule.at || '08:00'}`;
  }
  return 'Manual';
}

function parseAt(at) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || '08:00'));
  if (!m) return { h: 8, min: 0 };
  return { h: Math.min(23, Number(m[1])), min: Math.min(59, Number(m[2])) };
}

/**
 * ¿Le toca correr ahora?
 * @param {object} schedule
 * @param {number|null} lastFired  timestamp del último disparo
 * @param {Date} now
 */
function isDue(schedule, lastFired, now = new Date()) {
  if (!schedule?.enabled) return false;
  const last = Number(lastFired) || 0;

  if (schedule.kind === 'interval') {
    const everyMs = Math.max(1, Number(schedule.everyMin) || 15) * 60000;
    // Sin disparo previo arranca ya: si acabás de programarlo cada 15 min,
    // esperar 15 min para el primero se siente roto.
    return now.getTime() - last >= everyMs;
  }

  if (schedule.kind === 'daily' || schedule.kind === 'weekly') {
    if (schedule.kind === 'weekly' && !(schedule.days || []).includes(now.getDay())) return false;
    const { h, min } = parseAt(schedule.at);
    const target = new Date(now);
    target.setHours(h, min, 0, 0);
    if (now < target) return false;                 // todavía no llegó la hora
    if (last >= target.getTime()) return false;     // ya disparó el de hoy
    // Ventana de gracia: si la app estuvo cerrada y se abre a las 23:00, no
    // dispara el de las 07:00 de hoy. Media hora de tolerancia y listo.
    return now.getTime() - target.getTime() <= 30 * 60000;
  }

  return false;
}

/**
 * Arranca el ticker.
 * @param {object} deps { store, startRun, onFired }
 * @returns {() => void} para frenarlo
 */
function start({ store, startRun, onFired }) {
  let stopped = false;
  let busy = false;

  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      const [cfg, pipelines] = await Promise.all([store.loadConfig(), store.listPipelines()]);
      const state = cfg.settings.scheduleState || {};
      const now = new Date();
      let changed = false;

      for (const p of pipelines) {
        if (!isDue(p.schedule, state[p.id], now)) continue;
        state[p.id] = now.getTime();
        changed = true;
        try {
          const { runId } = await startRun(p.id, p.input || {}, { source: 'schedule' });
          onFired?.({ pipelineId: p.id, pipelineName: p.name, runId });
          console.log(`[schedules] ${p.name} → ${runId}`);
        } catch (err) {
          console.error(`[schedules] ${p.name} no arrancó:`, err.message);
        }
      }

      if (changed) {
        cfg.settings.scheduleState = state;
        await store.saveConfig(cfg);
      }
    } catch (err) {
      console.error('[schedules] el ticker falló:', err.message);
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(tick, TICK_MS);
  setTimeout(tick, 4000);      // una primera pasada apenas arranca la app
  return () => { stopped = true; clearInterval(timer); };
}

module.exports = { start, isDue, describe, parseAt, TICK_MS };
