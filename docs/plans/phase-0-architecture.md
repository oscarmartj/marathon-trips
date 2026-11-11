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

- Todo importe es un entero en unidades menores, en una columna con sufijo `Minor` (`totalMinor`, `amountMinor`), tipo `BigInt` de Prisma (`bigint` de PostgreSQL) **desde la primera migración**. Motivo: con `integer` (máximo 2 147 483 647) no caben importes de otras monedas (45 000 000 IDR con los 2 decimales de ISO 4217 son 4 500 000 000 unidades menores).
- **Toda fila que tiene una columna `*Minor` tiene su propia columna de moneda** (`Char(3)`, ISO 4217). Regla de emparejado: `fooMinor` usa `fooCurrency` si existe, y si no `currency` (por ejemplo `baseAmountMinor` usa `baseCurrency`). La prueba de convenciones (0.2) rechaza un `*Minor` sin su moneda emparejada. **Importe opcional, moneda obligatoria:** si una fila tiene algún `*Minor` no nulo, su moneda no es nula, y si todos son nulos, la moneda tampoco (`CHECK`); así una regla "−5000 fijo" no puede quedar sin moneda.
- **La moneda de una fila hija no puede diferir de la de su padre.** Se impone con clave ajena compuesta `(parentId, currency)` hacia `@@unique([id, currency])` del padre: `RoomRate`, `ParticipationRate`, `ExtraRate` → `PriceVersion`; `PriceVersion` → `Package`; `PaymentSchedule` → `Booking`; `PaymentScheduleItem` → `PaymentSchedule`; `Payment` y `PaymentAllocation` → `Booking` y `PaymentScheduleItem`; `Refund`, `Dispute` y `Receipt` → `Payment`; `Cancellation` y `BookingAmendment` → `Booking`; `QuoteLine` → `Quote`; `SupplierPaymentItem` → `SupplierPayment` y `CostItem`; `LedgerEntry` → `LedgerAccount`. Donde no hay padre natural (por ejemplo `CostItem`), la moneda es libre y cualquier suma agrupa por moneda. El motor de precios rechaza entradas con monedas distintas.
- En la API, los importes son `bigint` de JavaScript en todo el cálculo (nunca `number`). **En JSON viajan como cadena de dígitos** (`"123450"`), porque `bigint` no se serializa y un `number` pierde precisión por encima de 2⁵³. La API sigue rechazando importes absurdos (por encima de A$1 000 000 por línea, o su equivalente fijado por moneda en `Setting`), pero eso es validación de negocio, no un límite del tipo.
- **Signo de cada importe.** Por defecto, `CHECK (x >= 0)`; en importes de movimientos (`Payment`, `Refund`, `Dispute`, `SupplierPayment`, `SupplierPaymentItem`, `Receipt`), `> 0`. Solo admiten signo las columnas marcadas `/// @signed`: `LedgerEntry.amountMinor` (además `<> 0`), `PaymentAllocation.amountMinor` y `BookingAmendment.priceDifferenceMinor`. La prueba de convenciones (0.2) exige un `CHECK` de signo en todo `*Minor` no marcado.
- Porcentajes en **puntos básicos** enteros, columnas con sufijo `Bps` (1000 = 10 %).
- Tipos de cambio (solo para costes de proveedor en otra moneda y finanzas): entero escalado `rateE9 BigInt` (tipo × 10⁹). No es dinero, pero así **el esquema no tiene ni una columna `Float` ni `Decimal`**, y eso se puede comprobar con una prueba.
- Coordenadas geográficas, si se guardan, como `latitudeE7 Int` y `longitudeE7 Int` (grados × 10⁷), por la misma regla.
- Regla de redondeo (la fija y prueba 2.1, este plan la propone): las reglas porcentuales se calculan en aritmética entera sobre puntos básicos y se redondean **a la unidad menor, mitad hacia arriba sobre el valor absoluto, línea a línea**; el total es la suma de líneas ya redondeadas. Nunca se redondea el total por separado.
- En TypeScript, el tipo compartido es `Money = { amountMinor: bigint; currency: CurrencyCode }`; en los esquemas zod compartidos por API, `packages/shared` y web, `amountMinor` es `z.string().regex(/^-?\d+$/)` transformado a `bigint`, y la salida lo serializa como cadena. La web nunca hace aritmética con importes: los formatea. `packages/shared` solo tiene utilidades para **formatear** dinero, nunca para calcular totales.

### 1.2 Identificadores, tiempo y concurrencia

- Clave primaria: UUID v7 (`String @id @default(uuid(7)) @db.Uuid`; si la versión de Prisma no lo admite, `uuid()` v4). Se ordena por tiempo y no revela volumen.
- Referencias legibles para personas, únicas y no secuenciales: reserva `MT-7K3Q9P` (Crockford base32, 6 caracteres), reclamación `CMP-…`. Los recibos sí son secuenciales (`NumberSequence`), porque un registro contable lo espera.
- Instantes en `timestamptz(3)`, siempre en UTC. **Fechas de calendario** (fecha de carrera, entrada y salida del hotel, fecha límite del saldo) en `@db.Date`, sin hora.
- Zona horaria del negocio: `Australia/Brisbane` (sin horario de verano), guardada en `Setting.businessTimeZone`. "Días antes de la salida" = días de calendario entre la fecha de hoy en esa zona y `Package.checkInDate`. Un plazo "vence el día X" vence al final del día X en esa zona.
- Bloqueo optimista: los agregados editables desde el panel tienen `version Int @default(0)`; el panel envía la versión que leyó y la API responde 409 si ha cambiado.
- Cupos y contadores (plazas, usos de un código) se modifican con `UPDATE … SET consumed = consumed + n WHERE id = $1 AND consumed + n <= capacity` dentro de la transacción, con restricción `CHECK (consumed BETWEEN 0 AND capacity)` como red de seguridad.
- **Todo cambio de estado o contador es compare-and-set** (`WHERE status = $from`, `WHERE consumed + n <= capacity`) o va tras `SELECT … FOR UPDATE` de la fila dueña. **Orden de bloqueo fijo** para no crear interbloqueos: `Booking` → `Payment` → `Refund`/`Dispute` → cuentas del libro; nunca al revés.
- **Unicidad con columnas que admiten NULL.** Si NULL significa "ninguno" (plazo de una asignación de sobrepago), el índice se crea con `NULLS NOT DISTINCT` (PostgreSQL 15+). Si NULL significa "aún no se sabe" (referencia de la pasarela antes de su respuesta), el índice deja NULL libres y un `CHECK` exige el valor en cuanto el estado lo necesita.

### 1.3 Columnas comunes

| Columna | Dónde | Para qué |
|---|---|---|
| `createdAt`, `updatedAt` | todas | |
| `version` | agregados editables en el panel | bloqueo optimista |
| `deletedAt`, `deletedById` | entidades con borrado lógico (marcadas **SD** en la sección 5) | borrado lógico y restauración (0.5) |
| `customFields Json @default("{}")` | Race, Package, Customer, Traveller, Booking, Supplier (marcadas **CF**) | campos personalizados (7.5), con índice GIN |
| `isDemo Boolean @default(false)` | raíces de datos de ejemplo: Race, Hotel, Customer, Booking, Supplier | datos demo imposibles de publicar (1.5) |
| `/// @pii` o `/// @nopii <motivo>` | comentario de Prisma obligatorio en **toda** columna `String`, `String[]`, `Json` o `Bytes` de un modelo ligado al cliente (salvo claves, `@db.Uuid` y `Char(n)`); `customFields` y todo texto libre son siempre `@pii` | registro de datos personales y prueba de barrido (sección 4.9) |

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
- **`docker-compose`**: servicios `db` (PostgreSQL), `mail` (Mailpit), `api` y `web`. `docker compose up` aplica migraciones, ejecuta el seed de demo y deja la API y la web funcionando (criterio de la fase 0). Seed de demo por capas: 0.2 deja el comando `db:seed` (idempotente, se niega con `APP_ENV=production`) y el arranque de los cuatro servicios; 0.3 añade el usuario de personal demo (correo `owner@example.test`, contraseña y TOTP de desarrollo impresos en consola, solo con `APP_ENV=development`); 0.5 añade filas demo de la tabla de ejemplo; 1.5 añade el catálogo demo. **No hay Redis** en el stack: tareas, límites de peticiones y caché van sobre PostgreSQL o en memoria (una sola instancia de API). La mención a Redis en `docs/autonomous.md` es solo una ayuda del entorno; ninguna tarea debe añadir Redis.
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

**Feature flag por módulo.** Los módulos `catalogue`, `pricing`, `bookings` y `payments` **no tienen flag**: no se pueden apagar, y los webhooks entrantes de pasarelas siempre se reciben (una cuenta pausada o retirada sigue procesándolos). El resto de módulos tiene flag. Si el flag está apagado: sus rutas responden 404 y sus tareas programadas no se ejecutan. Para los eventos, cada consumidor declara `whenDisabled`:

- `hold`: el evento queda `pending` y se procesa al encender el módulo. **Obligatorio para todo consumidor de eventos `payments.*`, `bookings.*` y `changes.*`** (dinero y estados de reserva); una prueba de 0.4 recorre los consumidores registrados y falla si alguno de esos eventos tiene `skip`.
- `skip`: el evento se marca `skipped` (para índices, analítica, correos informativos); si el módulo necesita el pasado, lo reconstruye desde las tablas.
- Además, un consumidor **de solo aviso** (correo, webhook saliente) declara `maxEventAge` (por defecto 48 h): al procesar un evento más viejo, aunque sea de `bookings.*` y esté en `hold`, lo marca `skipped` sin avisar. Los que cambian estado o dinero no pueden declararlo.

El flag se lee en cada petición, sin reiniciar.

**Añadir un módulo** = crear la carpeta, su archivo `.prisma` y una línea en `modules.registry.ts`. No se modifica ningún módulo existente.

### 3.2 Mapa de módulos, nivel, tarea que lo crea y eventos principales

| Módulo | Nivel | Tarea | Publica (ejemplos) | Escucha (ejemplos) |
|---|---|---|---|---|
| platform (events, jobs, storage, mail, tablas y lectura de flags y ajustes) | base | 0.4 | — | — |
| platform (auth, access, audit, administración de flags y ajustes) | base | 0.3 | `auth.user.loggedIn`, `access.role.changed` | — |
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

- API REST con OpenAPI; cada ruta del panel tiene permiso; cada ruta del cliente declara con un decorador (`@OwnedBy(...)`) cómo comprueba que el recurso es suyo, y una prueba (0.3) recorre todas las rutas del área del cliente y falla si alguna no lo declara.
- Sesión en cookie `httpOnly`, `Secure` (salvo en local), `SameSite=Lax`. La web y la API deben estar en el **mismo sitio** (mismo dominio registrable, o la web hace de proxy de `/api`): 8.7 lo concreta.
- CSRF: comprobación de `Origin` más cabecera propia obligatoria en toda petición que cambia datos. Los webhooks entrantes de pasarelas quedan fuera (los protege la firma).
- Límites de peticiones en memoria (`@nestjs/throttler`), más estrictos en inicio de sesión, enlace mágico, solicitud de reserva y suscripción a alertas.
- Logger estructurado con redacción por rutas (cookies, `authorization`, cuerpos de auth y pagos, campos `@pii`). Nunca se registra el cuerpo de una petición de pagos ni de autenticación.
- CORS restringido al origen de la web.

### 4.2 Autenticación (0.3)

- **Dos tipos de usuario separados**: `User.kind = staff | customer`, con `@@unique([kind, email])`. Una sesión de cliente nunca puede convertirse en sesión de personal, aunque el correo coincida.
- **Clientes:** enlace mágico de un solo uso, 15 minutos, token aleatorio de 32 bytes guardado como hash. La respuesta a "envíame un enlace" es idéntica exista o no el correo. El usuario `customer` se crea al verificar el enlace.
- **Personal:** contraseña con argon2id más TOTP obligatorio para todo el personal. Tras intentos fallidos, **retraso progresivo** por cuenta y por IP (sin bloqueo definitivo, para que un atacante no pueda dejar fuera al único `owner`). Códigos de recuperación guardados como hash. **Sin recuperación por correo para el personal**: el primer propietario se crea y se recupera con un comando de consola (`pnpm api:cli staff:create`, `staff:reset`), que exige acceso al servidor.
- **Step-up:** `Session.mfaVerifiedAt`; las acciones sensibles exigen TOTP en los últimos 5 minutos y quedan auditadas: credenciales y cuentas de pasarela, reglas de enrutado, **instrucciones de los métodos manuales** (`PaymentMethodConfig.instructions`: PayID, BSB y cuenta), **confirmar un pago manual**, reembolsos, roles y permisos, claves de API, suscripciones de webhooks salientes y exportar todos los datos. La lista vive en código (decorador `@StepUp`); sin `mfaVerifiedAt` reciente se deniega.
- Sesiones opacas en base de datos (token como hash), revocables. Duraciones por defecto: personal, 12 h absolutas y 2 h de inactividad; cliente, 30 días absolutos y 7 días de inactividad.
- Librería: 0.3 evalúa primero una librería mantenida (por ejemplo Better Auth) contra estos requisitos (separación de tipos, step-up, tokens con hash, nombres de tabla de este plan). Si no los cumple sin parches, implementación propia fina sobre primitivas probadas (`@node-rs/argon2` o `argon2`, `otpauth`). Lo anota en su `done`.

