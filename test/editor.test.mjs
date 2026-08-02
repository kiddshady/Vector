/* Suite del editor. Va en ESM porque `graph-util.js` vive en el renderer, que
   es módulos nativos; el motor tiene la suya en CommonJS. Corre sin Electron. */

import {
  slugify, uniqueId, wouldCycle, renameNode, autoLayout, groupBox, makeGroup,
  migrateGroups, availableRefs, makePipeline, freeSpot, NODE_W, COL,
} from '../renderer/js/graph-util.js';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FALLA ${name} ${extra}`); }
};

/* ── 1. Slugs e ids ─────────────────────────────────────────────────── */
console.log('\n1. Identificadores');
ok('quita tildes y espacios', slugify('Síntesis Final') === 'sintesis-final', slugify('Síntesis Final'));
ok('colapsa símbolos', slugify('a!!!b   c') === 'a-b-c', slugify('a!!!b   c'));
ok('recorta guiones del borde', slugify('  --hola--  ') === 'hola', slugify('  --hola--  '));
ok('vacío cae al fallback', slugify('¿¿¿', 'x') === 'x');
ok('uniqueId evita choques', uniqueId('Triage', ['triage', 'triage-2']) === 'triage-3');

/* ── 2. Ciclos ──────────────────────────────────────────────────────── */
console.log('\n2. Ciclos');
const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }];
ok('detecta el ciclo directo', wouldCycle(edges, 'c', 'a'));
ok('detecta el auto-ciclo', wouldCycle(edges, 'a', 'a'));
ok('deja pasar lo que no cierra', !wouldCycle(edges, 'a', 'c'));
ok('deja pasar una rama nueva', !wouldCycle(edges, 'b', 'd'));

/* ── 3. Renombrar ───────────────────────────────────────────────────── */
console.log('\n3. Renombrar un paso');
const mk = () => ({
  id: 'p',
  nodes: [
    { id: 'triage', kind: 'agent', prompt: 'x' },
    { id: 'triage-2', kind: 'agent', prompt: 'otro' },
    { id: 'usa', kind: 'agent', prompt: 'Mirá {{steps.triage.output}} y {{steps.triage-2.output}}' },
    { id: 'gate', kind: 'branch', when: 'steps.triage.json.score >= 0.5' },
    { id: 'out', kind: 'output', from: '{{steps.triage.output}}' },
  ],
  edges: [{ from: 'triage', to: 'usa' }, { from: 'triage-2', to: 'usa' }, { from: 'usa', to: 'gate' }],
  groups: [{ id: 'g1', label: 'G', nodes: ['triage', 'usa'] }],
});

const p1 = mk();
const res = renameNode(p1, 'triage', 'clasificador');
ok('renombra y reporta las reescrituras', res.ok && res.rewrites >= 4, JSON.stringify(res));
ok('el nodo cambió de id', p1.nodes[0].id === 'clasificador');
ok('reescribe el prompt que lo usa', p1.nodes[2].prompt.includes('{{steps.clasificador.output}}'));
// El corazón del asunto: "triage-2" NO se toca al renombrar "triage".
ok('NO pisa el id que lo tiene de prefijo', p1.nodes[2].prompt.includes('{{steps.triage-2.output}}'), p1.nodes[2].prompt);
ok('reescribe la condición del rombo', p1.nodes[3].when === 'steps.clasificador.json.score >= 0.5', p1.nodes[3].when);
ok('reescribe la salida', p1.nodes[4].from === '{{steps.clasificador.output}}');
ok('reescribe las aristas', p1.edges[0].from === 'clasificador');
ok('reescribe los miembros del grupo', p1.groups[0].nodes.includes('clasificador'));

ok('rechaza un id ya usado', renameNode(mk(), 'triage', 'gate').ok === false);
ok('rechaza un id vacío', renameNode(mk(), 'triage', '   ').ok === false);
ok('rechaza mayúsculas y espacios', renameNode(mk(), 'triage', 'Mi Paso').ok === false);
ok('renombrar a lo mismo no hace nada', renameNode(mk(), 'triage', 'triage').rewrites === 0);

/* ── 4. Grupos ──────────────────────────────────────────────────────── */
console.log('\n4. Marcos de grupo');
const gp = {
  nodes: [{ id: 'a', x: 100, y: 100 }, { id: 'b', x: 400, y: 300 }, { id: 'c', x: 900, y: 900 }],
  groups: [{ id: 'g', label: 'G', nodes: ['a', 'b'] }],
};
const box = groupBox(gp, gp.groups[0]);
ok('el marco abraza a sus miembros', box.x < 100 && box.y < 100, JSON.stringify(box));
ok('y no al que quedó afuera', box.x + box.w < 900, JSON.stringify(box));
gp.nodes[1].x = 600;
const box2 = groupBox(gp, gp.groups[0]);
ok('se estira si movés un miembro', box2.w > box.w, `${box.w} → ${box2.w}`);
ok('un grupo sin miembros no da caja', groupBox(gp, { nodes: [] }) === null);
ok('makeGroup genera id único', makeGroup(gp, ['a'], 'X').id !== 'g');

const viejo = {
  nodes: [{ id: 'a', x: 100, y: 100 }, { id: 'z', x: 2000, y: 2000 }],
  groups: [{ label: 'Viejo', x: 50, y: 50, w: 300, h: 300 }],
};
migrateGroups(viejo);
ok('migra los grupos de coordenadas a miembros',
  viejo.groups[0].nodes?.includes('a') && !viejo.groups[0].nodes.includes('z'),
  JSON.stringify(viejo.groups[0]));
ok('la migración limpia las coordenadas viejas', viejo.groups[0].x === undefined);

/* ── 5. Layout ──────────────────────────────────────────────────────── */
console.log('\n5. Layout automático');
const lay = {
  nodes: [
    { id: 'a', kind: 'input', x: 999, y: 999 },
    { id: 'b', kind: 'agent', x: 0, y: 0 },
    { id: 'c', kind: 'agent', x: 0, y: 0 },
    { id: 'd', kind: 'output', x: 0, y: 0 },
  ],
  edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }],
  groups: [{ id: 'g', label: 'G', nodes: ['b', 'c'] }],
};
autoLayout(lay);
const at = (id) => lay.nodes.find((n) => n.id === id);
ok('la raíz queda a la izquierda', at('a').x < at('b').x);
ok('los hermanos comparten columna', at('b').x === at('c').x, `${at('b').x} vs ${at('c').x}`);
ok('los hermanos no se pisan', at('b').y !== at('c').y);
ok('la confluencia queda a la derecha', at('d').x > at('b').x);
ok('la separación de columnas es la esperada', at('b').x - at('a').x === COL, `${at('b').x - at('a').x}`);
ok('los grupos sobreviven al reordenamiento', lay.groups.length === 1 && groupBox(lay, lay.groups[0]) !== null);
ok('el stage se recalcula', lay.stage.w > 0 && lay.stage.h > 0);

/* ── 6. Referencias disponibles ─────────────────────────────────────── */
console.log('\n6. Referencias para las plantillas');
const refPipe = {
  input: { query: 'x' },
  nodes: [
    { id: 'a', kind: 'agent' },
    { id: 'rombo', kind: 'branch' },
    { id: 'fan', kind: 'fanout' },
    { id: 'z', kind: 'agent' },
    { id: 'suelto', kind: 'agent' },
  ],
  edges: [{ from: 'a', to: 'rombo' }, { from: 'rombo', to: 'fan' }, { from: 'fan', to: 'z' }],
};
const refs = availableRefs(refPipe, 'z');
ok('ofrece la entrada de la corrida', refs.includes('input.query'));
ok('ofrece los pasos anteriores', refs.includes('steps.a.output'));
ok('ofrece los items de un fan-out anterior', refs.includes('steps.fan.items'));
ok('NO ofrece un rombo (solo da true/false)', !refs.includes('steps.rombo.output'));
ok('NO ofrece un paso que no es antecesor', !refs.includes('steps.suelto.output'));
ok('dentro de un fan-out ofrece item e index',
  availableRefs(refPipe, 'fan', { inFanout: true }).includes('item'));

/* ── 7. Pipeline nuevo ──────────────────────────────────────────────── */
console.log('\n7. Pipeline nuevo');
const fresh = makePipeline('Mi Pipeline');
ok('nace con entrada y salida', fresh.nodes.length === 2);
ok('nace conectado', fresh.edges.length === 1);
ok('el id sale del nombre', fresh.id === 'mi-pipeline');
ok('freeSpot esquiva lo ocupado',
  freeSpot([{ x: 100, y: 100 }], 100, 100).y > 100);
ok('freeSpot deja en paz lo libre',
  freeSpot([{ x: 100, y: 100 }], 100 + NODE_W + 200, 100).y === 100);

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
