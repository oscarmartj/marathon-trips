# Estado del proyecto

Claude actualiza este archivo al cerrar cada tarea. Cinco líneas como máximo por tarea; lo antiguo se resume.

En modo autónomo (`docs/autonomous.md`) lo actualiza solo el hilo de cierre de cada fase; el detalle de cada tarea está en `docs/done/`, lo bloqueado en `docs/BLOCKED.md` y lo que espera a Oscar en `docs/FINAL-REVIEW.md`.

## Ahora

Cierre final (2026-11-26). Migraciones en `main`: 0001 a 0041 (la 0042 sigue libre).

- **Proyecto completo hasta la fase 9, incluida `9.fix-1` (#89); no hay siguiente tarea automática.** Ninguna pasarela es `verified`: eWAY, Airwallex y Stripe pay later son `experimental` contra falsos y todo lo de ellas (y de Afterpay, Klarna y Zip) está SIN VERIFICAR. Sin modo real, claves reales ni cuentas externas.
- **Espera a Oscar (por orden):** cuentas y claves de sandbox y sus secretos de repositorio; peticiones escritas a proveedores; preguntas al contable (GST, cuenta fiduciaria); permisos solo owner; decisiones de copy; despliegue. Orden y detalle en `docs/FINAL-REVIEW.md` y `docs/BLOCKED.md`.
- **Criterio 4 de la fase 9 PARCIAL** (núcleo tocado en 13 archivos, incluida la tarea ante fallo de reembolso para todas las pasarelas); la prueba semanal (9.4) cumple solo tras `9.fix-1`. Seguimientos abiertos: 9.1-F1/F2, 9.2-F1 a F6, 9.3-F1 a F8.

## Pendiente de Oscar

- Todo está en `docs/BLOCKED.md` (lo externo) y `docs/FINAL-REVIEW.md` (lo que revisar); no se abre al público nada sin repasarlos. Antes de cobrar: publicar la página `terms`.

## Hecho

Fases 0 a 9 completas (con `9.fix-1`); más 1.fix-1, 7.fix-1, 7.fix-2, 7.fix-3, 7.fix-4, 7.fix-5 y el arreglo de CI: ver `docs/done/`.

## Sin verificar

Docker no existe en el entorno de los hilos: `compose-smoke` solo corre en CI. Lector de pantalla y Lighthouse sobre un sitio desplegado, sin hacer. Detalle por tarea en `docs/done/` y en `docs/FINAL-REVIEW.md`.