### 4.3 Permisos (0.3)

- `Permission` lo declaran los módulos en código y se sincroniza al arrancar; `Role` y `RolePermission` se editan en el panel (matriz).
- Roles de sistema: `owner` (todos los permisos, no editable, no se puede quedar sin ningún usuario: quitar el rol o desactivar a un `owner` bloquea antes la fila del rol `owner` con `FOR UPDATE` y cuenta los que quedan, para que dos `owner` no se quiten el rol a la vez) y `customer` (implícito: solo sus propios recursos, comprobado por propiedad, no por matriz).
- `UserRole.scope Json?`: ámbito opcional (por ejemplo `{ "editionIds": [...] }`) para dar a un guía acceso solo a su viaje. **Falla en cerrado:** 0.3 crea la columna con `CHECK (scope IS NULL)`, la API rechaza asignar un ámbito (422) y la guarda de permisos trata cualquier ámbito no nulo como "denegar". La tarea que implemente el filtrado quita el `CHECK` en su migración, con sus pruebas.
- Cada ruta del panel declara su permiso con un decorador. Una prueba recorre todas las rutas registradas y falla si alguna ruta del panel no tiene permiso declarado.
- Claves de API (8.4): los permisos efectivos de un `ApiKey` se calculan **en cada petición** como `scopes ∩ permisos actuales del dueño`. Si el dueño pierde un permiso, la clave lo pierde; si el dueño está desactivado o borrado, la clave es inválida.

### 4.4 Auditoría (0.3)

- `AuditLog` se escribe **en la misma transacción** que el cambio, desde un servicio de plataforma (no por evento, para no perder ninguno).
- Se audita: toda acción del personal, de una automatización o de una clave de API; todo cambio de estado, precio, cupo, pago, permiso, credencial y ajuste; inicios de sesión y fallos.
- `changes` guarda `{ campo: { before, after } }` **solo para campos `@nopii`**. Todo campo `@pii` (incluidos `customFields` y cualquier texto libre como `Refund.reason`) y **el motivo que escribe el personal** van a `AuditPiiValue` (tabla aparte, el motivo como campo `_reason`), y en `changes` queda la marca `"[pii]"`. `AuditLog` no tiene ninguna columna de texto libre ni IP: guarda `sessionId?`, y la IP truncada está en `Session` (que se purga). `actorId`, `sessionId` y `entityId` son UUID **sin clave ajena**, para que borrar una sesión o un usuario nunca exija tocar el registro. Así el registro principal es inmutable de verdad y el borrado de un cliente elimina sus valores sin tocarlo.
- `AuditPiiValue.subjectCustomerId` lo rellena el servicio de auditoría desde el `customerLink` del registro de entidades (sección 4.9); si la entidad no está ligada a un cliente, queda NULL y la fila se purga a los 7 años.
- Las credenciales y secretos nunca se auditan con su valor: solo "cambiado".
- `AuditLog` no se edita: un disparador rechaza `UPDATE`, `DELETE` y `TRUNCATE` **sin excepciones**. `AuditPiiValue` solo admite `DELETE` dentro de `privacy_erase_customer` y de la purga por retención.
- El "historial de cambios por registro" (0.5) es una consulta sobre `AuditLog` por `entityType` y `entityId`; no hay otra tabla de historial.

### 4.5 Eventos y tareas (0.4)

- **Outbox:** el módulo escribe el `OutboxEvent` en la misma transacción que su cambio. Si la transacción se deshace, no hay evento.
- **Despachador:** tarea recurrente que toma eventos pendientes con `FOR UPDATE SKIP LOCKED`, crea un trabajo de pg-boss por cada consumidor suscrito (con clave única `consumer:eventId`) y marca el evento como despachado.
- **Consumidores:** entrega al menos una vez; cada consumidor es idempotente gracias a `EventDelivery` (`@@unique([eventId, consumer])`). Reintentos con espera creciente; tras el máximo, `failed` y visible en el monitor. `lastError` guarda código y mensaje redactado, como pg-boss.
- Las cargas de los eventos llevan identificadores, no datos personales.
- Orden: no se garantiza entre agregados. Dentro de un agregado, el consumidor compara `aggregateVersion` y descarta lo antiguo cuando importa.
- Retención: eventos despachados y entregas correctas se purgan a los 90 días (no son el registro de auditoría).
- **Feature flags y ajustes:** 0.4 crea `FeatureFlag` y `Setting` y el servicio de lectura (los necesitan los consumidores de eventos); 0.3 añade la administración desde el panel, con permisos y auditoría.
- **pg-boss** en su propio esquema (`pgboss`) de la misma base de datos, para tareas puntuales y programadas (cron). Requiere un proceso de API siempre encendido: condición para el alojamiento (sección 10).
  - **El esquema lo crean las migraciones como `mt_owner`**, no pg-boss al arrancar: se desactivan su creación y migración automáticas (0.4 fija los nombres exactos de las opciones en la versión elegida) y su SQL de construcción y migración se guarda como migración del repositorio. Si la versión elegida necesita DDL en ejecución (por ejemplo, crear una cola crea una partición), las colas que declaran los módulos se crean en el mismo paso de migraciones, y la API al arrancar solo comprueba que existen y no arranca si falta alguna. `mt_app` recibe `SELECT/INSERT/UPDATE/DELETE` en las tablas de `pgboss` y `EXECUTE` en sus funciones, nada más.
  - Los datos de un trabajo llevan identificadores, nunca datos personales ni importes calculados; el error guardado es un código y un mensaje pasado por el mismo redactor del logger. Trabajos terminados se borran a los 7 días.

### 4.6 Archivos y correo (0.4)

- `FileStorage`: `put`, `get`, `delete`, `signedUrl`. 0.4 entrega solo la interfaz y sus adaptadores, sin rutas HTTP. Los archivos privados (documentos, adjuntos) los sirve el módulo dueño a través de la API con permiso (0.5 en adelante), o con URL firmada de corta duración.
- `MailSender`: `send(message)`. Adaptador SMTP (Mailpit en local). Todo envío pasa por `OutboundEmail` (registro y cola), con `dedupeKey` único derivado del hecho que lo provoca (`booking:<id>:approved`), para que un consumidor reintentado no envíe dos veces.
- **Guarda de desarrollo:** salvo `MAIL_MODE=live` **y** `APP_ENV=production` a la vez (solo lo pone Oscar al desplegar; con cualquier otro `APP_ENV`, `MAIL_MODE=live` se ignora y se avisa al arrancar), la plataforma **rechaza enviar** a destinatarios fuera de la lista `MAIL_DEV_ALLOWLIST` (por defecto, dominios `example.test` y `example.com`) y lo registra como `suppressed`. Así ninguna tarea ni ninguna copia de producción en staging puede escribir a una persona real. Un valor desconocido de `MAIL_MODE` cuenta como "no live".
- Supresiones: bajas en un clic y rebotes en `EmailSuppression`, que guarda solo un HMAC del correo (no el correo), así sobrevive al borrado de un cliente sin conservar su dato. Los correos de marketing la consultan siempre, los transaccionales no.

### 4.7 Secretos en reposo

- AES-256-GCM con clave maestra en variable de entorno (`APP_ENCRYPTION_KEY`), con `keyVersion` en cada fila cifrada para poder rotarla.
- Se cifran: credenciales y secretos de webhook de pasarelas, secreto TOTP, secretos de webhooks salientes.
- La API nunca devuelve un valor cifrado; los DTO de salida no tienen esos campos (prueba de serialización).

### 4.8 Ajustes y flags

- `FeatureFlag`: interruptores booleanos (módulos y funciones). Tablas y lectura en 0.4; administración en 0.3. Un flag que no existe o no se puede leer cuenta como apagado (los módulos de dinero no tienen flag, sección 3.1).
- `Setting`: ajustes del negocio con valor tipado y validado: `businessTimeZone`, `salesCountries` (`["AU"]`), `gstRegistered` (`false`), `defaultCurrency` (`AUD`), plazos de caducidad de solicitudes y aprobaciones, `maintenanceMode`, retenciones. Abrir otro país es cambiar `salesCountries`.
- `APP_ENV` (`development`, `test`, `staging`, `production`) es **obligatorio y sin valor por defecto**: la API no arranca si falta o tiene otro valor.
- **Guarda de producción para toda llamada externa.** Con `APP_ENV` distinto de `production`:
  - **Pasarelas:** ningún adaptador hace una llamada con una cuenta `live`, sea cual sea la operación (cobro, reembolso, cancelación, consulta de estado, conciliación, pruebas de conexión, evidencias de disputas). Se impone en un único envoltorio `ProviderGateway` por el que pasan todas las llamadas de adaptadores, y además el servicio de cifrado **no descifra** credenciales de cuentas `live` fuera de producción. La operación falla con `live_call_blocked_outside_production`, se audita y no cambia estados ni libro. Esto cubre una copia de producción restaurada en staging (8.6) aunque comparta `APP_ENCRYPTION_KEY`.
  - **Webhooks salientes** (8.4): igual que el correo, solo a URL de `WEBHOOK_DEV_ALLOWLIST` (vacía por defecto); el resto se registra como `suppressed`.
  - **Automatizaciones** (7.4): solo actúan a través de correo, webhooks y tareas, así que heredan las dos guardas.

### 4.9 Datos personales

- **Anotación obligatoria.** Toda columna `String`, `String[]`, `Json` o `Bytes` de un modelo ligado al cliente lleva `/// @pii` o `/// @nopii <motivo>` (sección 1.3); la prueba de convenciones falla si falta. **Todo texto libre (motivos, notas, descripciones, `customFields`) es `@pii`**, sin excepción. Un `@nopii` en un `Json` solo vale si su esquema zod no admite texto libre (solo identificadores, códigos, números y fechas). Un script genera el registro de campos personales que usan el logger, la auditoría y la privacidad.
- **Registro de entidades con `customerLink`.** Cada modelo ligado a un cliente declara en el registro de entidades (`platform/entities`) la ruta hasta `customerId` (por ejemplo `Refund → Payment → Booking → customerId`) y su manejador `export` y `anonymise`. Una prueba (5.5) recorre el grafo de relaciones de Prisma (DMMF) y falla si un modelo con camino hasta `Customer`, `Traveller`, `Booking`, `Quote` o `Complaint` no está registrado, o si un modelo con `@pii` no tiene manejador. **La lista de borrado sale de ese registro, no de una tabla escrita a mano.**
- **Sin texto libre en tablas inmutables ni en lo que no se borra:** asientos del libro (`LedgerTransaction.description` se genera desde un código y referencias), `PaymentAllocation`, `InventoryMovement` (sin nota: el motivo de un ajuste va con su auditoría), `AuditLog` (sección 4.4), instantáneas de reserva (viajeros como "plaza 1, corredor con dorsal"; las líneas de un viaje a medida guardan `quoteLineId` y código, no la descripción), eventos del outbox, trabajos de pg-boss, enlaces de pago, `AutomationRun.steps` (acción, estado, entidad y código de error), `CsvJob.errors` (fila, columna y código, nunca el valor), `KeyDate.title` (generado desde un código), `Dispute.reasonCode` (código de la pasarela).
- **Roles de base de datos (0.2 los crea, 0.3 añade los disparadores).** Tres roles: `mt_owner` es dueño de todas las tablas y esquemas (incluido `pgboss`, sección 4.5) y solo lo usan las migraciones; `mt_app` es el único que usa la API en ejecución, con `SELECT`, `INSERT`, `UPDATE` y `DELETE` concedidos tabla a tabla, **sin `CREATE` en ningún esquema ni en la base de datos, sin `TEMPORARY`** y sin ser dueño de nada, así que no puede crear objetos, desactivar disparadores, alterar tablas ni hacer `TRUNCATE`; `mt_privacy` es un rol `NOLOGIN`, dueño de las funciones `privacy_erase_customer(customerId)` y `privacy_purge_expired()`, declaradas `SECURITY DEFINER` con **`SET search_path = pg_catalog, public, pg_temp`** y todos los objetos cualificados con su esquema; `EXECUTE` revocado a `PUBLIC` y concedido solo a `mt_app`. `docker-compose` y las pruebas crean los tres; el alojamiento debe admitir varios roles (lo anota 8.7).
- **Tablas inmutables.** Un disparador rechaza `UPDATE` y `DELETE` por fila y `TRUNCATE` por sentencia en `AuditLog`, `BookingSnapshot`, `LedgerTransaction`, `LedgerEntry`, `PaymentAllocation` e `InventoryMovement`, **sin ninguna excepción** (no tienen datos personales). Una tabla inmutable solo tiene claves ajenas hacia filas que nunca se borran físicamente (reservas, pagos, clientes anonimizados); a actores, sesiones y usuarios apunta con UUID sin FK. Solo las cuatro inmutables que sí los tienen admiten una excepción, `current_user = 'mt_privacy'`, que solo se da dentro de esas dos funciones: `mt_app` puede ejecutarlas, pero no fijar ese usuario de otra forma; las funciones solo aplican las operaciones de esta tabla, quedan auditadas y no reciben columnas ni SQL como parámetro. **No se usa una variable de sesión** como salida de emergencia: `mt_app` podría fijarla.

