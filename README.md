# Marathon Trips: paquete de arranque para Claude Code

Este paquete convierte la especificación en una estructura que Claude Code puede ejecutar de dos maneras: en **modo autónomo**, con un coordinador y varios hilos en paralelo que se revisan y fusionan solos, o en **modo manual**, tarea a tarea contigo delante.

## Qué hay

| Ruta | Qué es |
|---|---|
| `CLAUDE.md` | Instrucciones cortas que se cargan en cada sesión |
| `docs/brief.md`, `architecture.md`, `payments.md`, `modules.md`, `web.md` | Especificación de referencia, por secciones |
| `docs/phases/phase-0.md` a `phase-9.md` | Tareas, riesgo, modelo recomendado y criterios de aceptación |
| `docs/orchestration.md` | Qué modelo y qué subagente usar, y hábitos de ahorro |
| `docs/autonomous.md` | Reglas del modo autónomo y tabla de dependencias entre tareas |
| `docs/project-instructions.md` | Texto para pegar en las instrucciones del proyecto |
| `docs/done/` | Constancia de cada tarea hecha en modo autónomo |
| `docs/BLOCKED.md`, `docs/FINAL-REVIEW.md` | Lo bloqueado por algo externo y lo que espera tu revisión |
| `docs/STATE.md` | Dónde estamos; lo actualiza Claude al cerrar cada tarea |
| `docs/decisions.md` | Decisiones tomadas y abiertas |
| `.claude/agents/` | Subagentes: `verifier`, `reviewer`, `researcher`, `mechanic` |
| `.claude/rules/` | Reglas de pagos, precios y web, que se cargan siempre |
| `.claude/settings.json` | Límites para sesiones locales: secretos, despliegues, `git push`. No se aplican en los hilos de un proyecto |
| `prompts/` | Mensajes listos para empezar y cerrar tareas |

## Modo autónomo (recomendado)

Necesita Projects en claude.ai/code. La preparación se hace una vez y lleva unos diez minutos.

1. **Da acceso al repositorio.** Instala la app de GitHub de Claude en https://github.com/apps/claude y concédele este repositorio. Compruébalo en https://github.com/settings/installations.
2. **Crea el proyecto.** En claude.ai/code, **Projects > New project**. Nombre: `Marathon Trips`. Goal: el de `prompts/00-autonomous-kickoff.md`. Context: añade este repositorio.
3. **Evita que arranque solo.** Nada más crearlo, envía: `No hagas nada todavía, estoy configurando el proyecto.`
4. **Pega las instrucciones.** **Project settings > Memory > Project instructions**: el texto de `docs/project-instructions.md`.
5. **Baja el modelo por defecto.** **Project settings > General**: Thread model `Sonnet`, Thread effort `Medium`. El coordinador se queda como viene. Los hilos de riesgo alto piden Opus ellos mismos.
6. **Arranca.** Envía el primer mensaje de `prompts/00-autonomous-kickoff.md`.

A partir de ahí puedes cerrar el portátil. Los hilos siguen en la nube, y si se agota el límite de uso esperan y continúan solos cuando se renueva.

Qué mirar y cuándo:

- **Overview > Waiting on you**: si un hilo pide un permiso, se responde dentro de ese hilo.
- **Al cerrar cada fase**: el coordinador publica un resumen. `docs/FINAL-REVIEW.md` y `docs/BLOCKED.md` dicen qué te espera.
- **Project settings > Usage**: cuánto gasta cada hilo y cada modelo.
- **Si se para**: envía el mensaje "Si se para" de `prompts/00-autonomous-kickoff.md`.

Límites que conviene conocer:

- El ritmo lo marca el límite de uso de tu plan, no el número de agentes. Tres hilos a la vez es un punto de partida; súbelo o bájalo con un mensaje.
- GitHub incluye un cupo mensual de minutos de Actions para repositorios privados. Si CI se queda sin minutos, los hilos no pueden fusionar hasta que se renueve.
- Las fases 3, 4 y 9 se construyen contra un simulador hasta que pongas claves de sandbox en **Project settings > Environment**. Mientras tanto, esos adaptadores quedan como `experimental` y no pueden cobrar en real.
- Nadie ha mirado el código por ti. Antes de aceptar dinero real, repasa `docs/FINAL-REVIEW.md`.

## Modo manual


1. Clona este repositorio, o ábrelo en una sesión en la nube desde claude.ai/code.
2. Abre Claude Code en esa carpeta y acepta el diálogo de confianza del proyecto.
3. Envía `/mcp` y desactiva los servidores que este proyecto no necesita.
4. Envía `/model opus`. Cuando responda, envía `/effort high`.
5. Pega el mensaje de `prompts/01-kickoff.md`.
6. Lee el plan que te devuelve, responde a sus preguntas y apruébalo.
7. A partir de ahí, una tarea por sesión con `prompts/02-start-task.md` y `prompts/03-close-task.md`.

## Chuleta de modelos (modo manual)

Cada comando se envía solo, en su propio mensaje: escribe uno, pulsa Enter y espera antes de escribir el siguiente. Si juntas varios en una línea, no funcionan.

**Riesgo bajo**

1. `/clear`
2. `/model sonnet`
3. Pega el mensaje de la tarea.

**Riesgo medio**

1. `/clear`
2. `/model opusplan`
3. Entra en modo plan.
4. Pega el mensaje de la tarea.

**Riesgo alto**

1. `/clear`
2. `/model opusplan`
3. `/effort high`
4. Entra en modo plan.
5. Pega el mensaje de la tarea.

**Arquitectura (tareas 0.1 y 3.1)**

1. `/clear`
2. `/model opus`
3. `/effort high`
4. Pega el mensaje de la tarea.

Notas:

- **Modo plan:** pulsa `Shift + Tab` hasta que lo indique, o elígelo en el selector de permisos bajo la caja de texto de la app. `opusplan` solo usa Opus dentro del modo plan; fuera de él, todo corre en Sonnet.
- **Sin comandos:** en la app de escritorio el modelo también se elige en el selector bajo la caja de texto. `/model` sin nada detrás abre la lista de modelos.
- **Qué hay disponible:** teclea `/` en la caja vacía para ver los comandos de tu instalación.
- **No cambies de modelo a mitad de sesión:** obliga a releer toda la conversación sin caché.

## Reglas de avance

- En modo manual, no abras una fase sin haber usado la anterior con datos realistas. En modo autónomo, esa comprobación la hace el hilo de cierre de fase y tu parte queda en `docs/FINAL-REVIEW.md`.
- El hito es la fase 5: ahí ya se puede vender un viaje de principio a fin.
- Mira `/usage` una vez por semana y ajusta la tabla de `docs/orchestration.md` si un modelo o un subagente se lleva más de lo que aporta.

## Lo que sigue siendo tuyo

En los dos modos: revisar pagos y precios antes de aceptar dinero real, pedir cuentas y sandbox a las pasarelas, sustituir las páginas legales provisionales, elegir la marca, desplegar y poner claves reales. En modo manual, además, aprobar los planes y hacer los merges.
