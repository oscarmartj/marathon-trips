# Estado del proyecto

Claude actualiza este archivo al cerrar cada tarea. Cinco líneas como máximo por tarea; lo antiguo se resume.

En modo autónomo (`docs/autonomous.md`) lo actualiza solo el hilo de cierre de cada fase; el detalle de cada tarea está en `docs/done/`, lo bloqueado en `docs/BLOCKED.md` y lo que espera a Oscar en `docs/FINAL-REVIEW.md`.

## Ahora

- **Fase 0:** hecha: 0.1 a 0.7 y 0.fix-1 en `main`, CI en verde en `4d83a4c`. Se da por cerrada al fusionar 0.fix-2 (único criterio parcial: datos demo comprobados dentro de `docker compose up`).
- **Hechas fuera de fase:** 8.6 (copias y monitor), 8.7 (guía de despliegue) y 1.1 (API de catálogo).
- **Siguiente tarea:** 0.fix-2; en paralelo 1.2 y 1.3 (en curso), 1.5 y 2.1 (dependen solo de 1.1). Dinero aparcado desde el 2026-11-12.
- **Bloqueos:** ninguno que detenga el trabajo; lo externo está en `docs/BLOCKED.md`.

## Pendiente de Oscar

- Todo está en `docs/BLOCKED.md` (lo externo) y `docs/FINAL-REVIEW.md` (lo que revisar); no se abre al público nada sin repasarlos.

## Hecho

Fase 0 (salvo 0.fix-2), 8.6, 8.7 y 1.1: ver `docs/done/`.

## Sin verificar

Docker no existe en el entorno de los hilos: `compose-smoke` solo corre en CI. Detalle por tarea en `docs/done/` y en `docs/FINAL-REVIEW.md`.
