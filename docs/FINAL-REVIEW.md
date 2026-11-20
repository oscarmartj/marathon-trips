# Revisión final de Oscar

Todo lo que en modo autónomo se decidió, se dejó sin verificar o necesita tus ojos. Lo actualiza el hilo de cierre de cada fase. Nada de esta lista detuvo el trabajo, pero **nada se abre al público ni cobra dinero real hasta haberla repasado.**

## Antes de aceptar dinero real

- [ ] Leer los informes del revisor de pagos, libro de pagos y motor de precios.
- [ ] Comprobar a mano tres casos del motor de precios contra sus pruebas.
- [ ] Hacer un pago de prueba completo con Stripe en sandbox, con claves de prueba propias.
- [ ] Confirmación por escrito de cada pasarela que se vaya a activar.
- [ ] Sustituir las páginas legales provisionales.
- [ ] Validar el GST con tu contable (por componente, 1.1).
- [ ] Cumplir los 8 hallazgos vinculantes del plan 0.1 al retomar el dinero (`docs/BLOCKED.md`).

## Prioridad al cerrar la fase 6 (2026-11-20)

Lo nuevo de 6.2, 6.4 y 6.6 y lo que cambia lo anterior, por importancia. Sigue todo contra simuladores y falsos. Detalle en `docs/done/6.close.md` y en la sección "Fase 6" más abajo.

1. **Contable, fórmula de "dinero a reservar" (6.2, D7):** cambiada; con lo pagado a proveedores a 0 da lo mismo que 4.6, pero ya no garantiza "nunca guardar menos de lo retenido" y no es la opción más conservadora. Confirmar si el dinero de clientes puede pagar proveedores y devolver anticipos propios. Sin GST en el resultado por viaje (6.6).
2. **Resultado por viaje incompleto (6.6):** sin comisiones de pasarela ("fees not imported"); la comprobación "costs" compara `cost_items` consigo misma, no con el libro; saldo corriente de la previsión desde 0. Probar la exportación para el contable con step-up y abrir el CSV en su hoja.
3. **Permisos nuevos solo de owner que debes asignar:** `payments.report.tripResult`, `payments.report.cashForecast`, `payments.export.accountant` (6.6), `suppliers.payment.record|void` (6.2) y `pricing.cancellationPolicy.*` y `operator_cancelled` (6.4); la cancelación online del cliente viene apagada.
4. **Decisión: `copy.test.ts` y "cancelled"** (`apps/web/src/lib/copy.test.ts`, línea 33): la regex prohíbe "cancelled", que es la ortografía australiana; debería marcar "canceled". Los textos evitan la palabra y la prueba no se tocó (6.4).
5. **Catálogo de textos del panel (6.6):** se dividió en `en-AU.admin.json` y `lib/i18n-admin.ts` para no subir el límite de 200 000 bytes de JavaScript público; un test de importaciones vigila que `app/` (salvo `app/admin`) no lo importe. Queda como tarea, si procede, sacar `admin.*` del todo del JavaScript público.
6. **Seguimientos por registrar:** reembolso de cortesía (`courtesy_refund_lowers_total_without_reopening_balance`), registro de reembolsos externos, verificación por sandbox de cada pasarela cuando des cuentas.
7. **Proceso:** rondas de revisión por encima del tope de 3 por tu instrucción permanente (4.4, 4.6 y 6.4; 4.5 cinco, 8.5 cinco). 4.6 se fusionó sin tercera pasada del revisor; 6.2 sin revisor sobre el commit final (verificador, CI y los deltas exactos de las correcciones); 4.5 antes de que su verificador informase sobre `7f057c1` (después limpio).
8. **Hallazgos menores del revisor de 6.6 no corregidos:** ninguno bloqueante (aprobar en la ronda 1; los menores se corrigieron en su rama).

## Prioridad al cerrar la fase 4 (2026-11-20): dinero

Lo nuevo de 3.3, 3.4, 4.1 a 4.6, 6.2 y 6.4, por importancia. Todo funciona contra simuladores y falsos; nada cobra en real. Detalle en `docs/done/` y en la sección "Fase 4 y dinero" más abajo.

1. **Sin sandbox real, ningún adaptador es `verified`:** Stripe, PayPal y Pin son `experimental`; sus supuestos (PayPal A1 a A9, Pin A1 a A18) solo se probaron contra falsos. Hacer un pago de prueba completo con claves de cada una antes de nada (`docs/BLOCKED.md`).
2. **GST y contable:** sin GST en los recibos; `gstRegistered:true` da error. Preguntas y cuenta fiduciaria en `docs/BLOCKED.md`; las afirmaciones del ATO del plan 4.6 están sin verificar. Además `fundsAfterMinor` se ordena por `createdTxId`: corregirlo antes de cablear el GST (4.6).
3. **6.2 D7:** la fórmula de "dinero a apartar" ya no garantiza "nunca guardar menos de lo retenido"; no es la opción más conservadora. Confirmar con el contable (6.2).
4. **Permisos del dinero, hoy solo owner:** `manage` y `manageCredentials` (se pueden dar a cualquier rol), `payments.refund.*`, `payments.dispute.*`, `payments.routingRule.manage`, `reconciliation.run`, `report.clientMoney`, `suppliers.payment.*`, los de cancelación y `operator_cancelled`; la cancelación online del cliente está apagada.
5. **Retención para reclamaciones (GDPR art. 17(3)(e), APP 11.2)** en disputas (4.5).
6. **Publicar la página `terms`** antes de ningún pago; revisar el historial del repositorio público; paso de Docker para la IP real (S-04); S-13 y S-14; casilla `serviceMessageAck`.
7. **Decisión:** `copy.test.ts` prohíbe "cancelled", la ortografía australiana; la regex debería marcar "canceled" (6.4).
8. **Rondas de revisión por encima del tope de 3** por instrucción de Oscar: 8.5 y 4.5 cinco; 4.4, 4.6 y 6.4 de dos a tres. 4.5 se fusionó antes de que su verificador informara sobre `7f057c1` (después limpio, CI verde en la cabeza final); 4.6 se fusionó sin tercera pasada del revisor tras las correcciones (verificador, CI y pruebas); 6.2 se fusionó tras corregir una prueba inestable que halló el verificador.

