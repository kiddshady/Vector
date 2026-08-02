/* Suite de regresión del motor. Corre con `npm test`: sin Electron, sin red y
   sin claves — todo contra el proveedor mock. Si esto pasa, el problema está en
   el proveedor o en la UI, no en el scheduler. */
const { Run } = require('../src/engine/scheduler.js');
const graph = require('../src/engine/graph.js');
const expr = require('../src/engine/expr.js');
const template = require('../src/engine/template.js');
const { AGENTS, DEMO_PIPELINE } = require('../src/seed.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FALLA ${name} ${extra}`); }
};

const settings = { concurrency: 4, defaultProvider: 'mock', providers: { mock: {} } };
const mkRun = (pipeline, id = 'r-test') =>
  new Run({ pipeline, agents: AGENTS, settings, resolveKey: () => null, id });

(async () => {
  /* ── 1. Expresiones ─────────────────────────────────────────────── */
  console.log('\n1. Evaluador de condiciones');
  const ctx = { steps: { a: { output: 'Resumen del día', json: { score: 0.82, items: [1, 2, 3] } } }, input: { n: 5 } };
  ok('comparación numérica', expr.evaluate('steps.a.json.score >= 0.7', ctx) === true);
  ok('comparación falsa', expr.evaluate('steps.a.json.score > 0.9', ctx) === false);
  ok('contains', expr.evaluate("steps.a.output contains 'resumen'", ctx) === true);
  ok('and/or con paréntesis', expr.evaluate("(steps.a.json.score > 0.5 && input.n == 5) || false", ctx) === true);
  ok('negación', expr.evaluate('!(input.n == 9)', ctx) === true);
  ok('ruta inexistente es falsa', expr.evaluate('steps.zz.output contains "x"', ctx) === false);
  ok('sintaxis inválida se detecta', expr.check('steps.a.output ===').ok === false);
  ok('__proto__ no resuelve al prototipo', template.readPath(ctx, 'steps.a.__proto__').found === false);
  ok('constructor tampoco', template.readPath(ctx, 'steps.a.constructor').found === false);
  ok('una ruta ausente equivale a null', expr.evaluate('steps.zz.output == null', ctx) === true);
  ok('null y undefined no se confunden con texto', expr.evaluate("steps.zz.output contains 'defin'", ctx) === false);
  let threw = false;
  try { expr.evaluate('process.exit(1)', ctx); } catch { threw = true; }
  ok('no hay eval: process no resuelve', threw || expr.evaluate('process.exit', ctx) === undefined);

  /* ── 2. Plantillas ──────────────────────────────────────────────── */
  console.log('\n2. Plantillas');
  ok('interpola', template.render('score={{steps.a.json.score}}', ctx) === 'score=0.82');
  ok('filtro json', template.render('{{steps.a.json.items | json}}', ctx).includes('[\n  1,'));
  let missing = false;
  try { template.render('{{steps.nope.output}}', ctx); } catch { missing = true; }
  ok('ruta faltante explota en vez de mandar "undefined"', missing);

  /* ── 3. Validación del grafo ────────────────────────────────────── */
  console.log('\n3. Validación del grafo');
  const v = graph.validate(DEMO_PIPELINE, AGENTS);
  ok('el pipeline semilla es válido', v.ok, JSON.stringify(v.errors));
  const cyc = graph.validate({
    nodes: [{ id: 'a', kind: 'input' }, { id: 'b', kind: 'output', from: 'x' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
  }, AGENTS);
  ok('detecta ciclos', !cyc.ok && cyc.errors.some((e) => e.includes('ciclo')), JSON.stringify(cyc.errors));
  const badRef = graph.validate({
    nodes: [
      { id: 'a', kind: 'input' },
      { id: 'b', kind: 'agent', agent: 'triage', prompt: '{{steps.c.output}}' },
      { id: 'c', kind: 'agent', agent: 'triage', prompt: 'x' },
    ],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
  }, AGENTS);
  ok('detecta plantilla que mira hacia adelante', !badRef.ok && badRef.errors.some((e) => e.includes('no corre antes')), JSON.stringify(badRef.errors));
  const noAgent = graph.validate({
    nodes: [{ id: 'a', kind: 'agent', agent: 'fantasma', prompt: 'x' }], edges: [],
  }, AGENTS);
  ok('detecta agente inexistente', !noAgent.ok && noAgent.errors.some((e) => e.includes('fantasma')));

  /* ── 4. Corrida completa ────────────────────────────────────────── */
  console.log('\n4. Corrida completa del pipeline semilla');
  const run = mkRun(DEMO_PIPELINE);
  const seen = [];
  const starts = [];
  let maxParallel = 0, running = 0;
  run.on('event', (e) => {
    seen.push(e.type);
    if (e.type === 'step:start') { starts.push(e.nodeId); running++; maxParallel = Math.max(maxParallel, running); }
    if (['step:done', 'step:fail', 'step:skip'].includes(e.type) && !e.willRetry) running = Math.max(0, running - 1);
  });

  const t0 = Date.now();
  const rec = await run.start({ query: 'modelos locales' });
  const elapsed = Date.now() - t0;

  ok('la corrida termina en done', rec.state === 'done', `→ ${rec.state} ${rec.error || ''}`);
  ok('orden topológico: src antes que triage', starts.indexOf('src') < starts.indexOf('triage'));
  ok('orden topológico: gate antes que deep', starts.indexOf('gate') < starts.indexOf('deep'));
  ok('la rama falsa quedó omitida', rec.steps.archive.state === 'skipped', `→ ${rec.steps.archive.state}`);
  ok('la rama verdadera corrió', rec.steps.deep.state === 'done', `→ ${rec.steps.deep.state}`);
  ok('el fan-out procesó las 6 ramas', rec.steps.deep.items?.length === 6, `→ ${rec.steps.deep.items?.length}`);
  ok('el reintento se usó y salvó el paso', rec.steps.synth.attempts === 2 && rec.steps.synth.state === 'done',
    `→ intentos=${rec.steps.synth.attempts} estado=${rec.steps.synth.state}`);
  ok('la salida final se recolectó', typeof rec.result === 'string' && rec.result.includes('Resumen'));
  ok('se contaron tokens', rec.totals.tokensIn > 0 && rec.totals.tokensOut > 0, JSON.stringify(rec.totals));
  ok('hubo eventos de token para el streaming', seen.filter((t) => t === 'step:token').length > 0);
  ok('hubo eventos de progreso del fan-out', seen.filter((t) => t === 'step:progress').length >= 6);
  // 6 ítems × 1.3 s con concurrencia 3 ≈ 2.6 s; en serie serían ~7.8 s.
  ok('el fan-out corrió en paralelo, no en serie', rec.steps.deep.durMs < 5000, `→ ${rec.steps.deep.durMs}ms`);
  ok('la corrida completa es razonable', elapsed < 12000, `→ ${elapsed}ms`);

  /* ── 5. Cancelación ─────────────────────────────────────────────── */
  console.log('\n5. Cancelación a mitad de camino');
  const run2 = mkRun(DEMO_PIPELINE, 'r-abort');
  run2.on('event', (e) => { if (e.type === 'step:start' && e.nodeId === 'deep') setTimeout(() => run2.abort(), 250); });
  const rec2 = await run2.start({ query: 'x' });
  ok('la corrida queda abortada', rec2.state === 'aborted', `→ ${rec2.state}`);
  ok('los pasos ya terminados se conservan', rec2.steps.triage.state === 'done');
  ok('lo que venía después no corrió', ['skipped', 'pending'].includes(rec2.steps.publish.state), `→ ${rec2.steps.publish.state}`);

  /* ── 6. Fallo real y propagación ───────────────────────────────── */
  console.log('\n6. Fallo definitivo y propagación de omitidos');
  const broken = structuredClone(DEMO_PIPELINE);
  broken.nodes.find((n) => n.id === 'synth').retries = 0;
  broken.nodes.find((n) => n.id === 'synth').mock = { delayMs: 100, failTimes: 9, failWith: 'Rate limit simulado' };
  const run3 = mkRun(broken, 'r-fail');
  const rec3 = await run3.start({ query: 'x' });
  ok('la corrida queda fallida', rec3.state === 'failed', `→ ${rec3.state}`);
  ok('el paso culpable queda en failed', rec3.steps.synth.state === 'failed');
  ok('el mensaje de error se conserva', String(rec3.steps.synth.error).includes('Rate limit'));
  ok('lo de aguas abajo se omite', rec3.steps.check.state === 'skipped' && rec3.steps.publish.state === 'skipped',
    `→ check=${rec3.steps.check.state} publish=${rec3.steps.publish.state}`);
  ok('lo anterior sobrevive intacto', rec3.steps.deep.state === 'done');

  /* ── 7. Fan-out tolerante a fallos de ítem ─────────────────────── */
  console.log('\n7. Fan-out con ramas que fallan');
  const partial = structuredClone(DEMO_PIPELINE);
  const deepNode = partial.nodes.find((n) => n.id === 'deep');
  deepNode.mock = { delayMs: 200, failTimes: 1, output: 'ok' };  // cada rama falla su 1er intento
  deepNode.itemErrors = 'skip';
  const rec4 = await mkRun(partial, 'r-partial').start({ query: 'x' });
  ok('con itemErrors:skip la corrida no muere', ['done', 'failed'].includes(rec4.state), `→ ${rec4.state}`);
  ok('el fan-out reporta que falló entero si fallan todas', rec4.steps.deep.state === 'failed',
    `→ ${rec4.steps.deep.state}`);

  /* ── 8. Herramientas ────────────────────────────────────────────── */
  console.log('\n8. Herramientas');
  const fs = require('fs');
  const os = require('os');
  const pathMod = require('path');
  const tools = require('../src/tools');

  const WS = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'vector-test-'));
  const toolCtx = { workspace: WS, allowShell: false, signal: null };

  let escaped = false;
  try { tools.safePath(WS, '../../fuera.txt'); escaped = true; } catch { /* esperado */ }
  ok('safePath frena el path traversal', !escaped);
  let escaped2 = false;
  try { tools.safePath(WS, 'C:\\Windows\\System32\\drivers\\etc\\hosts'); escaped2 = true; } catch { /* esperado */ }
  ok('safePath frena una ruta absoluta', !escaped2);
  ok('safePath acepta lo de adentro', tools.safePath(WS, 'sub/archivo.txt').startsWith(WS));

  const w = await tools.execute('write_file', { path: 'nota.txt', content: 'hola mundo' }, toolCtx);
  ok('write_file escribe', w.ok, w.output);
  const r = await tools.execute('read_file', { path: 'nota.txt' }, toolCtx);
  ok('read_file lee lo escrito', r.ok && r.output === 'hola mundo', r.output);
  const ls = await tools.execute('list_dir', { path: '.' }, toolCtx);
  ok('list_dir lista', ls.ok && ls.output.includes('nota.txt'), ls.output);

  const bad = await tools.execute('read_file', { path: '../../../secreto.txt' }, toolCtx);
  ok('una tool no sale de la carpeta', !bad.ok && bad.output.includes('fuera de la carpeta'), bad.output);
  const unknownTool = await tools.execute('no_existe', {}, toolCtx);
  ok('una tool inexistente devuelve error, no explota', !unknownTool.ok);

  const shell = await tools.execute('run_command', { command: 'echo hola' }, toolCtx);
  ok('run_command bloqueada sin el permiso global', !shell.ok && shell.output.includes('desactivada'), shell.output);
  ok('allowedFor descarta el shell sin permiso',
    !tools.allowedFor(['read_file', 'run_command'], { allowShell: false }).includes('run_command'));
  ok('allowedFor lo deja pasar con permiso',
    tools.allowedFor(['run_command'], { allowShell: true }).includes('run_command'));
  ok('definitions arma el esquema para el modelo',
    tools.definitions(['read_file'])[0]?.function?.name === 'read_file');

  fs.rmSync(WS, { recursive: true, force: true });

  /* ── 9. Bucle de tool-calling ───────────────────────────────────── */
  console.log('\n9. Bucle de tool-calling');
  const WS2 = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'vector-tools-'));
  fs.writeFileSync(pathMod.join(WS2, 'datos.txt'), 'contenido de prueba');

  const toolPipe = {
    id: 'p-tools', name: 'Con herramientas', input: {},
    nodes: [
      {
        id: 'lector', kind: 'agent', title: 'Lector', agent: 'triage',
        prompt: 'Leé datos.txt',
        tools: ['read_file'],
        mock: { delayMs: 50, toolCalls: [{ name: 'read_file', args: { path: 'datos.txt' } }], output: 'Leí el archivo.' },
      },
    ],
    edges: [],
  };
  const toolRun = new Run({
    pipeline: toolPipe, agents: AGENTS, id: 'r-tools',
    settings: { concurrency: 2, defaultProvider: 'mock', providers: { mock: {} }, workspace: WS2, allowShell: false },
    resolveKey: () => null,
  });
  const toolEvents = [];
  toolRun.on('event', (e) => { if (e.type === 'step:tool') toolEvents.push(e); });
  const toolRec = await toolRun.start({});
  ok('la corrida con herramientas termina bien', toolRec.state === 'done', `${toolRec.state} ${toolRec.error || ''}`);
  ok('la herramienta se ejecutó', toolRec.steps.lector.toolCalls.length === 1, JSON.stringify(toolRec.steps.lector.toolCalls));
  ok('devolvió el contenido real del archivo',
    String(toolRec.steps.lector.toolCalls[0]?.output).includes('contenido de prueba'));
  ok('el modelo respondió después de la herramienta', toolRec.steps.lector.output === 'Leí el archivo.');
  ok('se emitieron eventos de herramienta', toolEvents.length >= 2, `${toolEvents.length}`);
  ok('la llamada quedó en el registro', toolRec.log.some((l) => l.msg.includes('read_file')));

  // Tope de turnos: un mock que pide herramientas para siempre tiene que cortar.
  const loopPipe = structuredClone(toolPipe);
  loopPipe.nodes[0].mock = {
    delayMs: 20,
    toolCalls: [{ name: 'read_file', args: { path: 'datos.txt' } }],
    toolLoops: 99,     // un modelo que pide la misma herramienta para siempre
  };
  loopPipe.nodes[0].maxToolTurns = 3;
  const loopRun = new Run({
    pipeline: loopPipe, agents: AGENTS, id: 'r-loop',
    settings: { concurrency: 2, defaultProvider: 'mock', providers: { mock: {} }, workspace: WS2, allowShell: false },
    resolveKey: () => null,
  });
  const loopRec = await loopRun.start({});
  ok('el tope de turnos corta el bucle', loopRec.state === 'failed'
    && String(loopRec.steps.lector.error).includes('tope'), `${loopRec.state} ${loopRec.steps.lector.error}`);

  fs.rmSync(WS2, { recursive: true, force: true });

  /* ── 10. Compuerta de aprobación ────────────────────────────────── */
  console.log('\n10. Compuerta de aprobación humana');
  const gatePipe = {
    id: 'p-gate', name: 'Con compuerta', input: { texto: 'algo' },
    nodes: [
      { id: 'ini', kind: 'input', title: 'Entrada' },
      { id: 'gate', kind: 'approval', title: 'Aprobación', question: '¿Publicamos {{input.texto}}?' },
      { id: 'si', kind: 'output', title: 'Publicar', from: 'publicado' },
      { id: 'no', kind: 'output', title: 'Descartar', from: 'descartado' },
    ],
    edges: [
      { from: 'ini', to: 'gate' },
      { from: 'gate', to: 'si', branch: true },
      { from: 'gate', to: 'no', branch: false },
    ],
  };
  const mkGate = (id) => new Run({
    pipeline: gatePipe, agents: AGENTS, id,
    settings: { concurrency: 2, defaultProvider: 'mock', providers: { mock: {} } },
    resolveKey: () => null,
  });

  const gateRun = mkGate('r-gate');
  let waitingEv = null;
  gateRun.on('event', (e) => { if (e.type === 'step:waiting') waitingEv = e; });
  const gatePromise = gateRun.start({ texto: 'el resumen' });
  await new Promise((r) => setTimeout(r, 400));

  ok('la corrida se frena esperando', waitingEv?.nodeId === 'gate', JSON.stringify(waitingEv));
  ok('la pregunta viene interpolada', waitingEv?.question === '¿Publicamos el resumen?', waitingEv?.question);
  ok('waitingApprovals la reporta', gateRun.waitingApprovals()[0]?.nodeId === 'gate');
  ok('sigue en curso mientras espera', gateRun.state === 'running');

  gateRun.resolveApproval('gate', true, 'dale');
  const gateRec = await gatePromise;
  ok('al aprobar la corrida termina', gateRec.state === 'done', `${gateRec.state} ${gateRec.error || ''}`);
  ok('se fue por la rama verdadera', gateRec.steps.si.state === 'done' && gateRec.steps.no.state === 'skipped',
    `si=${gateRec.steps.si.state} no=${gateRec.steps.no.state}`);
  ok('la nota queda registrada', gateRec.steps.gate.approval?.note === 'dale');

  const gateRun2 = mkGate('r-gate2');
  const gatePromise2 = gateRun2.start({ texto: 'x' });
  await new Promise((r) => setTimeout(r, 400));
  gateRun2.resolveApproval('gate', false);
  const gateRec2 = await gatePromise2;
  ok('al rechazar se va por la rama falsa',
    gateRec2.steps.no.state === 'done' && gateRec2.steps.si.state === 'skipped',
    `si=${gateRec2.steps.si.state} no=${gateRec2.steps.no.state}`);

  const gateRun3 = mkGate('r-gate3');
  const gatePromise3 = gateRun3.start({ texto: 'x' });
  await new Promise((r) => setTimeout(r, 400));
  gateRun3.abort();
  const gateRec3 = await gatePromise3;
  ok('abortar libera la compuerta en vez de colgarse', gateRec3.state === 'aborted', gateRec3.state);
  ok('no quedan aprobaciones pendientes', gateRun3.waitingApprovals().length === 0);
  ok('resolver una compuerta que ya no espera devuelve false', gateRun3.resolveApproval('gate', true) === false);

  /* ── 11. Horarios ───────────────────────────────────────────────── */
  console.log('\n11. Programación por horario');
  const sch = require('../src/schedules');
  const at9 = new Date(2026, 7, 1, 9, 0, 0);

  ok('intervalo sin corrida previa dispara ya', sch.isDue({ enabled: true, kind: 'interval', everyMin: 15 }, 0, at9));
  ok('intervalo no dispara antes de tiempo',
    !sch.isDue({ enabled: true, kind: 'interval', everyMin: 15 }, at9.getTime() - 5 * 60000, at9));
  ok('intervalo dispara pasado el tiempo',
    sch.isDue({ enabled: true, kind: 'interval', everyMin: 15 }, at9.getTime() - 16 * 60000, at9));
  ok('apagado nunca dispara', !sch.isDue({ enabled: false, kind: 'interval', everyMin: 1 }, 0, at9));

  ok('diario dispara pasada la hora',
    sch.isDue({ enabled: true, kind: 'daily', at: '08:50' }, 0, at9));
  ok('diario no dispara antes de la hora',
    !sch.isDue({ enabled: true, kind: 'daily', at: '09:30' }, 0, at9));
  ok('diario no repite el mismo día',
    !sch.isDue({ enabled: true, kind: 'daily', at: '08:50' }, new Date(2026, 7, 1, 8, 51).getTime(), at9));
  ok('diario no recupera lo viejo tras horas cerrado',
    !sch.isDue({ enabled: true, kind: 'daily', at: '02:00' }, 0, at9));

  const sabado = at9.getDay();
  ok('semanal respeta el día',
    sch.isDue({ enabled: true, kind: 'weekly', at: '08:50', days: [sabado] }, 0, at9));
  ok('semanal ignora los otros días',
    !sch.isDue({ enabled: true, kind: 'weekly', at: '08:50', days: [(sabado + 1) % 7] }, 0, at9));
  ok('describe habla en criollo', sch.describe({ enabled: true, kind: 'interval', everyMin: 120 }) === 'Cada 2 h');

  /* ── 12. Validación de los tipos nuevos ─────────────────────────── */
  console.log('\n12. Validación con aprobación');
  const vGate = graph.validate(gatePipe, AGENTS);
  ok('un pipeline con compuerta valida', vGate.ok, JSON.stringify(vGate.errors));
  const vGateHalf = graph.validate({
    nodes: [
      { id: 'a', kind: 'input' },
      { id: 'g', kind: 'approval', title: 'G' },
      { id: 'b', kind: 'output', from: 'x' },
    ],
    edges: [{ from: 'a', to: 'g' }, { from: 'g', to: 'b', branch: true }],
  }, AGENTS);
  ok('avisa si a la compuerta le falta la rama falsa',
    vGateHalf.warnings.some((w) => w.includes('caso falso')), JSON.stringify(vGateHalf.warnings));

  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('EXPLOTÓ:', e); process.exit(1); });
