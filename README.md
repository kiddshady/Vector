# Vector

Orquestador de agentes. **Las cuatro fases están completas**: el motor corre, los
pipelines se arman con el mouse, los agentes usan herramientas reales, las compuertas
esperan tu visto bueno y los horarios disparan solos.

```bash
npm install && npm run dev
```

`npm start` corre igual pero sin el reenvío de la consola del renderer a la terminal.
`npm test` corre la suite del motor (sin Electron, sin red, sin claves).

La app arranca con un pipeline de ejemplo que funciona contra el proveedor **mock**:
apretás *Correr* y ves el grafo moverse, sin configurar nada y sin gastar un centavo.

---

## La idea de diseño

Paleta acromática: negro, grises y blanco. En un sistema así **el acento es la luz** —
lo primario se rellena de blanco puro, lo seleccionado es lo más claro, y lo que ya
terminó se apaga y retrocede. Por eso hay como máximo un botón primario por pantalla:
dos blancos compitiendo destruyen la jerarquía.

**El rojo es el único color de la app y aparece una sola vez: cuando algo falla.**

Como el color no está disponible para codificar estado, lo hacen otros tres canales:

| Canal | Qué comunica | Cómo |
|---|---|---|
| **Forma** | Qué *es* el nodo | ■ entrada/salida · ● agente · ◆ decisión · ⬢ fan-out |
| **Luminancia** | Si está *vivo* | corriendo = lo más claro · terminado = atenuado |
| **Movimiento** | Qué pasa *ahora* | el anillo que respira y el guion que viaja por la arista son exclusivos de "corriendo" |

Un vector tiene dirección, así que todo lo que pertenece al flujo entra sobre el eje X
(izquierda → derecha, el sentido en que corre un pipeline) y las listas sobre Y.

---

## Estructura

```
main.cjs              ventana anti-flash + ciclo de vida
preload.cjs           la única puerta entre renderer y sistema
src/                  ── proceso principal ──
  store.js            JSON atómico (tmp + fsync + rename) con migración de esquema
  secrets.js          claves cifradas con safeStorage/DPAPI
  seed.js             el pipeline de ejemplo y los agentes iniciales
  ipc.js              superficie IPC; acá viven las corridas activas
  providers/
    index.js          registro: ollama-cloud · openrouter · mock
    openai-compat.js  adaptador con streaming SSE, uso de tokens y timeouts
  tools/
    index.js          las cinco herramientas, con sus límites
  schedules.js        el reloj: intervalo, diario y semanal
  engine/
    template.js       interpolación {{...}} — lectura de rutas, nunca eval
    expr.js           condiciones de los rombos — parser propio, nunca eval
    graph.js          validación y topología (ciclos, referencias, alcanzabilidad)
    scheduler.js      el motor: paralelismo, ramas, fan-out, tool-calling, compuertas
test/
  engine.test.cjs     85 comprobaciones del motor, herramientas y horarios
  editor.test.mjs     46 del editor (renombrado, grupos, layout, ciclos)
data/                 ── tus datos ──
  pipelines/*.json    versionables en git: son la definición del trabajo
  config.json         agentes, ajustes y claves cifradas (ignorado por git)
  runs/               historial (ignorado por git)
renderer/
  css/                tokens · base · motion · shell · controls · surfaces · overlays · graph
  js/
    vocab.js          traducción estado del motor → forma, palabra y número
    ui.js             helpers compartidos + el router (rompe el ciclo de imports)
    store.js          espejo local + bus de eventos de las corridas
    icons.js          ~60 SVG propios. Cero emojis, cero glifos unicode.
    motion.js         presencia (salidas animadas), scroll-fade, indicadores que viajan
    overlays.js       Tooltip · Toast · Menu · Modal
    palette.js        Ctrl+K con match por subsecuencia
    graph-util.js     layout por capas, detección de ciclos, fábrica de nodos
    graph-view.js     el lienzo Y el editor: arrastre, conexión, undo, autoguardado
    design-view.js    el catálogo de primitivos (documentación viva)
    app.js            router + el resto de las vistas
```

---

## El editor

El lienzo tiene dos modos y solo uno está activo por vez:

- **Edición** — sin corrida en curso. Se arrastra, se conecta, se borra y se configura.
- **Observación** — con corrida en curso, todo bloqueado. Editar el grafo que se está
  ejecutando dejaría a la corrida hablando de un pipeline que ya no existe.

Cuando la corrida termina se **conserva la foto final** sobre el grafo y vuelve la
edición: acabás de ejecutar algo y querés ver cómo fue, no un lienzo en blanco. Al abrir
un pipeline también se pinta encima el resultado de su última corrida.