| Tabla | Qué se conserva y por qué | Qué hace el borrado |
|---|---|---|
| `AuditPiiValue` | — | `DELETE` de las filas del cliente; las que no son de ningún cliente, a los 7 años |
| `TermsAcceptance` | fila con `customerId`, versión y fecha: prueba del contrato ante disputas y reclamaciones (obligación contractual y defensa legal, 7 años) | `ipAddress` y `userAgent` a `NULL` |
| `ConsentRecord` | fila con hash del correo, finalidad, fecha y texto: prueba de consentimiento y de baja (Spam Act 2003) | `email` a `NULL`; queda `emailHash` |
| `ComplaintEvent` | fila, tipo y fecha: procedimiento de reclamaciones demostrable (7 años) | `body` se sustituye por `[redacted]` |

- **Qué hace el borrado de un cliente (5.5).** Regla general: en cada modelo registrado con `customerLink`, las columnas `@pii` se anonimizan (`[redacted]`, `{}` en `customFields`, NULL si admite NULL) y las filas sin valor propio se borran (`Session`, `LoginToken`, `AlertSubscription`, `WaitlistEntry`, `AuditPiiValue`, adjuntos y sus archivos). Además:

| Dónde | Qué hace |
|---|---|
| `SearchDocument` | reindexa desde los datos ya anonimizados; borra los de entidades borradas |
| `WebhookEvent` | vacía `rawBody` de los eventos de sus pagos, reembolsos y disputas |
| `GeneratedDocument` + `StoredFile` | borra confirmaciones, itinerarios y bonos. **Conserva los recibos** (registro económico, 7 años) y los paquetes de pruebas de disputas abiertas, con esa base legal anotada en `PrivacyRequest` |
| `CsvJob`, `ReportRun` | borra **todos** los archivos de exportación e informes (se pueden regenerar); además se purgan solos a los 7 días |
| `EmailSuppression` | se conserva: solo guarda un HMAC |
| Libro, instantáneas, recibos, reservas, pagos | se conservan, con el cliente anonimizado y sin texto libre |

`IdempotencyRecord` ya no guarda el cuerpo de la respuesta (sección 5.1), así que no tiene datos personales. `SupplierContact` no es dato de clientes: tiene su propio manejador (borrar un contacto de proveedor).
- No se recogen pasaporte ni datos médicos; nunca datos de tarjeta.

### 4.10 Barrido sistemático por clases de fallo

Reglas generales que cada tarea aplica a sus tablas nuevas aunque este plan no las nombre.

| Clase | Regla que queda | Dónde |
|---|---|---|
| 1. Datos personales en lo que no se borra | `@pii`/`@nopii` obligatorio; todo texto libre es `@pii`; ningún texto libre ni IP en tablas inmutables, auditoría, outbox, trabajos, idempotencia ni errores guardados; lista de borrado sacada del registro de entidades y barrido sobre todos sus modelos | 1.3, 4.4, 4.5, 4.9, 8 (5.5) |
| 2. Idempotencia de dinero y estado | además de la clave de la API, un único derivado del objeto de negocio: referencia de pasarela (pagos, reembolsos, disputas, liquidaciones, líneas), clave de asiento y `batchKey` del reparto, un recibo por pago, un coste por pago de proveedor, una cancelación por reserva, una aceptación por presupuesto, un correo por `dedupeKey`, una ejecución por regla y evento; `NULLS NOT DISTINCT` donde NULL es "ninguno" | 1.2, 5.4, 5.5, 5.7, 5.8 |
| 3. Prueba/real y producción/no producción | `mode` en la cuenta del libro y en cada fila de dinero; `ProviderAccount.mode` inmutable; fuera de producción ninguna llamada `live`, correo y webhooks salientes suprimidos; recibos con secuencia por modo | 4.6, 4.8, 5.5 |
| 4. Atomicidad y concurrencia | compare-and-set en toda transición y contador; `FOR UPDATE` con orden de bloqueo fijo; bloqueo optimista con `version` en lo que se edita desde dos pestañas (incluido el reembolso); un intento de cobro solo se sustituye tras confirmarlo con la pasarela (P2) | 1.2, 4.3, 5.5, 6 |
| 5. Fallo en abierto | ámbitos de rol con `CHECK (scope IS NULL)`; step-up deniega sin TOTP reciente; flag inexistente = apagado; `MAIL_MODE` desconocido = no live; `APP_ENV` inválido = no arranca; adaptador sin manifiesto = no `verified`; marcas de la web solo si la API las devuelve | 4.2, 4.3, 4.6, 4.8, 5.2 |
| 6. Columnas de dinero | `BigInt` + moneda emparejada (obligatoria si hay importe) + `CHECK` de signo (o `@signed`); FK compuestas de moneda en los hijos; suma de plazos activos = total; tope de reembolso con estados en curso | 1.1, 5.5 |
| 7. Reversibilidad | asiento → transacción de reversión única; reparto → filas de signo contrario; cupo → movimiento compensatorio; pago a proveedor → anulación con reversión; reembolso revertido → `refunded → cancelled`; nada se edita ni se borra | 4.9, 5.2, 5.5, 5.7, 6.2 |

Riesgo que queda y se acepta: si el personal escribe el nombre de un cliente en el motivo de un cambio sobre una entidad **no** ligada a ningún cliente (por ejemplo, un rol), ese texto no se borra con el cliente; vive en `AuditPiiValue` y se purga a los 7 años.

---

## 5. Modelo de datos completo

Notación: **SD** = borrado lógico; **CF** = campos personalizados; **Ap** = solo se añaden filas (nunca se editan ni borran); **pii** = contiene datos personales. "Tarea" es la que crea la tabla. Archivo = archivo `.prisma` en `apps/api/prisma/schema/`.

### 5.1 Plataforma (`platform-*.prisma`)

| Entidad | Campos principales | Restricciones y notas | Tarea |
|---|---|---|---|
| **User** (pii) | `kind` staff/customer, `email` citext, `emailVerifiedAt`, `status` active/disabled, `passwordHash?`, `totpSecretCiphertext?`, `totpKeyVersion?`, `totpEnabledAt?`, `failedLoginCount`, `nextLoginAllowedAt?`, `lastLoginAt?`, `anonymisedAt?` | `@@unique([kind, email])`. `passwordHash` y TOTP solo para `staff` (check) | 0.3 |
| **RecoveryCode** | `userId`, `codeHash`, `usedAt?` | | 0.3 |
| **Session** (pii) | `userId`, `tokenHash` único, `createdAt`, `expiresAt`, `idleExpiresAt`, `lastSeenAt`, `mfaVerifiedAt?`, `userAgent?`, `ipPrefix?`, `revokedAt?` | IP truncada (/24, /48); las de personal se conservan 90 días tras caducar (las referencia `AuditLog.sessionId`) | 0.3 |
| **LoginToken** (pii) | `email`, `userId?`, `purpose` magic_link, `tokenHash` único, `expiresAt`, `consumedAt?` | un solo uso | 0.3 |
| **Role** | `key` único, `name`, `description`, `isSystem` | | 0.3 |
| **Permission** | `key` único, `module`, `description` | sincronizada desde código | 0.3 |
| **RolePermission** | `roleId`, `permissionKey` | PK compuesta | 0.3 |
| **UserRole** | `userId`, `roleId`, `scope Json?` | `CHECK (scope IS NULL)` hasta que exista el filtrado por ámbito (sección 4.3) | 0.3 |
| **AuditLog** (Ap) | `occurredAt`, `actorType` staff/customer/system/automation/api_key, `actorId?`, `action`, `entityType`, `entityId`, `changes Json` (solo campos `@nopii`), `requestId?`, `sessionId?` | `actorId`, `entityId` y `sessionId` sin FK; sin texto libre ni IP (sección 4.4); disparador anti-modificación sin excepciones; índice `(entityType, entityId, occurredAt)` | 0.3 |
| **AuditPiiValue** (pii) | `auditLogId`, `field` (`_reason` para el motivo), `before?`, `after?`, `subjectCustomerId?` | solo se borra al anonimizar o por retención (7 años si no es de ningún cliente) | 0.3 |
| **FeatureFlag** | `key` único, `enabled`, `description` | administración en 0.3 | 0.4 |
| **Setting** | `key` único, `value Json`, `schemaVersion` | validado por esquema del código; administración en 0.3 | 0.4 |
| **OutboxEvent** | `type`, `schemaVersion`, `aggregateType`, `aggregateId`, `aggregateVersion?`, `payload Json`, `actorType`, `actorId?`, `occurredAt`, `dispatchedAt?` | índice parcial sobre pendientes | 0.4 |
| **EventDelivery** | `eventId`, `consumer`, `status` pending/done/failed/skipped, `attempts`, `lastError?`, `processedAt?` | `@@unique([eventId, consumer])` | 0.4 |
| **IdempotencyRecord** | `scope` (= `actorType:actorId:route`), `actorType`, `actorId`, `key`, `requestHash`, `status` in_progress/completed, `responseStatus?`, `errorCode?`, `resourceType?`, `resourceId?`, `lockedUntil?`, `expiresAt` | `@@unique([scope, key])`: la misma clave enviada por otro actor u otra ruta es otra operación; misma clave, mismo actor y ruta con otro cuerpo → 422. Caduca a las 24 h. **No guarda el cuerpo de la respuesta** (ni datos personales ni secretos): al repetir, la API devuelve el mismo estado HTTP y la representación actual de `resourceId` (el `client_secret` se vuelve a pedir a la pasarela); si la respuesta original enseñaba un secreto una sola vez (clave de API), responde 409. **La idempotencia de la API no sustituye a la del negocio**: toda operación que mueve dinero o estado tiene además una restricción única derivada del objeto de negocio (sección 4.10) | 0.4 |
| **StoredFile** | `storageKey` único, `contentType`, `sizeBytes`, `checksumSha256`, `originalName?`, `visibility` private/public, `purpose`, `uploadedById?` | | 0.4 |
| **OutboundEmail** (pii) | `to`, `templateKey`, `locale`, `subject`, `dedupeKey` único, `status` queued/sent/failed/suppressed, `providerMessageId?`, `customerId?`, `relatedEntityType?`, `relatedEntityId?`, `error?` (`@pii`: un rebote puede citar el correo), `sentAt?` | se anonimiza al borrar un cliente | 0.4 |
| **EmailSuppression** | `emailHash` único (HMAC), `reason` unsubscribed/bounced/complaint, `scope` marketing/all | | 0.4 |
| **NumberSequence** | `key` único, `prefix`, `nextValue` | incremento en transacción | 0.4 |
| **Tag** | `name`, `colour`, `entityTypes String[]` | `@@unique([name])` | 0.5 |
| **Tagging** | `tagId`, `entityType`, `entityId` | `@@unique([tagId, entityType, entityId])` | 0.5 |
| **Note** (pii) | `entityType`, `entityId`, `body` (`@pii`), `authorId`, `pinned` | SD; sus cambios van a `AuditPiiValue` | 0.5 |
| **Attachment** | `entityType`, `entityId`, `storedFileId`, `title` (`@pii`) | SD; los del cliente y sus reservas se borran con su archivo al anonimizar | 0.5 |
| **Task** | `title` (`@pii`), `description?` (`@pii`), `entityType?`, `entityId?`, `dueAt?`, `assigneeId?`, `status` open/done/cancelled, `source` manual/automation/system, `sourceRef?` | SD | 0.5 |
| **SavedView** | `entityType`, `ownerId`, `name`, `filters Json`, `columns Json`, `sort Json`, `shared` | | 0.5 |
| **SearchDocument** | `entityType`, `entityId`, `title` (`@pii` posible), `subtitle?` (`@pii` posible), `searchVector tsvector`, `permissionKey` | `@@unique([entityType, entityId])`, GIN; mantenido por eventos | 0.5 |
| **CsvJob** | `entityType`, `kind` import/export, `status`, `inputFileId?`, `outputFileId?`, `stats Json`, `errors Json` (fila, columna y código, sin valores), `createdById` | importación con vista previa y validación; archivos de entrada y salida se purgan a los 7 días | 0.5 |
| **BulkOperation** | `entityType`, `action`, `entityIds String[]`, `status`, `results Json`, `createdById` | cada elemento pasa por la misma lógica y permiso que su acción individual | 0.5 |
| **CustomFieldDefinition** | `entityType`, `key`, `label LocalizedText`, `type` text/number/date/boolean/select/multiselect, `options Json?`, `validation Json?`, `required`, `visibleToCustomer`, `editableByCustomer`, `displayOrder`, `archivedAt?` | `@@unique([entityType, key])`; archivar, nunca borrar | 7.5 |

### 5.2 Catálogo (`catalogue.prisma`, 1.1)

