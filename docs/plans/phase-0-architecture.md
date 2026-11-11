# Plan 0.1: arquitectura general y modelo de datos completo

- **Tarea:** 0.1 (riesgo: arquitectura). Sin código.
- **Fecha:** 2026-11-11
- **Fuentes leídas:** `docs/brief.md`, `docs/architecture.md`, `docs/modules.md`, `docs/payments.md`, `docs/web.md`, `docs/phases/phase-0.md` a `phase-9.md`, `.claude/rules/*.md`, `docs/autonomous.md`.
- **Quién lo usa:** cada hilo que cree tablas o módulos. Si una tarea necesita apartarse de este plan, lo dice en su propio plan y en su `docs/done/N.M.md`; no se reabre este documento salvo que el cambio afecte a varios módulos.

Los identificadores (tablas, campos, módulos, eventos, permisos) van en inglés. El texto, en español para Oscar.

## Índice

1. Principios y convenciones que valen para todo el código
2. Estructura del monorepo
3. Módulos de la API y cómo se hablan
4. Plataforma común: autenticación, permisos, auditoría, eventos, tareas, archivos, correo
5. Modelo de datos completo, por módulo
6. Máquinas de estados
7. Casos de fallo y cómo los cubre el diseño
8. Pruebas que cada tarea escribe primero
9. Decisiones que tomo distinto de lo pedido
10. Riesgos del plan de fases y cambios en la tabla de dependencias
11. Supuestos (las preguntas que haría a Oscar)
12. Lo que este plan no hace

---

## 1. Principios y convenciones

Estas reglas se aplican desde la primera migración. Varias se pueden comprobar con una prueba automática sobre el esquema de Prisma (sección 8).

### 1.1 Dinero

- Todo importe es un entero en unidades menores, en una columna con sufijo `Minor` (`totalMinor`, `amountMinor`), tipo `Int` de PostgreSQL (`integer`).
- **Toda fila que tiene una columna `*Minor` tiene su propia columna `currency`** (`Char(3)`, ISO 4217). No se hereda la moneda de una tabla padre: así ninguna consulta puede mezclar monedas por accidente.
- Límite: `integer` llega a 2 147 483 647 unidades menores (A$21,4 millones). Ningún importe individual (línea, pago, asiento) puede acercarse; la API rechaza importes por encima de A$1 000 000 por línea. Las sumas en SQL devuelven `bigint` y se convierten con comprobación. Pasar a `BigInt` más adelante es una migración que solo ensancha la columna.
- Porcentajes en **puntos básicos** enteros, columnas con sufijo `Bps` (1000 = 10 %).
- Tipos de cambio (solo para costes de proveedor en otra moneda y finanzas): entero escalado `rateE9 BigInt` (tipo × 10⁹). No es dinero, pero así **el esquema no tiene ni una columna `Float` ni `Decimal`**, y eso se puede comprobar con una prueba.
- Coordenadas geográficas, si se guardan, como `latitudeE7 Int` y `longitudeE7 Int` (grados × 10⁷), por la misma regla.
- Regla de redondeo (la fija y prueba 2.1, este plan la propone): las reglas porcentuales se calculan en aritmética entera sobre puntos básicos y se redondean **a la unidad menor, mitad hacia arriba sobre el valor absoluto, línea a línea**; el total es la suma de líneas ya redondeadas. Nunca se redondea el total por separado.
- En TypeScript, el tipo compartido es `Money = { amountMinor: number; currency: CurrencyCode }`, validado con `z.number().int()`. `packages/shared` solo tiene utilidades para **formatear** dinero, nunca para calcular totales.

### 1.2 Identificadores, tiempo y concurrencia

- Clave primaria: UUID v7 (`String @id @default(uuid(7)) @db.Uuid`; si la versión de Prisma no lo admite, `uuid()` v4). Se ordena por tiempo y no revela volumen.
- Referencias legibles para personas, únicas y no secuenciales: reserva `MT-7K3Q9P` (Crockford base32, 6 caracteres), reclamación `CMP-…`. Los recibos sí son secuenciales (`NumberSequence`), porque un registro contable lo espera.
- Instantes en `timestamptz(3)`, siempre en UTC. **Fechas de calendario** (fecha de carrera, entrada y salida del hotel, fecha límite del saldo) en `@db.Date`, sin hora.
- Zona horaria del negocio: `Australia/Brisbane` (sin horario de verano), guardada en `Setting.businessTimeZone`. "Días antes de la salida" = días de calendario entre la fecha de hoy en esa zona y `Package.checkInDate`. Un plazo "vence el día X" vence al final del día X en esa zona.
- Bloqueo optimista: los agregados editables desde el panel tienen `version Int @default(0)`; el panel envía la versión que leyó y la API responde 409 si ha cambiado.
- Cupos y contadores (plazas, usos de un código) se modifican con `UPDATE … SET consumed = consumed + n WHERE id = $1 AND consumed + n <= capacity` dentro de la transacción, con restricción `CHECK (consumed BETWEEN 0 AND capacity)` como red de seguridad.

### 1.3 Columnas comunes

| Columna | Dónde | Para qué |
|---|---|---|
| `createdAt`, `updatedAt` | todas | |
| `version` | agregados editables en el panel | bloqueo optimista |
| `deletedAt`, `deletedById` | entidades con borrado lógico (marcadas **SD** en la sección 5) | borrado lógico y restauración (0.5) |
| `customFields Json @default("{}")` | Race, Package, Customer, Traveller, Booking, Supplier (marcadas **CF**) | campos personalizados (7.5), con índice GIN |
| `isDemo Boolean @default(false)` | raíces de datos de ejemplo: Race, Hotel, Customer, Booking, Supplier | datos demo imposibles de publicar (1.5) |
| `/// @pii` | comentario de Prisma en cada campo con datos personales | registro de datos personales (sección 4.9) |

Las tablas de asientos, auditoría e instantáneas **no** tienen `updatedAt` ni `deletedAt`: no se modifican nunca.

### 1.4 Texto traducible

- El contenido editable que ve el cliente usa el tipo `LocalizedText`: columna `Json` con forma `{ "en-AU": "…", "es-ES": "…" }`, validada con un esquema de `packages/shared`. Idioma por defecto y obligatorio: `en-AU`. Añadir un idioma es añadir claves, sin migración.
- Los textos de la interfaz no viven en la base de datos: archivos de mensajes de la web (`apps/web/messages/en-AU.json`).
- Los `slug` son únicos y comunes a todos los idiomas; el idioma va en el prefijo de la ruta.

### 1.5 Nombres

- Modelos de Prisma en PascalCase singular, tablas en snake_case plural con `@@map`.
- Eventos: `<module>.<aggregate>.<pastTense>` (`catalogue.package.saleStatusChanged`), con `schemaVersion` en la carga.
- Permisos: `<module>.<resource>.<action>` (`bookings.booking.approve`, `payments.providerAccount.manageCredentials`).
- Enumerados de Prisma para estados y tipos fijos del código; tablas para lo que Oscar define en el panel (etiquetas, campos, roles).

### 1.6 Extensiones de PostgreSQL

Solo extensiones incluidas en la distribución estándar: `citext` (correos sin distinguir mayúsculas), `pg_trgm` (búsqueda aproximada) y `btree_gist` (impedir solapes de versiones de precio con `EXCLUDE`). Versión mínima de PostgreSQL: 16.

---

## 2. Estructura del monorepo

```
apps/
  api/                       NestJS + Prisma
    src/
      main.ts
      app.module.ts          carga la plataforma y la lista de módulos
      modules.registry.ts    lista única de módulos de negocio (lo único que se toca al añadir uno)
      platform/              siempre encendida, sin feature flag
        config/              variables de entorno validadas con zod al arrancar
        database/            PrismaService, ayudante de transacciones, extensión de borrado lógico
        http/                cabeceras de seguridad, CORS, CSRF, límites de peticiones, filtro de errores, requestId
        logging/             logger con redacción de datos personales y secretos
        auth/                sesiones, enlace mágico, contraseña, TOTP, step-up
        access/              roles, permisos, guardas, ámbitos
        audit/               escritura del registro de auditoría
        events/              outbox, despachador, registro de consumidores
        jobs/                envoltorio de pg-boss, tareas programadas
        flags/               feature flags y ajustes (Setting)
        crypto/              cifrado de secretos en reposo
        idempotency/         claves de idempotencia de la API
        storage/             interfaz FileStorage + adaptadores (sistema de archivos, S3)
        mail/                interfaz MailSender + adaptador SMTP + guarda de desarrollo
        entities/            registro de entidades (lo que usan búsqueda, filtros, CSV, informes, campos personalizados)
        common/              etiquetas, notas, adjuntos, tareas, vistas guardadas, búsqueda, CSV, borrado lógico
        privacy/             registro de manejadores de datos personales (exportar, anonimizar)
        health/              salud, monitor, modo mantenimiento
      modules/               módulos de negocio, cada uno con su flag
        catalogue/
        pricing/
        bookings/
        crm/
        payments/
          core/              libro, plan de pagos, enrutado, cuentas, webhooks, conciliación
          adapters/
            simulator/       simulador para CI (3.6)
            manual/          transferencia, PayID (3.4)
            stripe/          (3.3)
            …                uno por pasarela, cada uno aislado
        customer-portal/
        alerts/
        templates/
        dashboard/
        suppliers/
        changes/             cambios, cancelaciones
        waitlist/
        operations/
        finance/
        content/
        complaints/
        reporting/
        automations/
        integrations/        claves de API, webhooks salientes
        groups/ partners/ campaigns/ reviews/ bespoke/   (más adelante: no se crean hasta que Oscar los pida)
    prisma/
      schema/                un archivo .prisma por módulo (sección 5)
      migrations/
      seed/                  datos demo (1.5)
    test/                    integración (contra PostgreSQL real)
  web/                       Next.js App Router + Tailwind
    src/app/
      [locale]/(public)/     sitio público, estático o incremental
      [locale]/(account)/    área del cliente
      admin/                 panel, grupo de rutas protegido y cargado aparte
    messages/en-AU.json
    e2e/                     Playwright
packages/
  shared/
    src/schemas/             esquemas zod compartidos (entrada y salida de la API)
    src/money/               tipo Money y formato (sin cálculo de totales)
    src/brand/brand.config.ts   archivo único de marca: nombre, colores, logotipo (0.6)
    src/api-client/          cliente tipado generado desde el OpenAPI (generado y versionado)
  tooling/                   configuración compartida de ESLint y TypeScript (si 0.2 lo prefiere)
docs/
```