## Prioridad al cerrar la fase 8 (2026-11-19)

Todo lo abierto, por importancia: seguridad y legal, luego corrección y por último pulido. Cada punto lleva su fuente; el detalle por fase está más abajo.

### Seguridad y legal

1. **Repositorio público** desde el 2026-11-19 (para que Actions volviera a correr tras un bloqueo de facturación). Revisar el historial por claves, correos o datos personales en `docs/`, fixtures y `deploy/`, y decidir si vuelve a privado. Fuente: `docs/decisions.md`; 8.5 no halló secretos en `git log --all -p`.
2. **IP real tras Caddy (S-04):** el paso de Docker de la guía es obligatorio antes de abrir; comprobarlo con dos conexiones y el monitor (`clientIp.privateAddressRequests` en 0). Si no, el límite por IP cuenta todo el sitio junto. Fuente: `docs/done/8.5.md`, `docs/BLOCKED.md`.
3. **S-13 (pantalla de sesiones) y S-14 (segundo factor para clientes)** abiertos: decisión de producto de Oscar. Fuente: `docs/security/asvs-review.md`.
4. **Publicar la página `terms`** antes de ningún pago: sin ella 3.5 se niega a iniciar pagos (`terms_unavailable`). Fuente: `docs/done/3.5.md`.
5. **Páginas legales provisionales:** sustituirlas y quitar el aviso de revisión pendiente. Fuente: `docs/done/8.1.md`.
6. **Asignar los permisos nuevos** (hoy solo owner; ninguno es alcance de clave de API, varios piden step-up): lista completa en `docs/BLOCKED.md`, incluidos los de 7.x y 8.x. Fuente: `docs/done/7.close.md`, `docs/done/8.4.md`.
7. **Consentimiento de avisos (7.fix-2):** un aviso sin acuse exige consentimiento `marketing_email.v2`; quien dio el v1 debe retirarlo y volver a darlo para recibirlos (no hay datos reales aún). Fuente: `docs/done/7.fix-2.md`.
8. **Casilla de `serviceMessageAck` en el panel: no existe**, así que todos los avisos al cliente salen como marketing. Decidir si se quiere avisos de servicio. Fuente: `docs/done/7.fix-2.md`.
9. **Datos personales:** riesgo residual aceptado en la fase 0; 5.5 ya borra, pero restaurar una copia antigua resucita a los clientes borrados (`privacy:erasures-reapply`) y `?audience=full` lleva notas del personal. Fuente: `docs/done/5.5.md`.
10. **Pendientes de 8.5:** ZAP y SSL Labs contra el entorno de pruebas, `includeSubDomains` en HSTS (S-24), y para 9.x S-19 y ampliar la CSP y `Permissions-Policy: payment`. Fuente: `docs/done/8.5.md`.
11. **Antes de dinero real:** lista de arriba, cuando terminen 3.3, 3.4, 4.x, 6.2, 6.4, 6.6 y 9.x (dinero retomado el 2026-11-19).

### Corrección

