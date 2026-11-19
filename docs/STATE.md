# Estado del proyecto

Claude actualiza este archivo al cerrar cada tarea. Cinco líneas como máximo por tarea; lo antiguo se resume.

En modo autónomo (`docs/autonomous.md`) lo actualiza solo el hilo de cierre de cada fase; el detalle de cada tarea está en `docs/done/`, lo bloqueado en `docs/BLOCKED.md` y lo que espera a Oscar en `docs/FINAL-REVIEW.md`.

## Ahora

Actualizado tras 7.fix-3, 7.fix-4 y 7.fix-5 (2026-11-19). Migraciones en `main`: 0001 a 0031.

- **Fases 0, 1, 2, 3, 5, 6, 7 y 8 cerradas** (detalle en `docs/done/*.close.md`); fase 8 con 8.5 hecha con pendientes (S-04, S-13, S-14). **Dinero retomado el 2026-11-19** (decisión de Oscar): sin modo real, claves reales ni cuentas externas.
- **Fases 4 y 9 abiertas; reabiertas las partes de las fases 3 y 6** (3.3, 3.4, 6.2, 6.4, 6.6; 9.x tras la fase 4 y 8.5). **Siguiente: 3.3 y 3.4 en marcha** y después 4.x; requisitos P1–P12 y hallazgos en `docs/plans/phase-0-architecture.md`.
- **Arreglos posteriores al cierre fusionados:** 7.fix-3 (#67, exportaciones), 7.fix-4 (#66, informes) y 7.fix-5 (#68, CSV de la plataforma), tras las revisiones de Opus de 7.2 y 7.7.
- **Siguiente paso: la revisión de Oscar** con `docs/FINAL-REVIEW.md` (ordenado por importancia) y lo externo en `docs/BLOCKED.md`. Nada se abre al público ni cobra antes.
- **Antes de abrir:** paso de Docker de la guía para la IP real (S-04), publicar la página `terms`, asignar los permisos nuevos y revisar el historial del repositorio (público desde el 2026-11-19).

## Pendiente de Oscar

- Todo está en `docs/BLOCKED.md` (lo externo) y `docs/FINAL-REVIEW.md` (lo que revisar); no se abre al público nada sin repasarlos. Antes de cobrar: publicar la página `terms`.

## Hecho

Fases 0, 1, 2, 3 (de 3.3 y 3.4, en marcha), 5, 6 (de 6.2, 6.4 y 6.6, pendientes), 7 y 8 completas; más 1.fix-1, 7.fix-1, 7.fix-2, 7.fix-3, 7.fix-4, 7.fix-5 y el arreglo de CI: ver `docs/done/`.

## Sin verificar

Docker no existe en el entorno de los hilos: `compose-smoke` solo corre en CI. Lector de pantalla y Lighthouse sobre un sitio desplegado, sin hacer. Detalle por tarea en `docs/done/` y en `docs/FINAL-REVIEW.md`.