| Entidad | Campos principales | Restricciones y notas |
|---|---|---|
| **Race** (SD, CF, demo) | `slug` único, `name LocalizedText`, `countryCode Char(2)`, `city`, `timeZone`, `raceType` road/trail/ultra/other, `typicalMonth Int?` (1–12), `summary LocalizedText`, `websiteUrl?`, `latitudeE7?`, `longitudeE7?`, `heroMediaId?`, `seo Json`, `status` draft/published/archived, `externalSource?`, `externalId?` | `@@unique([externalSource, externalId])` |
| **RaceDistance** | `raceId`, `kind` marathon/half/ten_k/five_k/ultra/other, `distanceMetres Int`, `name LocalizedText` | |
| **RaceClaim** | `raceId`, `kind` official_partner/accredited_agent/guaranteed_entry/other, `enabled`, `evidenceNote`, `evidenceAttachmentId?`, `enabledById?`, `enabledAt?` | **única fuente** de cualquier distintivo en la web; auditado. `guaranteed_entry` además exige cupo confirmado: la API calcula por paquete `guaranteedEntry = RaceClaim(guaranteed_entry).enabled ∧ todos los cupos de dorsales del paquete tienen confirmedBySupplier`, y la web solo pinta las marcas que devuelve la API (`claims` de la carrera y `guaranteedEntry` del paquete), nunca las deduce |
| **RaceEdition** | `raceId`, `year`, `startDate @db.Date?`, `endDate?`, `dateStatus` provisional/confirmed, `status` draft/announced/active/completed/cancelled, `notes LocalizedText` | `@@unique([raceId, year])` |
| **Package** (SD, CF) | `editionId`, `slug`, `name LocalizedText`, `saleStatus`, `checkInDate`, `checkOutDate`, `includes LocalizedText`, `excludes LocalizedText`, `instantBooking`, `autoConfirmOnDeposit`, `depositMode` per_person/per_booking/percent, `depositAmountMinor?`, `depositBps?`, `balanceDueDate @db.Date`, `minTravellers`, `maxTravellers`, `maxExtraNightsBefore`, `maxExtraNightsAfter`, `currency`, `cancellationPolicyId?`, `seo Json`, `publishedAt?` | `@@unique([editionId, slug])`; check `checkOutDate > checkInDate`; `isDemo` se hereda de la carrera |
| **PackageParticipationOption** | `packageId`, `type` runner_with_entry/runner_own_entry/supporter, `enabled` | qué tipos de viajero admite el paquete (ver decisión 9.1) |
| **PackageEntryOption** | `packageId`, `raceDistanceId`, `entryPoolId` | dorsales por distancia, cada uno con su cupo |
| **Hotel** (SD, demo) | `name`, `address`, `city`, `countryCode`, `starRating Int?`, `description LocalizedText`, `supplierId?`, `latitudeE7?`, `longitudeE7?` | reutilizable entre paquetes |
| **PackageHotel** | `packageId`, `hotelId`, `displayOrder` | `@@unique([packageId, hotelId])` |
| **RoomOption** | `packageHotelId`, `roomType` single/twin/double/triple/quad/other, `name LocalizedText`, `minOccupancy`, `maxOccupancy`, `roomPoolId` | check `1 ≤ min ≤ max ≤ 4` |
| **Extra** (SD) | `packageId`, `kind` excursion/transfer/meal/merchandise/other, `name LocalizedText`, `description LocalizedText`, `pricingUnit` per_person/per_booking, `availableTo` all/runners/supporters, `mandatory`, `maxPerBooking?`, `poolId?`, `schedule Json?` (traslados: salida, origen, destino) | un extra `mandatory` siempre entra en el total |
| **InventoryPool** | `kind` entry/room/extra, `label`, `capacity Int`, `consumed Int`, `lowStockThreshold Int?`, `confirmedBySupplier Boolean`, `confirmationNote?` | check `0 ≤ consumed ≤ capacity`; `confirmedBySupplier` en un cupo de dorsales es condición necesaria, pero no suficiente, para "entrada garantizada": además hace falta el `RaceClaim` `guaranteed_entry` activado para la carrera |
| **InventoryMovement** (Ap) | `poolId`, `delta Int`, `reason` hold/release/capacity_change/adjustment, `bookingId?`, `actorType`, `actorId?`, `auditLogId?` | historia del cupo; sin texto libre (el motivo de un ajuste va a la auditoría); una corrección es un movimiento compensatorio |
| **ItineraryDay** | `packageId`, `dayNumber`, `title LocalizedText`, `description LocalizedText` | `@@unique([packageId, dayNumber])`; 7.1 |
| **OrganiserExportFormat** | `raceId`, `name`, `columns Json` (campo origen → cabecera), `fileFormat` csv | 7.2 |

Notas:

- `Package.nights` no se guarda: se deriva de las fechas.
- `MediaAsset` (contenido) se usa para imágenes de carrera desde la fase 1 con marcadores de posición; si 8.1 aún no existe, 1.1 crea `MediaAsset` mínimo en `content.prisma`.
- Las "noches extra" se venden por noche y persona según ocupación (`RoomRate.extraNightPerPersonMinor`), dentro de los límites del paquete.

### 5.3 Precios (`pricing.prisma`)

| Entidad | Campos principales | Restricciones y notas | Tarea |
|---|---|---|---|
| **PriceVersion** | `packageId`, `label`, `currency` (FK compuesta con `Package`; `@@unique([id, currency])`), `validFrom timestamptz`, `validTo?`, `status` draft/published/archived, `publishedAt?` | dos versiones publicadas de un paquete no se solapan (`EXCLUDE USING gist` sobre `tstzrange`). 1.1 crea una versión por paquete; 2.2 permite varias | 1.1 |
| **RoomRate** | `priceVersionId`, `roomOptionId`, `occupancy` 1–4, `pricePerPersonMinor`, `extraNightPerPersonMinor`, `currency` | `@@unique([priceVersionId, roomOptionId, occupancy])`; check ≥ 0 | 1.1 |
| **ParticipationRate** | `priceVersionId`, `participationType`, `raceDistanceId?`, `amountPerPersonMinor`, `currency` | componente del dorsal o del acompañante; ≥ 0 | 1.1 |
| **ExtraRate** | `priceVersionId`, `extraId`, `amountMinor`, `currency` | | 1.1 |
| **PriceRule** | `scopeType` global/edition/package, `scopeId?`, `kind` early_bird/late_supplement/group_discount/occupancy_supplement/custom, `conditions Json` (tipada por `kind`), `effectMode` percent/fixed, `valueBps?`, `valueMinor?`, `currency?`, `per` person/booking, `appliesTo` accommodation/participation/extras/subtotal, `priority`, `stackable`, `validFrom?`, `validTo?`, `enabled` | semántica y orden de aplicación los fija 2.2 | 2.2 |
| **PromoCode** | `code` citext único, `description`, mismo efecto que `PriceRule`, `scopeType`, `scopeId?`, `maxRedemptions?`, `maxPerCustomer?`, `redeemedCount`, `validFrom?`, `validTo?`, `enabled` | `redeemedCount` con `UPDATE` condicional y check `≤ maxRedemptions`; `maxPerCustomer` se comprueba tras `FOR UPDATE` sobre el `Customer` | 2.2 |
| **PromoRedemption** | `promoCodeId`, `bookingId`, `customerId`, `redeemedAt`, `releasedAt?` | `@@unique([promoCodeId, bookingId])`; se libera si la reserva se rechaza o caduca, con `UPDATE … WHERE releasedAt IS NULL` y el contador se resta solo si esa sentencia afectó a una fila | 2.2 |
| **CancellationPolicy** | `name`, `description LocalizedText`, `status` draft/active/archived | | 6.4 |
| **CancellationTier** | `policyId`, `minDaysBeforeDeparture`, `penaltyMode` percent/fixed_per_person/fixed_per_booking, `penaltyBps?`, `penaltyMinor?`, `currency?` | tramos sin huecos, probados en sus días límite | 6.4 |
| **ExchangeRate** (Ap) | `baseCurrency`, `quoteCurrency`, `rateE9 BigInt`, `asOf`, `source` | | 6.1 |

El **motor de precios** (2.1) es una función pura `price(input, catalogueView, rules, now) → PriceBreakdown`, sin acceso a la base de datos, que se prueba con tablas. Un servicio la rodea y le pasa los datos. `PriceBreakdown` incluye líneas, subtotales, descuentos, total, depósito, fecha del saldo, `priceVersionId` y `engineVersion`. El motor **nunca aplica un efecto fijo (regla, código, penalización) de otra moneda**: con ámbito de paquete o edición se rechaza al guardarlo; con ámbito global solo se aplica a paquetes de su moneda.

### 5.4 Reservas y CRM (`bookings.prisma`, `crm.prisma`)

| Entidad | Campos principales | Restricciones y notas | Tarea |
|---|---|---|---|
| **Customer** (pii, SD, CF, demo) | `userId?` único, `email` citext único, `givenName`, `familyName`, `phone?`, `countryOfResidence Char(2)`, `preferredLocale`, `source`, `anonymisedAt?` | uno por correo | 2.4 (mínimo), 2.5 |
| **Traveller** (pii, CF) | `customerId` (dueño; `@@unique([id, customerId])`), `givenName`, `familyName` (como en el documento), `dateOfBirth @db.Date?`, `email?`, `phone?`, `emergencyContactName?`, `emergencyContactPhone?`, `estimatedFinishSeconds Int?`, `anonymisedAt?` | sin pasaporte ni datos médicos | 2.4 (mínimo), 5.2 |
| **Booking** (CF, demo) | `reference` único, `customerId`, `kind` catalogue/bespoke, `packageId?`, `editionId?`, `status`, `currentSnapshotVersion`, `currency`, `totalMinor`, `depositMinor`, `balanceDueDate`, `residenceCountry`, `requestedAt`, `approvedAt?`, `approvalExpiresAt?`, `requestExpiresAt?`, `depositPaidAt?`, `confirmedAt?`, `balancePaidAt?`, `completedAt?`, `cancelledAt?`, `statusReason?` (`@pii`, texto libre), `quoteId?`, `groupId?`, `partnerId?`, `sourceChannel`, `version` | check `kind = catalogue ⇒ packageId no nulo`; sin borrado: se cancela | 2.4 |
| **BookingSnapshot** (Ap) | `bookingId`, `version`, `kind` original/amendment, `configuration Json`, `priceBreakdown Json`, `cancellationPolicy Json?`, `termsVersionId?`, `totalMinor`, `currency`, `priceVersionId?`, `engineVersion` | `@@unique([bookingId, version])`; disparador anti-modificación; **sin datos personales ni texto libre**: `configuration` y `priceBreakdown` son `@nopii` con esquemas sin texto libre (las líneas a medida llevan `quoteLineId`) | 2.4 |
| **BookingTraveller** | `bookingId`, `customerId`, `slot Int`, `participationType`, `raceDistanceId?`, `travellerId?`, `isLead`, `addedInVersion`, `removedInVersion?` | FK compuestas `(bookingId, customerId)` → `Booking @@unique([id, customerId])` y `(travellerId, customerId)` → `Traveller`: solo se asignan viajeros del cliente de la reserva. La plaza existe desde la solicitud; los datos personales llegan en 5.2 | 2.4 |
| **BookingRoom** | `bookingId`, `roomOptionId`, `occupancy`, `travellerSlots Int[]` | configuración vigente (operativa) | 2.4 |
| **BookingExtra** | `bookingId`, `extraId`, `quantity`, `travellerSlot?` | | 2.4 |
| **InventoryClaim** | `bookingId`, `poolId`, `quantity`, `status` held/released | qué devolver al cancelar o caducar | 2.4 |
| **Quote** (SD) | `reference`, `customerId`, `kind` catalogue/bespoke, `configuration Json` (`@nopii`, mismo esquema sin texto libre que la instantánea), `priceBreakdown Json`, `totalMinor`, `currency`, `expiresAt`, `status` draft/sent/accepted/expired/withdrawn, `bookingId?`, `createdById` | el total y el desglose salen siempre del motor de precios. Aceptar respeta el precio cotizado hasta `expiresAt` y, en la misma transacción, crea la reserva y **retiene el cupo** (`InventoryClaim`); si no queda cupo, la aceptación falla con 409. Aceptar es compare-and-set `sent → accepted` y `@@unique([bookingId])`: dos clics crean una sola reserva | 2.5 |
| **QuoteLine** | `quoteId`, `description LocalizedText` (`@pii`: texto libre de Oscar), `quantity`, `unitAmountMinor`, `currency` | para viajes a medida: Oscar introduce los importes unitarios; la suma la hace el motor de precios | 2.5 |
| **WaitlistEntry** (pii) | `email` (`@pii`), `customerId?`, `reason` non_resident/sold_out, `raceId?`, `editionId?`, `packageId?`, `countryOfResidence`, `travellers Int`, `position`, `status` waiting/offered/converted/expired/withdrawn, `offeredAt?`, `offerExpiresAt?` | 2.6 crea; 6.5 añade la promoción | 2.6 |
| **TermsVersion** | `kind` booking_terms/privacy/website_terms, `version`, `content LocalizedText`, `publishedAt`, `isProvisional` | `@@unique([kind, version])`; Ap una vez publicada | 3.5 |
| **TermsAcceptance** (pii, Ap) | `customerId`, `bookingId?`, `termsVersionId`, `acceptedAt`, `ipAddress?` (`@pii`), `userAgent?` (`@pii`) | prueba para disputas; excepción de borrado en 4.9 | 3.5 |
| **ConsentRecord** (pii, Ap) | `customerId?`, `email?` (`@pii`), `emailHash`, `purpose` marketing_email, `granted`, `source`, `wordingVersion`, `recordedAt` | el estado vigente es el último registro; excepción de borrado en 4.9 | 5.5 |
| **BookingAmendment** | `bookingId`, `fromVersion`, `toVersion?`, `kind` room/nights/travellers/name_change/extras/other, `priceDifferenceMinor` (`@signed`), `feeMinor`, `currency`, `status` proposed/applied/rejected, `reason` (`@pii`), `createdById`, `appliedAt?` | crea una `BookingSnapshot` nueva; nunca edita la original. Aplicar es compare-and-set sobre `Booking.currentSnapshotVersion = fromVersion` y `@@unique([bookingId, toVersion])`; en la misma transacción reasigna los pagos al plan nuevo (P7, P8) | 6.3 |
| **Cancellation** | `bookingId` único, `requestedBy` customer/staff, `requestedAt`, `daysBeforeDeparture`, `policySnapshot Json`, `penaltyMinor`, `refundableMinor`, `currency`, `reason` (`@pii`) | `bookingId` único: dos clics, una cancelación | 6.4 |

