# Marathon Trips: paquete de arranque para Claude Code

Este paquete convierte la especificación en una estructura que Claude Code puede ejecutar tarea a tarea, gastando el uso justo.

## Qué hay

| Ruta | Qué es |
|---|---|
| `CLAUDE.md` | Instrucciones cortas que se cargan en cada sesión |
| `docs/brief.md`, `architecture.md`, `payments.md`, `modules.md`, `web.md` | Especificación de referencia, por secciones |
| `docs/phases/phase-0.md` a `phase-9.md` | Tareas, riesgo, modelo recomendado y criterios de aceptación |
| `docs/orchestration.md` | Qué modelo y qué subagente usar, y hábitos de ahorro |
| `docs/STATE.md` | Dónde estamos; lo actualiza Claude al cerrar cada tarea |
| `docs/decisions.md` | Decisiones tomadas y abiertas |
| `.claude/agents/` | Subagentes: `verifier`, `reviewer`, `researcher`, `mechanic` |
| `.claude/rules/` | Reglas que solo se cargan al tocar pagos, precios o la web |
| `.claude/settings.json` | Límites que se aplican siempre: secretos, despliegues, `git push` |
| `prompts/` | Mensajes listos para empezar y cerrar tareas |

## Cómo empezar

1. Clona este repositorio, o ábrelo en una sesión en la nube desde claude.ai/code.
2. Abre Claude Code en esa carpeta y acepta el diálogo de confianza del proyecto.
3. Envía `/mcp` y desactiva los servidores que este proyecto no necesita.
4. Envía `/model opus`. Cuando responda, envía `/effort high`.
5. Pega el mensaje de `prompts/01-kickoff.md`.
6. Lee el plan que te devuelve, responde a sus preguntas y apruébalo.
7. A partir de ahí, una tarea por sesión con `prompts/02-start-task.md` y `prompts/03-close-task.md`.

## Chuleta de modelos

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

- No abras una fase sin haber usado la anterior con datos realistas.
- El hito es la fase 5: ahí ya se puede vender un viaje de principio a fin.
- Mira `/usage` una vez por semana y ajusta la tabla de `docs/orchestration.md` si un modelo o un subagente se lleva más de lo que aporta.

## Lo que sigue siendo tuyo

Aprobar planes, revisar lo de riesgo alto, pedir cuentas y sandbox a las pasarelas, sustituir las páginas legales provisionales, desplegar y poner claves reales.
