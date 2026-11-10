# Empezar una tarea

Antes de pegar el mensaje, envía los comandos de preparación de uno en uno, cada uno en su propio mensaje. La lista completa por riesgo está en `README.md`, sección "Chuleta de modelos".

## Riesgo bajo

Preparación: `/clear`, después `/model sonnet`.

Tarea N.M de `docs/phases/phase-N.md`. Lee `docs/STATE.md` y solo las secciones de referencia que cita la fase para esta tarea. Hazla y enséñame cómo comprobarla.

## Riesgo medio

Preparación: `/clear`, después `/model opusplan`, y entra en modo plan (`Shift + Tab`) antes de pegar.

Tarea N.M de `docs/phases/phase-N.md`. Lee `docs/STATE.md` y solo las secciones de referencia que cita la fase para esta tarea. Antes de cambiar nada, dime qué archivos vas a tocar, qué harás en cada uno y qué pruebas escribirás. Espera mi visto bueno y guarda el plan en `docs/plans/`.

## Riesgo alto

Preparación: `/clear`, después `/model opusplan`, después `/effort high`, y entra en modo plan (`Shift + Tab`) antes de pegar.

Tarea N.M de `docs/phases/phase-N.md`. Lee `docs/STATE.md`, la regla de `.claude/rules/` de esta área y solo las secciones de referencia que cita la fase. En modo plan, dame: el diseño, los casos de fallo que cubrirás, las pruebas que escribirás primero y lo que no vas a hacer. Espera mi visto bueno y guarda el plan en `docs/plans/`. Escribe las pruebas de los casos de fallo antes que la implementación.