Decisiones de herramientas que 0.2 concreta (versiones estables actuales al empezar):

- **pnpm workspaces + Turborepo**, Node LTS activo.
- **Validación:** zod en `packages/shared`; la API valida con esos mismos esquemas y genera el OpenAPI desde ellos (por ejemplo `nestjs-zod`). El cliente tipado se genera con `openapi-typescript` + `openapi-fetch` y se versiona; CI regenera y falla si hay diferencias.
- **Pruebas:** Vitest (con SWC para los decoradores de NestJS) para unitarias e integración; Playwright para extremo a extremo. Las pruebas de integración usan una base de datos PostgreSQL real, con un esquema aislado por proceso de pruebas.
- **Fronteras entre módulos** comprobadas en lint (`dependency-cruiser` o reglas `no-restricted-imports`): un módulo solo importa de `platform/*` y del `index.ts` público de otro módulo.
- **`docker-compose`**: PostgreSQL y Mailpit. **No hay Redis** en el stack: tareas, límites de peticiones y caché van sobre PostgreSQL o en memoria (una sola instancia de API). La mención a Redis en `docs/autonomous.md` es solo una ayuda del entorno; ninguna tarea debe añadir Redis.
- Almacenamiento en desarrollo: adaptador de sistema de archivos. El adaptador S3 se prueba con la misma batería de contrato contra un emulador S3 si 0.4 lo encuentra libre y ligero; si no, queda escrito contra la documentación y marcado como no probado.

---

## 3. Módulos de la API

### 3.1 Contrato de un módulo

Cada módulo de `modules/` exporta:

- Un `NestModule` y un `manifest`:
  - `key` y `flagKey` (`module.suppliers`);
  - `permissions`: lista de permisos que declara (se sincronizan a la tabla `Permission` al arrancar);
  - `publishes` y `subscribes`: eventos;
  - `entities`: entidades que registra en el registro de entidades (campos filtrables, exportables, columnas, permiso de lectura);
  - `personalData`: manejador de exportación y anonimización si guarda datos personales;
  - `jobs`: tareas programadas.
- Un `index.ts` con su API pública (servicios de consulta y comandos). Ningún otro módulo usa Prisma sobre sus tablas para **escribir**; para leer, usa su servicio público o el registro de entidades.

Las relaciones de clave ajena entre tablas de módulos distintos están permitidas (por ejemplo `Booking.packageId`), pero la escritura es del módulo dueño.

**Feature flag por módulo.** Si el flag está apagado: sus rutas responden 404, sus tareas programadas no se ejecutan y sus consumidores marcan los eventos como `skipped` (al encenderlo no procesa el pasado; si lo necesita, lo reconstruye desde las tablas). El flag se lee en cada petición, sin reiniciar.

**Añadir un módulo** = crear la carpeta, su archivo `.prisma` y una línea en `modules.registry.ts`. No se modifica ningún módulo existente.

### 3.2 Mapa de módulos, nivel, tarea que lo crea y eventos principales

| Módulo | Nivel | Tarea | Publica (ejemplos) | Escucha (ejemplos) |
|---|---|---|---|---|
| platform (auth, access, audit, flags) | base | 0.3 | `auth.user.loggedIn`, `access.role.changed` | — |
| platform (events, jobs, storage, mail) | base | 0.4 | — | — |
| platform/common | base | 0.5 | `common.note.added` | todos (índice de búsqueda) |
| catalogue | núcleo | 1.1 | `catalogue.package.saleStatusChanged`, `catalogue.race.published` | — |
| pricing | núcleo | 2.1, 2.2 | `pricing.priceVersion.published` | — |
| bookings | núcleo | 2.4 | `bookings.booking.requested`, `…statusChanged` | `payments.scheduleItem.paid` |
| crm | núcleo | 2.5 | `crm.quote.sent` | `bookings.*` (correos por cambio de estado) |
| waitlist | núcleo / 2.ª ola | 2.6, 6.5 | `waitlist.entry.offered` | `bookings.booking.cancelled`, `catalogue.inventory.released` |
| payments | núcleo | 3.x, 4.x | `payments.payment.succeeded`, `payments.refund.completed`, `payments.reconciliation.mismatch` | `bookings.booking.approved` |
| customer-portal | núcleo | 5.1, 5.2 | `customerPortal.traveller.updated` | — |
| alerts | núcleo | 5.3 | `alerts.subscription.confirmed` | `catalogue.package.saleStatusChanged` |
| templates | núcleo | 5.4 | — | — |
| privacy (endpoints) | núcleo | 5.5 | `privacy.customer.erased` | — |
| dashboard | núcleo | 5.6 | — | lee de otros módulos |
| suppliers | 2.ª ola | 6.1, 6.2 | `suppliers.allotment.releaseDue` | — |
| changes | 2.ª ola | 6.3, 6.4 | `changes.amendment.applied`, `changes.cancellation.completed` | — |
| finance | 2.ª ola | 6.6 | — | `payments.*`, `suppliers.*` |
| operations | 2.ª ola | 7.1–7.3 | — | `bookings.*`, `suppliers.*` |
| automations | plataforma | 7.4 | `automations.run.completed` | todos (disparadores) |
| complaints | 2.ª ola | 7.6 | `complaints.complaint.dueSoon` | — |
| reporting | 2.ª ola | 7.7 | — | `web.analytics.*` |
| content | 2.ª ola | 8.1 | `content.page.published` | — |
| integrations | plataforma | 8.4 | — | todos (webhooks salientes) |
| groups, partners, campaigns, reviews, bespoke | más adelante | — | — | — |

Cuando un evento debe cambiar la web pública (publicar un paquete, una guía), un consumidor llama a la revalidación bajo demanda de Next.js por etiqueta.

---

## 4. Plataforma común

### 4.1 HTTP y seguridad

- API REST con OpenAPI; cada ruta del panel tiene permiso; cada ruta del cliente comprueba que el recurso es suyo.
- Sesión en cookie `httpOnly`, `Secure` (salvo en local), `SameSite=Lax`. La web y la API deben estar en el **mismo sitio** (mismo dominio registrable, o la web hace de proxy de `/api`): 8.7 lo concreta.
- CSRF: comprobación de `Origin` más cabecera propia obligatoria en toda petición que cambia datos. Los webhooks entrantes de pasarelas quedan fuera (los protege la firma).
- Límites de peticiones en memoria (`@nestjs/throttler`), más estrictos en inicio de sesión, enlace mágico, solicitud de reserva y suscripción a alertas.
- Logger estructurado con redacción por rutas (cookies, `authorization`, cuerpos de auth y pagos, campos `@pii`). Nunca se registra el cuerpo de una petición de pagos ni de autenticación.
- CORS restringido al origen de la web.

### 4.2 Autenticación (0.3)

- **Dos tipos de usuario separados**: `User.kind = staff | customer`, con `@@unique([kind, email])`. Una sesión de cliente nunca puede convertirse en sesión de personal, aunque el correo coincida.
- **Clientes:** enlace mágico de un solo uso, 15 minutos, token aleatorio de 32 bytes guardado como hash. La respuesta a "envíame un enlace" es idéntica exista o no el correo. El usuario `customer` se crea al verificar el enlace.
- **Personal:** contraseña con argon2id más TOTP obligatorio para todo el personal. Bloqueo progresivo tras intentos fallidos. Códigos de recuperación guardados como hash. **Sin recuperación por correo para el personal**: el primer propietario se crea y se recupera con un comando de consola (`pnpm api:cli staff:create`, `staff:reset`), que exige acceso al servidor.
- **Step-up:** `Session.mfaVerifiedAt`; las acciones sensibles (credenciales de pasarela, roles, claves de API, exportar todos los datos) exigen TOTP en los últimos 5 minutos.
- Sesiones opacas en base de datos (token como hash), revocables. Duraciones por defecto: personal, 12 h absolutas y 2 h de inactividad; cliente, 30 días absolutos y 7 días de inactividad.
- Librería: 0.3 evalúa primero una librería mantenida (por ejemplo Better Auth) contra estos requisitos (separación de tipos, step-up, tokens con hash, nombres de tabla de este plan). Si no los cumple sin parches, implementación propia fina sobre primitivas probadas (`@node-rs/argon2` o `argon2`, `otpauth`). Lo anota en su `done`.

