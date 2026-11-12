# Estado del proyecto

Claude actualiza este archivo al cerrar cada tarea. Cinco líneas como máximo por tarea; lo antiguo se resume.

En modo autónomo (`docs/autonomous.md`) lo actualiza solo el hilo de cierre de cada fase; el detalle de cada tarea está en `docs/done/`, lo bloqueado en `docs/BLOCKED.md` y lo que espera a Oscar en `docs/FINAL-REVIEW.md`.

## Ahora

- **Fases 0, 1 y 2 cerradas** (fase 2: 2.1, 2.2, 2.2b, 2.3, 2.4, 2.5 y 2.6 en `main`; los 7 criterios comprobados, evidencia en `docs/done/2.*.md`; ver el PR "2.close"). Fuera de fase ya en `main`: 1.fix-1, 3.1 (núcleo de pagos contra el simulador), 5.3, 6.1, 7.5, 8.4, 8.6, 8.7.
- **Siguiente:** 3.2 (reparto de cobros, cobertura, caducidad de aprobaciones con gancho `expire`, enlaces y recordatorios; la reserva sigue `approved` tras el depósito hasta entonces), 3.6 y el resto según `docs/autonomous.md`. Dinero real aparcado desde el 2026-11-12.
- **Bloqueos:** ninguno que detenga el trabajo; lo externo está en `docs/BLOCKED.md`.
- **Permisos por asignar (Oscar):** `common.customField.publish`, `waitlist.entry.read` y los de reservas y CRM; solo los tiene owner y ninguno es alcance de clave de API.

## Pendiente de Oscar

- Todo está en `docs/BLOCKED.md` (lo externo) y `docs/FINAL-REVIEW.md` (lo que revisar); no se abre al público nada sin repasarlos.

## Hecho

Fases 0, 1 y 2, 1.fix-1, 3.1, 5.3, 6.1, 7.5, 8.4, 8.6 y 8.7: ver `docs/done/`.

## Sin verificar

Docker no existe en el entorno de los hilos: `compose-smoke` solo corre en CI. Detalle por tarea en `docs/done/` y en `docs/FINAL-REVIEW.md`.
