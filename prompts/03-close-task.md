# Cerrar una tarea

## Riesgo bajo o medio

Cierra la tarea. Pasa el subagente `verifier`. Dime, criterio por criterio de la fase, cuáles cumple esta tarea y cómo lo has comprobado, y qué queda sin verificar. Actualiza `docs/STATE.md` y propón el mensaje de commit.

## Riesgo alto

Cierra la tarea. Pasa el subagente `verifier` y después el subagente `reviewer`, dándole el número de tarea, el plan de `docs/plans/` y el rango de commits. Corrige lo que el `reviewer` marque como grave y vuelve a pasar `verifier`. Enséñame el informe del `reviewer` tal cual, dime criterio por criterio cómo se ha comprobado y qué queda sin verificar. Actualiza `docs/STATE.md` y propón el mensaje de commit.

## Cerrar una fase

Hemos terminado la fase N. Repasa todos sus criterios de aceptación y dime cuáles pasan con prueba automática, cuáles he de comprobar yo a mano y cuáles no se cumplen. Resume `docs/STATE.md`, añade a `docs/decisions.md` lo decidido en esta fase y dime si cambiarías algo de la fase siguiente con lo aprendido.