### 4.3 Permisos (0.3)

- `Permission` lo declaran los módulos en código y se sincroniza al arrancar; `Role` y `RolePermission` se editan en el panel (matriz).
- Roles de sistema: `owner` (todos los permisos, no editable, no se puede quedar sin ningún usuario) y `customer` (implícito: solo sus propios recursos, comprobado por propiedad, no por matriz).
- `UserRole.scope Json?`: ámbito opcional (por ejemplo `{ "editionIds": [...] }`) para dar a un guía acceso solo a su viaje. 0.3 crea la columna y aplica solo el ámbito vacío; el filtrado por ámbito llega cuando haga falta.
- Cada ruta del panel declara su permiso con un decorador. Una prueba recorre todas las rutas registradas y falla si alguna ruta del panel no tiene permiso declarado.
- Claves de API (8.4): un `ApiKey` actúa con un subconjunto de permisos (`scopes`) y nunca con más que el usuario que la creó.

### 4.4 Auditoría (0.3)

- `AuditLog` se escribe **en la misma transacción** que el cambio, desde un servicio de plataforma (no por evento, para no perder ninguno).
- Se audita: toda acción del personal, de una automatización o de una clave de API; todo cambio de estado, precio, cupo, pago, permiso, credencial y ajuste; inicios de sesión y fallos.
- `changes` guarda `{ campo: { before, after } }`. Los campos marcados `@pii` no van ahí: se escriben en `AuditPiiValue` (tabla aparte) y en `changes` queda la marca `"[pii]"`. Así el registro principal es inmutable y el borrado de un cliente puede eliminar sus valores personales sin tocarlo.
- Las credenciales y secretos nunca se auditan con su valor: solo "cambiado".
- `AuditLog` y `AuditPiiValue` no se editan; un disparador de PostgreSQL rechaza `UPDATE`, `DELETE` y `TRUNCATE` en `AuditLog`. `AuditPiiValue` solo admite `DELETE` desde el manejador de privacidad.
- El "historial de cambios por registro" (0.5) es una consulta sobre `AuditLog` por `entityType` y `entityId`; no hay otra tabla de historial.

### 4.5 Eventos y tareas (0.4)

- **Outbox:** el módulo escribe el `OutboxEvent` en la misma transacción que su cambio. Si la transacción se deshace, no hay evento.
- **Despachador:** tarea recurrente que toma eventos pendientes con `FOR UPDATE SKIP LOCKED`, crea un trabajo de pg-boss por cada consumidor suscrito (con clave única `consumer:eventId`) y marca el evento como despachado.
- **Consumidores:** entrega al menos una vez; cada consumidor es idempotente gracias a `EventDelivery` (`@@unique([eventId, consumer])`). Reintentos con espera creciente; tras el máximo, `failed` y visible en el monitor.
- Las cargas de los eventos llevan identificadores, no datos personales.
- Orden: no se garantiza entre agregados. Dentro de un agregado, el consumidor compara `aggregateVersion` y descarta lo antiguo cuando importa.
- Retención: eventos despachados y entregas correctas se purgan a los 90 días (no son el registro de auditoría).
- **pg-boss** en su propio esquema de la misma base de datos, para tareas puntuales y programadas (cron). Requiere un proceso de API siempre encendido: condición para el alojamiento (sección 10).

### 4.6 Archivos y correo (0.4)

- `FileStorage`: `put`, `get`, `delete`, `signedUrl`. Los archivos privados (documentos, adjuntos) solo se sirven a través de la API con permiso, o con URL firmada de corta duración.
- `MailSender`: `send(message)`. Adaptador SMTP (Mailpit en local). Todo envío pasa por `OutboundEmail` (registro y cola).
- **Guarda de desarrollo:** salvo `MAIL_MODE=live` (que solo pone Oscar al desplegar), la plataforma **rechaza enviar** a destinatarios fuera de la lista `MAIL_DEV_ALLOWLIST` (por defecto, dominios `example.test` y `example.com`) y lo registra como `suppressed`. Así ninguna tarea puede escribir a una persona real.
- Supresiones: bajas en un clic y rebotes en `EmailSuppression`; los correos de marketing la consultan siempre, los transaccionales no.

### 4.7 Secretos en reposo

- AES-256-GCM con clave maestra en variable de entorno (`APP_ENCRYPTION_KEY`), con `keyVersion` en cada fila cifrada para poder rotarla.
- Se cifran: credenciales y secretos de webhook de pasarelas, secreto TOTP, secretos de webhooks salientes.
- La API nunca devuelve un valor cifrado; los DTO de salida no tienen esos campos (prueba de serialización).

### 4.8 Ajustes y flags

- `FeatureFlag`: interruptores booleanos (módulos y funciones).
- `Setting`: ajustes del negocio con valor tipado y validado: `businessTimeZone`, `salesCountries` (`["AU"]`), `gstRegistered` (`false`), `defaultCurrency` (`AUD`), plazos de caducidad de solicitudes y aprobaciones, `maintenanceMode`, retenciones. Abrir otro país es cambiar `salesCountries`.

### 4.9 Datos personales

- Cada campo personal lleva `/// @pii` en el esquema. Un script genera el registro de campos personales que usan el logger, la auditoría y la privacidad.
- Cada módulo con datos personales registra un manejador `export(customerId)` y `anonymise(customerId)`. Una prueba (5.5) falla si un modelo con campos `@pii` no tiene manejador.
- Lo que no lleva datos personales a propósito: asientos del libro, instantáneas de reserva (los viajeros aparecen como "plaza 1, corredor con dorsal"), eventos del outbox, enlaces de pago.
- No se recogen pasaporte ni datos médicos; nunca datos de tarjeta.

---

## 5. Modelo de datos completo

Notación: **SD** = borrado lógico; **CF** = campos personalizados; **Ap** = solo se añaden filas (nunca se editan ni borran); **pii** = contiene datos personales. "Tarea" es la que crea la tabla. Archivo = archivo `.prisma` en `apps/api/prisma/schema/`.

### 5.1 Plataforma (`platform-*.prisma`)

| Entidad | Campos principales | Restricciones y notas | Tarea |
|---|---|---|---|
| **User** (pii) | `kind` staff/customer, `email` citext, `emailVerifiedAt`, `status` active/disabled/locked, `passwordHash?`, `totpSecretCiphertext?`, `totpKeyVersion?`, `totpEnabledAt?`, `failedLoginCount`, `lockedUntil?`, `lastLoginAt?`, `anonymisedAt?` | `@@unique([kind, email])`. `passwordHash` y TOTP solo para `staff` (check) | 0.3 |
| **RecoveryCode** | `userId`, `codeHash`, `usedAt?` | | 0.3 |
| **Session** | `userId`, `tokenHash` único, `createdAt`, `expiresAt`, `idleExpiresAt`, `lastSeenAt`, `mfaVerifiedAt?`, `userAgent?`, `ipPrefix?`, `revokedAt?` | IP truncada (/24, /48) | 0.3 |
| **LoginToken** (pii) | `email`, `userId?`, `purpose` magic_link, `tokenHash` único, `expiresAt`, `consumedAt?` | un solo uso | 0.3 |
| **Role** | `key` único, `name`, `description`, `isSystem` | | 0.3 |
| **Permission** | `key` único, `module`, `description` | sincronizada desde código | 0.3 |
| **RolePermission** | `roleId`, `permissionKey` | PK compuesta | 0.3 |
| **UserRole** | `userId`, `roleId`, `scope Json?` | | 0.3 |
| **AuditLog** (Ap) | `occurredAt`, `actorType` staff/customer/system/automation/api_key, `actorId?`, `action`, `entityType`, `entityId`, `changes Json`, `reason?`, `requestId?`, `ipPrefix?` | disparador anti-modificación; índice `(entityType, entityId, occurredAt)` | 0.3 |
| **AuditPiiValue** (pii) | `auditLogId`, `field`, `before?`, `after?`, `subjectCustomerId?` | solo se borra al anonimizar | 0.3 |
| **FeatureFlag** | `key` único, `enabled`, `description` | | 0.3 |
| **Setting** | `key` único, `value Json`, `schemaVersion` | validado por esquema del código | 0.3 |
| **OutboxEvent** | `type`, `schemaVersion`, `aggregateType`, `aggregateId`, `aggregateVersion?`, `payload Json`, `actorType`, `actorId?`, `occurredAt`, `dispatchedAt?` | índice parcial sobre pendientes | 0.4 |
| **EventDelivery** | `eventId`, `consumer`, `status` pending/done/failed/skipped, `attempts`, `lastError?`, `processedAt?` | `@@unique([eventId, consumer])` | 0.4 |
| **IdempotencyRecord** | `scope`, `key`, `requestHash`, `status` in_progress/completed, `responseStatus?`, `responseBody Json?`, `lockedUntil?`, `expiresAt` | `@@unique([scope, key])`; misma clave con otro cuerpo → 422 | 0.4 |
| **StoredFile** | `storageKey` único, `contentType`, `sizeBytes`, `checksumSha256`, `originalName?`, `visibility` private/public, `purpose`, `uploadedById?` | | 0.4 |
| **OutboundEmail** (pii) | `to`, `templateKey`, `locale`, `subject`, `status` queued/sent/failed/suppressed, `providerMessageId?`, `customerId?`, `relatedEntityType?`, `relatedEntityId?`, `error?`, `sentAt?` | se anonimiza al borrar un cliente | 0.4 |
| **EmailSuppression** (pii) | `email` citext único, `reason` unsubscribed/bounced/complaint, `scope` marketing/all | | 0.4 |
| **NumberSequence** | `key` único, `prefix`, `nextValue` | incremento en transacción | 0.4 |
| **Tag** | `name`, `colour`, `entityTypes String[]` | `@@unique([name])` | 0.5 |
| **Tagging** | `tagId`, `entityType`, `entityId` | `@@unique([tagId, entityType, entityId])` | 0.5 |
| **Note** (pii posible) | `entityType`, `entityId`, `body`, `authorId`, `pinned` | SD | 0.5 |
| **Attachment** | `entityType`, `entityId`, `storedFileId`, `title` | SD | 0.5 |
| **Task** | `title`, `description?`, `entityType?`, `entityId?`, `dueAt?`, `assigneeId?`, `status` open/done/cancelled, `source` manual/automation/system, `sourceRef?` | SD | 0.5 |
| **SavedView** | `entityType`, `ownerId`, `name`, `filters Json`, `columns Json`, `sort Json`, `shared` | | 0.5 |
| **SearchDocument** | `entityType`, `entityId`, `title`, `subtitle?`, `searchVector tsvector`, `permissionKey` | `@@unique([entityType, entityId])`, GIN; mantenido por eventos | 0.5 |
| **CsvJob** | `entityType`, `kind` import/export, `status`, `inputFileId?`, `outputFileId?`, `stats Json`, `errors Json`, `createdById` | importación con vista previa y validación | 0.5 |
| **BulkOperation** | `entityType`, `action`, `entityIds String[]`, `status`, `results Json`, `createdById` | cada elemento pasa por la misma lógica y permiso que su acción individual | 0.5 |
| **CustomFieldDefinition** | `entityType`, `key`, `label LocalizedText`, `type` text/number/date/boolean/select/multiselect, `options Json?`, `validation Json?`, `required`, `visibleToCustomer`, `editableByCustomer`, `displayOrder`, `archivedAt?` | `@@unique([entityType, key])`; archivar, nunca borrar | 7.5 |

