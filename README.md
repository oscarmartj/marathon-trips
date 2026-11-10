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

1. Crea un repositorio privado vacío y copia dentro todo el contenido de esta carpeta, incluida `.claude/`.
2. Abre Claude Code en esa carpeta y acepta el diálogo de confianza del proyecto.
3. Ejecuta `/mcp` y desactiva los servidores que este proyecto no necesita.
4. Ejecuta `/model opus` y `/effort high`, y pega el mensaje de `prompts/01-kickoff.md`.
5. Lee el plan que te devuelve, responde a sus preguntas y apruébalo.
6. A partir de ahí, una tarea por sesión con `prompts/02-start-task.md` y `prompts/03-close-task.md`.

## Chuleta de modelos

| Tarea | Antes de empezar |
|---|---|
| Riesgo bajo | `/clear`, `/model sonnet` |
| Riesgo medio | `/clear`, `/model opusplan` |
| Riesgo alto | `/clear`, `/model opusplan`, `/effort high` |
| Arquitectura (0.1 y 3.1) | `/clear`, `/model opus`, `/effort high` |

Elige el modelo al empezar la sesión y no lo cambies a mitad: cambiarlo obliga a releer toda la conversación sin caché.

## Reglas de avance

- No abras una fase sin haber usado la anterior con datos realistas.
- El hito es la fase 5: ahí ya se puede vender un viaje de principio a fin.
- Mira `/usage` una vez por semana y ajusta la tabla de `docs/orchestration.md` si un modelo o un subagente se lleva más de lo que aporta.

## Lo que sigue siendo tuyo

Aprobar planes, revisar lo de riesgo alto, pedir cuentas y sandbox a las pasarelas, sustituir las páginas legales provisionales, desplegar y poner claves reales.
