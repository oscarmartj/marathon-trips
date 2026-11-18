# Estado del proyecto

Claude actualiza este archivo al cerrar cada tarea. Cinco líneas como máximo por tarea; lo antiguo se resume.

En modo autónomo (`docs/autonomous.md`) lo actualiza solo el hilo de cierre de cada fase; el detalle de cada tarea está en `docs/done/`, lo bloqueado en `docs/BLOCKED.md` y lo que espera a Oscar en `docs/FINAL-REVIEW.md`.

## Ahora

Cinco líneas por fase como máximo. Actualizado tras cerrar las fases 5, 6 y 7 y fusionar 8.2, 8.3 y el arreglo de CI (2026-11-19). Migraciones en `main`: 0001 a 0029.

- **Fases 0, 1, 2 y 3 cerradas** (fase 3 con el dinero aparcado: 3.3 y 3.4 sin empezar; solo simulador). Detalle en `docs/done/` y en `docs/FINAL-REVIEW.md`.
- **Fase 4: aparcada** (dinero). **Fase 9: aparcada** (pasarelas reales). Se retoman cuando Oscar quite la etiqueta «aparcada» de `docs/autonomous.md`; ver `docs/BLOCKED.md`.

### Fase 5 (cerrada, `docs/done/5.close.md`)

- Hechas 5.1 a 5.7: área de cliente y enlaces de pago de un solo uso, datos de viajeros, alertas de apertura, plantillas, privacidad (exportar y borrar), recordatorios de saldo, panel de inicio y ensayo general e2e contra el simulador (`rehearsal.spec.ts`). Los cinco criterios cumplen; sin tareas `5.fix-N`.
- **Siguiente:** nada pendiente en la fase. `instantBooking` no tiene dueño (pasó 2.4, 3.1, 3.2, 3.5 y 5.1): decidir si se crea una tarea de riesgo alto.
- **Bloqueos:** ninguno que detenga el trabajo; sin recibos (4.6) ni reembolsos por el dinero aparcado.
- **Permisos por asignar (Oscar; solo owner, ninguno es alcance de clave de API):** `privacy.customer.read|export|erase` (borrar con step-up), `dashboard.home.read`, `payments.paymentLink.send`, `alerts.subscription.read`, `templates.template.read|manage|publish`.

### Fase 6 (cerrada con 6.2, 6.4 y 6.6 aparcadas, `docs/done/6.close.md`)

- Hechas 6.1 (proveedores, cupos, costes), 6.3 (cambios de reserva; cambios del cliente apagados por defecto con `customerAmendmentsEnabled`) y 6.5 (ofertas de lista de espera). 6.2, 6.4 y 6.6 aparcadas con el dinero, sin empezar.
- **Siguiente:** nada sin dinero. La «Revisión de Oscar» de la fase (cambio y cancelación con penalización) no se puede hacer sin 6.4.
- **Bloqueos:** dinero aparcado (penalizaciones, reembolsos, pagos a proveedores, resultado por viaje).
- **Permisos por asignar (Oscar):** `bookings.booking.confirm` (step-up), `bookings.booking.amend` (step-up), `waitlist.entry.read`, `suppliers.supplier.read|manage`, `suppliers.allotment.manage`, `suppliers.cost.read|manage`.
- **Decisiones por confirmar:** base de precio de 6.3 con las reglas actuales, `stackable` por defecto `false` e `instantBooking`; ver `docs/FINAL-REVIEW.md`.

### Fase 7 (cerrada, `docs/done/7.close.md`)

- Hechas 7.1 a 7.7: listas de viaje, exportaciones para organizadores (dos formatos de ejemplo, sin pantalla), fechas clave, automatizaciones, campos personalizados, reclamaciones y embudo con informes. Los cuatro criterios cumplen; sin tareas `7.fix-N`.
- **Siguiente:** nada pendiente en la fase; revisiones de Opus pendientes en 7.2, 7.4 y 7.7 (sin hacer, ver `docs/done/7.close.md`).
- **Bloqueos:** ninguno externo.
- **Permisos por asignar (Oscar; solo owner):** `tripops.lists.read`, `exports.runnerData.read|generate` (paso reforzado), `keydates.date.read|manage`, `automations.rule.*` (activar pide TOTP), `complaints.complaint.read|manage`, `reports.*`, `common.customField.publish`.
- **Para activar:** redactar las plantillas `automations.customer_notice_1..3` y `automations.staff_notice` antes de reglas con correo.

### Fase 8 (en curso)

- Hechas 8.1, 8.2 (idiomas y `hreflang`; `es-ES` parcial y apagado), 8.3 (accesibilidad y rendimiento del sitio público), 8.4, 8.6 y 8.7, más el arreglo de CI que fija los trabajos en `ubuntu-24.04` (PR #48). Falta 8.5 (seguridad).
- **Siguiente:** 8.5; seguimiento de 8.3: `apps/web/src/lib/amendments.ts` mete zod en el navegador en cuenta y admin.
- **Bloqueos:** alojamiento real (AWS, dominio, SMTP) y `TRUST_PROXY`; ver `docs/BLOCKED.md`.
- **Repositorio público desde el 2026-11-19** (se hizo para que GitHub Actions volviera a correr tras un bloqueo de facturación): ver `docs/FINAL-REVIEW.md`.

## Pendiente de Oscar

- Todo está en `docs/BLOCKED.md` (lo externo) y `docs/FINAL-REVIEW.md` (lo que revisar); no se abre al público nada sin repasarlos. Antes de cobrar: publicar la página `terms`.

## Hecho

Fases 0, 1, 2, 3 (sin 3.3 ni 3.4), 5, 6 (sin 6.2, 6.4 ni 6.6) y 7; de la fase 8, 8.1, 8.2, 8.3, 8.4, 8.6 y 8.7; más 1.fix-1 y el arreglo de CI: ver `docs/done/`.

## Sin verificar

Docker no existe en el entorno de los hilos: `compose-smoke` solo corre en CI. Lector de pantalla y Lighthouse sobre un sitio desplegado, sin hacer. Detalle por tarea en `docs/done/` y en `docs/FINAL-REVIEW.md`.