### 5.2 Catálogo (`catalogue.prisma`, 1.1)

| Entidad | Campos principales | Restricciones y notas |
|---|---|---|
| **Race** (SD, CF, demo) | `slug` único, `name LocalizedText`, `countryCode Char(2)`, `city`, `timeZone`, `raceType` road/trail/ultra/other, `typicalMonth Int?` (1–12), `summary LocalizedText`, `websiteUrl?`, `latitudeE7?`, `longitudeE7?`, `heroMediaId?`, `seo Json`, `status` draft/published/archived, `externalSource?`, `externalId?` | `@@unique([externalSource, externalId])` |
| **RaceDistance** | `raceId`, `kind` marathon/half/ten_k/five_k/ultra/other, `distanceMetres Int`, `name LocalizedText` | |
| **RaceClaim** | `raceId`, `kind` official_partner/accredited_agent/other, `enabled`, `evidenceNote`, `evidenceAttachmentId?`, `enabledById?`, `enabledAt?` | **única fuente** de cualquier distintivo de acreditación en la web; auditado |
| **RaceEdition** | `raceId`, `year`, `startDate @db.Date?`, `endDate?`, `dateStatus` provisional/confirmed, `status` draft/announced/active/completed/cancelled, `notes LocalizedText` | `@@unique([raceId, year])` |
| **Package** (SD, CF) | `editionId`, `slug`, `name LocalizedText`, `saleStatus`, `checkInDate`, `checkOutDate`, `includes LocalizedText`, `excludes LocalizedText`, `instantBooking`, `autoConfirmOnDeposit`, `depositMode` per_person/per_booking/percent, `depositAmountMinor?`, `depositBps?`, `balanceDueDate @db.Date`, `minTravellers`, `maxTravellers`, `maxExtraNightsBefore`, `maxExtraNightsAfter`, `currency`, `cancellationPolicyId?`, `seo Json`, `publishedAt?` | `@@unique([editionId, slug])`; check `checkOutDate > checkInDate`; `isDemo` se hereda de la carrera |
| **PackageParticipationOption** | `packageId`, `type` runner_with_entry/runner_own_entry/supporter, `enabled` | qué tipos de viajero admite el paquete (ver decisión 9.1) |
| **PackageEntryOption** | `packageId`, `raceDistanceId`, `entryPoolId` | dorsales por distancia, cada uno con su cupo |
| **Hotel** (SD, demo) | `name`, `address`, `city`, `countryCode`, `starRating Int?`, `description LocalizedText`, `supplierId?`, `latitudeE7?`, `longitudeE7?` | reutilizable entre paquetes |
| **PackageHotel** | `packageId`, `hotelId`, `displayOrder` | `@@unique([packageId, hotelId])` |
| **RoomOption** | `packageHotelId`, `roomType` single/twin/double/triple/quad/other, `name LocalizedText`, `minOccupancy`, `maxOccupancy`, `roomPoolId` | check `1 ≤ min ≤ max ≤ 4` |
| **Extra** (SD) | `packageId`, `kind` excursion/transfer/meal/merchandise/other, `name LocalizedText`, `description LocalizedText`, `pricingUnit` per_person/per_booking, `availableTo` all/runners/supporters, `mandatory`, `maxPerBooking?`, `poolId?`, `schedule Json?` (traslados: salida, origen, destino) | un extra `mandatory` siempre entra en el total |
| **InventoryPool** | `kind` entry/room/extra, `label`, `capacity Int`, `consumed Int`, `lowStockThreshold Int?`, `confirmedBySupplier Boolean`, `confirmationNote?` | check `0 ≤ consumed ≤ capacity`; `confirmedBySupplier` en un cupo de dorsales es la condición para cualquier texto de "entrada garantizada" |
| **InventoryMovement** (Ap) | `poolId`, `delta Int`, `reason` hold/release/capacity_change/adjustment, `bookingId?`, `actorType`, `actorId?`, `note?` | historia del cupo |
| **ItineraryDay** | `packageId`, `dayNumber`, `title LocalizedText`, `description LocalizedText` | `@@unique([packageId, dayNumber])`; 7.1 |
| **OrganiserExportFormat** | `raceId`, `name`, `columns Json` (campo origen → cabecera), `fileFormat` csv | 7.2 |

Notas:

- `Package.nights` no se guarda: se deriva de las fechas.
- `MediaAsset` (contenido) se usa para imágenes de carrera desde la fase 1 con marcadores de posición; si 8.1 aún no existe, 1.1 crea `MediaAsset` mínimo en `content.prisma`.
- Las "noches extra" se venden por noche y persona según ocupación (`RoomRate.extraNightPerPersonMinor`), dentro de los límites del paquete.

### 5.3 Precios (`pricing.prisma`)

| Entidad | Campos principales | Restricciones y notas | Tarea |
|---|---|---|---|
| **PriceVersion** | `packageId`, `label`, `currency`, `validFrom timestamptz`, `validTo?`, `status` draft/published/archived, `publishedAt?` | dos versiones publicadas de un paquete no se solapan (`EXCLUDE USING gist` sobre `tstzrange`). 1.1 crea una versión por paquete; 2.2 permite varias | 1.1 |
| **RoomRate** | `priceVersionId`, `roomOptionId`, `occupancy` 1–4, `pricePerPersonMinor`, `extraNightPerPersonMinor`, `currency` | `@@unique([priceVersionId, roomOptionId, occupancy])`; check ≥ 0 | 1.1 |
| **ParticipationRate** | `priceVersionId`, `participationType`, `raceDistanceId?`, `amountPerPersonMinor`, `currency` | componente del dorsal o del acompañante; ≥ 0 | 1.1 |
| **ExtraRate** | `priceVersionId`, `extraId`, `amountMinor`, `currency` | | 1.1 |
| **PriceRule** | `scopeType` global/edition/package, `scopeId?`, `kind` early_bird/late_supplement/group_discount/occupancy_supplement/custom, `conditions Json` (tipada por `kind`), `effectMode` percent/fixed, `valueBps?`, `valueMinor?`, `currency?`, `per` person/booking, `appliesTo` accommodation/participation/extras/subtotal, `priority`, `stackable`, `validFrom?`, `validTo?`, `enabled` | semántica y orden de aplicación los fija 2.2 | 2.2 |
| **PromoCode** | `code` citext único, `description`, mismo efecto que `PriceRule`, `scopeType`, `scopeId?`, `maxRedemptions?`, `maxPerCustomer?`, `redeemedCount`, `validFrom?`, `validTo?`, `enabled` | check `redeemedCount ≤ maxRedemptions` | 2.2 |
| **PromoRedemption** | `promoCodeId`, `bookingId`, `customerId`, `redeemedAt`, `releasedAt?` | se libera si la reserva se rechaza o caduca | 2.2 |
| **CancellationPolicy** | `name`, `description LocalizedText`, `status` draft/active/archived | | 6.4 |
| **CancellationTier** | `policyId`, `minDaysBeforeDeparture`, `penaltyMode` percent/fixed_per_person/fixed_per_booking, `penaltyBps?`, `penaltyMinor?`, `currency?` | tramos sin huecos, probados en sus días límite | 6.4 |
| **ExchangeRate** (Ap) | `baseCurrency`, `quoteCurrency`, `rateE9 BigInt`, `asOf`, `source` | | 6.1 |

