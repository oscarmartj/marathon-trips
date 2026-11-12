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
6. **Revisión del plan 0.1 con ronda 18 «aprobar con cambios».** Los 8 hallazgos abiertos están aparcados con el dinero y son vinculantes al retomarlo.
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
