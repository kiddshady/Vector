/* Escritura atómica bajo concurrencia. Existe porque una corrida real disparó
   dos guardados del mismo archivo a la vez y el segundo murió con ENOENT: el
   `.tmp` era un nombre fijo y el primero en renombrar se lo llevaba. */

import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-store-'));
process.env.VECTOR_DATA = DIR;
const store = require('../src/store.js');

console.log('\n1. Escrituras simultáneas del mismo archivo');
const file = path.join(DIR, 'concurrente.json');

// 40 escrituras a la vez: el escenario que rompía antes.
const resultados = await Promise.allSettled(
  Array.from({ length: 40 }, (_, i) => store.writeJSON(file, { n: i })),
);
const fallidas = resultados.filter((r) => r.status === 'rejected');
ok('ninguna escritura falla', fallidas.length === 0,
  fallidas.slice(0, 2).map((f) => f.reason?.message).join(' · '));

ok('el archivo final es JSON válido y completo', (() => {
  try { return typeof JSON.parse(fs.readFileSync(file, 'utf8')).n === 'number'; } catch { return false; }
})());

const sobrantes = fs.readdirSync(DIR).filter((f) => f.includes('.tmp'));
ok('no quedan temporales tirados', sobrantes.length === 0, sobrantes.join(', '));

console.log('\n2. Guardado concurrente de una corrida');
await store.ensureDirs();
const run = {
  id: 'r-9001', pipelineId: 'p', pipelineName: 'P', state: 'running',
  startedAt: Date.now(), stepsDone: 1, stepsTotal: 5, totals: { tokensIn: 1, tokensOut: 1 },
};
const guardados = await Promise.allSettled([
  store.saveRun({ ...run, stepsDone: 1 }),
  store.saveRun({ ...run, stepsDone: 3 }),
  store.saveRun({ ...run, stepsDone: 5, state: 'done' }),
]);
ok('los tres guardados sobreviven', guardados.every((g) => g.status === 'fulfilled'),
  guardados.map((g) => g.reason?.message).filter(Boolean).join(' · '));

const idx = await store.listRuns();
ok('el índice tiene una sola entrada de esa corrida',
  idx.filter((r) => r.id === 'r-9001').length === 1, `${idx.filter((r) => r.id === 'r-9001').length}`);
ok('la corrida se puede releer', (await store.getRun('r-9001'))?.id === 'r-9001');

console.log('\n3. Bloqueo transitorio del destino (lo que pasa en Windows)');
const lockFile = path.join(DIR, 'bloqueado.json');
await store.writeJSON(lockFile, { v: 0 });
// Mantener el archivo abierto un rato simula el EPERM del rename en Windows.
const fh = fs.openSync(lockFile, 'r+');
const escritura = store.writeJSON(lockFile, { v: 99 });
setTimeout(() => fs.closeSync(fh), 120);
let sobrevivio = true;
try { await escritura; } catch (err) { sobrevivio = false; console.log('    →', err.message); }
ok('la escritura sobrevive al bloqueo', sobrevivio);
ok('y el valor nuevo quedó', JSON.parse(fs.readFileSync(lockFile, 'utf8')).v === 99);

console.log('\n4. Un JSON corrupto no borra los datos');
const roto = path.join(DIR, 'roto.json');
fs.writeFileSync(roto, '{ esto no es json');
const leido = await store.readJSON(roto, { fallback: true });
ok('devuelve el fallback', leido?.fallback === true);
ok('y aparta el archivo ilegible en vez de perderlo',
  fs.readdirSync(DIR).some((f) => f.startsWith('roto.json.corrupto-')),
  fs.readdirSync(DIR).join(', '));

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