El **motor de precios** (2.1) es una función pura `price(input, catalogueView, rules, now) → PriceBreakdown`, sin acceso a la base de datos, que se prueba con tablas. Un servicio la rodea y le pasa los datos. `PriceBreakdown` incluye líneas, subtotales, descuentos, total, depósito, fecha del saldo, `priceVersionId` y `engineVersion`.

### 5.4 Reservas y CRM (`bookings.prisma`, `crm.prisma`)

| Entidad | Campos principales | Restricciones y notas | Tarea |
|---|---|---|---|
| **Customer** (pii, SD, CF, demo) | `userId?` único, `email` citext único, `givenName`, `familyName`, `phone?`, `countryOfResidence Char(2)`, `preferredLocale`, `source`, `anonymisedAt?` | uno por correo | 2.4 (mínimo), 2.5 |
| **Traveller** (pii, CF) | `customerId` (dueño), `givenName`, `familyName` (como en el documento), `dateOfBirth @db.Date?`, `email?`, `phone?`, `emergencyContactName?`, `emergencyContactPhone?`, `estimatedFinishSeconds Int?`, `anonymisedAt?` | sin pasaporte ni datos médicos | 2.4 (mínimo), 5.2 |
| **Booking** (CF, demo) | `reference` único, `customerId`, `kind` catalogue/bespoke, `packageId?`, `editionId?`, `status`, `currentSnapshotVersion`, `currency`, `totalMinor`, `depositMinor`, `balanceDueDate`, `residenceCountry`, `requestedAt`, `approvedAt?`, `approvalExpiresAt?`, `requestExpiresAt?`, `depositPaidAt?`, `confirmedAt?`, `balancePaidAt?`, `completedAt?`, `cancelledAt?`, `statusReason?`, `quoteId?`, `groupId?`, `partnerId?`, `sourceChannel`, `version` | check `kind = catalogue ⇒ packageId no nulo`; sin borrado: se cancela | 2.4 |
| **BookingSnapshot** (Ap) | `bookingId`, `version`, `kind` original/amendment, `configuration Json`, `priceBreakdown Json`, `cancellationPolicy Json?`, `termsVersionId?`, `totalMinor`, `currency`, `priceVersionId?`, `engineVersion` | `@@unique([bookingId, version])`; disparador anti-modificación; **sin datos personales** | 2.4 |
| **BookingTraveller** | `bookingId`, `slot Int`, `participationType`, `raceDistanceId?`, `travellerId?`, `isLead`, `addedInVersion`, `removedInVersion?` | la plaza existe desde la solicitud; los datos personales llegan en 5.2 | 2.4 |
| **BookingRoom** | `bookingId`, `roomOptionId`, `occupancy`, `travellerSlots Int[]` | configuración vigente (operativa) | 2.4 |
| **BookingExtra** | `bookingId`, `extraId`, `quantity`, `travellerSlot?` | | 2.4 |
| **InventoryClaim** | `bookingId`, `poolId`, `quantity`, `status` held/released | qué devolver al cancelar o caducar | 2.4 |
| **Quote** (SD) | `reference`, `customerId`, `kind` catalogue/bespoke, `configuration Json`, `priceBreakdown Json`, `totalMinor`, `currency`, `expiresAt`, `status` draft/sent/accepted/expired/withdrawn, `bookingId?`, `createdById` | aceptar respeta el precio cotizado hasta `expiresAt`, siempre desde el servidor | 2.5 |
| **QuoteLine** | `quoteId`, `description LocalizedText`, `quantity`, `unitAmountMinor`, `currency` | para viajes a medida | 2.5 |
| **WaitlistEntry** (pii) | `email`, `customerId?`, `reason` non_resident/sold_out, `raceId?`, `editionId?`, `packageId?`, `countryOfResidence`, `travellers Int`, `position`, `status` waiting/offered/converted/expired/withdrawn, `offeredAt?`, `offerExpiresAt?` | 2.6 crea; 6.5 añade la promoción | 2.6 |
| **TermsVersion** | `kind` booking_terms/privacy/website_terms, `version`, `content LocalizedText`, `publishedAt`, `isProvisional` | `@@unique([kind, version])`; Ap una vez publicada | 3.5 |
| **TermsAcceptance** (pii, Ap) | `customerId`, `bookingId?`, `termsVersionId`, `acceptedAt`, `ipAddress?`, `userAgent?` | prueba para disputas | 3.5 |
| **ConsentRecord** (pii, Ap) | `customerId?`, `email`, `purpose` marketing_email, `granted`, `source`, `wordingVersion`, `recordedAt` | el estado vigente es el último registro | 5.5 |
| **BookingAmendment** | `bookingId`, `fromVersion`, `toVersion?`, `kind` room/nights/travellers/name_change/extras/other, `priceDifferenceMinor` (con signo), `feeMinor`, `currency`, `status` proposed/applied/rejected, `reason`, `createdById`, `appliedAt?` | crea una `BookingSnapshot` nueva; nunca edita la original | 6.3 |
| **Cancellation** | `bookingId` único, `requestedBy` customer/staff, `requestedAt`, `daysBeforeDeparture`, `policySnapshot Json`, `penaltyMinor`, `refundableMinor`, `currency`, `reason` | | 6.4 |

### 5.5 Pagos (`payments.prisma`, la tarea 3.1 afina columnas y reglas de asiento)

| Entidad | Campos principales | Restricciones y notas | Tarea |
|---|---|---|---|
| **ProviderAccount** | `adapterKey`, `displayName`, `mode` test/live, `status` active/paused/retired/archived, `credentialsCiphertext Bytes`, `credentialsKeyVersion`, `webhookSecretCiphertext?`, `webhookPathToken` único, `lastConnectionTestAt?`, `lastConnectionTestResult?`, `createdById` | sin borrado físico si tiene historial (sin ruta DELETE y FK restrictivas); `mode=live` solo si el adaptador es `verified` | 3.3 (mínimo), 4.1 |
| **PaymentMethodConfig** | `method` card/apple_pay/google_pay/payto/becs/payid_transfer/bpay/bnpl/manual_other, `enabled`, `countries String[]`, `displayOrder`, `instructions LocalizedText?` | bnpl nace apagado | 3.4, 4.2 |
| **RoutingRule** | `method`, `providerAccountId`, `countries String[]`, `currencies String[]`, `minAmountMinor?`, `maxAmountMinor?`, `currency?`, `priority`, `fallbackForRuleId?`, `enabled` | | 4.2 |
| **PaymentSchedule** | `bookingId` único, `currency` | | 3.2 |
| **PaymentScheduleItem** | `scheduleId`, `kind` deposit/balance/instalment/adjustment, `sequence`, `amountMinor`, `currency`, `dueDate @db.Date`, `status` pending/paid/overdue/waived/superseded | importes calculados por la API | 3.2 |
| **PaymentLink** | `bookingId`, `scheduleItemId?`, `tokenHash` único, `expiresAt`, `status` active/used/expired/revoked, `createdById?` | **no guarda importe**: se calcula al usarlo | 3.2 |
| **Payment** | `bookingId`, `scheduleItemId?`, `payerCustomerId?`, `providerAccountId`, `adapterKey`, `method`, `amountMinor`, `currency`, `status` created/pending/requires_action/succeeded/failed/cancelled, `idempotencyKey` único, `providerPaymentRef?`, `failureCode?`, `succeededAt?` | `@@unique([providerAccountId, providerPaymentRef])` | 3.2 |
| **Refund** | `paymentId`, `amountMinor`, `currency`, `reason`, `status` requested/pending/succeeded/failed, `idempotencyKey` único, `providerRefundRef?`, `requestedById`, `cancellationId?` | suma de reembolsos ≤ pago (comprobado en transacción) | 3.2, 4.5 |
| **Dispute** | `paymentId`, `providerDisputeRef`, `amountMinor`, `currency`, `reason`, `status` open/evidence_submitted/won/lost/closed, `evidenceDueBy?`, `evidenceDocumentId?` | | 4.5 |
| **LedgerAccount** | `code` único (p. ej. `customer_funds`, `provider_clearing:<accountId>`, `payment_fees`, `supplier_payable`, `revenue`, `refunds_payable`), `kind` asset/liability/revenue/expense, `currency` | | 3.2 |
| **LedgerTransaction** (Ap) | `occurredAt`, `kind` payment/refund/fee/chargeback/supplier_payment/adjustment/reversal, `bookingId?`, `paymentId?`, `refundId?`, `disputeId?`, `supplierPaymentId?`, `reversesTransactionId?`, `idempotencyKey` único, `description` | una corrección es una transacción nueva que referencia la original | 3.2 |
| **LedgerEntry** (Ap) | `transactionId`, `accountCode`, `amountMinor` (con signo: débito +, crédito −), `currency`, `bookingId?` | disparador diferido: cada transacción suma 0 por moneda; anti-modificación | 3.2 |
| **WebhookEvent** (pii posible) | `providerAccountId`, `providerEventId`, `type`, `signatureValid`, `rawBody Bytes?`, `headers Json` (saneadas), `receivedAt`, `status` received/processed/ignored/failed, `attempts`, `processedAt?`, `error?` | `@@unique([providerAccountId, providerEventId])`; el cuerpo crudo se vacía a los 180 días o al anonimizar | 3.3 |
| **Settlement** | `providerAccountId`, `providerSettlementRef`, `payoutDate`, `grossMinor`, `feesMinor`, `netMinor`, `currency` | | 4.6 |
| **SettlementLine** | `settlementId`, `paymentId?`, `refundId?`, `kind`, `amountMinor`, `feeMinor`, `currency` | | 4.6 |
| **ReconciliationRun** | `providerAccountId`, `forDate`, `status` matched/mismatch/failed, `differences Json`, `createdAt` | alerta si no cuadra | 4.6 |
| **Receipt** | `number` único (secuencia), `bookingId`, `paymentId`, `amountMinor`, `currency`, `gstRegisteredAtIssue`, `gstAmountMinor?`, `issuedAt`, `documentId?` | si `gstRegisteredAtIssue = false`, el documento no muestra GST ni dice "tax invoice" | 4.6 |