### 5.5 Pagos (`payments.prisma`)

Aquí se fija el **esquema base y los invariantes del libro**. El diseño de cobros, reparto, reembolsos y reasignación es de 3.1, 3.2, 4.5 y 6.3, que deben cumplir los **requisitos vinculantes** de la tabla siguiente, cada uno con su prueba nombrada.

| Entidad | Campos principales | Restricciones | Tarea |
|---|---|---|---|
| **ProviderAccount** | `adapterKey`, `displayName`, `mode` test/live, `status` active/paused/retired/archived, `credentialsCiphertext Bytes`, `credentialsKeyVersion`, `webhookSecretCiphertext?`, `webhookPathToken` único, `lastConnectionTestAt?`, `lastConnectionTestResult?`, `createdById` | `@@unique([id, mode])`; disparador rechaza cambiar `mode` (pasar a real = cuenta `live` nueva, con adaptador `verified`, prueba de conexión y step-up); sin borrado físico con historial | 3.3 (mínimo), 4.1 |
| **PaymentMethodConfig** | `method` card/apple_pay/google_pay/payto/becs/payid_transfer/bpay/bnpl/manual_other, `enabled`, `countries String[]`, `displayOrder`, `instructions LocalizedText?` | bnpl nace apagado; editar `instructions` exige step-up (4.2) | 3.4, 4.2 |
| **RoutingRule** | `method`, `providerAccountId`, `countries String[]`, `currencies String[]`, `minAmountMinor?`, `maxAmountMinor?`, `currency?`, `priority`, `fallbackForRuleId?`, `enabled` | moneda obligatoria si hay límite (1.1); editar exige step-up | 4.2 |
| **PaymentSchedule** | `bookingId` único, `currency` | FK compuesta `(bookingId, currency)` | 3.2 |
| **PaymentScheduleItem** | `scheduleId`, `kind` deposit/balance/instalment/adjustment, `sequence`, `amountMinor`, `currency`, `dueDate @db.Date`, `state` active/waived/superseded | importes de la API; lo pagado y lo pendiente se derivan de `PaymentAllocation` | 3.2 |
| **PaymentLink** | `bookingId`, `targetScheduleItemId?`, `tokenHash` único, `expiresAt`, `status` active/used/expired/revoked, `createdById?` | no guarda importe (P1) | 3.2 |
| **Payment** | `bookingId`, `origin` collection/manual_intent/inbound, `targetScheduleItemId?`, `payerCustomerId?`, `providerAccountId`, `adapterKey`, `method`, `mode`, `amountMinor`, `currency`, `status` created/pending/requires_action/succeeded/failed/cancelled/expired, `idempotencyKey` único, `providerPaymentRef?`, `failureCode?`, `pendingExpiresAt?`, `succeededAt?`, `version` | FK `(providerAccountId, mode)`; `@@unique([providerAccountId, providerPaymentRef])`; `CHECK`: referencia no nula si `succeeded` o `inbound`; `manual_intent` nunca `succeeded`; índice único parcial: un intento vivo (`created`, `pending`, `requires_action`) de origen `collection` o `manual_intent` por reserva | 3.2 |
| **PaymentAllocation** (Ap) | `paymentId`, `scheduleItemId?`, `amountMinor` (`@signed`), `currency`, `kind` schedule/overpayment, `cause` payment/refund/chargeback/chargeback_reinstated/refund_reversed/reallocation, `batchKey`, `ledgerTransactionId?` | `@@unique([batchKey, paymentId, scheduleItemId, kind]) NULLS NOT DISTINCT`: **un solo neto por tupla y lote** (P7) | 3.2 |
| **Refund** | `paymentId`, `providerAccountId`, `mode`, `origin` app/external, `purpose` price_reduction/overpayment_return/cancellation, `amountMinor`, `currency`, `reason?` (`@pii`), `status` requested/pending/succeeded/failed, `idempotencyKey` único, `providerRefundRef?`, `requestedById?`, `cancellationId?`, `amendmentId?` | cuenta, modo y moneda del pago (FK compuesta); `@@unique([providerAccountId, providerRefundRef])`; referencia no nula si `succeeded` o `external` | 3.2, 4.5 |
| **Dispute** | `paymentId`, `providerAccountId`, `mode`, `providerDisputeRef`, `amountMinor`, `currency`, `reasonCode`, `status` open/evidence_submitted/won/lost/closed, `evidenceDueBy?`, `evidenceDocumentId?` | `@@unique([providerAccountId, providerDisputeRef])`; FK compuesta con el pago | 4.5 |
| **LedgerAccount** | `code` (p. ej. `customer_funds`, `customer_overpayments`, `provider_clearing:<accountId>`, `payment_fees`, `supplier_payable`, `revenue`, `refunds_payable`), `kind` asset/liability/revenue/expense, `currency`, `mode` | `@@unique([code, currency, mode])`: prueba y real nunca comparten cuenta | 3.2 |
| **LedgerTransaction** (Ap) | `occurredAt`, `kind` payment/refund/fee/chargeback/supplier_payment/adjustment/reversal, `bookingId?`, `paymentId?`, `refundId?`, `disputeId?`, `supplierPaymentId?`, `reversesTransactionId?` único, `mode`, `idempotencyKey` único (P5), `description` | `@@unique([id, mode])`; corrección = transacción de reversión | 3.2 |
| **LedgerEntry** (Ap) | `transactionId`, `accountCode`, `amountMinor` (`@signed`, `<> 0`), `currency`, `mode`, `bookingId?` | FK `(accountCode, currency, mode)` → `LedgerAccount` y `(transactionId, mode)` → `LedgerTransaction`; disparador diferido: cada transacción suma 0 por moneda | 3.2 |
| **WebhookEvent** (pii posible) | `providerAccountId`, `providerEventId`, `type`, `rawBody Bytes?` (`@pii`), `headers Json` (saneadas), `receivedAt`, `status` received/processed/ignored/failed, `attempts`, `processedAt?`, `error?` | solo firma válida; `@@unique([providerAccountId, providerEventId])`; cuerpo vaciado a 180 días o al anonimizar | 3.3 |
| **WebhookRejection** | `providerAccountId?`, `receivedAt`, `reason` bad_signature/too_large/unknown_account, `bodySha256`, `sizeBytes`, `claimedEventId?`, `headers Json` (saneadas) | sin cuerpo; no bloquea el reintento válido; visible en el monitor; límite de 256 KB antes de verificar | 3.3 |
| **Settlement** | `providerAccountId`, `mode`, `providerSettlementRef`, `payoutDate`, `grossMinor`, `feesMinor`, `netMinor`, `currency` | `@@unique([providerAccountId, providerSettlementRef])`; `CHECK (netMinor = grossMinor - feesMinor)` | 4.6 |
| **SettlementLine** | `settlementId`, `providerLineRef`, `paymentId?`, `refundId?`, `kind`, `amountMinor` (`@signed`), `feeMinor`, `currency` | `@@unique([settlementId, providerLineRef])` | 4.6 |
| **ReconciliationRun** | `providerAccountId`, `forDate`, `status` matched/mismatch/failed, `differences Json` (`@nopii`), `createdAt` | solo lee; alerta si no cuadra | 4.6 |
| **Receipt** | `number` único, `bookingId`, `paymentId`, `mode`, `amountMinor`, `currency`, `gstRegisteredAtIssue`, `gstAmountMinor?`, `issuedAt`, `documentId?` | `@@unique([paymentId])`; secuencia por modo (`MT-R-`, `MT-T-`); `CHECK (gstAmountMinor <= amountMinor)`; sin GST registrado, ni GST ni "tax invoice" | 4.6 |

**Estado del adaptador** (`verified`, `experimental`, `planned`) vive en el manifiesto del adaptador, en código: cambiarlo exige un PR con pruebas y el panel no puede tocarlo; sin manifiesto o con estado desconocido cuenta como no `verified`. Se comprueba al crear una cuenta `live`, al crear cada cobro `live` (en la misma transacción) y al arrancar (una cuenta `live` con adaptador no `verified` se pausa, se audita y se avisa a Oscar).

**Requisitos vinculantes de pagos.** La tarea que diseña cada parte elige cómo, pero no puede cerrar sin la prueba nombrada.

| # | Requisito | Pruebas | Tarea |
|---|---|---|---|
| P1 | El importe de un cobro o enlace lo calcula el servidor con la reserva bloqueada: `min(pendiente acumulado hasta el plazo objetivo, pendiente de la reserva)`; 0 = "nada que pagar". Las entradas no tienen campo de importe | `client_amount_field_rejected`, `single_payment_covers_deposit_and_balance`, `deposit_paid_in_two_parts` | 3.2 |
| P2 | Un solo intento vivo por reserva, de cualquier tipo. Uno `pending` de origen `collection` (débito ya enviado al banco) **bloquea** un cobro nuevo con 409 y no se cancela. Uno `created`/`requires_action` se retoma si coinciden cuenta, método e importe; si no, se sustituye **solo después** de que la pasarela confirme su cancelación o de consultar su estado (si ya cobró, pasa a `succeeded`); sin respuesta de la pasarela, no se sustituye. Un cobro tardío de un intento cancelado es `succeeded` y lo que sobre, sobrepago | `second_live_attempt_for_booking_rejected`, `pending_debit_blocks_new_attempt`, `replace_attempt_only_after_provider_confirms_cancel`, `abandoned_3ds_resumed_or_replaced_immediately`, `late_success_of_cancelled_attempt_becomes_overpayment` | 3.2, 4.2 |
| P3 | Todo intento no terminal tiene `pendingExpiresAt`, que no se renueva al retomarlo; al vencer, **se consulta antes el estado real a la pasarela** y solo se pasa a `expired` si no se completó. En `approved`, pasado `approvalExpiresAt` no se crea ningún intento; la caducidad de la reserva espera al intento vivo (6.2) | `expiry_of_pending_debit_queries_provider_first`, `new_attempt_after_approval_expiry_rejected`, `resume_does_not_extend_pending_expiry`, `approval_expiry_skipped_while_payment_pending`, `create_charge_vs_expire_concurrent` | 3.2 |
| P4 | Transferencias: toda confirmación crea un `inbound` con referencia bancaria obligatoria y normalizada, única por cuenta; el `manual_intent` vivo se cierra en la misma transacción. Confirmar y editar instrucciones exigen step-up y quedan auditados | `manual_confirmation_twice_posts_once`, `manual_confirmation_without_reference_rejected`, `manual_intent_never_succeeds`, `edit_manual_instructions_requires_step_up_and_is_audited` | 3.4 |
| P5 | Idempotencia por objeto de negocio, no por evento: cada evento se traduce a su objeto (por referencia única de pasarela), la transición es compare-and-set y el asiento usa una clave derivada (`payment:<id>:succeeded`, `refund:<id>:succeeded`, `refund:<id>:reversed`, `chargeback:<disputeId>:withdrawn`, `…:reinstated`, `fee:<settlementLineId>`, `supplier_payment:<id>`, `…:voided`); el reparto usa la misma clave como `batchKey`. Un reembolso hecho desde el panel de la pasarela crea un `Refund` `external` y una tarea | `same_success_via_two_event_types_posts_once`, `dispute_created_and_funds_withdrawn_posts_once`, `refund_initiated_outside_app_recorded_once`, `receipt_issued_once_per_payment`, `settlement_fee_posted_once_per_line`, `invalid_then_valid_same_event_id_processed_once` | 3.3, 4.5, 4.6 |
| P6 | Webhooks: firma verificada antes de guardar, duplicados y fuera de orden tolerados (el estado solo avanza; ante duda se consulta a la pasarela), 413 por encima de 256 KB | `webhook_duplicate_out_of_order_bad_signature`, `oversized_webhook_rejected` | 3.3 |
| P7 | Reparto: el dinero que entra cubre los plazos activos por `sequence`; el resto es sobrepago (pasivo `customer_overpayments` y tarea de reembolso). Reembolsos y contracargos restan de las asignaciones de **ese** pago (primero sobrepago, luego del último plazo hacia atrás). Al cambiar el plan, se reasigna en la misma transacción con **un solo neto por (lote, pago, plazo, tipo)** | `overpayment_posts_liability_and_creates_refund_task`, `lost_chargeback_reopens_item_pending`, `amendment_supersedes_items_reallocates`, `reallocation_overpayment_to_schedule_nets_per_tuple`, `lost_chargeback_on_deposit_flags_unpaid_and_blocks_confirm`, `payment_on_cancelled_booking_does_not_reactivate` | 3.2, 6.3 |
| P8 | Invariantes (prueba de propiedades): **suma de plazos activos = `Booking.totalMinor`**; por pago, asignaciones = importe − reembolsos `succeeded` − contracargos retirados + reintegrados; por plazo activo, entre 0 y su importe; no activos, 0; sobrepago ≥ 0; lo asignado cuadra con el libro. Condonar un plazo solo es posible con un cambio (6.3) que baja el total | `allocation_and_schedule_invariants_hold` (propiedades), `waive_item_requires_total_change` | 3.2, 6.3 |
| P9 | Todo reembolso declara su finalidad: `price_reduction` exige en la misma transacción un cambio que baje el total (no reabre plazos); `overpayment_return` solo consume sobrepago; `cancellation` va con su `Cancellation` | `courtesy_refund_lowers_total_without_reopening_balance`, `overpayment_refund_cannot_touch_schedule_items`, `refund_reversed_moves_refunded_back_to_cancelled` | 4.5, 6.3, 6.4 |
| P10 | Tope de reembolsos: con el pago bloqueado, `requested` + `pending` + `succeeded` + nuevo ≤ cobrado neto de contracargos; la petición del panel envía `Payment.version` | `concurrent_refunds_cannot_exceed_payment`, `stale_payment_version_refund_rejected` | 4.5 |
| P11 | Modo y entorno: `mode` en cada fila de dinero y en la cuenta del libro; informes y estado de cobro solo cuentan el modo del entorno; fuera de producción ninguna llamada `live` (4.8); en `production` el enrutado no ofrece cuentas `test` | `test_mode_payment_not_counted_in_production`, `ledger_entry_mode_must_match_account_and_transaction`, `ledger_entry_currency_must_match_account`, `provider_account_mode_is_immutable`, `non_production_refund_on_live_account_rejected`, `non_production_start_pauses_live_accounts`, `live_credentials_not_decrypted_outside_production`, `production_routing_excludes_test_accounts`, `live_charge_rejected_when_adapter_not_verified`, `startup_pauses_live_account_with_unverified_adapter` | 3.2, 3.3, 4.1 |
| P12 | Proveedores: un coste se paga una sola vez; anular libera el coste y revierte el asiento | `cost_item_cannot_be_paid_twice`, `voided_supplier_payment_frees_cost_item` | 6.2 |