12. **Prueba inestable `pending_collections_skip_paid_lines`** (y `payments/flow.test.ts` «drive against expiry»): fallan por datos acumulados o carreras ajenas y pasan al repetir. Aislarlas con su propio estado. Fuente: `docs/done/7.fix-2.md`.
13. **Consulta de atrasos de automatizaciones O(n^2)** con una cola grande; vale con el volumen actual. Fuente: `docs/done/7.fix-2.md`.
14. **Base de precio de 6.3 con las reglas actuales:** una regla posterior se aplica en silencio a lo añadido; confirmar o exigir congelar la base. Fuente: `docs/done/6.3.md`.
15. **`stackable` por defecto `false`** en reglas y códigos: confirmar o cambiar. Fuente: `docs/done/2.2.md`.
16. **`instantBooking`** es una función del brief sin dueño (2.4, 3.1, 3.2, 3.5, 5.1): decidir si se crea una tarea de riesgo alto. Fuente: `docs/done/5.close.md`.
17. **Límites conocidos:** 5.5 (copias antiguas, `audience=full`, archivados sin usuario), 5.6 (desfase consumido con pago en curso, sin recordatorios de vencidos, sin pantalla de desfases), 6.3 (recordatorio `failed` si llega un cambio, crédito manual), 6.5 (solo al liberarse plazas, «el primero al que le cabe», sin prueba del reintento por interbloqueo) y 7.2 (dos formatos de ejemplo, sin pantalla). Fuente: `docs/done/5.5.md`, `5.6.md`, `6.3.md`, `6.5.md`, `7.2.md`.
18. **Informes (7.fix-1):** índice sobre `bookings."requestedAt"` aplazado (pide migración); el fallo de un informe no deja ejecución. Fuente: `docs/done/7.fix-1.md`.
19. **CI:** `ci.yml` fijado a `ubuntu-24.04` (PR #48) por `pg_restore` y `transaction_timeout`; quitar el pin al subir PostgreSQL y comprobar `backup.test.ts`. Fuente: `docs/done/fix-ci-runner-pin.md`.
20. **Sin verificar:** Docker, Caddy, TLS y `rclone` reales; correo real; lector de pantalla, móvil real y Lighthouse sobre un sitio desplegado. Fuente: `docs/done/8.5.md`, `8.6.md`, `8.3.md`.
21. **Filas de auditoría de exportaciones grandes (7.fix-3):** unos 175 KB por exportación de 5000 corredores y `GET /admin/audit` devuelve hasta 200 filas sin paginar (unos 35 MB en el peor caso): paginar o acotar. Fuente: `docs/done/7.fix-3.md`.
22. **Límites de exportación para organizadores en memoria (7.2):** se pierden al reiniciar y se multiplican por instancia; el límite por IP es de 100 archivos/hora (no 10), por usuario 10 y comprobaciones 60. Fuente: `docs/done/7.fix-3.md`.
23. **Informes semanales con un periodo distinto de 7 días** ahora envían 7 días; los días de un envío con el calendario cambiado (`MAIL_NOT_SENDABLE`) no los cubre el siguiente y solo avisa el monitor `mail_failed`. Fuente: `docs/done/7.fix-4.md`.
24. **`appliesTo.years` se quitó** de los formatos de exportación: solo queda `raceSlugs`. Fuente: `docs/done/7.fix-3.md`.
25. **Pruebas inestables vistas en CI:** `apps/web/e2e/customer-area.spec.ts:205` (`getByText('Ada')`, otra vez) y `apps/api/test/ops/backup.test.ts` (una vez, la frase de contraseña errónea dio «not a Marathon Trips backup» en lugar de «cannot decrypt»; pasó al repetir). Fuente: CI de las PR #66 a #68.

### Pulido

26. **Idiomas (8.2):** `es-ES` parcial y apagado; el compose de producción no pasa `ENABLED_LOCALES` (hay que ponerlo en la construcción y en el contenedor web); cliente y panel siguen en inglés. Fuente: `docs/done/8.2.md`.
27. **`apps/web/src/lib/amendments.ts`** mete zod en el navegador de cuenta y admin; hacer como con `checkout.ts`. Fuente: `docs/done/8.3.md`.
28. **E2E frágil:** `getByText('Ada')` en `apps/web/e2e/customer-area.spec.ts` (~línea 182, y `:205`) es una subcadena sin distinguir mayúsculas y falló una vez contra texto aleatorio. Apretarla en una decisión aparte. Fuente: `docs/done/5.7.md`.
29. **Prueba del limitador (nit):** falta el caso espejo del desempate por id en `apps/api/test/modules/automations/automations.test.ts`. Fuente: `docs/done/7.fix-2.md`.
30. **Plantillas por redactar** antes de activar: `payments.balance_reminder` (y `balanceReminderOffsetsDays`), `automations.customer_notice_1..3` y `automations.staff_notice`. Fuente: `docs/done/7.close.md`, `5.6.md`.
31. **Auditoría de accesibilidad propia** en lugar de `axe-core` (MPL-2.0): cambiar si Oscar acepta la licencia. Fuente: `docs/done/8.3.md`.
32. **Prueba `organiser-exports/exports.test.ts:470`** desestructura `audits()` sin `orderBy` (riesgo bajo de inestabilidad). Fuente: `apps/api/test/modules/organiser-exports/exports.test.ts`.
33. **Caracteres de fórmula de ancho completo** no se guardan en CSV (se cree inocuo en Excel y LibreOffice; sin verificar). Fuente: `docs/done/7.fix-5.md`.
34. **Borde teórico de CSV:** un valor que acaba en `;` en la última columna, abierto con un lector con `;`. Fuente: `docs/done/7.fix-5.md`.

## Recorridos que conviene hacer a mano

- [ ] Como administrador: crear una carrera con paquete, publicarla, gestionar una solicitud. (Fase 1: el alta y la publicación hasta verla en la web ya las recorre la e2e `create_publish_and_view_race`; falta a mano la solicitud.)
- [ ] Como cliente: alerta, configuración, solicitud, depósito, datos de viajeros, saldo y documentos.
- [ ] Entrar como propietario con contraseña y TOTP con `docker compose up` (el log de `api` imprime las credenciales demo) y probar `/admin/tasks`.
- [ ] Antes de abrir al público: seguir `docs/deploy/guide.md` en un entorno de pruebas, comprobar la IP real tras Caddy y repetir `verify-restore.sh` en el servidor.

## Decisiones tomadas sin ti

Lista completa, con motivo, en `docs/decisions.md` (filas del 2026-11-12) y, con la alternativa y cómo deshacerla, en el apartado «Decisiones tomadas sin Oscar» de cada `docs/done/N.M.md`. Las que más conviene mirar: adaptadores propios en lugar de Hyperswitch; autenticación propia en lugar de Better Auth; servidor único en Sídney con Caddy; automatizaciones que no aprueban ni cancelan reservas.

## Construido sin verificar

- Fase 0: Docker no existe en el entorno de los hilos, así que `compose-smoke` solo se ha visto pasar en CI (servicios sanos); el contenido de los datos demo dentro del compose se comprueba en 0.fix-2. Envío real del enlace mágico a Mailpit (solo emisor falso y servidor SMTP falso en proceso). Adaptador S3 de archivos no construido. Migraciones 0002 a 0006 escritas sin motor de Prisma local; `prisma migrate diff` de CI las valida.
- 8.6 y 8.7: `docker compose` de producción, Caddy, la imagen de copias, `rclone` y la subida real; los pasos de la guía no se han seguido en un servidor.
- Accesibilidad: contraste y foco comprobados en cifras y marcado; las e2e de Playwright usan roles y etiquetas, pero **nada se ha probado con lector de pantalla** (0.3, 0.5, 0.6).
- Fase 1: lector de pantalla, teclado completo, contraste, foco y 320 px de las páginas públicas y del panel nuevo, solo comprobados en marcado, etiquetas y roles (1.2, 1.3). Rich Results Test de Google y depurador de Open Graph sin ejecutar (1.4: sin salida a esos servicios; solo curl del JSON-LD, las etiquetas y la imagen 1200x630). La migración 0006 se escribió sin motor de Prisma; la validó CI (`migrate diff`).

## Riesgos aceptados y pendientes (fase 0)

Ordenados por importancia.

1. **Datos personales, riesgo residual aceptado** (decisión del revisor y del plan, sección 4.9 del plan de 0.1). El diseño anota cada campo como `@pii`/`@nopii`/`@secret`, audita sin texto libre y borra desde el registro de entidades con `customerLink`, pero el borrado completo (5.5) aún no existe y las tablas inmutables conservan lo mínimo por obligación legal (7 años). Se acepta hasta la fase 5; revisar antes de abrir al público.
2. **Límite por IP y `TRUST_PROXY`.** Los contadores van en memoria (válidos con una instancia de API) y, con la web como proxy, cuentan todo el sitio junto hasta fijar `TRUST_PROXY` y `WEB_TRUSTED_PROXY_HOPS`. Pendiente de la comprobación manual tras Caddy (`docs/BLOCKED.md`).
3. **Minores del revisor de 0.3 aún abiertos** (los tres, tal como los transmitió el coordinador; el informe del revisor no está en el repositorio): el arnés de pruebas de rutas `self` es ciego a `@Req`; carrera al añadir un titular a un rol; el orden de bloqueo no sigue del todo la sección 6.3 de la arquitectura. La ronda 2 del revisor de 0.3 figura como pendiente en su `done`.
4. **Pruebas que dependen de una base propia por hilo.** Las que desactivan a todos los owners (`admin.test.ts`) y el monitor de 8.6 parten de una base sin otros hilos; dos hilos con la misma base se pisan. Hoy se evita por convención (0.fix-1); en CI cada ejecución tiene su base.
5. **Desviación de «Sin código» en 0.1.** `scripts/check-dependency-table.mjs` (solo lectura, sin dependencias) se escribió en la tarea de arquitectura para comprobar la tabla de `docs/autonomous.md`; 0.2 lo añadió a `pnpm lint`. Se acepta; ver `docs/done/0.1.md`.
6. **Revisión del plan 0.1 con ronda 18 «aprobar con cambios».** Los 8 hallazgos abiertos son vinculantes desde que se retomó el dinero (2026-11-19); el plan los reparte por tarea.
7. **Investigación 0.7 incompleta.** 31 de 38 pasarelas sin confirmar la política de viajes, y casi todas sin confirmar sole trader, liquidaciones y retenciones; cada fila conserva su fuente y fecha.

## Revisión por fase

### Fase 0 (cerrada con 0.fix-2 pendiente)

Sección «Revisión de Oscar» de `docs/phases/phase-0.md`, con su estado:

- Aprobar el plan de 0.1: en modo autónomo lo revisó el subagente revisor (18 rondas, aprobar con cambios); conviene leer `docs/plans/phase-0-architecture.md`, secciones 9 y 11 y «Aparcado: dinero».
- Leer el informe del `reviewer` de 0.3: ronda 1 aprobar con cambios (corregidos, plan §10); ronda 2 pendiente según su `done`. Ver el riesgo 3.
- Decidir orquestador de pagos y alojamiento con la investigación de 0.7: propuesto adaptadores propios y servidor único en Sídney (`docs/decisions.md`); confirmar o cambiar.
- Pedir a Stripe confirmación escrita sobre «travel reservation services»; preguntar a Pin y eWAY por sole trader y viajes.

### Fase 1 (cerrada; `WEB_ORIGIN` resuelto)

Sección «Revisión de Oscar» de `docs/phases/phase-1.md` y menores abiertos, tal como constan en `docs/done/`:

- Cargar tres carreras reales de ejemplo a mano en el panel y anotar qué resulta lento o confuso (criterio de la fase; 1.2). Mirar también las tres carreras demo tras `pnpm db:seed`: deben verse claramente como demo (1.5).
- Mirar el buscador y la página de carrera con carreras cargadas (1.3), y una carrera compartida por enlace cuando haya despliegue; la imagen para compartir es provisional, marca sobre fondo oscuro y sin fotos (1.4).
- Contenido pendiente por falta de modelo o de datos: la guía de carrera solo muestra lo que hay en la API (sin recorrido, clima ni consejos; 1.3); `FAQPage` sin preguntas y `Offer` sin precios públicos (1.4); filtros por precio, tipo de entrada, estado y continente (1.3); el panel no edita otros idiomas que `en-AU` y no hay botón de alerta en la web, que es de 5.3 (1.2, 1.3).
- **`WEB_ORIGIN` también al construir (resuelto por `1.fix-1`, PR #29).** Hallazgo del cierre: `docker/Dockerfile` construye la web sin `WEB_ORIGIN` y `deploy/docker-compose.prod.yml` no lo pasa a la web en ejecución, así que las canónicas, `hreflang`, Open Graph y JSON-LD de las páginas estáticas saldrían con `http://localhost:3000` (`apps/web/src/lib/site.ts`; solo `robots.txt` lo lee por petición). Propuesta de tarea **1.fix-1** (bajo, Sonnet): `ARG`/`ENV WEB_ORIGIN` en la etapa de construcción, `build.args` y `environment` en el compose de producción, ampliar `scripts/check-deploy-config.mjs` y una prueba que falle si falta. No es un criterio de la fase 1; sin Docker en los hilos solo la comprobará CI.
- El sitemap falla (error de construcción o de petición) si el catálogo no responde, en lugar de publicarse sin carreras (decisión de 1.4): la guía de despliegue debería avisar de que la API debe estar sana al construir la web.
- Limitaciones locales vistas en el cierre: `test/ops/backup.test.ts` pide un superusuario de PostgreSQL y no corre en los hilos (12 omitidas, por eso `pnpm check:no-skipped` falla en local); lo cubre CI, que está en verde en `main`.

#### Llegados de la tarea 2.1 (motor de precios, fusionada)

- **Riesgo residual M3:** cerrar un paquete, cambiar quién toma un extra o su obligatoriedad y reabrirlo cambia el total sin step-up (dos acciones auditadas; reabrir pasa las puertas). Si 2.2 se fusiona con `pricedTerms` (plan `docs/plans/2.2-pricing-rules-promo-codes.md`, §6; hoy solo en la rama de 2.2), las versiones publicadas guardan los términos de extras con que se fijó el precio y la puerta de apertura los compara, lo que lo resuelve; hasta entonces sigue abierto.
- **`stackable` por defecto `false`** en reglas y códigos (plan de 2.2, §15 punto 11): es una decisión de negocio para Oscar. Un recargo que deba sumarse a otros (temporada alta y suplemento individual) hay que marcarlo apilable a mano; confirmar o cambiar el valor por defecto.
- El revisor de código de 2.1 aprobó en la ronda 3 (PR #19); queda como menor M3 (arriba), que resolverá 2.2 (PR #27) al fusionarse; hasta entonces sigue abierto.
- Quedan para 2.2: enumeración de códigos (M10: límite por IP ya puesto y respuesta `invalid` única); duplicar paquete (1.2) no copia precios; `depositSchema` del catálogo da 500 con importes no numéricos (zod 4 ejecuta el `refine` aunque falle el `regex`).
- **Pantallas del panel de precios, reglas y códigos:** no existen (2.1 solo tiene API; ni 1.2 ni 2.2 las incluyen). Propuesta de tarea **2.2b** (medio, Sonnet): pantallas de versiones de precio y tarifas, reglas y códigos promocionales, con vista previa de cotización. Hasta entonces los precios solo se cargan por la API; `Prices are not shown yet` sigue visible en la vista previa.

### Fase 2 (cerrada)

Sección «Revisión de Oscar» de `docs/phases/phase-2.md` y lo que dejan los `docs/done/2.*.md`:

- **Criterios (7 de 7 con prueba automática; CI verde en `main`).** Motor de precios con tablas (2.1, 2.2: `engine-tables.test.ts`, `engine-2.2.test.ts`); cambiar un precio no altera la solicitud (2.4: `price_change_does_not_alter_snapshot`); última plaza (2.4: `two_requests_last_place_one_wins`, `concurrent_requests_never_oversell`); transición no permitida (2.4: `booking_state_event_matrix`, `booking_status_trigger_matrix`); la web no envía importes (2.1 `quote_request_rejects_amount_fields`, 2.3 `builder.test.ts`, 2.4 `client_amount_field_rejected` y `request_body_has_no_money_keys`); e2e buscar, configurar, solicitar y gestionar (2.5: `search-configure-request-manage.spec.ts`; panel de precios 2.2b: `pricing-panel.spec.ts`); confirmación que dice «solicitud» (2.4: `confirmation_page_says_request_not_booking`; lista de espera 2.6: `waitlist_page_says_waiting_list_not_booking`).
- **Revisión de Oscar de la fase:** leer `engine-tables.test.ts` y `engine-2.2.test.ts` como tarifa y comprobar tres casos a mano; leer los informes del `reviewer` (resumidos en cada `done`: 2.1 aprobar en la ronda 3, 2.2 y 2.4 en la ronda 2, 2.5 en la ronda 3, 2.6 corregido tras la ronda 1, 7.5 en la ronda 2).
- **Permisos que debe asignar Oscar** (solo los tiene owner y ninguno es alcance de clave de API): `common.customField.publish` (con step-up; los roles que hoy gestionan campos no lo reciben solos, 7.5), `waitlist.entry.read` (2.6) y los permisos de reservas y CRM (2.4, 2.5).
- **Decisión de negocio:** `stackable` vale `false` por defecto en reglas y códigos (2.2); un recargo que deba sumarse a otros hay que marcarlo apilable a mano. Confirmar o cambiar el valor por defecto.
- **Menores de 8.4 aún abiertos:** la resolución DNS queda fuera del plazo de 10 s; la guía de despliegue debe aclarar qué pasa con las entregas pendientes; los webhooks de una persona desactivada siguen enviando ids de evento; el preflight CORS solo se prueba en la API; la rama de producción del reclamo no tiene e2e; faltan la FK `createdById` y la columna de versión en algunas tablas.
- **Para el monitor de 8.6:** contador de códigos promocionales desconocidos (pendiente desde 2.2).
- **Para 5.5 (borrado y anonimización):** tras anonimizar, `userId` sigue enlazado y esa cuenta recibe 409 `customer_closed` siempre; un `Customer` borrado sin usuario con el mismo correo da `customer_conflict` permanente (2.4). `WaitlistEntry` se redacta, no se borra (2.6). El texto de las notas entra en `AuditPiiValue` (2.5).
- **Para 3.2 (de 3.1):** añadir el gancho `expire` (`hooks.ts` solo admite approve|cancel; sin él el disparador rechaza `approved → expired`); la reserva sigue `approved` tras el depósito hasta 3.2; el reproceso manual de webhooks fallidos desde el panel no existe hasta 4.1; la única forma de crear la cuenta del simulador es `payments:simulator-account`. 3.1 absorbió parte de 3.2 (plan, intentos y registro de cobros): la fila 3.2 de `docs/autonomous.md` quedó ajustada.
- **Límites conocidos:** la clave de idempotencia K2 no se guarda en la rama «entrada viva» de la lista de espera (2.6); los paquetes en `waitlist` o `sold_out` no admiten lista de espera por esa ruta (2.6; sold_out es de 6.5); topes por cliente de 3 solicitudes abiertas y 12 plazas retenidas (2.4; el segundo puede frenar grupos grandes); las páginas públicas no pintan aún los campos personalizados, solo la API pública (7.5); aceptar un presupuesto respeta el precio cotizado hasta `expiresAt` (2.5); las aprobaciones no caducan hasta 3.2 y un paquete agotado no pasa solo a `sold_out` (2.4).
- **Sin verificar:** `prisma migrate diff` de las migraciones 0007 a 0017 (sin motor local; lo valida CI); lector de pantalla y teclado completo del panel de precios y del constructor (2.2b, 2.3).
- **Rama remota obsoleta** `task/8.1-web-foundation`: borrar a mano (`docs/BLOCKED.md`).

### Fase 3 (cerrada; 3.3 y 3.4 hechas el 2026-11-19, ver "Fase 4 y dinero")

Hechas 3.1, 3.2, 3.5 y 3.6, solo contra el simulador; 3.3 (Stripe) y 3.4 (PayID) reabiertas el 2026-11-19, aún no hechas. Evidencia en `docs/done/3.1.md`, `3.2.md`, `3.5.md` y `3.6.md`. Llegan también 5.4, 6.5, 7.3, 7.4 y 7.6, fusionadas fuera de su fase.

- **Revisión de Oscar de la fase:** pago de prueba completo y claves de Stripe, imposibles hasta que 3.3 y haya sandbox real. Mientras tanto, publicar la página `terms` en el panel y probar el checkout con el simulador (`payments:simulator-account`).
- **Permisos que debe asignar Oscar:** ver `docs/BLOCKED.md` (`bookings.booking.confirm`, plantillas, reclamaciones, fechas clave, automatizaciones).
- **Límites conocidos de 3.2:** `PaymentLink` pasa a 5.1 y los recordatorios a 5.6; la aprobación automática `instantBooking` queda para 5.1/3.5. Menor: si un intento termina como `not_live` entre dos transacciones, el cliente recibe 409 `payment_attempt_in_progress` aunque no haya nada vivo (reintentar funciona). Corregido: se perdía el error original en un fallo de cobertura.
- **3.5:** las condiciones son la página publicada `terms`; `legalReviewPending` no bloquea el pago; la web solo admite redirección http a localhost cuando se sirve desde localhost, mientras la API admite más en los adaptadores de prueba.
- **6.5:** solo se ofrece al liberarse plazas (no al subir la capacidad ni al unirse); «el primero al que le cabe» puede dejar esperando a un grupo grande; `inventory_movements` no referencia la entrada; una entrada con oferta se redacta, no se borra (5.5 debe bloquear al cliente `FOR UPDATE` y reintentar 40001); el camino de reintento por interbloqueo no tiene prueba.
- **7.4:** los datos se toman al despachar; `call_webhook` ejerce un permiso con step-up en segundo plano sin sesión (decisión documentada); los correos al cliente son transaccionales (respetan supresión y rebotes, sin enlace de baja).
- **7.3:** antelación fija de 7 días y una tarea de saldos por edición y día. **7.6:** plazos por defecto de 2 y 30 días; sin adjuntos (no hay ruta de subida); `GET /admin/complaints/owners` enseña el correo del personal a quien tenga `manage`.
- **Proceso:** un verificador ejecutó por error `docker/db/init/01-roles.sql` (tiene `\connect marathon_trips`) contra la base local de desarrollo `marathon_trips`; es idempotente y no se borró nada. Ahora se les dice que creen su propia base a mano, sin ese archivo.
- **Sin verificar:** `prisma migrate diff` de 0018 a 0023 (sin motor local; lo valida CI); `backup.test.ts` (pide superusuario); lector de pantalla del checkout y de los paneles nuevos; `test:sandbox` contra un sandbox real.

### Fase 4 y dinero (cerrada, `docs/done/4.close.md`; incluye 3.3, 3.4, 6.2 y 6.4)

Sección «Revisión de Oscar» de `docs/phases/phase-4.md`: crear, pausar y retirar una cuenta de pasarela a mano y leer los informes del `reviewer`. Los 8 criterios cumplen con prueba automática, contra simuladores y falsos.

- **4.1:** nada ata una cuenta a su identidad en la pasarela (rotar una cuenta activa a la clave de otra cuenta de Stripe autentica); `manage` y `manageCredentials` se pueden asignar a cualquier rol; `createStripeTestAccount` inserta cuentas activas sin prueba de conexión.
- **4.2:** un cliente cuyo intento vivo coincidió con la caída de la pasarela sigue bloqueado en esa reserva hasta que conteste (P2 intacto; el aviso `live_attempts_on_unreachable_account` lista esas reservas).
- **4.3 (PayPal):** cancelar la reserva justo antes de la captura deja un cobro tardío (se registra); un 422 desconocido en `drive` vuelve a mandar a PayPal sin `failureCode`; la tarea de M2 enlaza al WebhookEvent, no al pago ni a la reserva; una captura con 401/404 se reintenta sin fin y el intento sigue vivo hasta la tarea de 24 h. Quien elige "Card" puede acabar en la página de PayPal.
- **4.4 (Pin):** contrato enmendado por capacidad (`preCardSession` da `NO_GATEWAY_EVENT` y `refundEventOurId: 'via_retrieve'`, solo `CardSessionProvider`; precedente: sujeto de Stripe en `subjects/stripe.ts:119`); un estado de webhook desconocido queda `ignored` sin tarea; sin FK de pago, reserva ni reembolso en las tablas de sesiones de tarjeta; la `returnUrl` lleva la referencia de la reserva; `settle` no relee sesiones `succeeded`; un 3-D Secure abandonado bloquea la reserva hasta la tarea de 24 h; decidir si se aceptan tarjetas sin 3-D Secure.
- **4.5:** ventana de `resolve`; sin barrido de disputas si se pierde el webhook final (lo cubre 4.6); `courtesy_refund_lowers_total_without_reopening_balance` sin tarea dueña (seguimiento); seguimiento de reembolsos externos. Un pago en disputa no se reembolsa; el paquete de pruebas no se envía por API.
- **4.6:** Stripe y PayPal no listan actividad (el informe dice "fees not imported"); el consumidor espera al barrido horario; la tarea de atraso trata `mismatch` y `partial` como correctos; `fundsAfterMinor` por `createdTxId` (ver arriba); sin exportación CSV; sin e2e propios.
- **6.4:** la penalización por encima de lo cobrado no se reclama; la fecha de una solicitud bloqueada vale 14 días; ruta `operator_cancelled`; los reembolsos los envía el personal; el editor de tramos de importe fijo solo admite AUD.
- **6.2:** solo registra pagos ya hechos, no envía dinero; desviaciones D2 (`CostItem` sin `mode`), D3 (sin conversión de moneda; pasa a 6.6), D4 y D7; el catálogo en-AU entero va en el JavaScript público y el presupuesto de bytes no tiene margen: tarea para sacar `admin.*` (mirar el PR de 6.6).
- **Observaciones de 3.3 y 3.4:** variantes de referencia como "MT ABC123"; `.rejects.toThrow()` sin mensaje en `manual.test.ts:385`; colisiones de ID de extracto entre bancos; cursor guardado antes de las tareas; `paymentLedgerCheckCursor` editable desde el panel; prueba inestable `flow.test.ts:597`; `ledger.test.ts` no se repite sobre la misma base.
- **Tareas de seguimiento a registrar:** (a) sacar `admin.*` del JavaScript público; (b) reembolso de cortesía de 4.5; (c) registrar reembolsos externos; (d) verificación por sandbox de cada pasarela cuando Oscar dé cuentas.
- **Sin verificar:** `test:sandbox` de las tres pasarelas, e2e de recibos y conciliación, script real de Pin, `prisma migrate diff` (solo CI) y `backup.test.ts`.

### Fase 5 (cerrada, `docs/done/5.close.md`)

Sección «Revisión de Oscar» de `docs/phases/phase-5.md`: hacer el recorrido completo como cliente y como administrador con un paquete realista; no abrir la fase 6 antes. Los cinco criterios cumplen con prueba automática (`rehearsal.spec.ts` y las de 5.1 a 5.6, contra el simulador, sin recibos ni reembolsos).

- **Límites conocidos de 5.5:** restaurar una copia antigua resucita a los clientes borrados; hay que volver a aplicarlos con `privacy:erasures-reapply` (guía en `docs/deploy/guide.md`). La exportación `?audience=full` lleva notas del personal (solo owner; revisarla antes de enviarla). Un cliente archivado creado por el personal y sin usuario solo se borra desde la ficha.
- **Límites conocidos de 5.6:** el desfase se consume si hay un pago en curso al enviar; no hay recordatorios de vencidos (los ve el panel); no hay pantalla para editar los desfases (`balanceReminderOffsetsDays`, lista vacía = apagado). El panel suma todos los pagos en cada carga (vale con el volumen actual).
- **Decisiones de 5.1 a 5.6:** enlaces de pago de un solo uso (caducan a los 7 días o al vencer el depósito, solo al correo de la reserva); documentos generados al pedirlos; datos mínimos de viajeros sin pasaporte ni datos médicos; borrado solo por owner con step-up y 409 con viaje o dinero vivo; la baja de marketing también suprime las alertas.
- **Sin verificar:** correo real (solo buzón de pruebas), lector de pantalla, `compose-smoke` solo en CI, borrar a un cliente de punta a punta (pide un viaje terminado). El revisor de 5.2 no tuvo ronda final.

### Fase 6 (cerrada el 2026-11-20, `docs/done/6.close.md`; incluye 6.2, 6.4 y 6.6)

Sección «Revisión de Oscar» de `docs/phases/phase-6.md`: simular un viaje con un cambio y una cancelación y comprobar los números a mano. Ya se puede hacer entera, contra el simulador: un cambio (6.3) con su diferencia, una cancelación con penalización y reembolso (6.4) que promociona a la lista de espera (6.5), costes y pagos a proveedores (6.1, 6.2) y el resultado por viaje con su CSV (6.6). Los cuatro criterios cumplen con prueba automática; dos con matiz (cupo contratado del proveedor y comisiones, abajo).

- **Límites conocidos de 6.5:** solo se ofrece al liberarse plazas (no al subir la capacidad ni al unirse con hueco); «el primero al que le cabe» puede dejar esperando siempre a un grupo grande; el correo de oferta es texto simple (sin plantilla 5.4) y sin recordatorio previo; el panel de la lista es de solo lectura; `inventory_movements` no referencia la entrada; el camino de reintento por interbloqueo no tiene prueba.
- **Límites conocidos de 6.3:** si un cambio llega entre que se encola un recordatorio y se envía, ese correo queda `failed` y ese desfase se pierde (quedan el siguiente, la lista de cobros y la tarea de vencido); el crédito pendiente es una tarea manual; los cambios del cliente están apagados por defecto (`customerAmendmentsEnabled`, activar en Ajustes cuando se quiera); el estado se comprueba por disparador al insertar el cambio, no en `mt_booking_guard`.
- **Límite de 6.1:** el cupo contratado solo se compara con el stock, no se decrementa al cancelar; el panel no tiene e2e de navegador.
- **Sin verificar:** `prisma migrate diff` de 0009, 0022 y 0029 (solo CI), lector de pantalla.
- **6.2:** solo registra pagos ya hechos, no envía dinero; D2 (`CostItem` sin `mode`), D3 (sin conversión de moneda; el hallazgo 3 pasó a 6.6 y está probado), D4 y D7 (fórmula de "dinero a reservar", ver arriba); un coste de 0 da 422; sin formulario de cuotas en el panel (la ruta sigue); el catálogo en-AU entero iba en el JavaScript público con el límite sin margen.
- **6.4:** penalización por encima de lo cobrado no se reclama; solicitud bloqueada vale 14 días; `approved` y `requested` no retienen nada; reembolsos los envía el personal; editor de importes fijos solo en AUD; sin correos de cancelación; cancelación online apagada.
- **6.6:** resultado por viaje y moneda, previsión de caja por fecha de Brisbane (saldo desde 0, solo fechas con movimientos) y CSV para el contable con permiso, step-up y auditoría; sin comisiones importadas, sin GST; un solo caso de mutación del límite de Brisbane no se hizo a mano; catálogo `admin.*` separado del JavaScript público.
- **Sin verificar (6.2, 6.4, 6.6):** `prisma migrate diff` de 0038 a 0040 (solo CI), `backup.test.ts`, e2e de cancelación y de 6.6 y el presupuesto de JavaScript (los cubre CI), lector de pantalla.

### Fase 7 (cerrada, `docs/done/7.close.md`)

Sección «Revisión de Oscar» de `docs/phases/phase-7.md`: crear dos automatizaciones reales y un informe que usarías cada semana. Probar también una reclamación y el calendario de fechas clave (antelación fija de 7 días).

- **Límites conocidos:** 7.2 solo trae dos formatos de ejemplo de organizador (los reales se desconocen) y no tiene pantalla en el panel; 7.7 no tiene prueba unitaria de la exclusión de reservas demo (`NOT b."isDemo"` en `engine.ts`; la existente cubre solo carreras demo); 7.1 solo incluye reservas con depósito pagado y sitúa en un día los traslados con fecha `AAAA-MM-DD`; 7.3 antelación fija; 7.4 sin transiciones de estado ni eventos de pagos; 7.5 las páginas públicas aún no pintan los campos personalizados; 7.6 sin adjuntos y `GET /admin/complaints/owners` enseña el correo del personal a quien tenga `manage`.
- **Revisiones de Opus:** hechas las de 7.2, 7.4 y 7.7; sus puntos están en 7.fix-2 a 7.fix-5.
- **Sin verificar:** envío real de correo, lector de pantalla.

### Fase 8 (cerrada, `docs/done/8.close.md`)

Sección «Revisión de Oscar» de `docs/phases/phase-8.md`: leer el informe de seguridad (`docs/security/asvs-review.md`) y seguir la guía de despliegue en un entorno de pruebas. Los cinco criterios cumplen con prueba automática; sin tareas `8.fix-N`.

- **8.2 (idiomas y `hreflang`):** `es-ES` es parcial (cabecera, pie, inicio, carreras, FAQ y legales) y está apagado por defecto; componentes de cliente y panel en inglés; el compose de producción no pasa `ENABLED_LOCALES`. Revisar `messages/es-ES.json` antes de activarlo. Sin verificar: lector de pantalla con `lang` mixto y cookies bloqueadas.
- **8.3 (accesibilidad y rendimiento):** `amendments.ts` (6.3) mete zod en cuenta y admin. Sin verificar: lector de pantalla, móvil real, Lighthouse desplegado y páginas con sesión.
- **8.5 (seguridad):** 24 hallazgos, 3 altos corregidos; S-04 solo se ve en el servidor; S-13 y S-14 abiertos. Necesitó 5 rondas de revisión (más de las 3 habituales, por instrucción de Oscar). Migración 0031.
- **7.fix-1 y 7.fix-2:** informes y automatizaciones corregidos tras la revisión de 7.4; migración 0030. Ver puntos 7, 8, 13, 14 y 19 de la lista de arriba.

### Lecciones de proceso (fases 5 a 8)

- Cada verificador y revisor debe usar su propia base nueva y nunca `scripts/db-init.sh`. Más de una vez se ejecutó el SQL de roles sin la línea `\connect`, de modo que los `REVOKE`/`GRANT` sobre `marathon_trips` corrieron en la base de mantenimiento (idempotente; no se tocaron datos).
- Playwright reutiliza servidores existentes fuera de CI: varias ejecuciones e2e locales de distintos hilos se enganchan a los servidores de otros y fallan sin motivo. Manda la e2e de CI.
- `ubuntu-latest` pasó a 26.04 y su `pg_restore` rechaza `transaction_timeout`: `ci.yml` queda en `ubuntu-24.04` (PR #48).