**Estado del adaptador** (`verified`, `experimental`, `planned`) **no está en la base de datos**: lo declara el manifiesto del adaptador en código, junto con métodos, monedas, países y capacidades. Cambiarlo exige un PR con pruebas; el panel no puede modificarlo. Así no hay forma de saltarse "solo `verified` pasa a real" desde el panel.

**Estado de cobro de una reserva**: se deriva del libro y del plan de pagos (pendiente, depósito cobrado, pagada, con reembolso parcial, reembolsada), no se guarda a mano.

### 5.6 Plantillas, documentos, alertas, privacidad (`templates.prisma`, `alerts.prisma`)

| Entidad | Campos principales | Notas | Tarea |
|---|---|---|---|
| **EmailTemplate** | `key`, `locale`, `version`, `status` draft/active/archived, `subject`, `body`, `variablesSchema Json` | `@@unique([key, locale, version])`; vista previa con datos de ejemplo | 5.4 |
| **DocumentTemplate** | `key` confirmation/itinerary/voucher/receipt/evidence_pack, `locale`, `version`, `status`, `body`, `variablesSchema Json` | | 5.4 |
| **GeneratedDocument** | `bookingId?`, `kind`, `templateId`, `templateVersion`, `storedFileId`, `createdAt` | Ap | 5.4 |
| **AlertSubscription** (pii) | `email` citext, `customerId?`, `raceId`, `editionId?`, `status` pending/confirmed/unsubscribed, `confirmTokenHash?`, `confirmedAt?`, `unsubscribeTokenHash` único, `lastNotifiedAt?` | `@@unique([email, raceId])` | 5.3 |
| **PrivacyRequest** | `customerId`, `kind` export/erasure, `status` received/completed/rejected, `requestedAt`, `completedAt?`, `resultFileId?`, `notes` | | 5.5 |

### 5.7 Proveedores y finanzas (`suppliers.prisma`, `finance.prisma`)

| Entidad | Campos principales | Notas | Tarea |
|---|---|---|---|
| **Supplier** (SD, CF, demo) | `kind` hotel/ground_operator/race_organiser/other, `name`, `countryCode`, `defaultCurrency`, `paymentTerms`, `notes` | | 6.1 |
| **SupplierContact** (pii) | `supplierId`, `name`, `email?`, `phone?`, `role` | | 6.1 |
| **SupplierContract** (SD) | `supplierId`, `editionId?`, `reference`, `signedAt?`, `validFrom?`, `validTo?`, `terms`, `attachmentId?` | | 6.1 |
| **Allotment** | `contractId`, `poolId`, `kind` room/entry, `quantity`, `releaseDate @db.Date?`, `unitCostMinor`, `currency`, `status` held/released | contratado al proveedor; alimenta la capacidad del `InventoryPool` | 6.1 |
| **CostItem** | `supplierId`, `contractId?`, `packageId?`, `bookingId?`, `description`, `basis` per_person/per_room/per_booking/fixed, `quantity`, `unitAmountMinor`, `amountMinor`, `currency`, `dueDate?`, `status` planned/due/paid/cancelled | coste en su moneda | 6.1 |
| **SupplierPayment** | `supplierId`, `amountMinor`, `currency`, `paidAt`, `reference`, `costItemIds String[]`, `fxRateE9?`, `amountAudMinor?` | genera asiento en el libro | 6.2 |
| **AccountingExport** | `periodFrom`, `periodTo`, `format`, `storedFileId`, `createdById` | | 6.6 |

"Viaje", para operaciones y resultado económico, **es un `Package`** (una salida). El resultado por edición o carrera suma sus paquetes.

### 5.8 Operaciones, reclamaciones, contenido, informes, automatizaciones, integraciones

| Entidad | Campos principales | Notas | Tarea |
|---|---|---|---|
| **KeyDate** | `entityType`, `entityId`, `kind` allotment_release/balance_due/entry_submission/supplier_payment/custom, `date`, `title`, `taskId?` | mantenida por eventos; genera tareas | 7.3 |
| **Complaint** (pii, SD) | `reference` único, `customerId?`, `bookingId?`, `receivedAt`, `channel`, `category`, `description`, `status` received/acknowledged/investigating/resolved/closed, `ownerId?`, `acknowledgeBy`, `resolveBy`, `resolution?`, `resolvedAt?` | | 7.6 |
| **ComplaintEvent** (Ap) | `complaintId`, `kind`, `body`, `actorId`, `occurredAt` | cronología demostrable | 7.6 |
| **AutomationRule** | `name`, `triggerType` event/schedule, `eventType?`, `cron?`, `conditions Json`, `actions Json`, `enabled`, `testMode`, `version` | acciones de una lista cerrada: nunca mover dinero ni cambiar permisos | 7.4 |
| **AutomationRun** | `ruleId`, `ruleVersion`, `triggerEventId?`, `testMode`, `status`, `steps Json`, `startedAt`, `finishedAt?` | | 7.4 |
| **ReportDefinition** | `name`, `entityType`, `columns Json`, `filters Json`, `groupBy Json`, `ownerId`, `shared` | usa el registro de entidades | 7.7 |
| **ReportSchedule** | `reportId`, `cron`, `recipients String[]`, `format`, `enabled` | | 7.7 |
| **ReportRun** | `reportId`, `status`, `storedFileId?`, `startedAt`, `finishedAt?` | | 7.7 |
| **AnalyticsEvent** | `anonymousId`, `type` page_view/builder_started/builder_changed/request_submitted/…, `raceId?`, `packageId?`, `occurredAt` | sin datos personales, sin IP; purga a 13 meses | 7.7 |
| **FunnelDailyStat** | `date`, `raceId`, `packageId?`, `views`, `builderStarts`, `requests`, `deposits` | agregado diario | 7.7 |
| **MediaAsset** | `storedFileId`, `alt LocalizedText`, `credit?`, `width`, `height`, `isPlaceholder` | | 1.1 o 8.1 |
| **Guide**, **Page** (SD) | `slug`, `raceId?` (guía), `title LocalizedText`, `body LocalizedText` (bloques), `seo Json`, `status` draft/published/archived, `publishedAt?`, `isLegalProvisional` (páginas legales) | | 8.1 (1.3 usa una guía básica en `Race`) |
| **FaqItem**, **Banner**, **MenuItem** | textos `LocalizedText`, orden, estado, fechas de vigencia | | 8.1 |
| **Redirect** | `fromPath` único, `toPath`, `statusCode` 301/302 | | 8.1 |
| **ApiKey** | `name`, `prefix` único, `secretHash`, `scopes String[]`, `ownerUserId`, `expiresAt?`, `lastUsedAt?`, `revokedAt?` | el secreto se enseña una sola vez | 8.4 |
| **WebhookSubscription** | `url`, `eventTypes String[]`, `secretCiphertext`, `keyVersion`, `enabled`, `consecutiveFailures`, `disabledAt?` | URL validada contra direcciones privadas (SSRF) | 8.4 |
| **WebhookDelivery** | `subscriptionId`, `outboxEventId`, `attempt`, `status`, `responseStatus?`, `durationMs?`, `nextAttemptAt?` | | 8.4 |
| **BackupRun** | `kind` backup/restore_test, `status`, `startedAt`, `finishedAt?`, `location`, `notes` | | 8.6 |
| **SystemErrorEvent** | `occurredAt`, `source`, `message`, `requestId?`, `fingerprint` | sin datos personales; purga a 30 días | 8.6 |

### 5.9 Más adelante (diseñado; no se crea hasta que Oscar lo pida)

| Entidad | Campos principales | Gancho que ya existe |
|---|---|---|
| **Group**, **GroupMember** | `name`, `leaderCustomerId`, `editionId`; miembro con `customerId`, `bookingId` | `Booking.groupId`, `Payment.payerCustomerId` |
| **Partner**, **PartnerCommission** | `kind` club/coach/agent, `code` único, `commissionBps`, `status`; comisión con `bookingId`, `amountMinor`, `currency`, `status` | `Booking.partnerId` |
| **Segment**, **Campaign**, **CampaignRecipient** | definición de segmento en `Json`; campaña con plantilla, estado, fecha; destinatario solo con consentimiento vigente | `ConsentRecord`, `EmailSuppression` |
| **Survey**, **SurveyResponse** | encuesta por edición; respuesta ligada a una reserva `completed`, `moderationStatus` | `Booking.status = completed` |
| Viajes a medida | sin tablas nuevas: `Booking.kind = bespoke`, `Quote.kind = bespoke` y `QuoteLine` | |
| Más monedas y países | sin tablas nuevas: `Setting.salesCountries`, `PriceVersion.currency`, `currency` en cada fila con importe | |

### 5.10 Archivos de esquema