**Estado de cobro de una reserva** (pendiente, depósito cobrado, pagada, depósito revertido, con reembolso parcial, reembolsada): se deriva del reparto y del plan de pagos, nunca se guarda a mano.

### 5.6 Plantillas, documentos, alertas, privacidad (`templates.prisma`, `alerts.prisma`)

| Entidad | Campos principales | Notas | Tarea |
|---|---|---|---|
| **EmailTemplate** | `key`, `locale`, `version`, `status` draft/active/archived, `subject`, `body`, `variablesSchema Json` | `@@unique([key, locale, version])`; vista previa con datos de ejemplo | 5.4 |
| **DocumentTemplate** | `key` confirmation/itinerary/voucher/receipt/evidence_pack, `locale`, `version`, `status`, `body`, `variablesSchema Json` | | 5.4 |
| **GeneratedDocument** (pii) | `bookingId?`, `kind`, `templateId`, `templateVersion`, `storedFileId`, `createdAt`, `deletedForPrivacyAt?` | el archivo contiene datos personales; tratamiento al borrar en 4.9 | 5.4 |
| **AlertSubscription** (pii) | `email` citext, `customerId?`, `raceId`, `editionId?`, `status` pending/confirmed/unsubscribed, `confirmTokenHash?`, `confirmedAt?`, `unsubscribeTokenHash` único, `lastNotifiedAt?` | `@@unique([email, raceId])` | 5.3 |
| **PrivacyRequest** | `customerId`, `kind` export/erasure, `status` received/completed/rejected, `requestedAt`, `completedAt?`, `resultFileId?`, `notes` (`@pii`) | la fila se conserva como prueba de la solicitud; `notes` se redacta | 5.5 |

### 5.7 Proveedores y finanzas (`suppliers.prisma`, `finance.prisma`)

| Entidad | Campos principales | Notas | Tarea |
|---|---|---|---|
| **Supplier** (SD, CF, demo) | `kind` hotel/ground_operator/race_organiser/other, `name`, `countryCode`, `defaultCurrency`, `paymentTerms`, `notes` | | 6.1 |
| **SupplierContact** (pii) | `supplierId`, `name`, `email?`, `phone?`, `role` | | 6.1 |
| **SupplierContract** (SD) | `supplierId`, `editionId?`, `reference`, `signedAt?`, `validFrom?`, `validTo?`, `terms`, `attachmentId?` | | 6.1 |
| **Allotment** | `contractId`, `poolId`, `kind` room/entry, `quantity`, `releaseDate @db.Date?`, `unitCostMinor`, `currency`, `status` held/released | contratado al proveedor; alimenta la capacidad del `InventoryPool` | 6.1 |
| **CostItem** | `supplierId`, `contractId?`, `packageId?`, `bookingId?`, `description` (`@pii`), `basis` per_person/per_room/per_booking/fixed, `quantity`, `unitAmountMinor`, `amountMinor`, `currency`, `dueDate?`, `status` planned/due/paid/cancelled | coste en su moneda; `@@unique([id, currency])`. Un pago parcial a un proveedor (señal y resto) son dos `CostItem` | 6.1 |
| **SupplierPayment** | `supplierId`, `amountMinor`, `currency`, `paidAt`, `reference`, `status` recorded/voided, `idempotencyKey` único, `fxRateE9?`, `baseAmountMinor?`, `baseCurrency?` | genera asiento en el libro (`supplier_payment:<id>`); anular es compare-and-set `recorded → voided` con transacción de reversión; el importe convertido lleva su propia moneda | 6.2 |
| **SupplierPaymentItem** | `supplierPaymentId`, `costItemId`, `amountMinor`, `currency`, `active` | FK compuestas con la moneda del pago y del coste; **índice único parcial sobre `costItemId` donde `active`**: un coste no se paga dos veces; anular el pago pone `active = false` en la misma transacción | 6.2 |
| **AccountingExport** | `periodFrom`, `periodTo`, `format`, `storedFileId`, `createdById` | | 6.6 |

"Viaje", para operaciones y resultado económico, **es un `Package`** (una salida). El resultado por edición o carrera suma sus paquetes.

### 5.8 Operaciones, reclamaciones, contenido, informes, automatizaciones, integraciones

| Entidad | Campos principales | Notas | Tarea |
|---|---|---|---|
| **KeyDate** | `entityType`, `entityId`, `kind` allotment_release/balance_due/entry_submission/supplier_payment/custom, `date`, `title`, `taskId?` | mantenida por eventos; genera tareas | 7.3 |
| **Complaint** (pii, SD) | `reference` único, `customerId?`, `bookingId?`, `receivedAt`, `channel`, `category`, `description` (`@pii`), `status` received/acknowledged/investigating/resolved/closed, `ownerId?`, `acknowledgeBy`, `resolveBy`, `resolution?` (`@pii`), `resolvedAt?` | | 7.6 |
| **ComplaintEvent** (pii, Ap) | `complaintId`, `kind`, `body` (`@pii`), `actorId`, `occurredAt` | cronología demostrable; excepción de borrado en 4.9 | 7.6 |
| **AutomationRule** | `name`, `triggerType` event/schedule, `eventType?`, `cron?`, `conditions Json`, `actions Json`, `enabled`, `testMode`, `version` | acciones de una lista cerrada: nunca mover dinero ni cambiar permisos | 7.4 |
| **AutomationRun** | `ruleId`, `ruleVersion`, `triggerEventId?`, `testMode`, `status`, `steps Json` (`@nopii`: acción, estado, entidad y código de error, nunca contenido renderizado), `startedAt`, `finishedAt?` | `@@unique([ruleId, triggerEventId])`: un evento dispara una regla una vez; purga a 90 días | 7.4 |
| **ReportDefinition** | `name`, `entityType`, `columns Json`, `filters Json`, `groupBy Json`, `ownerId`, `shared` | usa el registro de entidades | 7.7 |
| **ReportSchedule** | `reportId`, `cron`, `recipients String[]`, `format`, `enabled` | | 7.7 |
| **ReportRun** | `reportId`, `status`, `storedFileId?`, `startedAt`, `finishedAt?` | el archivo se purga a los 7 días | 7.7 |
| **AnalyticsEvent** | `anonymousId`, `type` page_view/builder_started/builder_changed/request_submitted/…, `raceId?`, `packageId?`, `occurredAt` | sin datos personales, sin IP; purga a 13 meses | 7.7 |
| **FunnelDailyStat** | `date`, `raceId`, `packageId?`, `views`, `builderStarts`, `requests`, `deposits` | agregado diario | 7.7 |
| **MediaAsset** | `storedFileId`, `alt LocalizedText`, `credit?`, `width`, `height`, `isPlaceholder` | | 1.1 o 8.1 |
| **Guide**, **Page** (SD) | `slug`, `raceId?` (guía), `title LocalizedText`, `body LocalizedText` (bloques), `seo Json`, `status` draft/published/archived, `publishedAt?`, `isLegalProvisional` (páginas legales) | | 8.1 (1.3 usa una guía básica en `Race`) |
| **FaqItem**, **Banner**, **MenuItem** | textos `LocalizedText`, orden, estado, fechas de vigencia | | 8.1 |
| **Redirect** | `fromPath` único, `toPath`, `statusCode` 301/302 | | 8.1 |
| **ApiKey** | `name`, `prefix` único, `secretHash`, `scopes String[]`, `ownerUserId`, `expiresAt?`, `lastUsedAt?`, `revokedAt?` | el secreto se enseña una sola vez | 8.4 |
| **WebhookSubscription** | `url`, `eventTypes String[]`, `secretCiphertext`, `keyVersion`, `enabled`, `consecutiveFailures`, `disabledAt?` | URL validada contra direcciones privadas (SSRF) | 8.4 |
| **WebhookDelivery** | `subscriptionId`, `outboxEventId`, `attempt`, `status` (incluye `suppressed`, sección 4.8), `responseStatus?`, `durationMs?`, `nextAttemptAt?` | `@@unique([subscriptionId, outboxEventId, attempt])`; la carga lleva identificadores, no datos personales | 8.4 |
| **BackupRun** | `kind` backup/restore_test, `status`, `startedAt`, `finishedAt?`, `location`, `notes` | | 8.6 |
| **SystemErrorEvent** | `occurredAt`, `source`, `message` (pasado por el redactor del logger), `requestId?`, `fingerprint` | purga a 30 días | 8.6 |

### 5.9 Más adelante (diseñado; no se crea hasta que Oscar lo pida)

| Entidad | Campos principales | Gancho que ya existe |
|---|---|---|
| **Group**, **GroupMember** | `name`, `leaderCustomerId`, `editionId`; miembro con `customerId`, `bookingId` | `Booking.groupId`, `Payment.payerCustomerId` |
| **Partner**, **PartnerCommission** | `kind` club/coach/agent, `code` único, `commissionBps`, `status`; comisión con `bookingId`, `amountMinor`, `currency`, `status` | `Booking.partnerId` |
| **Segment**, **Campaign**, **CampaignRecipient** | definición de segmento en `Json`; campaña con plantilla, estado, fecha; destinatario solo con consentimiento vigente | `ConsentRecord`, `EmailSuppression` |
| **Survey**, **SurveyResponse** | encuesta por edición; respuesta ligada a una reserva `completed`, `moderationStatus` | `Booking.status = completed` |
| Viajes a medida | sin tablas nuevas: `Booking.kind = bespoke`, `Quote.kind = bespoke` y `QuoteLine` | |
| Más monedas y países | sin cambiar el esquema: `Setting.salesCountries`, `PriceVersion.currency`, moneda en cada fila con importe. Sí hace falta crear **filas** nuevas: las cuentas del libro de cada moneda (`LedgerAccount` por código, moneda y modo) y el enrutado de pagos para esa moneda. Los importes ya son `BigInt`, así que monedas con muchas unidades menores caben sin migración | |

### 5.10 Archivos de esquema

`base.prisma` (generador, datasource, enumerados comunes), `platform-auth.prisma`, `platform-audit.prisma`, `platform-events.prisma`, `platform-files.prisma`, `platform-common.prisma`, `catalogue.prisma`, `pricing.prisma`, `bookings.prisma`, `crm.prisma`, `payments.prisma`, `templates.prisma`, `alerts.prisma`, `suppliers.prisma`, `finance.prisma`, `operations.prisma`, `complaints.prisma`, `content.prisma`, `reporting.prisma`, `automations.prisma`, `integrations.prisma`. Cada tarea crea solo el suyo. Restricciones `CHECK`, disparadores, índices parciales y `EXCLUDE` van en SQL dentro de la migración (Prisma no los expresa), con un comentario en el modelo que lo indique.

---

## 6. Máquinas de estados

Toda transición pasa por un servicio de estados del módulo dueño, con una tabla de transiciones permitidas y una prueba que recorre todos los pares (origen, destino) y comprueba que solo los permitidos pasan. Cada transición escribe auditoría y un evento.