| Gesto | Qué hace |
|---|---|
| arrastrar un nodo | moverlo (con snap a 10 px, para que el JSON quede legible) |
| tirar del punto derecho | conectar con otro paso |
| click en una arista | seleccionarla · `Supr` la borra |
| `+` en la barra | agregar un paso de cualquiera de los cinco tipos |
| ícono de ajustar | ordenar el grafo por capas automáticamente |
| `Shift` + click | sumar pasos a la selección · arrastrar mueve a todos |
| `Ctrl G` | agrupar los seleccionados en un marco |
| click en la etiqueta de un marco | seleccionarlo · doble click lo renombra · `Supr` lo saca |
| `Ctrl Z` / `Ctrl Y` | deshacer y rehacer (60 pasos) |
| `Ctrl` + rueda | zoom · arrastrar el vacío desplaza |

El **identificador** de un paso se puede renombrar desde el inspector: al confirmar se
reescriben solas todas las referencias —plantillas, condiciones y aristas— y te dice
cuántas tocó. El límite de palabra es estricto, así que renombrar `triage` no pisa
`triage-2`. Los **marcos de grupo** guardan a quiénes abrazan, no coordenadas: siguen a
sus miembros y sobreviven al reordenamiento automático.

**Todo se guarda solo**, con freno de medio segundo, y el estado se ve arriba a la
derecha. La **validación corre en vivo** contra el mismo chequeo del motor —no una copia
en el renderer, que se desincronizaría— y aparece abajo a la derecha. Un paso al que le
falta lo mínimo para correr se marca con trazo punteado, sin color: es un borrador, no un
fallo, y el rojo está reservado para lo que se rompe.

El editor **rechaza lo imposible en el momento**: un ciclo (te dice cuál), una conexión
repetida. Desde un rombo, la arista nueva se etiqueta sola con la rama que falte —`sí` o
`no`— y si ya están las dos, pregunta.

En los campos de prompt, condición y `over` hay **chips con las referencias disponibles**:
solo los pasos que corren antes que ese, y se insertan en el cursor. Escribir
`{{steps.x.output}}` a mano es pedir un error de tipeo que cuesta una corrida.

---

## Cómo se define un pipeline

Un archivo JSON en `data/pipelines/` — que es lo que el editor escribe, y sigue siendo
editable a mano. Cinco tipos de paso:

| `kind` | Qué hace |
|---|---|
| `input` | La entrada de la corrida. Queda disponible como `{{input.loQueSea}}`. |
| `agent` | Una llamada al modelo. Necesita `agent` y `prompt`. Puede usar herramientas. |
| `branch` | Evalúa `when` y enciende una de sus salidas. |
| `fanout` | Itera `over` en paralelo; dentro del prompt usás `{{item}}` e `{{index}}`. |
| `approval` | **Frena la corrida** hasta que decidís. Bifurca como un rombo. |
| `output` | Recolecta el resultado con `from`. |

Las aristas van en `edges`. Las que salen de un `branch` llevan `branch: true|false`.

```json
{ "id": "gate", "kind": "branch", "when": "steps.triage.json.score >= 0.7" }
{ "from": "gate", "to": "deep", "branch": true, "label": "sí" }
```

**Plantillas** (`{{...}}`) leen rutas del contexto: `input`, `steps.<id>.output`,
`steps.<id>.json`, `steps.<id>.items`, y dentro de un fan-out `item` e `index`.
Filtros: `| json`, `| trim`, `| upper`, `| lower`.

**Condiciones** aceptan `== != > >= < <=`, `contains`, `startsWith`, `endsWith`,
`matches`, `in`, más `&& || !` y paréntesis. Nada más: es un parser propio, no
JavaScript. Un pipeline es un archivo de datos y no tiene que poder ejecutar código.

Por paso: `retries`, `timeoutMs`, `temperature`, `maxTokens`, `model`;
en un fan-out además `concurrency` e `itemErrors: "skip"` para que una rama rota no
mate la corrida. En un `branch`, `allowDeadEnd: true` si el corte es intencional.

---

## Semántica del motor (lo que más confunde de un orquestador)

- Un paso espera a que **todas** sus entradas queden resueltas — eso es el *tiempo*.
- Después corre si **al menos una** quedó activa — eso es la *habilitación*.
- Un rombo que se fue por "no" deja la otra rama omitida, y lo que venía después se
  omite en cascada. Pero un paso que junta las dos ramas igual corre.
- Un paso que falla definitivamente apaga sus salidas: lo de aguas abajo se omite y la
  corrida termina en `failed`. Lo que ya había terminado se conserva.
- **Pausar** no congela lo que ya está en vuelo: deja de lanzar pasos nuevos y espera a
  que los que corren terminen. **Abortar** sí corta todo por `AbortSignal`.
- La corrida vive en el proceso principal. Si recargás la ventana, se reengancha sola.

---

## Proveedores

