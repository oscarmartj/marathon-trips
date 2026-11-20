# Estado del proyecto

Claude actualiza este archivo al cerrar cada tarea. Cinco líneas como máximo por tarea; lo antiguo se resume.

En modo autónomo (`docs/autonomous.md`) lo actualiza solo el hilo de cierre de cada fase; el detalle de cada tarea está en `docs/done/`, lo bloqueado en `docs/BLOCKED.md` y lo que espera a Oscar en `docs/FINAL-REVIEW.md`.

## Ahora

Actualizado tras 6.close (2026-11-20). Migraciones en `main`: 0001 a 0040.

- **Fases 0 a 8 cerradas** (detalle en `docs/done/*.close.md`). Fase 6 completa (6.1 a 6.6) con los 4 criterios probados; dos quedan parciales: el cupo contratado del proveedor no se decrementa al cancelar y el resultado por viaje no cuadra contra comisiones de pasarela (no importadas) ni GST. **Todo el dinero va contra simuladores y falsos: sin modo real, claves reales ni cuentas externas; Stripe, PayPal y Pin son `experimental`.**
- **Siguiente:** fase 9 (9.1 a 9.4; sus dependencias, fase 4 y 8.5, ya están hechas).
- **Seguimientos por registrar:** sacar `admin.*` del JavaScript público (6.6 lo separó en `en-AU.admin.json`; queda ver si hace falta más); reembolso de cortesía (`courtesy_refund_lowers_total_without_reopening_balance`); registrar reembolsos externos; verificación por sandbox de cada pasarela cuando Oscar aporte cuentas.
- **Siguiente paso de Oscar:** `docs/FINAL-REVIEW.md` (ordenado por importancia) y lo externo en `docs/BLOCKED.md` (sandbox, contable, permisos, decisión sobre "cancelled"). Nada se abre al público ni cobra antes.
- **Antes de abrir:** paso de Docker de la guía para la IP real (S-04), publicar la página `terms`, asignar los permisos nuevos y revisar el historial del repositorio (público desde el 2026-11-19).

## Pendiente de Oscar

- Todo está en `docs/BLOCKED.md` (lo externo) y `docs/FINAL-REVIEW.md` (lo que revisar); no se abre al público nada sin repasarlos. Antes de cobrar: publicar la página `terms`.

## Hecho

Fases 0 a 8 completas; más 1.fix-1, 7.fix-1, 7.fix-2, 7.fix-3, 7.fix-4, 7.fix-5 y el arreglo de CI: ver `docs/done/`.

## Sin verificar

Docker no existe en el entorno de los hilos: `compose-smoke` solo corre en CI. Lector de pantalla y Lighthouse sobre un sitio desplegado, sin hacer. Detalle por tarea en `docs/done/` y en `docs/FINAL-REVIEW.md`.