**Transición atómica.** Una transición es `UPDATE … SET status = $to, version = version + 1 WHERE id = $1 AND status = $from` dentro de la transacción; si afecta a 0 filas, otra transición ganó y la API responde 409 sin efectos. Todo lo que acompaña a la transición (liberar cupo, asientos, auditoría, outbox) va en la **misma transacción**. Cuando un evento permite avanzar varios pasos (por ejemplo un pago que cubre el total), el servicio aplica en la misma transacción la cadena de transiciones permitidas, una a una, cada una auditada.

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
- **Los datos demo no se publican en ningún entorno.** Un paquete con `isDemo` heredado no puede salir de `draft` y una carrera demo no puede pasar a `Race.status = published`, sea cual sea `APP_ENV`. `isDemo` no se puede cambiar por la API. La API pública excluye siempre `isDemo`. Las pruebas e2e crean sus propios datos no demo. Para ver el sitio con datos demo en local existe una vista previa solo con `APP_ENV=development`, que muestra los registros demo en borrador con una banda "DEMO" visible, sin cambiar su estado. El seed se niega a ejecutarse con `APP_ENV=production`.
- Pasar a `open` exige al menos una versión de precio publicada y vigente, y un depósito configurado.

### 6.2 Reserva (2.4; se mantienen los estados pedidos)

| Desde | Hacia | Quién o qué |
|---|---|---|
| requested | approved | Oscar; o automático si `instantBooking` y el cupo está retenido |
| requested | declined | Oscar |
| requested | expired | tarea: `requestExpiresAt` vencido sin revisar |
| requested | cancelled | el cliente la retira |
| approved | deposit_paid | evento de pago: depósito cubierto según el libro (si el pago cubre el total, sigue la cadena permitida en la misma transacción) |
| approved | expired | tarea: `approvalExpiresAt` vencido sin depósito y **sin ningún intento vivo** (`created`, `pending` o `requires_action`) |
| approved | cancelled | cliente u Oscar |
| deposit_paid | confirmed | automático si `autoConfirmOnDeposit`; si no, Oscar; exige depósito cubierto y total aún no cubierto |
| deposit_paid | balance_paid | se confirma (automático u Oscar) y el total ya está cubierto: `balance_paid` implica confirmada |
| deposit_paid | cancelled | cliente u Oscar (política de cancelación) |
| confirmed | balance_paid | evento de pago: total cubierto |
| confirmed | cancelled | |
| balance_paid | confirmed | queda importe pendiente: un cambio (6.3) sube el total o se pierde un contracargo |
| balance_paid | completed | tarea: pasada la fecha de salida |
| balance_paid | cancelled | |
| cancelled | refunded | se llegó a cobrar algo y, tras los reembolsos, el neto cobrado es 0. Si nunca se cobró nada, se queda en `cancelled` |
| refunded | cancelled | un reembolso se revierte (`refund_reversed`) y el neto cobrado vuelve a ser > 0 |

- **El cupo se retiene al solicitar** (`InventoryClaim` en estado `held`) y se libera al pasar a `declined`, `expired` o `cancelled`. Por eso la solicitud caduca si nadie la revisa (supuesto 11.4). La liberación es `UPDATE inventory_claim SET status = 'released' WHERE booking_id = $1 AND status = 'held' RETURNING pool_id, quantity`, y solo lo que devuelve esa sentencia se resta de `InventoryPool.consumed`, en la misma transacción que la transición: aunque dos procesos lo intenten, el cupo se libera una sola vez.
- Los estados de cobro (`deposit_paid`, `balance_paid`) **solo** los provoca el módulo de pagos según el libro; ningún endpoint los fija a mano.
- **Caducidad con pago en curso.** La tarea de caducidad, con la reserva bloqueada, no caduca una reserva `approved` mientras tenga un intento vivo. Con P2 y P3 (5.5) la retención del cupo queda acotada a `approvalExpiresAt` más la vida del último intento creado antes, y un débito que el banco aún procesa no se da por caducado sin consultarlo. Si el dinero llega después de caducar, va a sobrepago.
- **Pago sobre una reserva `expired`, `declined` o `cancelled`:** no la reactiva. El dinero se asienta (sobrepago, sección 5.5), se marca para revisión y se crea una tarea para Oscar (reembolsar o, si aún hay cupo, reactivar con una acción explícita y auditada).
- **Contracargo perdido** (P7): los plazos de ese pago vuelven a estar pendientes y el enlace cobra lo debido. Si la reserva estaba `balance_paid`, vuelve a `confirmed`. Si deja el depósito sin cubrir, la reserva no retrocede de estado (`deposit_paid` o `confirmed`), su estado de cobro pasa a "depósito revertido", `deposit_paid → confirmed` queda bloqueado hasta cubrirlo y se crea una tarea para Oscar; nunca se cancela sola (`lost_chargeback_on_deposit_flags_unpaid_and_blocks_confirm`, 4.5).
- **Pago del saldo antes de confirmar** (`autoConfirmOnDeposit = false`): la reserva sigue en `deposit_paid` con el estado de cobro "pagada"; cuando Oscar confirma, pasa directamente a `balance_paid`.
- Enviar una solicitud exige sesión de cliente (enlace mágico) y país de residencia en `Setting.salesCountries`; si no, se crea `WaitlistEntry` (2.6).

### 6.3 Otras

- **ProviderAccount:** active ↔ paused; active/paused → retired; retired → archived solo sin pagos, reembolsos ni disputas pendientes. `paused` y `retired` no aceptan cobros nuevos y sí reembolsos, disputas y webhooks, **siempre sujetos a la guarda de entorno** (4.8): fuera de producción, una cuenta `live` no hace ninguna llamada, esté como esté. `mode` no cambia nunca; crear una cuenta `live` exige adaptador `verified`, prueba de conexión correcta y step-up.
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
| Un código con límite por cliente se canjea dos veces a la vez | `FOR UPDATE` sobre el `Customer` antes de contar sus canjes | 2.2 |
| Caducidad y cancelación (o aprobación y caducidad) a la vez | transición condicional `WHERE status = $from`; liberación del cupo condicional `WHERE status = 'held'`, en la misma transacción | 2.4 |
| Cobros dobles; intentos abandonados, en curso o tardíos; transferencias; reembolsos y contracargos; webhooks; prueba frente a real; pagos a proveedores | requisitos vinculantes P1–P12 de la sección 5.5, cada uno con su prueba | 3.x, 4.x, 6.2, 6.3 |
| Una copia de producción en staging reembolsa, concilia o avisa con dinero real | ninguna llamada en `live` fuera de producción, sea cual sea la operación (`ProviderGateway`), y credenciales `live` sin descifrar; webhooks salientes y correo suprimidos | 3.3, 4.1, 8.4 |
| Mezcla de monedas | FK compuestas con la moneda del padre; moneda obligatoria en todo importe opcional; cuenta del libro por moneda; el motor nunca aplica un efecto fijo de otra moneda | 2.1, 2.2, 3.2 |
| Un módulo apagado pierde eventos de dinero | módulos de dinero sin flag; consumidores de eventos de dinero con `hold` | 0.4 |
| Clave de API de un usuario desactivado o que perdió permisos | permisos efectivos calculados en cada petición | 8.4 |
| Un secreto o un dato personal queda en la tabla de idempotencia | no guarda el cuerpo de la respuesta | 0.4, 8.4 |
| Un atacante bloquea al único `owner` con intentos fallidos | retraso progresivo, sin bloqueo definitivo | 0.3 |
| Un cupo baja de cero por un ajuste manual | `CHECK (consumed BETWEEN 0 AND capacity)`; reducir capacidad por debajo de lo consumido se rechaza | 1.1 |
| Alguien solicita con el correo de otra persona para retener cupo | la solicitud exige sesión verificada por enlace mágico; límite de peticiones; caducidad de solicitudes | 2.4 |
| El navegador manda un importe | los esquemas de entrada de solicitud y cobro no tienen campo de importe; prueba que un campo extra se rechaza | 2.4, 3.2 |
| Cambia un precio después de una solicitud | la reserva usa su `BookingSnapshot`; nada la recalcula | 2.4 |
| Reintento con la misma clave de idempotencia | `IdempotencyRecord` devuelve el mismo estado y el recurso actual; misma clave con otro cuerpo → 422 | 0.4 |
| Un ámbito de rol todavía no implementado da acceso a todo | `CHECK (scope IS NULL)`; la API rechaza ámbitos y la guarda los trata como denegar | 0.3 |
| Dos `owner` se quitan el rol a la vez | bloqueo de la fila del rol `owner` antes de contar | 0.3 |
| Pasarela caída en el checkout | P2: un intento solo se sustituye tras confirmar su cancelación o su estado; si no se puede, la reserva sigue aprobada sin cobro y se ofrece reintentar | 4.2, 3.5 |
| Pausar la última cuenta de un método o país | el panel avisa antes de confirmar | 4.1 |
| Corrección de un asiento | transacción de reversión que referencia la original; disparador impide `UPDATE`, `TRUNCATE` y `DELETE` | 3.2 |
| Fallo a mitad de un cambio con evento | outbox en la misma transacción: o están los dos o ninguno | 0.4 |
| Consumidor procesa dos veces un evento | `EventDelivery` único por consumidor y evento | 0.4 |
| Un módulo de avisos se enciende tras meses y manda correos viejos | los consumidores de solo aviso descartan eventos más antiguos que su límite | 0.4 |
| Un hilo envía correo a una persona real | guarda de desarrollo con lista permitida; `MAIL_MODE=live` solo lo pone Oscar | 0.4 |
| Sesión robada | cookie `httpOnly`, revocable, caducidad por inactividad, step-up en acciones sensibles | 0.3 |
| Enumeración de correos | respuesta idéntica al pedir enlace mágico | 0.3 |
| Ruta del panel sin permiso | prueba que recorre todas las rutas | 0.3 |
| Un cliente ve la reserva de otro | cada ruta del cliente declara `@OwnedBy`; las consultas filtran por `customerId` de la sesión; prueba que recorre las rutas y prueba con dos clientes | 0.3, 5.1 |
| Un cliente asigna a su plaza el viajero de otro cliente | FK compuesta `(travellerId, customerId)`: el viajero debe ser del cliente de la reserva | 5.2 |
| Datos personales en registros | redacción en el logger; eventos sin datos personales | 0.3, 0.4 |
| Borrar un cliente con pagos | lista sacada del registro de entidades y excepciones por tabla (4.9); sin texto libre en tablas inmutables; se conservan libro, instantáneas y recibos | 5.5 |
| La API crea objetos que se ejecutan con privilegios de `mt_privacy` | `mt_app` sin `CREATE` ni `TEMPORARY`; funciones con `search_path` fijo; pg-boss creado por migraciones | 0.2, 0.3, 0.4 |
| CSV con fórmulas maliciosas (`=`, `+`, `-`, `@`) | se escapan al exportar | 0.5 |
| Importación CSV a medias | se valida entera antes de escribir; se escribe en una transacción o no se escribe | 0.5 |
| Fecha límite en el cambio de día | fechas de calendario y zona del negocio; pruebas en el día exacto de cada tramo | 3.2, 6.4 |
| Desbordamiento de enteros en sumas | importes en `bigint`; `SUM` de PostgreSQL devuelve `numeric`, que se convierte a `bigint` con comprobación | 4.6, 6.6 |
| Migraciones en paralelo que chocan | un archivo de esquema por módulo; regenerar la migración propia encima de `main` | todas |
| Webhook saliente hacia una IP interna | validación de URL y resolución DNS contra rangos privados | 8.4 |
| Automatización que mueve dinero o permisos | la lista de acciones no las incluye; prueba que intentar registrarlas falla | 7.4 |
| API dormida pierde webhooks | requisito de alojamiento siempre encendido; reconciliación diaria como red | 0.7, 4.6, 8.7 |

---

## 8. Pruebas que cada tarea escribe primero

Esta tarea no tiene código. Estas son las pruebas que fijan los invariantes del plan; cada tarea las escribe antes de implementar.