| | URL base por defecto | Notas |
|---|---|---|
| **Ollama Cloud** | `https://ollama.com/v1` | Clave en ollama.com/settings/keys. Suscripción: no se reporta costo por token. |
| **OpenRouter** | `https://openrouter.ai/api/v1` | Clave en openrouter.ai/keys. Devuelve el costo real de cada llamada. |
| **Mock** | — | Local, sin red. Simula latencia, streaming, tokens y fallos. |

Las dos URLs se editan en Ajustes por si cambian. Las claves **nunca salen del proceso
principal**: la interfaz solo recibe si están puestas, si se pueden leer, y sus últimos
cuatro caracteres.

> **Cómo cifra de verdad `safeStorage` en Windows** (no es lo que uno supone). No es DPAPI
> directo sobre el dato: es el formato OSCrypt de Chromium — el blob empieza con `v10,` —
> que usa una clave maestra AES guardada en `<userData>/Local State`, y esa clave sí está
> protegida con DPAPI por usuario.
>
> La consecuencia práctica no es solo que copiar `config.json` a otra máquina no sirva:
> **si borrás el userData de la app (`%APPDATA%\Vector`) o le cambiás el nombre, las claves
> guardadas dejan de poder leerse**, aunque el `config.json` siga intacto. Por eso Ajustes
> no se conforma con ver que el registro existe: intenta descifrarlo y avisa con
> «clave ilegible» si no puede, en vez de dejarte descubrirlo a mitad de una corrida.

El **mock** no es un juguete: es lo que permite probar el motor sin clave, sin latencia
y sin gasto. Se controla con el bloque `mock` del paso — `{ output, json, delayMs,
failTimes }` — y `failTimes` es lo que hace visible un reintento de verdad.

---

## Atajos

| | |
|---|---|
| `Ctrl K` | command palette (navegar, correr, validar) |
| `Ctrl` + rueda | zoom del lienzo |
| arrastrar el vacío | desplazar el lienzo |
| `Esc` | cerrar el overlay de arriba |

---

## Herramientas

Lo que un agente puede hacer además de escribir. Se activan **por paso**, desde el
inspector del lienzo.

| | Qué hace | Límite |
|---|---|---|
| `read_file` | Lee un archivo de texto | Solo dentro de la carpeta de trabajo |
| `write_file` | Escribe o reemplaza un archivo | Solo dentro de la carpeta de trabajo |
| `list_dir` | Lista un directorio | Solo dentro de la carpeta de trabajo |
| `fetch_url` | Descarga una página o API por GET | Solo http/https; el HTML se pasa a texto |
| `run_command` | Ejecuta un comando de shell | **Doble cerrojo** (ver abajo) |

**Los límites, que son la parte importante:**

- Las de disco viven confinadas a `data/workspace/` (configurable en Ajustes). Toda ruta
  se resuelve y se compara contra esa raíz: `../../` falla, y una ruta absoluta también.
- `run_command` está detrás de **dos** cerrojos: un ajuste global apagado de fábrica y el
  permiso por agente. Un modelo que alucina un `rm -rf` no debería poder ejecutarlo porque
  alguien se olvidó de un checkbox.
- **Toda llamada queda en el registro de la corrida**, con sus argumentos y el tamaño de
  la respuesta. Una herramienta que se ejecuta sin dejar rastro es una que no podés auditar.
- El bucle de herramientas tiene tope de turnos (5 por defecto): un modelo que se queda
  pidiendo lo mismo se corta en vez de consumir tokens sin fin.

## Compuertas humanas

Un paso `approval` frena la corrida y espera. Muestra una pregunta y una vista previa
—ambas con plantillas, así que podés mostrar lo que produjo el paso anterior— y bifurca
según apruebes o rechaces. La nota que escribas queda en el registro.

**No tiene timeout a propósito.** Un paso que se auto-aprueba por cansancio no es una
aprobación. Si querés cortar, abortás la corrida.

## Horarios

Intervalo, diario o semanal. Deliberadamente **no es cron**: para una app de escritorio
personal, "cada N minutos" y "estos días a las HH:MM" cubren todo y no se escriben mal.

> **Límite honesto:** el reloj corre mientras Vector esté abierto. No es un servicio de
> Windows. Si la app está cerrada no dispara, y al volver a abrirla **tampoco recupera**
> lo que se perdió — ejecutar de golpe ocho digests atrasados sería peor que no ejecutarlos.

---

## Lo que falta

- **Biblioteca**: prompts reutilizables, esquemas de salida y artefactos de las corridas.
- Las herramientas son un catálogo fijo; no hay forma de agregar una propia desde la UI
  (habría que tocar `src/tools/index.js`).
- Un paso `approval` bloquea un lugar de la concurrencia mientras espera. Con el límite en
  4 y cuatro compuertas abiertas a la vez, el resto del grafo queda frenado hasta que
  decidas — que es discutible, pero al menos es predecible.
- Salida estructurada garantizada (JSON schema / grammars): hoy se parsea lo que venga y
  se cae con elegancia si no era JSON.