`base.prisma` (generador, datasource, enumerados comunes), `platform-auth.prisma`, `platform-audit.prisma`, `platform-events.prisma`, `platform-files.prisma`, `platform-common.prisma`, `catalogue.prisma`, `pricing.prisma`, `bookings.prisma`, `crm.prisma`, `payments.prisma`, `templates.prisma`, `alerts.prisma`, `suppliers.prisma`, `finance.prisma`, `operations.prisma`, `complaints.prisma`, `content.prisma`, `reporting.prisma`, `automations.prisma`, `integrations.prisma`. Cada tarea crea solo el suyo. Restricciones `CHECK`, disparadores, índices parciales y `EXCLUDE` van en SQL dentro de la migración (Prisma no los expresa), con un comentario en el modelo que lo indique.

---

## 6. Máquinas de estados

Toda transición pasa por un servicio de estados del módulo dueño, con una tabla de transiciones permitidas y una prueba que recorre todos los pares (origen, destino) y comprueba que solo los permitidos pasan. Cada transición escribe auditoría y un evento.

### 6.1 Estado de venta del paquete (1.1)

| Desde | Hacia |
|---|---|
| draft | coming_soon, open |
| coming_soon | open, closed, draft |
| open | waitlist, sold_out, closed |
| waitlist | open, closed |
| sold_out | open, waitlist, closed |
| closed | open |

- `coming_soon` solo admite alertas. `open` admite solicitudes. `waitlist` y `sold_out` admiten lista de espera.
- Un paquete con `isDemo` heredado no puede salir de `draft` salvo con `APP_ENV` `development` o `test`. La API pública filtra `isDemo` siempre que `APP_ENV=production`, y el seed se niega a ejecutarse en producción.
- Pasar a `open` exige al menos una versión de precio publicada y vigente.

### 6.2 Reserva (2.4; se mantienen los estados pedidos)

| Desde | Hacia | Quién o qué |
|---|---|---|
| requested | approved | Oscar; o automático si `instantBooking` y el cupo está retenido |
| requested | declined | Oscar |
| requested | expired | tarea: `requestExpiresAt` vencido sin revisar |
| requested | cancelled | el cliente la retira |
| approved | deposit_paid | evento de pago: depósito cubierto según el libro |
| approved | expired | tarea: `approvalExpiresAt` vencido sin depósito |
| approved | cancelled | cliente u Oscar |
| deposit_paid | confirmed | automático si `autoConfirmOnDeposit`; si no, Oscar |
| deposit_paid | cancelled | cliente u Oscar (política de cancelación) |
| confirmed | balance_paid | evento de pago: total cubierto |
| confirmed | cancelled | |
| balance_paid | confirmed | un cambio (6.3) sube el total y queda importe pendiente |
| balance_paid | completed | tarea: pasada la fecha de salida |
| balance_paid | cancelled | |
| cancelled | refunded | todo lo cobrado ha sido devuelto (neto cobrado = 0) |

- **El cupo se retiene al solicitar** (`InventoryClaim` en estado `held`) y se libera al pasar a `declined`, `expired` o `cancelled`. Por eso la solicitud caduca si nadie la revisa (supuesto 11.4).
- Los estados de cobro (`deposit_paid`, `balance_paid`) **solo** los provoca el módulo de pagos según el libro; ningún endpoint los fija a mano.
- Un pago que llega para una reserva `expired` o `declined` no la reactiva sola: queda marcado para revisión, con tarea para Oscar (reembolsar o reactivar).
- Enviar una solicitud exige sesión de cliente (enlace mágico) y país de residencia en `Setting.salesCountries`; si no, se crea `WaitlistEntry` (2.6).

### 6.3 Otras

- **ProviderAccount:** active ↔ paused; active/paused → retired; retired → archived solo sin pagos, reembolsos ni disputas pendientes. `retired` no acepta cobros nuevos y sí reembolsos, disputas y webhooks. Pasar a `live` exige adaptador `verified`, prueba de conexión correcta y step-up.
- **Payment:** la define 3.1.
- **AlertSubscription:** pending → confirmed → unsubscribed; pending → unsubscribed.
- **Quote:** draft → sent → accepted/expired/withdrawn.
- **Complaint:** received → acknowledged → investigating → resolved → closed.
- **WaitlistEntry:** waiting → offered → converted/expired; waiting → withdrawn.

---

## 7. Casos de fallo y cómo los cubre el diseño

| Caso | Respuesta del diseño | Tarea que lo prueba |
|---|---|---|
| Dos solicitudes por la última plaza a la vez | `UPDATE` condicional del cupo en la transacción y `CHECK`; la segunda falla con 409 | 2.4 |
| Un cupo baja de cero por un ajuste manual | `CHECK (consumed BETWEEN 0 AND capacity)`; reducir capacidad por debajo de lo consumido se rechaza | 1.1 |
| Alguien solicita con el correo de otra persona para retener cupo | la solicitud exige sesión verificada por enlace mágico; límite de peticiones; caducidad de solicitudes | 2.4 |
| El navegador manda un importe | los esquemas de entrada de solicitud y cobro no tienen campo de importe; prueba que un campo extra se rechaza | 2.4, 3.2 |
| Cambia un precio después de una solicitud | la reserva usa su `BookingSnapshot`; nada la recalcula | 2.4 |
| Webhook duplicado | `@@unique([providerAccountId, providerEventId])` y asiento con clave de idempotencia | 3.3 |
| Webhook fuera de orden | el estado del pago solo avanza; se consulta a la pasarela el estado real si hay duda | 3.3 |
| Webhook con firma inválida | se guarda como `signatureValid=false`, no se procesa, responde 400 | 3.3 |
| Reintento de cobro con la misma clave | `IdempotencyRecord` devuelve la misma respuesta; misma clave con otro cuerpo → 422 | 3.2 |
| Reembolsos que superan lo cobrado | comprobación en transacción con bloqueo del pago | 4.5 |
| Pasarela caída en el checkout | el enrutado salta a la siguiente regla; si no queda ninguna, la reserva sigue como solicitud sin cobro | 4.2, 3.5 |
| Pausar la última cuenta de un método o país | el panel avisa antes de confirmar | 4.1 |
| Corrección de un asiento | transacción de reversión que referencia la original; disparador impide `UPDATE` y `DELETE` | 3.2 |
| Fallo a mitad de un cambio con evento | outbox en la misma transacción: o están los dos o ninguno | 0.4 |
| Consumidor procesa dos veces un evento | `EventDelivery` único por consumidor y evento | 0.4 |
| Un hilo envía correo a una persona real | guarda de desarrollo con lista permitida; `MAIL_MODE=live` solo lo pone Oscar | 0.4 |
| Sesión robada | cookie `httpOnly`, revocable, caducidad por inactividad, step-up en acciones sensibles | 0.3 |
| Enumeración de correos | respuesta idéntica al pedir enlace mágico | 0.3 |
| Ruta del panel sin permiso | prueba que recorre todas las rutas | 0.3 |
| Un cliente ve la reserva de otro | todas las consultas del cliente filtran por `customerId` de la sesión; prueba con dos clientes | 5.1 |
| Datos personales en registros | redacción en el logger; eventos sin datos personales | 0.3, 0.4 |
| Borrar un cliente con pagos | se anonimizan `Customer`, `Traveller`, `User`, `OutboundEmail`, `AuditPiiValue`, cuerpos de webhook; se conservan libro, instantáneas y recibos | 5.5 |
| CSV con fórmulas maliciosas (`=`, `+`, `-`, `@`) | se escapan al exportar | 0.5 |
| Importación CSV a medias | se valida entera antes de escribir; se escribe en una transacción o no se escribe | 0.5 |
| Fecha límite en el cambio de día | fechas de calendario y zona del negocio; pruebas en el día exacto de cada tramo | 3.2, 6.4 |
| Desbordamiento de enteros en sumas | sumas en `bigint` con comprobación al convertir | 4.6, 6.6 |
| Migraciones en paralelo que chocan | un archivo de esquema por módulo; regenerar la migración propia encima de `main` | todas |
| Webhook saliente hacia una IP interna | validación de URL y resolución DNS contra rangos privados | 8.4 |
| Automatización que mueve dinero o permisos | la lista de acciones no las incluye; prueba que intentar registrarlas falla | 7.4 |
| API dormida pierde webhooks | requisito de alojamiento siempre encendido; reconciliación diaria como red | 0.7, 4.6, 8.7 |

---

## 8. Pruebas que cada tarea escribe primero

Esta tarea no tiene código. Estas son las pruebas que fijan los invariantes del plan; cada tarea las escribe antes de implementar.

- **0.2:** prueba de convenciones del esquema: ninguna columna `Float` ni `Decimal`; toda columna `*Minor` es `Int` y su modelo tiene `currency`; toda columna `*Bps` es `Int`. CI falla si hay pruebas saltadas.
- **0.3:** 403 para un rol sin permiso; todas las rutas del panel declaran permiso; auditoría con valor anterior y nuevo; campo `@pii` va a `AuditPiiValue`; disparador impide modificar `AuditLog`; enlace mágico de un solo uso y caducado; respuesta idéntica para correo inexistente; sesión de cliente no accede al panel aunque el correo coincida; e2e de entrada con contraseña y TOTP.
- **0.4:** transacción deshecha no deja evento; evento entregado dos veces se procesa una; consumidor con flag apagado marca `skipped`; guarda de correo rechaza destinatario fuera de la lista; batería de contrato de `FileStorage`.
- **0.5:** borrado lógico oculta y restaura; vista guardada por usuario; CSV exportado escapa fórmulas; importación con un error no escribe nada; acción en lote respeta el permiso de cada elemento.
- **1.1:** transiciones de estado de venta; cupo no baja de cero; paquete en `draft` no sale por la API pública; demo no pasa a `open` en producción.
- **2.1/2.2:** tabla de ocupación 1 a 4, noches extra, acompañantes, códigos, combinaciones de reglas, fechas límite y regla de redondeo.
- **2.4:** dos solicitudes concurrentes por la última plaza; transición no permitida rechazada; cambio de precio no altera la instantánea; importe del cliente ignorado.
- **3.2/3.3/3.6:** asiento duplicado imposible; suma por reserva = cobrado − reembolsado; idempotencia; webhooks duplicados, fuera de orden y con firma mala.
- **5.5:** todo modelo con `@pii` tiene manejador de privacidad; borrado conserva el libro.