- **0.2:** prueba de convenciones del esquema: ninguna columna `Float` ni `Decimal`; toda columna `*Minor` es `BigInt` y tiene su moneda emparejada (`fooCurrency` o `currency`); toda columna `*Bps` es `Int`; todo `*Minor` opcional cumple `CHECK ((x IS NULL) = (moneda IS NULL))` (si comparte moneda con otros, la moneda es nula solo si todos lo son); todo `*Minor` no marcado `@signed` tiene `CHECK` de signo; toda columna `String`/`Json`/`Bytes` de un modelo ligado al cliente lleva `@pii` o `@nopii`. `docker compose up` arranca `db`, `mail`, `api` y `web` (comprobación de salud de los cuatro). La API no arranca sin `APP_ENV`. La API se conecta como `mt_app` y las migraciones como `mt_owner`; una prueba comprueba que `mt_app` no es dueño de ninguna tabla ni tiene `TRUNCATE`; `mt_app_has_no_create_privilege` (sin `CREATE` en ningún esquema ni en la base de datos, sin `TEMPORARY`). CI falla si hay pruebas saltadas.
- **0.3:** 403 para un rol sin permiso; todas las rutas del panel declaran permiso; todas las rutas del cliente declaran `@OwnedBy`; auditoría con valor anterior y nuevo; campo `@pii` y motivo van a `AuditPiiValue`; disparador impide modificar `AuditLog`, también a `mt_privacy`; `privacy_erase_customer` tiene `search_path` fijo y `EXECUTE` solo para `mt_app`; `non_empty_role_scope_rejected_and_denies`; `last_owner_cannot_be_removed_concurrently`; acciones de la lista de step-up sin TOTP reciente → 403; `secret_change_audited_as_changed_only` (credenciales y secretos solo como "cambiado"); `immutable_tables_have_no_fk_to_deletable_rows` (`AuditLog.actorId`, `sessionId` y `entityId` son UUID sin FK); enlace mágico de un solo uso y caducado; respuesta idéntica para correo inexistente; sesión de cliente no accede al panel aunque el correo coincida; intentos fallidos aplican retraso y nunca bloqueo definitivo; cambiar un flag desde el panel queda auditado; e2e de entrada con contraseña y TOTP.
- **0.4:** transacción deshecha no deja evento; evento entregado dos veces se procesa una; consumidor `skip` con flag apagado marca `skipped`; **consumidor `hold` con flag apagado deja el evento `pending` y lo procesa al encender**; ningún consumidor de `payments.*`, `bookings.*` o `changes.*` declara `skip`; `IdempotencyRecord` nunca guarda cuerpo de respuesta y la repetición devuelve el recurso actual; guarda de correo rechaza destinatario fuera de la lista y `MAIL_MODE=live` se ignora fuera de `production`; `OutboundEmail.dedupeKey` evita el doble envío; la API no arranca si falta una cola de pg-boss y nunca crea su esquema; `stale_notify_event_skipped_after_reenable` (un consumidor de solo aviso descarta eventos más viejos que su límite; los de estado y dinero los procesan todos); batería de contrato de `FileStorage`.
- **0.5:** sobre la **tabla de ejemplo de la fase 0, que es la lista de `Task` del panel** (tareas con fecha, responsable, estado y entidad enlazada): búsqueda global encuentra una tarea por su título; filtros combinados (estado + responsable + vencimiento) y orden; vista guardada por usuario; acción en lote (completar) respeta el permiso de cada elemento; CSV exportado escapa fórmulas; importación con un error no escribe nada; etiquetar y quitar etiqueta; añadir nota; historial muestra cambios con valor anterior y nuevo; borrado lógico oculta y restaura.
- **1.1:** transiciones de estado de venta; `guaranteedEntry` es falso si falta el `RaceClaim` o algún cupo de dorsales no está confirmado; cupo no baja de cero; paquete en `draft` no sale por la API pública; **un paquete demo no pasa a `open` ni una carrera demo a `published`, con cualquier `APP_ENV`**; `isDemo` no se puede cambiar por la API.
- **2.1/2.2:** tabla de ocupación 1 a 4, noches extra, acompañantes, códigos, combinaciones de reglas, fechas límite y regla de redondeo; **entradas con monedas distintas se rechazan**; `fixed_rule_other_currency_never_applied`; `max_per_customer_concurrent_redemptions`.
- **2.4:** dos solicitudes concurrentes por la última plaza; **caducidad y cancelación concurrentes liberan el cupo una sola vez; aprobar y caducar a la vez: solo gana una**; transición no permitida rechazada; cambio de precio no altera la instantánea; importe del cliente ignorado.
- **2.5:** `quote_accepted_twice_creates_one_booking`; `quote_acceptance_without_inventory_returns_409`.
- **3.x, 4.x, 6.2, 6.3:** todas las pruebas nombradas en los requisitos P1–P12 (sección 5.5), escritas antes de implementar por la tarea indicada en cada fila.
- **5.1/5.2:** `customer_cannot_read_other_customers_booking` (dos clientes, todas las rutas del área); `traveller_of_other_customer_cannot_be_assigned`.
- **5.5:** todo modelo con camino hasta el cliente está en el registro de entidades con `customerLink` y manejador (recorriendo el DMMF); borrado conserva el libro; **prueba de barrido**: se crea un cliente y, **para cada modelo del registro con `customerLink`** (no una lista escrita a mano), filas con un marcador único escrito en **todas** sus columnas de texto, `String[]`, `Json` y `Bytes` (las `@nopii` se intentan rellenar por la API y deben rechazar el marcador o no guardarlo), más documentos, exportaciones, informes, índice de búsqueda, auditoría con motivo, trabajos y correos; se borra (sin errores de FK ni `UPDATE` sobre tablas inmutables, aunque se borren sesiones y usuarios referenciados por `AuditLog`) y se recorren **todas las columnas de texto, `Json` y `Bytes` de todas las tablas (incluido `pgboss`) y todos los archivos guardados**: el marcador solo puede quedar en los recibos conservados; `mt_app` no puede modificar las tablas inmutables ni con `UPDATE` ni con `TRUNCATE`, y solo las funciones de `mt_privacy` aplican las excepciones.
- **6.4:** `one_cancellation_per_booking` (dos clics); penalización en el día exacto de cada tramo (`cancellation_tier_boundaries`).
- **7.4:** `registering_money_or_permission_action_fails`.
- **8.4:** una clave de API pierde un permiso cuando su dueño lo pierde; clave de un dueño desactivado → 401; `outbound_webhook_suppressed_outside_production`.

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
12. **Módulos de dinero sin feature flag** (`catalogue`, `pricing`, `bookings`, `payments`): apagarlos dejaría reservas y pagos a medias. Deshacer: añadir el flag con consumidores `hold`.
13. **Los datos demo nunca se publican**, ni en desarrollo; para verlos en local hay una vista previa marcada como "DEMO". Deshacer: permitir publicar demo en `development`.
14. **Importes en `BigInt` desde el principio y como cadena en JSON.** Deshacer: imposible sin migración; por eso se elige ya el tipo ancho.
15. **Pendiente derivado del reparto (que cuadra con el libro) y un solo intento vivo por reserva, de cualquier tipo**, en lugar de cobros atados a un plazo. Un débito en curso bloquea; los demás se retoman o se sustituyen tras confirmarlo con la pasarela; pasado `approvalExpiresAt` no se crea ninguno (sustituye a "un aplazamiento manual una sola vez"). Deshacer: un `Setting` de gracia tras `approvalExpiresAt`.
16. **Roles de base de datos separados** (`mt_owner`, `mt_app`, `mt_privacy`): la API no es dueña de las tablas, no puede crear objetos (`CREATE`, `TEMPORARY`) y el esquema de pg-boss lo crean las migraciones. Deshacer: conceder `CREATE` en `pgboss` a `mt_app` y dejar que pg-boss migre al arrancar.
17. **Ningún texto libre en tablas inmutables ni en `AuditLog`**: los motivos van a `AuditPiiValue`; `IdempotencyRecord` no guarda el cuerpo de la respuesta. Deshacer: añadir columnas `@pii` con su excepción de borrado.
18. **Fuera de producción, ninguna llamada en `live`** a una pasarela, sea cual sea la operación, y sin descifrar credenciales `live`; webhooks salientes suprimidos como el correo. Deshacer: no recomendado; es la red contra una copia de producción en staging.
19. **`ProviderAccount.mode` inmutable y `mode` en la cuenta del libro.** Pasar a real es crear una cuenta nueva. Deshacer: migración que quita `mode` de la clave de `LedgerAccount`.
20. **Toda transferencia confirmada es un `Payment` `inbound`** con referencia bancaria obligatoria y única por cuenta; el `manual_intent` solo da instrucciones. Deshacer: permitir que el `manual_intent` pase a `succeeded`, manteniendo el único de referencia.
21. **Reparto reversible y reembolsos con finalidad**: filas negativas por reembolso y contracargo, reasignación neta al cambiar el plan, suma de plazos activos = total; un reembolso de cortesía rebaja el total con un cambio y condonar un plazo también. Deshacer: recalcular el reparto en cada lectura (sin tabla).
22. **Un coste de proveedor, un pago**: señal y resto son dos `CostItem`. Deshacer: tope por suma con bloqueo en lugar del único.
23. **Ámbitos de rol bloqueados** con `CHECK (scope IS NULL)` hasta que exista su filtrado. Deshacer: la migración de esa tarea quita el `CHECK`.
24. **Un contracargo sobre el depósito no hace retroceder la reserva**: queda con estado de cobro "depósito revertido", sin confirmar hasta cubrirlo y con tarea para Oscar; y se añade `refunded → cancelled` si un reembolso se revierte. Deshacer: añadir `deposit_paid → approved`.
25. **Los avisos viejos se descartan**: un consumidor de solo aviso ignora eventos de más de 48 h aunque esté en `hold`. Deshacer: subir `maxEventAge`.

---

## 10. Riesgos del plan de fases y cambios en la tabla de dependencias

### 10.1 Cambios que aplico en `docs/autonomous.md`

| Tarea | Antes | Ahora | Motivo |
|---|---|---|---|
| 0.3 | 0.2 | 0.2, **0.4** | El enlace mágico necesita la interfaz de correo y la guarda de desarrollo de 0.4. Sin ella, 0.3 inventaría su propio envío. Para que no haya dependencia circular, las tablas `FeatureFlag` y `Setting` y su lectura pasan a 0.4 (las necesitan sus consumidores de eventos), y 0.4 no expone rutas HTTP; 0.3 añade la administración de flags y ajustes, con permisos y auditoría. |
| 2.5 | 2.4, 0.5 | 2.4, **2.3**, 0.5 | La prueba de extremo a extremo de la fase 2 (buscar, configurar, solicitar, gestionar) solo se puede escribir cuando existen constructor, solicitud y bandeja; la asigno a 2.5. |
| 5.1 | 3.5 | 3.5, **4.6**, **5.4** | El área del cliente descarga recibos (4.6) y documentos PDF (5.4). |
| 7.3 | 1.2, 0.4 | 1.2, 0.4, **3.2**, **6.1** | Las fechas clave incluyen vencimiento de saldos (plan de pagos, 3.2) y liberación de cupos contratados (6.1). |
| 5.7 | resto de la fase 5, fase 4 cerrada | 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, fase 4 cerrada | Lista explícita. |
| 8.5 | fases 0 a 7 cerradas, 8.4 | fases 0, 1, 2, 3, 4, 5, 6 y 7 cerradas, **8.1, 8.2, 8.3**, 8.4, **8.6**, **8.7** | Una revisión de seguridad de todo el producto debe incluir el gestor de contenido, el monitor, el modo mantenimiento y el alojamiento elegido (mismo sitio para web y API, que sostiene la cookie y el CSRF; roles de base de datos). |
| 9.x | fase 4 cerrada, 8.5 | filas propias 9.1–9.4 | 9.1: fase 4 cerrada, 8.5. 9.2: 9.1. 9.3: 9.2 (solo si se eligieron adaptadores propios). 9.4: 9.1 (solo si se eligieron adaptadores propios). Riesgo alto salvo 9.4 (bajo). Encadenar 9.1→9.2→9.3 respeta las dos variantes del archivo de fase y el límite de dos hilos de riesgo alto. |

"Fase N cerrada" queda definido en una nota bajo la tabla: todas las tareas de la fase tienen `docs/done/N.M.md` en `main` y el PR del hilo de cierre de la fase está fusionado.

Comprobado con `node scripts/check-dependency-table.mjs` (sin dependencias; se puede ejecutar en cualquier momento): 61 filas, ninguna tarea que falte en un lado o en el otro, ningún identificador inexistente ni ciclo. "Fase N cerrada" se expande a todas las tareas de esa fase; 9.1 y 9.2 aparecen dos veces en `phase-9.md` (una por cada camino de pagos) a propósito.

### 10.2 Riesgos que no cambian la tabla

- **Sin claves de Stripe, la prueba e2e "pagar con la tarjeta de prueba de Stripe" no se puede ejecutar.** Y CI falla si hay pruebas saltadas. Propuesta para 3.3 y 3.6: la batería contra el sandbox real es un comando aparte (`test:sandbox`), no incluido en la batería por defecto ni saltado en ella; la e2e por defecto paga contra el simulador. **Pagar contra el simulador no cumple ese criterio de la fase 3: queda BLOQUEADO** (en `docs/done/3.3.md` y, al cerrar la fase, en `docs/BLOCKED.md`) hasta que Oscar ponga las claves y se ejecute `test:sandbox`. El adaptador de Stripe queda `experimental` mientras tanto.
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
4. Una solicitud sin revisar caduca a los 7 días (recordatorio a Oscar a los 3). Una aprobación sin depósito caduca a las 72 horas, salvo que haya un pago en curso (sección 6.2). Un pago manual pendiente vence a los 5 días hábiles. Todos ajustables.
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
16. Una reserva pagada (`balance_paid`) solo pasa a `completed` tras la fecha de salida del paquete.

---

## 12. Lo que este plan no hace

- No escribe código, migraciones ni configuración.
- No elige pasarela de pagos ni orquestador (0.7 y 3.1), ni alojamiento (0.7 y 8.7).
- No fija la semántica exacta de reglas de precio, posting del libro ni estados de `Payment`: son de 2.2 y 3.1, dentro de los invariantes y los requisitos P1–P12 de aquí.
- No cambia los archivos de fase ni los criterios de aceptación; solo la tabla de dependencias de `docs/autonomous.md`.
- No crea tablas de los módulos "más adelante".
