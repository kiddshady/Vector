/* ═══════════════════════════════════════════════════════════════════════════
   VECTOR — vocabulario y formato
   El puente entre lo que dice el motor y lo que dibuja la UI. Es el único lugar
   donde se traduce un estado interno a una forma, una palabra o un número
   legible: si la traducción vive desperdigada, tarde o temprano dos vistas
   muestran lo mismo distinto.
   ═══════════════════════════════════════════════════════════════════════════ */

/** El tipo de nodo decide su forma. Tiene que coincidir con src/engine/graph.js. */
export const SHAPE = {
  input: 'square',
  output: 'square',
  agent: 'circle',
  branch: 'diamond',
  approval: 'diamond',   // también bifurca; la diferencia es quién decide
  fanout: 'hex',
};

export const STATE_LABEL = {
  idle: 'Sin correr',
  pending: 'En cola',
  queued: 'En cola',
  running: 'Corriendo',
  waiting: 'Esperando',
  done: 'Listo',
  skipped: 'Omitido',
  failed: 'Falló',
  aborted: 'Abortado',
};

/**
 * El motor usa `pending` para "todavía no le tocó". Sin corrida encima eso es
 * "sin correr"; con una corrida en curso es "en cola", que es otra cosa.
 */
export function markState(engineState, hasRun = true) {
  if (!engineState) return hasRun ? 'queued' : 'idle';
  if (engineState === 'pending') return hasRun ? 'queued' : 'idle';
  return engineState;
}

/* ── Formato ─────────────────────────────────────────────────────────────── */

export function fmtDur(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

export function fmtTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtUsd(n) {
  if (!n) return '0.00';
  return n < 0.01 ? n.toFixed(4) : n.toFixed(2);
}

export function fmtClock(ts) {
  if (!ts) return '—';
  const d = typeof ts === 'string' ? new Date(ts) : new Date(Number(ts));
  return d.toLocaleTimeString('es-AR', { hour12: false });
}

/** "hace 2 min" — para que el usuario no tenga que restar fechas mentalmente. */
export function relTime(ts) {
  if (!ts) return 'nunca';
  const diff = Date.now() - Number(ts);
  if (diff < 0) return 'recién';
  const s = Math.round(diff / 1000);
  if (s < 45) return 'recién';
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'ayer' : `hace ${d} días`;
}

const DAY_NAMES = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

/** Un horario en palabras. Tolera el formato viejo (una cadena suelta). */
export function describeSchedule(schedule) {
  if (typeof schedule === 'string') return schedule || 'Manual';
  if (!schedule?.enabled) return 'Manual';
  if (schedule.kind === 'interval') {
    const m = Number(schedule.everyMin) || 15;
    return m % 60 === 0 ? `Cada ${m / 60} h` : `Cada ${m} min`;
  }
  if (schedule.kind === 'daily') return `Diario ${schedule.at || '08:00'}`;
  if (schedule.kind === 'weekly') {
    const days = (schedule.days || []).map((d) => DAY_NAMES[d]).join(', ') || 'sin días';
    return `${days} · ${schedule.at || '08:00'}`;
  }
  return 'Manual';
}

/** Iniciales para el monograma del agente cuando no trae uno propio. */
export function monogram(name = '') {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '··';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
