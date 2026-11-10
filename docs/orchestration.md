# Orquestación: cómo trabajamos y cómo gastamos poco

El objetivo es doble: que cada tarea salga bien a la primera y que no se pague por contexto ni por modelo que la tarea no necesita.

## Principios

1. **Una tarea, una sesión.** Cada petición reenvía toda la conversación, así que una sesión con tres tareas mezcladas paga las tres en cada turno. Entre tareas, `/clear`.
2. **El estado vive en archivos, no en la conversación.** `docs/STATE.md`, el plan en `docs/plans/` y los criterios de la fase permiten empezar una sesión nueva sin releer nada más.
3. **El modelo se elige por riesgo, y al empezar la sesión.** Cambiar de modelo a mitad de sesión invalida la caché y la siguiente petición relee todo el historial a precio completo.
4. **Planificar es barato; rehacer es caro.** Plan aprobado antes de tocar más de dos o tres archivos.
5. **Las pruebas deciden cuándo algo está hecho**, no el resumen de la sesión.
6. **Los subagentes cuestan uso extra.** Solo se usan para tres cosas: revisión independiente, salida ruidosa y búsquedas en la web.

## Qué modelo para qué

| Riesgo de la tarea | Ejemplos | Sesión principal | Esfuerzo | Revisión |
|---|---|---|---|---|
| Bajo | Interfaz, CRUD, contenido, estilos, datos demo | Sonnet | medio | Solo `verifier` |
| Medio | Flujos con estados, importaciones, CRM, correos | `opusplan` (Opus en modo plan, Sonnet al ejecutar) | medio | `verifier` |
| Alto | Pagos, libro de pagos, motor de precios, autenticación, permisos, datos personales | `opusplan` | alto | `verifier` + `reviewer` + revisión de Oscar |
| Decisión de arquitectura | Tareas 0.1 y 3.1, elegir orquestador de pagos | Opus (o Fable para la más difícil) | alto | Oscar aprueba el plan |

- Fable se reserva para una o dos decisiones de diseño. Antes de usarlo, comprueba cómo lo contabiliza tu plan.
- Haiku no se usa en la sesión principal. Solo en subagentes mecánicos.
- Alternativa a `opusplan` que conviene probar: sesión en Sonnet con Opus como consejero (herramienta "advisor"), que consulta al modelo fuerte solo en los puntos de decisión.

## Subagentes del proyecto

| Subagente | Modelo | Para qué | Cuándo |
|---|---|---|---|
| `verifier` | Haiku | Ejecuta lint, tipos y pruebas, y devuelve solo los fallos | Al cerrar cada tarea |
| `reviewer` | Opus, esfuerzo alto, solo lectura | Revisión independiente contra el plan y las reglas de riesgo | Al cerrar tareas de riesgo alto |
| `researcher` | Sonnet | Consulta páginas oficiales y deja tablas con fuente y fecha en `docs/research/` | Investigación de pasarelas y alojamiento |
| `mechanic` | Haiku | Cambios mecánicos y repetitivos ya decididos | Renombrados, datos demo, claves de traducción |

No se delega la implementación normal a un subagente: no mejora el resultado y duplica el contexto.

## Protocolo de una sesión

Los comandos se envían de uno en uno, cada uno en su propio mensaje.

1. Envía `/clear`.
2. Envía el comando de modelo de la tabla: `/model sonnet`, `/model opusplan` o `/model opus`.
3. Si la tarea pide esfuerzo alto, envía `/effort high`.
4. Riesgo medio o alto: entra en modo plan antes de enviar la tarea (`Shift + Tab` hasta que lo indique, o el selector de permisos de la app). `opusplan` solo usa Opus dentro del modo plan; fuera de él, todo corre en Sonnet.
5. Pega el mensaje de `prompts/02-start-task.md` con el número de tarea.
6. Claude lee `docs/STATE.md`, la tarea en el archivo de fase y solo las secciones de referencia que la tarea cita.
7. En modo plan, Oscar corrige y aprueba. El plan se guarda en `docs/plans/`.
8. Implementación en commits pequeños, con pruebas del área tocada.
9. Cierre con `prompts/03-close-task.md`: `verifier`, `reviewer` si toca, resumen de lo verificado y actualización de `docs/STATE.md`.
10. Oscar revisa según el riesgo y hace el merge.

Si algo se tuerce a mitad de tarea, vuelve al modo plan y replanifica en vez de corregir sobre la marcha.

## Hábitos que ahorran uso

- **Bloques de trabajo seguidos.** La caché de la conversación dura alrededor de una hora en suscripción. Si vas a parar más tiempo, cierra la tarea o empieza sesión nueva al volver.
- **`/usage` una vez por semana**, para ver qué modelo y qué subagente se llevan el uso, y ajustar esta tabla.
- **`/mcp` al empezar el proyecto**: desactiva los servidores que este repositorio no usa.
- **`CLAUDE.md` corto.** Se carga en cada sesión. Lo que solo aplica a una carpeta va en `.claude/rules/` con `paths`, que se carga al tocar esos archivos.
- **Peticiones concretas**: número de tarea, archivos afectados y cómo se comprueba. Las peticiones vagas provocan exploración, y la exploración se paga.
- **Sin sesiones en paralelo** hasta que el núcleo esté terminado.
- **Cuando Claude repita un error**, pídele que añada la corrección a `CLAUDE.md` o a la regla de esa carpeta, en una línea.

## Reparto del trabajo de Oscar

| Riesgo | Qué revisa Oscar |
|---|---|
| Bajo | Lo prueba en el navegador. No lee el código. |
| Medio | Lee el plan y prueba el flujo. |
| Alto | Lee el plan, las pruebas, el informe del `reviewer` y el diff de las rutas sensibles. |

Regla de avance: no se abre una fase hasta haber usado la anterior con datos de prueba realistas.

## Lo que no admite excepciones

Estas reglas no dependen de que Claude las recuerde. Están en `.claude/settings.json`: no leer archivos de secretos, no ejecutar herramientas de despliegue y pedir confirmación antes de cualquier `git push`. En la tarea 0.2 se añade un hook que impide cerrar una tarea con lint o tipos en rojo.

## Fuentes

- https://code.claude.com/docs/en/best-practices
- https://code.claude.com/docs/en/costs
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/prompt-caching
- https://code.claude.com/docs/en/advisor
- https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code
