# Estado del proyecto

Claude actualiza este archivo al cerrar cada tarea. Cinco líneas como máximo por tarea; lo antiguo se resume.

En modo autónomo (`docs/autonomous.md`) lo actualiza solo el hilo de cierre de cada fase; el detalle de cada tarea está en `docs/done/`, lo bloqueado en `docs/BLOCKED.md` y lo que espera a Oscar en `docs/FINAL-REVIEW.md`.

## Ahora

Actualizado tras 9.close (2026-11-26). Migraciones en `main`: 0001 a 0041 (la 0042 sigue libre).

- **Fases 0 a 9 hechas; 9.close cierra la 9 con `9.fix-1` pendiente.** eWAY (9.1), Airwallex (9.2) y Stripe pay later (9.3) son `experimental` contra falsos, con la batería de contrato en verde; ninguna pasarela es `verified` y todo lo de ellas está SIN VERIFICAR (el proxy bloqueó sus documentaciones). Sin modo real, claves reales ni cuentas externas.
- **Siguiente (coordinador): `9.fix-1`** (bajo, Sonnet). `weekly-sandbox-contract.yml` (9.4) tiene YAML inválido en la línea 116: ni corre por cron ni por `workflow_dispatch` y GitHub registra un fallo en cada push. Hay que corregirlo, hacer que `weekly.test.ts` analice el YAML y añadir los secretos de Airwallex y `stripe_bnpl`.
- **Seguimientos:** 9.1-F1 y F2, 9.2-F1 a F6, 9.3-F1 a F8, y los de fases anteriores (reembolso de cortesía, reembolsos externos, `admin.*` fuera del JavaScript público).
- **Siguiente paso de Oscar:** `docs/FINAL-REVIEW.md` (prioridad de la fase 9 arriba) y `docs/BLOCKED.md`: sandbox de eWAY, Airwallex, Stripe pay later (segunda cuenta de Stripe) y de las anteriores, y las peticiones escritas a proveedores. Nada se abre al público ni cobra antes.

## Pendiente de Oscar

- Todo está en `docs/BLOCKED.md` (lo externo) y `docs/FINAL-REVIEW.md` (lo que revisar); no se abre al público nada sin repasarlos. Antes de cobrar: publicar la página `terms`.

## Hecho

Fases 0 a 9 completas (9 con `9.fix-1` pendiente); más 1.fix-1, 7.fix-1, 7.fix-2, 7.fix-3, 7.fix-4, 7.fix-5 y el arreglo de CI: ver `docs/done/`.

## Sin verificar

Docker no existe en el entorno de los hilos: `compose-smoke` solo corre en CI. Lector de pantalla y Lighthouse sobre un sitio desplegado, sin hacer. Detalle por tarea en `docs/done/` y en `docs/FINAL-REVIEW.md`.
