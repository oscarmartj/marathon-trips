# Estado del proyecto

Claude actualiza este archivo al cerrar cada tarea. Cinco líneas como máximo por tarea; lo antiguo se resume.

En modo autónomo (`docs/autonomous.md`) lo actualiza solo el hilo de cierre de cada fase; el detalle de cada tarea está en `docs/done/`, lo bloqueado en `docs/BLOCKED.md` y lo que espera a Oscar en `docs/FINAL-REVIEW.md`.

## Ahora

- **Fases 0 y 1 cerradas** (1.1 a 1.5 en `main`, CI en verde en `6897121`; los 6 criterios de la fase 1 comprobados, ver el PR "Phase 1 close"). Fuera de fase ya en `main`: 2.1, 2.3, 5.3, 6.1, 8.6, 8.7.
- **En marcha:** 2.2 (reglas y códigos, en implementación) y 8.4 (claves de API y webhooks, en revisión de plan). Dinero aparcado desde el 2026-11-12.
- **Siguiente:** 2.4 cuando 2.2 se fusione; propuestas `1.fix-1` (`WEB_ORIGIN` al construir la imagen) y `2.2b` (pantallas de precios, reglas y códigos) en `docs/FINAL-REVIEW.md`.
- **Bloqueos:** ninguno que detenga el trabajo; lo externo está en `docs/BLOCKED.md`.

## Pendiente de Oscar

- Todo está en `docs/BLOCKED.md` (lo externo) y `docs/FINAL-REVIEW.md` (lo que revisar); no se abre al público nada sin repasarlos.

## Hecho

Fases 0 y 1, 2.1, 2.3, 5.3, 6.1, 8.6 y 8.7: ver `docs/done/`.

## Sin verificar

Docker no existe en el entorno de los hilos: `compose-smoke` solo corre en CI. Detalle por tarea en `docs/done/` y en `docs/FINAL-REVIEW.md`.