---

## 9. Decisiones que tomo distinto de lo pedido

Cada una con su motivo y cómo deshacerla. Ninguna cambia lo que Oscar pidió que el producto haga; cambian cómo se modela.

1. **Tipo de viajero por persona, no tipo de paquete.** Lo pedido: `Package.type` = `with_entry`, `own_entry` o `supporter`. Problema: una pareja (corredor con dorsal + acompañante) que comparte habitación tendría que reservar dos paquetes distintos que comparten una habitación, y el precio por ocupación deja de funcionar. Propuesta: un paquete admite uno o varios tipos de participación (`PackageParticipationOption`) y cada viajero de la reserva tiene el suyo, con su componente de precio (`ParticipationRate`). Un paquete "solo con dorsal" es un paquete con solo esa opción activada. Deshacer: limitar cada paquete a una sola opción.
2. **Cupos unificados en `InventoryPool`.** Dorsales, habitaciones y extras con cupo usan la misma tabla con `CHECK` y movimientos. Los `Allotment` de proveedor (6.1) alimentan esos mismos cupos, así la fase 6 no cambia el catálogo. Deshacer: columnas de cupo en cada entidad.
3. **Dorsales por distancia.** Una carrera con maratón y media tiene cupos distintos; `PackageEntryOption` une paquete, distancia y cupo.
4. **Instantáneas sin datos personales y auditoría con tabla aparte para ellos.** Así el libro, las instantáneas y el registro de auditoría pueden ser inmutables de verdad y a la vez cumplir el borrado de un cliente.
5. **Personal y clientes como identidades separadas** (`User.kind`), personal con TOTP obligatorio y sin recuperación por correo. Reduce la superficie de ataque del panel.
6. **Solicitar exige sesión de cliente.** Como el cupo se retiene al solicitar, una solicitud anónima permitiría bloquear plazas con correos ajenos. El constructor guarda su estado en la URL, así el enlace mágico devuelve al cliente al mismo punto. Deshacer: permitir solicitud anónima con verificación posterior y retención corta.
7. **Ninguna columna `Float` ni `Decimal`, ni siquiera para tipos de cambio o coordenadas.** Una regla comprobable vale más que una regla con excepciones.
8. **Estado de cobro derivado del libro**, además de los estados pedidos. Se añade una transición `balance_paid → confirmed` cuando un cambio sube el total. Sin ella, una reserva pagada que se amplía quedaría "pagada" debiendo dinero.
9. **El estado del adaptador vive en código**, no en la base de datos, para que nadie pueda marcarlo `verified` desde el panel.
10. **Fase 9: no escribir treinta adaptadores a ciegas.** Recomiendo que la fase 9 cree fichas `planned` para todo el catálogo y adaptadores solo para las pasarelas que Oscar vaya a pedir, empezando por las que den sandbox sin trámite. Un adaptador `experimental` sin sandbox es mantenimiento sin uso. No cambio el archivo de fase: lo dejo para la revisión de Oscar.
11. **Sin Redis**, coherente con `docs/architecture.md`.

---

## 10. Riesgos del plan de fases y cambios en la tabla de dependencias

### 10.1 Cambios que aplico en `docs/autonomous.md`

| Tarea | Antes | Ahora | Motivo |
|---|---|---|---|
| 0.3 | 0.2 | 0.2, **0.4** | El enlace mágico necesita la interfaz de correo y la guarda de desarrollo de 0.4. Sin ella, 0.3 inventaría su propio envío. |
| 2.5 | 2.4, 0.5 | 2.4, **2.3**, 0.5 | La prueba de extremo a extremo de la fase 2 (buscar, configurar, solicitar, gestionar) solo se puede escribir cuando existen constructor, solicitud y bandeja; la asigno a 2.5. |
| 5.1 | 3.5 | 3.5, **4.6**, **5.4** | El área del cliente descarga recibos (4.6) y documentos PDF (5.4). |
| 7.3 | 1.2, 0.4 | 1.2, 0.4, **3.2**, **6.1** | Las fechas clave incluyen vencimiento de saldos (plan de pagos, 3.2) y liberación de cupos contratados (6.1). |
| 8.5 | fases 0 a 7 cerradas, 8.4 | fases 0 a 7 cerradas, **8.1, 8.2, 8.3**, 8.4, **8.6** | Una revisión de seguridad de todo el producto debe incluir el gestor de contenido, el monitor y el modo mantenimiento. |

Comprobado: con estos cambios la tabla no tiene ciclos y todas las tareas de los archivos de fase siguen presentes.

### 10.2 Riesgos que no cambian la tabla

- **Sin claves de Stripe, la prueba e2e "pagar con la tarjeta de prueba de Stripe" no se puede ejecutar.** Y CI falla si hay pruebas saltadas. Propuesta para 3.3 y 3.6: la batería contra el sandbox real es un comando aparte (`test:sandbox`), no incluido en la batería por defecto ni saltado en ella; la e2e por defecto paga contra el simulador. El adaptador de Stripe queda `experimental` hasta que Oscar ponga las claves y se ejecute `test:sandbox`.
- **0.3 y 0.5 son grandes** para una sola tarea. Si el plan de cualquiera supera lo razonable, que lo divida en sub-PR dentro de la misma tarea, no en tareas nuevas.
- **Recibos (4.6) antes de plantillas (5.4):** 4.6 entrega los datos del recibo, la numeración y la regla del GST con pruebas, y una representación mínima; el PDF con plantilla editable llega en 5.4 y lo conecta 5.1.
- **El cupo se retiene al solicitar**: si Oscar tarda en revisar, las plazas quedan bloqueadas. Mitigado con caducidad configurable y recordatorio.
- **Alojamiento:** pg-boss y los webhooks exigen una API siempre encendida. Un plan gratuito que duerme la API no sirve para producción. Lo debe recoger 0.7 y lo usará 8.7.
- **Playwright** puede no descargarse en el entorno de un hilo: las e2e se validan en CI (ya previsto).
- **Migraciones en paralelo**: cada tarea toca solo su archivo de esquema; si `main` trae una migración nueva, se regenera la propia encima.
- **Fase 5 antes que la 6**: las cancelaciones con penalización llegan en 6.4. Hasta entonces, cancelar una reserva pagada lo hace Oscar a mano con reembolso de 4.5. Se debe anotar en el ensayo general (5.7).

---

## 11. Supuestos (las preguntas que haría a Oscar)

Cada uno es la opción más conservadora y fácil de cambiar; casi todos son un `Setting`.

1. Zona horaria del negocio: `Australia/Brisbane`.
2. Moneda única por paquete: AUD.
3. Depósito: lo fija cada paquete (por persona, por reserva o porcentaje). Sin valor por defecto: un paquete sin depósito no puede pasar a `open`.
4. Una solicitud sin revisar caduca a los 7 días (recordatorio a Oscar a los 3). Una aprobación sin depósito caduca a las 72 horas. Ambos ajustables.
5. Un "viaje" es un paquete.
6. Un cliente por correo. Los viajeros pertenecen al cliente que reserva y se pueden reutilizar.
7. Los acompañantes y los corredores con dorsal propio no consumen dorsales.
8. Todas las personas de una habitación pagan la tarifa de esa ocupación; no hay tarifa infantil.
9. GST desactivado al empezar; los recibos no dicen "tax invoice".
10. Países de venta: solo `AU`.
11. Recibos con numeración secuencial `MT-R-000001`.
12. Retención de registros económicos: 7 años (la ATO pide 5; retener de más se puede corregir, borrar de más no). Cuerpos crudos de webhooks: 180 días. Eventos de analítica: 13 meses.
13. Se guardan IP y navegador al aceptar condiciones, como prueba ante disputas.
14. Sesiones: personal 12 h (2 h de inactividad); cliente 30 días (7 de inactividad). Enlace mágico: 15 minutos.
15. El primer usuario `owner` se crea por consola con el correo que Oscar ponga en una variable de entorno.
16. Una reserva confirmada solo pasa a `completed` tras la fecha de salida del paquete.

---

## 12. Lo que este plan no hace

- No escribe código, migraciones ni configuración.
- No elige pasarela de pagos ni orquestador (0.7 y 3.1), ni alojamiento (0.7 y 8.7).
- No fija la semántica exacta de reglas de precio, posting del libro ni estados de `Payment`: son de 2.2 y 3.1, dentro de los invariantes de aquí.
- No cambia los archivos de fase ni los criterios de aceptación; solo la tabla de dependencias de `docs/autonomous.md`.
- No crea tablas de los módulos "más adelante".
