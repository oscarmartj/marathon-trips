# Estado del proyecto

Claude actualiza este archivo al cerrar cada tarea. Cinco líneas como máximo por tarea; lo antiguo se resume.

En modo autónomo (`docs/autonomous.md`) lo actualiza solo el hilo de cierre de cada fase; el detalle de cada tarea está en `docs/done/`, lo bloqueado en `docs/BLOCKED.md` y lo que espera a Oscar en `docs/FINAL-REVIEW.md`.

## Ahora

- **Fases 0, 1, 2 y 3 cerradas** (fase 3 con el dinero aparcado: hechas 3.1, 3.2, 3.5 y 3.6, solo contra el simulador; evidencia en `docs/done/3.1.md`, `3.2.md`, `3.5.md` y `3.6.md`; ver el PR "3.close"). **Aparcadas: 3.3 y 3.4** (dinero; no empezadas). Listo para retomarlas: interfaz `PaymentProvider`, simulador, batería de contrato de 23 cláusulas (`docs/adding-a-payment-adapter.md`) y checkout contra el simulador.
- Fuera de su fase y ya en `main`: 1.fix-1, 5.3, 5.4 (plantillas, `0018_templates`), 6.1, 6.5 (ofertas de lista de espera, `0022`), 7.3 (fechas clave, `0021`), 7.4 (automatizaciones, `0020`), 7.5, 7.6 (reclamaciones, `0019`), 8.4, 8.6 y 8.7. La 3.5 trae la aceptación de condiciones (`0023_terms_acceptance`). Migraciones en `main`: 0001 a 0023.
- **Siguiente:** fase 4 (aparcada casi entera) y la 5 según la tabla de `docs/autonomous.md`; 5.1 hereda de 3.2 el enlace de pago y la aprobación automática `instantBooking`, y 5.6 los recordatorios. Dinero real aparcado desde el 2026-11-12.
- **Bloqueos:** ninguno que detenga el trabajo; lo externo está en `docs/BLOCKED.md`.
- **Permisos por asignar (Oscar):** `bookings.booking.confirm` (step-up, solo owner), `templates.template.read|manage|publish`, `complaints.complaint.read|manage`, `keydates.date.read|manage`, `automations.rule.*` (activar exige step-up), además de `common.customField.publish`, `waitlist.entry.read` y los de reservas y CRM; solo los tiene owner y ninguno es alcance de clave de API.

## Pendiente de Oscar

- Todo está en `docs/BLOCKED.md` (lo externo) y `docs/FINAL-REVIEW.md` (lo que revisar); no se abre al público nada sin repasarlos.

## Hecho

Fases 0, 1, 2 y 3 (sin 3.3 ni 3.4), 1.fix-1, 5.3, 5.4, 6.1, 6.5, 7.3, 7.4, 7.5, 7.6, 8.4, 8.6 y 8.7: ver `docs/done/`.

## Sin verificar

Docker no existe en el entorno de los hilos: `compose-smoke` solo corre en CI. Detalle por tarea en `docs/done/` y en `docs/FINAL-REVIEW.md`.
