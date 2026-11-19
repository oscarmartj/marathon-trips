# Plan 0.1: arquitectura general y modelo de datos completo

- **Tarea:** 0.1 (riesgo: arquitectura). Sin código.
- **Fecha:** 2026-11-11
- **Fuentes leídas:** `docs/brief.md`, `docs/architecture.md`, `docs/modules.md`, `docs/payments.md`, `docs/web.md`, `docs/phases/phase-0.md` a `phase-9.md`, `.claude/rules/*.md`, `docs/autonomous.md`.
- **Quién lo usa:** cada hilo que cree tablas o módulos. Si una tarea necesita apartarse de este plan, lo dice en su propio plan y en su `docs/done/N.M.md`; no se reabre este documento salvo que el cambio afecte a varios módulos.

Los identificadores (tablas, campos, módulos, eventos, permisos) van en inglés. El texto, en español para Oscar.

Secciones: 1 convenciones · 2 monorepo · 3 módulos · 4 plataforma · 5 modelo de datos · 6 estados · 7 fallos · 8 pruebas · 9 decisiones · 10 riesgos y dependencias · 11 supuestos · 12 lo que no hace.

## Aparcado: dinero (decisión de Oscar, 2026-11-12)

> **Levantado el 2026-11-19 (decisión de Oscar).** El dinero deja de estar aparcado: 3.3, 3.4, 4.1 a 4.6, 6.2, 6.4, 6.6 y 9.1 a 9.4 se arrancan según la tabla de `docs/autonomous.md`, y los requisitos vinculantes de abajo (P1–P12, las celdas con dinero de 6.2, la tabla de padres de 1.1 y los 8 hallazgos) se aplican a la tarea que construye cada cosa. Siguen en pie las reglas de "Lo que no cambia nunca": sin modo real, sin claves reales, sin cuentas externas; un adaptador no probado contra un sandbox real se queda en `experimental` (el sandbox lo aporta Oscar: `docs/BLOCKED.md`). El texto de abajo se conserva como estaba el 2026-11-12.
>
> | Hallazgo | Tarea que lo cumple | Nota |
> |---|---|---|
> | 1. Reembolso manual/PayID (P13) | 3.4 (confirmación manual, referencia bancaria y dónde viven los datos bancarios de destino) y 4.5 (el reembolso manual: confirmado una sola vez, con paso de verificación reforzada y destino borrado con el cliente, 5.5) | pruebas `manual_refund_*` |
> | 2. Webhook casado por id interno, filtrado por la cuenta que lo recibe | 3.3 (webhooks de Stripe); lo repiten 4.1 (cuentas), 4.3, 4.4 y 9.x en cada adaptador nuevo | `webhook_metadata_id_from_other_account_not_matched` |
> | 3. `rateE9` en unidades mayores y exponentes por moneda | 6.2 (pagos a proveedores en otra moneda) y 6.6 (resultado y previsión de caja); 4.6 si el informe de dinero de clientes convierte monedas | `fx_conversion_respects_currency_exponents` (JPY/AUD); `ExchangeRate` ya existe desde 6.1 |
> | 4. Descuento acotado al componente; total nunca bajo 0 | Ya cumplido por 2.1; 3.2, 4.5 y 6.4 no deben romperlo (reembolsos y penalizaciones parten de la instantánea) | `discount_capped_at_component`, `total_never_negative`: no se reescriben |
> | 5. Cancelación del cliente → 409 hasta que existan políticas | 6.4 (retira el 409 solo cuando existen políticas y su cálculo); mientras, sigue en pie | `customer_cancellation_rejected_until_policies_exist` |
> | 6. GST acumulado por recibo, con nota de ajuste en reembolsos | 4.6 (recibos), con 4.5 (reembolsos) como origen del ajuste | `receipt_gst_sums_to_booking_gst` |
> | 7. Penalización mayor que lo cobrado | 6.4 (decide qué ocurre con lo no cobrado: no se cobra tras cancelar), con 4.5 para lo ya cobrado | Prueba nombrada por 6.4 al planificar |
> | 8. Criterio de la fase 6 sin prueba | Ya cumplido por 6.3 (`amendment_records_difference_and_keeps_original_snapshot`, `docs/done/6.3.md`); 6.4 y 6.6 no deben romperlo | |
>
> Las 3.3, 3.4 y 4.x escriben primero las pruebas de P1–P12 que les tocan; 6.2, 6.4 y 6.6 las de 6.2 y 6.4 (sección 8).

**Aparcado**, sin fecha: cobros reales, libro contable real, reembolsos, contracargos, conciliación, recibos y GST, divisas, pagos a proveedores y cancelación con penalización. Etiquetas "aparcada"/"parcial" en la tabla de `docs/autonomous.md`.

**Sí queda listo**, sin modo real: modelos y tipos con dinero en unidades menores enteras y moneda (1.1); motor de precios en la API (el frontend solo muestra lo que devuelve); `PaymentProvider` con simulador y batería de contrato (3.6), adaptadores en `experimental`; plan de depósito y saldo, endpoints y pantallas de pago (checkout, área del cliente, enlaces) contra el simulador.

**Requisitos vinculantes al retomarlo**: P1–P12 (5.5), las celdas con dinero de 6.2, la tabla de padres de 1.1 y los hallazgos abiertos de la ronda 18:

1. Reembolso de pagos manuales/PayID: quién lo confirma, referencia bancaria y dónde viven los datos bancarios de destino (P13: `manual_refund_confirmed_once_with_bank_reference`, `manual_refund_requires_step_up`, `manual_refund_destination_erased_with_customer`).
2. Al casar un webhook por id interno, filtrar por la cuenta que lo recibe (`webhook_metadata_id_from_other_account_not_matched`).
3. Unidad de `rateE9` (unidades mayores) y tabla de exponentes por moneda (`fx_conversion_respects_currency_exponents`, JPY/AUD).
4. Un descuento no supera el componente al que se aplica; el total nunca baja de 0 (`discount_capped_at_component`).
5. Cancelación por el cliente antes de 6.4 → 409 (`customer_cancellation_rejected_until_policies_exist`).
6. GST acumulado por recibo, con nota de ajuste en reembolsos (`receipt_gst_sums_to_booking_gst`).
7. Penalización mayor que lo cobrado: no se puede cobrar tras cancelar; lo decide 6.4.
8. Criterio de la fase 6 sin prueba: `amendment_records_difference_and_keeps_original_snapshot`.

---

## 1. Principios y convenciones

Estas reglas se aplican desde la primera migración. Varias se pueden comprobar con una prueba automática sobre el esquema de Prisma (sección 8).

### 1.1 Dinero

- Todo importe es un entero en unidades menores, en una columna con sufijo `Minor` (`totalMinor`, `amountMinor`), tipo `BigInt` de Prisma (`bigint` de PostgreSQL) **desde la primera migración**. Motivo: con `integer` (máximo 2 147 483 647) no caben importes de otras monedas (45 000 000 IDR con los 2 decimales de ISO 4217 son 4 500 000 000 unidades menores).
- **Toda fila que tiene una columna `*Minor` tiene su propia columna de moneda** (`Char(3)`, ISO 4217). Regla de emparejado: `fooMinor` usa `fooCurrency` si existe, y si no `currency` (por ejemplo `baseAmountMinor` usa `baseCurrency`). La prueba de convenciones (0.2) rechaza un `*Minor` sin su moneda emparejada. **Importe opcional, moneda obligatoria:** si un `*Minor` no es nulo, su moneda tampoco; y si esa moneda es **opcional** (solo existe para importes opcionales, como en `PriceRule`), es nula cuando todos ellos lo son (`CHECK`). La `currency` obligatoria de una fila (la de sus FK compuestas, como en `Package`) no entra en esa segunda regla. Así un descuento fijo de 5000 no puede quedar sin moneda.
- **Toda fila con dinero hereda moneda (y modo, si lo tiene) de un padre obligatorio**, con FK compuesta hacia un `@@unique` declarado en el padre; una FK con columna nula no se comprueba, así que el padre debe ser no nulo (o un `CHECK` lo exige). Tabla completa:

| Tabla con dinero | FK compuesta → padre (siempre `Restrict`, 5.10) |
|---|---|
| `RoomRate`, `ParticipationRate`, `ExtraRate` → `PriceVersion` → `Package` | `(parentId, currency)` |
| `Booking` | `(packageId, currency)` → `Package` si `catalogue`; `(quoteId, currency)` → `Quote` si `bespoke` (`CHECK` de no nulo según `kind`) |
| `BookingSnapshot`, `Cancellation`, `BookingAmendment`, `PaymentSchedule`, `Payment` (y `PartnerCommission`, más adelante) | `(bookingId, currency)` → `Booking` |
| `QuoteLine` | `(quoteId, currency)` → `Quote` |
| `PaymentScheduleItem` | `(scheduleId, bookingId, currency)` → `PaymentSchedule` |
| `PaymentAllocation` | `(paymentId, bookingId, currency)` → `Payment`; `(scheduleItemId, bookingId, currency)` → plazo |
| `Refund`, `Dispute` | `(paymentId, bookingId, providerAccountId, mode, currency)` → `Payment` |
| `Receipt` | `(paymentId, bookingId, mode, currency, amountMinor)` → `Payment`: misma moneda **e importe** |
| `Settlement` | `(providerAccountId, mode)` → `ProviderAccount` (moneda del abono, libre) |
| `SettlementLine` | `(settlementId, mode, currency)` → `Settlement`; `(paymentId, mode)` → `Payment`; `(refundId, mode)` → `Refund` |
| `LedgerEntry` | `(accountCode, currency, mode)` → `LedgerAccount`; `(transactionId, mode)` → `LedgerTransaction` |
| `SupplierPaymentItem` | `(supplierPaymentId, mode, currency)` → `SupplierPayment`; `(costItemId, mode, currency)` → `CostItem` |
| Sin padre natural: `Package`, `Quote`, `CostItem`, `SupplierPayment`, `Allotment`, `LedgerAccount`; configuración (`PriceRule`, `PromoCode`, `CancellationTier`, `RoutingRule`) | moneda propia; toda suma agrupa por moneda; el motor no aplica una configuración de otra moneda |

- En la API, los importes son `bigint` de JavaScript en todo el cálculo (nunca `number`). **En JSON viajan como cadena de dígitos** (`"123450"`), porque `bigint` no se serializa y un `number` pierde precisión por encima de 2⁵³. La API sigue rechazando importes absurdos (por encima de A$1 000 000 por línea, o su equivalente fijado por moneda en `Setting`), pero eso es validación de negocio, no un límite del tipo.
- **Signo de cada importe.** Por defecto, `CHECK (x >= 0)`; en importes de movimientos (`Payment`, `Refund`, `Dispute`, `SupplierPayment`, `SupplierPaymentItem`, `Receipt`), `> 0`. Solo admiten signo las columnas marcadas `/// @signed`: `LedgerEntry.amountMinor` (además `<> 0`), `PaymentAllocation.amountMinor`, `BookingAmendment.priceDifferenceMinor` y los importes de liquidación (`Settlement.grossMinor`, `feesMinor`, `netMinor`; `SettlementLine.amountMinor`, `feeMinor`), que pueden llegar negativos (comisión de disputa devuelta). La prueba de convenciones (0.2) exige un `CHECK` de signo en todo `*Minor` no marcado.
- Porcentajes en **puntos básicos** enteros, columnas con sufijo `Bps` (1000 = 10 %).
- Tipos de cambio (solo para costes de proveedor en otra moneda y finanzas): entero escalado `rateE9 BigInt` (tipo × 10⁹). No es dinero, pero así **el esquema no tiene ni una columna `Float` ni `Decimal`**, y eso se puede comprobar con una prueba.
- Coordenadas geográficas, si se guardan, como `latitudeE7 Int` y `longitudeE7 Int` (grados × 10⁷), por la misma regla.
- **Regla de redondeo única** para todo importe derivado de un porcentaje o una fracción (reglas de precio, `depositBps`, `penaltyBps`, GST): entera, **a la unidad menor, mitad hacia arriba sobre el valor absoluto, línea a línea**; el total suma líneas ya redondeadas. La prueban 2.1, 3.2, 6.4 y 4.6. **GST por componente:** cada línea lleva su tratamiento (gravada o libre; alojamiento y servicios en el extranjero, en principio libres); GST = 1/11 de las líneas gravadas, repartido entre recibos y plazos por mayor resto. 4.6 lo confirma; Oscar lo valida con su contable (`FINAL-REVIEW`).
- **Pagos en otra moneda** (proveedor en EUR pagado desde AUD): dos lados cuadrados cada uno en su moneda a través de `fx_conversion` (AUD: banco → `fx_conversion`; EUR: `fx_conversion` → `supplier_payable`); `fxRateE9` y `baseAmountMinor` los relacionan y 6.6 informa de la diferencia. Lo concreta 6.2.
- En TypeScript, el tipo compartido es `Money = { amountMinor: bigint; currency: CurrencyCode }`; en los esquemas zod compartidos por API, `packages/shared` y web, `amountMinor` es `z.string().regex(/^-?\d+$/)` transformado a `bigint`, y la salida lo serializa como cadena. La web nunca hace aritmética con importes: los formatea. `packages/shared` solo tiene utilidades para **formatear** dinero, nunca para calcular totales.

### 1.2 Identificadores, tiempo y concurrencia

- Clave primaria: UUID v7 (`String @id @default(uuid(7)) @db.Uuid`; si la versión de Prisma no lo admite, `uuid()` v4). Se ordena por tiempo y no revela volumen.
- Referencias legibles para personas, únicas y no secuenciales: reserva `MT-7K3Q9P` (Crockford base32, 6 caracteres), reclamación `CMP-…`. Los recibos sí son secuenciales (`NumberSequence`), porque un registro contable lo espera.
- Instantes en `timestamptz(3)`, siempre en UTC. **Fechas de calendario** (fecha de carrera, entrada y salida del hotel, fecha límite del saldo) en `@db.Date`, sin hora.
- Zona horaria del negocio: `Australia/Brisbane` (sin horario de verano), guardada en `Setting.businessTimeZone`. "Días antes de la salida" = días de calendario entre hoy en esa zona y `Booking.departureDate`. Un plazo "vence el día X" vence al final del día X en esa zona.
- Bloqueo optimista: los agregados editables desde el panel tienen `version Int @default(0)`; el panel envía la versión que leyó y la API responde 409 si ha cambiado.
- Cupos y contadores (plazas, usos de un código) se modifican con `UPDATE … SET consumed = consumed + n WHERE id = $1 AND consumed + n <= capacity` dentro de la transacción, con restricción `CHECK (consumed BETWEEN 0 AND capacity)` como red de seguridad.
- **Todo cambio de estado o contador es compare-and-set** (`WHERE status = $from`, `WHERE consumed + n <= capacity`) o va tras `SELECT … FOR UPDATE` de la fila dueña. **Orden de bloqueo global** y reintento ante interbloqueo: sección 6.3.
- **Claves de idempotencia de negocio** (`Payment`, `Refund`, `SupplierPayment`, `LedgerTransaction`): las genera el **servidor**, desde el objeto **con número de intento**, calculado con el pago bloqueado (`booking:<id>:attempt:<n>`; reembolsos `cancellation:<id>:<paymentId>:attempt:<n>`, `overpayment_return:<paymentId>:attempt:<n>`, `price_reduction:<amendmentId>:<paymentId>:attempt:<n>`: un reembolso `failed` se reintenta con clave nueva, `failed_refund_retried_with_new_key`) o como hash del ámbito de `IdempotencyRecord` más la clave del cliente; nunca la cabecera en bruto, y toda búsqueda por clave filtra también por reserva o actor (`same_client_key_different_customers_isolated`, 3.2).
- **Unicidad con columnas que admiten NULL.** Si NULL significa "ninguno" (plazo de una asignación de sobrepago), el índice se crea con `NULLS NOT DISTINCT` (PostgreSQL 15+). Si NULL significa "aún no se sabe" (referencia de la pasarela antes de su respuesta), el índice deja NULL libres y un `CHECK` exige el valor en cuanto el estado lo necesita.

### 1.3 Columnas comunes

| Columna | Dónde | Para qué |
|---|---|---|
| `createdAt`, `updatedAt` | todas | |
| `version` | agregados editables en el panel | bloqueo optimista |
| `deletedAt`, `deletedById` | entidades con borrado lógico (marcadas **SD** en la sección 5) | borrado lógico y restauración (0.5) |
| `customFields Json @default("{}")` | Race, Package, Customer, Traveller, Booking, Supplier (marcadas **CF**) | campos personalizados (7.5), con índice GIN |
| `isDemo Boolean @default(false)` | raíces de datos de ejemplo: Race, Hotel, Customer, Booking, Supplier | datos demo imposibles de publicar (1.5) |
| `/// @pii`, `/// @nopii <motivo>` o `/// @secret` | toda columna de texto, `String[]`, `Json` o `Bytes` de todo modelo, y **toda columna que no sea clave, de cualquier tipo** (fechas, enteros, `Char(n)`), en los modelos con `customerLink`; texto libre y `customFields` siempre `@pii`; sin anotar = `@pii` | datos personales (4.9), secretos (4.7) |

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
      modules/               módulos de negocio (con flag salvo los de dinero, 3.1), uno por fila de la tabla 3.2:
                             catalogue, pricing, bookings, crm, customer-portal, alerts, templates, dashboard,
                             suppliers, changes, waitlist, operations, finance, content, complaints, reporting,
                             automations, integrations; más adelante groups, partners, campaigns, reviews, bespoke
        payments/core/       libro, plan de pagos, enrutado, cuentas, webhooks, conciliación
        payments/adapters/   simulator (3.6), manual (3.4), stripe (3.3)… uno por pasarela, aislados
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
scripts/check-dependency-table.mjs   comprueba la tabla de dependencias de docs/autonomous.md (0.1; CI lo ejecuta desde 0.2)
```

Decisiones de herramientas que 0.2 concreta (versiones estables actuales al empezar):

- **pnpm workspaces + Turborepo**, Node LTS activo.
- **Validación:** zod en `packages/shared`; la API valida con esos esquemas y genera el OpenAPI (p. ej. `nestjs-zod`); el cliente tipado (`openapi-typescript` + `openapi-fetch`) se versiona y CI falla si difiere.
- **Pruebas:** Vitest (con SWC) para unitarias e integración, contra PostgreSQL real con un esquema por proceso; Playwright para e2e.
- **Fronteras entre módulos** comprobadas en lint (`dependency-cruiser` o reglas `no-restricted-imports`): un módulo solo importa de `platform/*` y del `index.ts` público de otro módulo.
- **`docker-compose`**: servicios `db` (PostgreSQL), `mail` (Mailpit), `api` y `web`; `docker compose up` migra, ejecuta el seed demo y deja todo funcionando (criterio de la fase 0). Seed por capas: 0.2 el comando `db:seed` (idempotente, se niega en `production`); 0.3 el personal demo (`owner@example.test`, contraseña y TOTP impresos solo en `development`); 0.5 la tabla de ejemplo; 1.5 el catálogo. **Sin Redis**: tareas, límites y caché sobre PostgreSQL o en memoria (una instancia de API); ninguna tarea lo añade.
- Almacenamiento en desarrollo: sistema de archivos. El adaptador S3 se prueba con la misma batería contra un emulador S3 si 0.4 encuentra uno libre y ligero; si no, queda marcado como no probado.

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

**Dinero y estado van juntos, sin eventos:** bookings declara **ganchos síncronos** (`onApproved`, `onAmended`, `onCancelled`) que payments registra al arrancar (bookings no importa payments), y payments llama a `bookings.applyCoverage`, todo en la misma transacción. Los eventos quedan para efectos secundarios.

**Feature flag por módulo.** Los módulos `catalogue`, `pricing`, `bookings` y `payments` **no tienen flag**: no se pueden apagar, y los webhooks entrantes de pasarelas siempre se reciben (una cuenta pausada, retirada o archivada sigue procesándolos). El resto de módulos tiene flag. Si el flag está apagado: sus rutas responden 404 y sus tareas programadas no se ejecutan. Para los eventos, cada consumidor declara `whenDisabled`:

- `hold`: el evento queda `pending` y se procesa al encender el módulo. **Obligatorio para todo consumidor de eventos `payments.*`, `bookings.*` y `changes.*`** (dinero y estados de reserva); una prueba de 0.4 recorre los consumidores registrados y falla si alguno de esos eventos tiene `skip`.
- `skip`: el evento se marca `skipped` (para índices, analítica, correos informativos); si el módulo necesita el pasado, lo reconstruye desde las tablas.
- Además, un consumidor **de solo aviso** (correo, webhook saliente) declara `maxEventAge` (por defecto 48 h): al procesar un evento más viejo, aunque sea de `bookings.*` y esté en `hold`, lo marca `skipped` sin avisar. Los que cambian estado o dinero no pueden declararlo.

El flag se lee en cada petición, sin reiniciar.

**Añadir un módulo** = crear la carpeta, su archivo `.prisma` y una línea en `modules.registry.ts`. Del resto solo se tocan, en el archivo del padre, los **campos inversos de relación** que Prisma exige (sin columnas ni lógica); una FK hacia un módulo posterior la añade ese módulo en su migración (por ejemplo `Booking.quoteId`, 2.5).

### 3.2 Mapa de módulos, nivel, tarea que lo crea y eventos principales

| Módulo | Nivel | Tarea | Publica (ejemplos) | Escucha (ejemplos) |
|---|---|---|---|---|
| platform (events, jobs, storage, mail, tablas y lectura de flags y ajustes, registro de entidades con `customerLink`) | base | 0.4 | — | — |
| platform (auth, access, audit, administración de flags y ajustes) | base | 0.3 | `auth.user.loggedIn`, `access.role.changed` | — |
| platform/common | base | 0.5 | `common.note.added` | todos (índice de búsqueda) |
| catalogue | núcleo | 1.1 | `catalogue.package.saleStatusChanged`, `catalogue.race.published` | — |
| pricing | núcleo | 2.1, 2.2 | `pricing.priceVersion.published` | — |
| bookings | núcleo | 2.4 | `bookings.booking.requested`, `…statusChanged` | — (la cobertura le llega por comando síncrono, 6.2) |
| crm | núcleo | 2.5 | `crm.quote.sent` | `bookings.*` (correos por cambio de estado) |
| waitlist | núcleo / 2.ª ola | 2.6, 6.5 | `waitlist.entry.offered` | `bookings.booking.cancelled`, `catalogue.inventory.released` |
| payments | núcleo | 3.x, 4.x | `payments.payment.succeeded`, `payments.refund.completed`, `payments.reconciliation.mismatch` | — (registra el gancho síncrono de aprobación, cambio y cancelación de bookings) |
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

- API REST con OpenAPI. **Toda ruta declara exactamente una marca de acceso**: `@Public(expone)`, `@OwnedBy(...)` (cliente: cómo comprueba que el recurso es suyo) o `@RequirePermission(...)` (personal o clave de API). Una guarda global **deniega** la ruta sin marca o con dos, y una prueba de 0.3 recorre **todas** las rutas registradas, sin mirar prefijos (`every_route_has_exactly_one_access_mark`). `@Public` dice qué expone: webhooks (firma), enlace mágico, alertas, páginas públicas y el token de `PaymentLink` (sin sesión; solo referencia, paquete, fechas, moneda e importe pendiente; límite de peticiones).
- Sesión en cookie `httpOnly`, `Secure` (salvo en local), `SameSite=Lax`. La web y la API deben estar en el **mismo sitio** (mismo dominio registrable, o la web hace de proxy de `/api`): 8.7 lo concreta.
- CSRF: comprobación de `Origin` más cabecera propia obligatoria en toda petición que cambia datos. Los webhooks entrantes de pasarelas quedan fuera (los protege la firma).
- Límites de peticiones en memoria (`@nestjs/throttler`), más estrictos en inicio de sesión, enlace mágico, solicitud de reserva y suscripción a alertas.
- Logger estructurado con redacción por rutas (cookies, `authorization`, cuerpos de auth y pagos, campos `@pii`). Nunca se registra el cuerpo de una petición de pagos ni de autenticación, y los tokens se redactan también en ruta y query, en los registros de API y web; las páginas con token llevan `Referrer-Policy: no-referrer` (`token_urls_redacted_in_logs`). **Errores guardados** (logs, `SystemErrorEvent`, `EventDelivery.lastError`, pg-boss): solo código y mensaje de clases de error conocidas, nunca `detail`, `where` ni `meta` de PostgreSQL o Prisma, que traen valores (`unique_violation_error_does_not_store_value`, 0.4).
- CORS restringido al origen de la web.

### 4.2 Autenticación (0.3)

- **Dos tipos de usuario separados**: `User.kind = staff | customer`, con `@@unique([kind, email])`. Una sesión de cliente nunca puede convertirse en sesión de personal, aunque el correo coincida.
- **Clientes:** enlace mágico de un solo uso, 15 minutos, token aleatorio de 32 bytes guardado como hash. La respuesta a "envíame un enlace" es idéntica exista o no el correo. El GET del enlace muestra una página y solo un POST consume el token, para que los escáneres de correo no lo gasten (`magic_link_get_does_not_consume_token`). El usuario `customer` se crea al verificar el enlace.
- **Personal:** contraseña con argon2id más TOTP obligatorio para todo el personal; un código TOTP no se acepta dos veces (`User.totpLastUsedStep`, actualizado con compare-and-set). Tras fallos, **retraso progresivo** por cuenta e IP, sin bloqueo definitivo (nadie puede dejar fuera al único `owner`). Códigos de recuperación con hash. **Sin recuperación por correo**: el primer propietario se crea y recupera por consola (`pnpm api:cli staff:create`, `staff:reset`).
- **Step-up:** `Session.mfaVerifiedAt`; TOTP en los últimos 5 minutos, con auditoría, para: cuentas y credenciales de pasarela, enrutado, **instrucciones de métodos manuales**, **confirmar o anular un pago manual**, reembolsos, roles, claves de API, webhooks salientes, exportar todo y **exportar o anonimizar un cliente**. La lista vive en los manifiestos de permisos (`requiresStepUp`, 4.3); sin `mfaVerifiedAt` reciente se deniega.
- Sesiones opacas en base de datos (token como hash), revocables. Duraciones por defecto: personal, 12 h absolutas y 2 h de inactividad; cliente, 30 días absolutos y 7 días de inactividad.
- Librería: 0.3 evalúa primero una librería mantenida (por ejemplo Better Auth) contra estos requisitos (separación de tipos, step-up, tokens con hash, nombres de tabla de este plan). Si no los cumple sin parches, implementación propia fina sobre primitivas probadas (`@node-rs/argon2` o `argon2`, `otpauth`). Lo anota en su `done`.

### 4.3 Permisos (0.3)

- `Permission` lo declaran los módulos en código y se sincroniza al arrancar; `Role` y `RolePermission` se editan en el panel (matriz).
- Roles de sistema: `owner` (todos los permisos, no editable, no se puede quedar sin ningún usuario: quitar el rol o desactivar a un `owner` bloquea antes la fila del rol `owner` con `FOR UPDATE` y cuenta los que quedan, para que dos `owner` no se quiten el rol a la vez) y `customer` (implícito: solo sus propios recursos, comprobado por propiedad, no por matriz).
- `UserRole.scope Json?`: ámbito opcional (por ejemplo `{ "editionIds": [...] }`) para dar a un guía acceso solo a su viaje. **Falla en cerrado:** 0.3 crea la columna con `CHECK (scope IS NULL)`, la API rechaza asignar un ámbito (422) y la guarda de permisos trata cualquier ámbito no nulo como "denegar". La tarea que implemente el filtrado quita el `CHECK` en su migración, con sus pruebas.
- **El step-up va unido al permiso**, no a la ruta: el manifiesto del módulo marca `requiresStepUp` en cada permiso sensible (lista de 4.2) y la guarda lo aplica en toda ruta con ese permiso (`step_up_enforced_from_permission_manifest`).
- Claves de API (8.4): los permisos efectivos de un `ApiKey` se calculan **en cada petición** como `scopes ∩ permisos actuales del dueño`. Si el dueño pierde un permiso, la clave lo pierde; si el dueño está desactivado o borrado, la clave es inválida; una clave nunca ejerce un permiso `requiresStepUp` (`api_key_cannot_use_step_up_permission`).

### 4.4 Auditoría (0.3)

- `AuditLog` se escribe **en la misma transacción** que el cambio, desde un servicio de plataforma (no por evento, para no perder ninguno).
- Se audita: toda acción del personal, de una automatización o de una clave de API; todo cambio de estado, precio, cupo, pago, permiso, credencial y ajuste; inicios de sesión y fallos.
- `changes` guarda `{ campo: { before, after } }` **solo para campos `@nopii`** (sin anotar = `@pii`). Los `@pii` y **el motivo del personal** (`_reason`) van a `AuditPiiValue`, con la marca `"[pii]"` en `changes`; los `@secret`, solo `"[changed]"`. `AuditLog` no tiene texto libre ni IP (la IP truncada está en `Session`), y `actorId`, `sessionId` y `entityId` son UUID **sin clave ajena**: inmutable de verdad y compatible con el borrado.
- `AuditPiiValue.subjectCustomerId` y `subjectUserId` los rellena el servicio de auditoría desde el `customerLink` del registro de entidades (lo crea 0.4; 0.5 le añade filtros, columnas y CSV). Un `User` de cliente es su propio sujeto (`subjectUserId`), porque existe antes que su `Customer` (2.4) y se enlaza por `Customer.userId`; el borrado elimina las filas de los dos. Sin cliente ni usuario cliente: NULL y purga a los 7 años.
- Las columnas `@secret` (4.7) se auditan solo como `"[changed]"`.
- `AuditLog` no se edita: un disparador rechaza `UPDATE`, `DELETE` y `TRUNCATE` **sin excepciones**. `AuditPiiValue` solo admite `DELETE` dentro de `privacy_erase_customer` y de la purga por retención.
- El "historial de cambios por registro" (0.5) es una consulta sobre `AuditLog` por `entityType` y `entityId`; no hay otra tabla de historial.

### 4.5 Eventos y tareas (0.4)

- **Outbox:** el `OutboxEvent` se escribe en la misma transacción que el cambio. Un **despachador** toma los pendientes con `FOR UPDATE SKIP LOCKED` y crea un trabajo de pg-boss por consumidor (clave única `consumer:eventId`).
- **Consumidores:** al menos una vez, idempotentes por `EventDelivery` (`@@unique([eventId, consumer])`), con reintentos crecientes y `failed` visible en el monitor (`lastError` según 4.1). Cargas con identificadores, sin datos personales. Sin orden entre agregados; dentro de uno, `aggregateVersion`. Purga a los 90 días.
- **Flags y ajustes:** tablas y lectura en 0.4; administración en 0.3.
- **pg-boss** en su propio esquema (`pgboss`), para tareas puntuales y programadas; exige una API siempre encendida (sección 10).
  - **El esquema lo crean las migraciones como `mt_owner`**: se desactivan la creación y migración automáticas de pg-boss y su SQL se guarda como migración; si crear una cola exige DDL, las colas de los módulos se crean en ese mismo paso y la API no arranca si falta alguna. `mt_app` solo recibe `SELECT/INSERT/UPDATE/DELETE` en `pgboss` y `EXECUTE` en sus funciones.
  - Los datos de un trabajo llevan identificadores, nunca datos personales ni importes calculados; el error guardado sigue 4.1. Trabajos terminados se borran a los 7 días.

### 4.6 Archivos y correo (0.4)

- `FileStorage`: `put`, `get`, `delete`, `signedUrl`; 0.4 entrega la interfaz y sus adaptadores, sin rutas. Los archivos privados los sirve el módulo dueño con permiso o URL firmada corta.
- `MailSender`: `send(message)`. Adaptador SMTP (Mailpit en local). Todo envío pasa por `OutboundEmail` (registro y cola), con `dedupeKey` único derivado del hecho que lo provoca (`booking:<id>:approved`). **Ni `OutboundEmail` ni los datos de un trabajo guardan secretos ni el cuerpo renderizado**: un token de un solo uso (enlace mágico, `PaymentLink`, confirmar alerta) se acuña **dentro del paso de envío**, en la misma transacción que guarda su hash, y cada reintento acuña uno nuevo e invalida el anterior; los enlaces de baja usan un HMAC del id con una clave del servidor (`one_time_tokens_never_persisted_in_plaintext`, 0.3 y 0.4).
- **Guarda de desarrollo:** salvo `MAIL_MODE=live` **y** `APP_ENV=production` a la vez (fuera de producción `MAIL_MODE=live` se ignora con aviso; un valor desconocido cuenta como no live), la plataforma **rechaza enviar** fuera de `MAIL_DEV_ALLOWLIST` (por defecto `example.test` y `example.com`) y lo registra como `suppressed`: ni una tarea ni una copia de producción en staging escribe a una persona real.
- Supresiones (bajas y rebotes) en `EmailSuppression`, solo con un HMAC del correo: sobrevive al borrado sin conservar el dato. Marketing la consulta siempre; los transaccionales no.

### 4.7 Secretos en reposo

- AES-256-GCM con clave maestra en variable de entorno (`APP_ENCRYPTION_KEY`), con `keyVersion` en cada fila cifrada para poder rotarla.
- Se cifran: credenciales y secretos de webhook de pasarelas, secreto TOTP, secretos de webhooks salientes.
- **`/// @secret`** marca toda columna con un secreto, hash de credencial o token (`passwordHash`, `RecoveryCode.codeHash`, `tokenHash`, `ApiKey.secretHash`, `*Ciphertext`, `webhookPathTokenHash`…): la prueba de convenciones (0.2) la exige en toda columna `*Hash`, `*Ciphertext`, `*Secret*` y `*Token`; la API nunca la devuelve, el logger la redacta y la auditoría guarda solo `"[changed]"`, ni en `changes` ni en `AuditPiiValue` (`secret_columns_never_serialised_logged_or_audited`, recorre todas las `@secret` y el historial de 0.5; lo único que se enseña una vez es el valor recién creado, nunca la columna: `webhook_url_shown_once_and_regenerated_with_step_up`).

### 4.8 Ajustes y flags

- `FeatureFlag`: interruptores booleanos (módulos y funciones). Tablas y lectura en 0.4; administración en 0.3. Un flag que no existe o no se puede leer cuenta como apagado (los módulos de dinero no tienen flag, sección 3.1).
- `Setting`: ajustes del negocio con valor tipado y validado: `businessTimeZone`, `salesCountries` (`["AU"]`), `gstRegistered` (`false`), `defaultCurrency` (`AUD`), plazos de caducidad de solicitudes y aprobaciones, `maintenanceMode`, retenciones. Abrir otro país es cambiar `salesCountries`.
- `APP_ENV` (`development`, `test`, `staging`, `production`) es **obligatorio y sin valor por defecto**: la API no arranca si falta o tiene otro valor.
- **Guarda de producción para toda llamada externa.** Con `APP_ENV` distinto de `production`:
  - **Pasarelas:** ninguna llamada con una cuenta `live`, sea cual sea la operación, impuesto en el envoltorio único `ProviderGateway`; el cifrado **no descifra** credenciales `live`. Falla con `live_call_blocked_outside_production`, se audita y no cambia estados ni libro, aunque una copia de producción en staging (8.6) comparta `APP_ENCRYPTION_KEY`.
  - **Webhooks salientes** (8.4): igual que el correo, solo a URL de `WEBHOOK_DEV_ALLOWLIST` (vacía por defecto); el resto se registra como `suppressed`.
  - **Automatizaciones** (7.4): solo actúan a través de correo, webhooks y tareas, así que heredan las dos guardas.

### 4.9 Datos personales

- **Anotación obligatoria** (1.3): todo texto libre es `@pii`; un `@nopii` en un `Json` solo vale si su esquema zod no admite texto libre. Un script genera el registro de campos personales que usan logger, auditoría y privacidad.
- **Registro de entidades con `customerLink`** (`platform/entities`): cada modelo ligado a un cliente declara su ruta hasta `customerId` y sus manejadores `export` y `anonymise`; una prueba (5.5) recorre el DMMF y falla si falta un modelo con camino hasta `Customer`, `Traveller`, `Booking`, `Quote` o `Complaint`, o un manejador. **La lista de borrado sale de ese registro, no de una tabla escrita a mano.** Las tablas **polimórficas** (`Note`, `Task`, `Attachment`, `Tagging`, `KeyDate`, `SearchDocument`), que apuntan con `entityType`/`entityId` sin relación de Prisma, se declaran como tales en el registro (la prueba falla si un modelo con esas columnas no lo hace) y el borrado las trata por `(entityType, entityId)` cuando la entidad es del cliente: él, sus reservas, viajeros, presupuestos y reclamaciones (`Note.body`, `Task.title` y `description` redactados; adjuntos borrados con su archivo).
- **Sin texto libre en tablas inmutables ni en lo que no se borra:** libro (descripción generada desde códigos), `PaymentAllocation`, `InventoryMovement`, `AuditLog` (4.4), instantáneas (viajeros como "plaza 1"; líneas a medida por `quoteLineId`), outbox, trabajos, enlaces de pago, `AutomationRun.steps`, `CsvJob.errors` (fila, columna y código), `KeyDate.title` y `Dispute.reasonCode`.
- **Roles de base de datos (0.2 los crea, 0.3 añade los disparadores).** `mt_owner`, dueño de tablas y esquemas (incluido `pgboss`), solo para migraciones; `mt_app`, el de la API, con `SELECT`/`INSERT`/`UPDATE`/`DELETE` tabla a tabla, **sin `CREATE` ni `TEMPORARY`** y sin ser dueño de nada (no puede crear objetos, desactivar disparadores, alterar tablas ni hacer `TRUNCATE`); `mt_privacy` es un rol `NOLOGIN`, dueño de las funciones `privacy_erase_customer(customerId)` (que repite la comprobación de viaje activo y aborta) y `privacy_purge_expired()`, declaradas `SECURITY DEFINER` con **`SET search_path = pg_catalog, public, pg_temp`** y todos los objetos cualificados con su esquema; `EXECUTE` revocado a `PUBLIC` y concedido solo a `mt_app`. `docker-compose` y las pruebas crean los tres; el alojamiento debe admitir varios roles (lo anota 8.7).
- **Tablas inmutables.** Todo modelo **Ap** lleva `/// @appendOnly` y un disparador que rechaza `UPDATE`, `DELETE` y `TRUNCATE`. **Sin excepción:** `AuditLog`, `InventoryMovement`, `ExchangeRate`, `BookingSnapshot`, `PaymentAllocation`, `LedgerTransaction`, `LedgerEntry` y `TermsVersion` publicada. **Con excepción** solo para `current_user = 'mt_privacy'` (que solo se da dentro de sus dos funciones, sin parámetros de columnas ni SQL, y auditadas) y solo en las columnas y valores de la tabla siguiente: `AuditPiiValue`, `TermsAcceptance`, `ConsentRecord` y `ComplaintEvent`. Sus claves ajenas solo apuntan a filas que nunca se borran físicamente; a actores, sesiones y usuarios, UUID sin FK. **Sin variable de sesión** como salida de emergencia: `mt_app` podría fijarla.

| Tabla | Qué se conserva y por qué | Qué hace el borrado |
|---|---|---|
| `AuditPiiValue` | — | `DELETE` de las filas del cliente; las que no son de ningún cliente, a los 7 años |
| `TermsAcceptance` | fila con `customerId`, versión y fecha: prueba del contrato ante disputas y reclamaciones (obligación contractual y defensa legal, 7 años) | `ipAddress` y `userAgent` a `NULL` |
| `ConsentRecord` | fila con HMAC del correo (clave del servidor con `keyVersion`, rotación documentada, como `EmailSuppression`), finalidad, fecha y texto: prueba de consentimiento y de baja (Spam Act 2003) | `email` a `NULL`; queda `emailHash` |
| `ComplaintEvent` | fila, tipo y fecha: procedimiento de reclamaciones demostrable (7 años) | `body` se sustituye por `[redacted]` |

- **Qué hace el borrado de un cliente (5.5).** Bloquea `Customer` → sus `Booking` y responde 409 si tiene una reserva con salida futura no cancelada, un intento de cobro vivo o una disputa abierta (`erasure_rejected_with_active_trip`); Operaciones necesita esos viajeros. Regla general: en cada modelo registrado con `customerLink`, las columnas `@pii` se anonimizan (`[redacted]`, `{}` en `customFields`, NULL si admite NULL; un correo único se sustituye por `erased+<uuid>@invalid` para no chocar con su índice: `erasing_two_customers_succeeds`; un país obligatorio, por `ZZ`) y las filas sin valor propio se borran (`Session`, `LoginToken`, `AlertSubscription`, `WaitlistEntry`, `AuditPiiValue`, adjuntos y sus archivos). Además:

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

Siete ejes que cada tarea aplica a sus tablas nuevas: datos personales (4.4, 4.9), idempotencia por objeto de negocio (1.2, P5), prueba/real y producción (4.8), concurrencia y bloqueos (6.3), fallo en cerrado (4.1–4.8), dinero (1.1, 5.5) y reversibilidad: nada se edita ni se borra (6.2).

Riesgo aceptado: un nombre de cliente escrito en el motivo de un cambio sobre algo no ligado a él (p. ej. un rol) no se borra con el cliente; se purga a los 7 años.

---

## 5. Modelo de datos completo

Notación: **SD** = borrado lógico; **CF** = campos personalizados; **Ap** = solo se añaden filas (nunca se editan ni borran); **pii** = contiene datos personales. "Tarea" es la que crea la tabla. Archivo = archivo `.prisma` en `apps/api/prisma/schema/`.

### 5.1 Plataforma (`platform-*.prisma`)

| Entidad | Campos principales | Restricciones y notas | Tarea |
|---|---|---|---|
| **User** (pii) | `kind` staff/customer, `email` citext, `emailVerifiedAt`, `status` active/disabled, `passwordHash?`, `totpSecretCiphertext?`, `totpKeyVersion?`, `totpEnabledAt?`, `totpLastUsedStep BigInt?`, `failedLoginCount`, `nextLoginAllowedAt?`, `lastLoginAt?`, `anonymisedAt?` | `@@unique([kind, email])`. `passwordHash` y TOTP solo para `staff` (check) | 0.3 |
| **RecoveryCode** | `userId`, `codeHash`, `usedAt?` | | 0.3 |
| **Session** (pii) | `userId`, `tokenHash` único, `createdAt`, `expiresAt`, `idleExpiresAt`, `lastSeenAt`, `mfaVerifiedAt?`, `userAgent?`, `ipPrefix?`, `revokedAt?` | IP truncada (/24, /48); las de personal se conservan 90 días tras caducar (las referencia `AuditLog.sessionId`) | 0.3 |
| **LoginToken** (pii) | `email`, `userId?`, `purpose` magic_link, `tokenHash` único, `expiresAt`, `consumedAt?` | un solo uso | 0.3 |
| **Role** | `key` único, `name`, `description`, `isSystem` | | 0.3 |
| **Permission** | `key` único, `module`, `description` | sincronizada desde código | 0.3 |
| **RolePermission** | `roleId`, `permissionKey` | PK compuesta | 0.3 |
| **UserRole** | `userId`, `roleId`, `scope Json?` | `CHECK (scope IS NULL)` hasta que exista el filtrado por ámbito (sección 4.3) | 0.3 |
| **AuditLog** (Ap) | `occurredAt`, `actorType` staff/customer/system/automation/api_key, `actorId?`, `action`, `entityType`, `entityId`, `changes Json` (solo campos `@nopii`), `requestId?`, `sessionId?` | `actorId`, `entityId` y `sessionId` sin FK; sin texto libre ni IP (sección 4.4); disparador anti-modificación sin excepciones; índice `(entityType, entityId, occurredAt)` | 0.3 |
| **AuditPiiValue** (pii, Ap) | `auditLogId`, `field` (`_reason` para el motivo), `before?`, `after?`, `subjectCustomerId?`, `subjectUserId?` | solo se borra al anonimizar o por retención (7 años si no es de ningún cliente) | 0.3 |
| **FeatureFlag** | `key` único, `enabled`, `description` | administración en 0.3 | 0.4 |
| **Setting** | `key` único, `value Json`, `schemaVersion` | validado por esquema del código; administración en 0.3 | 0.4 |
| **OutboxEvent** | `type`, `schemaVersion`, `aggregateType`, `aggregateId`, `aggregateVersion?`, `payload Json`, `actorType`, `actorId?`, `occurredAt`, `dispatchedAt?` | índice parcial sobre pendientes | 0.4 |
| **EventDelivery** | `eventId`, `consumer`, `status` pending/done/failed/skipped, `attempts`, `lastError?`, `processedAt?` | `@@unique([eventId, consumer])` | 0.4 |
| **IdempotencyRecord** | `scope` (= `actorType:actorId:route`; en una ruta `@Public` con token, como la de `PaymentLink`, `actorType = token` y `actorId` = hash del token; una ruta `@Public` sin token no admite idempotencia), `actorType`, `actorId`, `key`, `requestHash`, `status` in_progress/completed, `responseStatus?`, `errorCode?`, `resourceType?`, `resourceId?`, `lockedUntil?`, `expiresAt` | `@@unique([scope, key])`; misma clave con otro cuerpo → 422; caduca a las 24 h. **Sin cuerpo de respuesta**: al repetir, mismo estado HTTP y representación actual de `resourceId` (409 si enseñaba un secreto una sola vez). No sustituye a la idempotencia del negocio | 0.4 |
| **StoredFile** | `storageKey` único, `contentType`, `sizeBytes`, `checksumSha256`, `originalName?`, `visibility` private/public, `purpose`, `uploadedById?` | | 0.4 |
| **OutboundEmail** (pii) | `to`, `templateKey`, `templateVersion`, `locale`, `subject`, `bodySha256` (huella, nunca el cuerpo), `dedupeKey` único, `status` queued/sent/failed/suppressed, `providerMessageId?`, `customerId?`, `relatedEntityType?`, `relatedEntityId?`, `error?` (`@pii`: un rebote puede citar el correo), `sentAt?` | se anonimiza al borrar un cliente. El paquete de pruebas de una disputa (4.5) lista los correos de la reserva con fecha, plantilla y versión, asunto, estado y huella; el texto se reconstruye con esa versión de plantilla (`dispute_pack_lists_emails_with_template_version`) | 0.4 |
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
| **Package** (SD, CF) | `editionId`, `slug`, `name LocalizedText`, `saleStatus`, `checkInDate`, `checkOutDate`, `includes LocalizedText`, `excludes LocalizedText`, `instantBooking`, `autoConfirmOnDeposit` (por defecto `true`, como el flujo del brief), `depositMode` per_person/per_booking/percent, `depositAmountMinor?`, `depositBps?` (el motor usa `min(depósito, total)`: `deposit_capped_at_total`, 2.1), `balanceDueDate @db.Date`, `minTravellers`, `maxTravellers`, `maxExtraNightsBefore`, `maxExtraNightsAfter`, `currency`, `cancellationPolicyId?`, `seo Json`, `publishedAt?` | `@@unique([editionId, slug])`, `([id, currency])`; check `checkOutDate > checkInDate`; `isDemo` se hereda de la carrera |
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
| **PriceRule** | `scopeType` global/edition/package, `scopeId?`, `kind` early_bird/late_supplement/group_discount/occupancy_supplement/custom, `direction` discount/surcharge, `conditions Json` (tipada por `kind`), `effectMode` percent/fixed, `valueBps?`, `valueMinor?`, `currency?`, `per` person/booking, `appliesTo` accommodation/participation/extras/subtotal, `priority`, `stackable`, `validFrom?`, `validTo?`, `enabled` | importes y puntos básicos siempre ≥ 0: el signo lo da `direction`; semántica y orden de aplicación los fija 2.2 | 2.2 |
| **PromoCode** | `code` citext único, `description`, mismo efecto que `PriceRule` con `direction = discount` siempre, `scopeType`, `scopeId?`, `maxRedemptions?`, `maxPerCustomer?`, `redeemedCount`, `validFrom?`, `validTo?`, `enabled` | `redeemedCount` con `UPDATE` condicional y check `≤ maxRedemptions`; `maxPerCustomer` se comprueba tras `FOR UPDATE` sobre el `Customer` | 2.2 |
| **PromoRedemption** | `promoCodeId`, `bookingId`, `customerId`, `redeemedAt`, `releasedAt?` | `@@unique([promoCodeId, bookingId])`; se libera si la reserva se rechaza, caduca o cancela (no llega a viajar), con `UPDATE … WHERE releasedAt IS NULL` y el contador se resta solo si esa sentencia afectó a una fila | 2.2 |
| **CancellationPolicy** | `name`, `description LocalizedText`, `status` draft/active/archived | | 6.4 |
| **CancellationTier** | `policyId`, `minDaysBeforeDeparture`, `penaltyMode` percent/fixed_per_person/fixed_per_booking, `penaltyBps?`, `penaltyMinor?`, `currency?` | tramos sin huecos, probados en sus días límite; el último cubre días < 0, pasada la salida (`cancellation_after_departure_uses_final_tier`) | 6.4 |
| **ExchangeRate** (Ap) | `baseCurrency`, `quoteCurrency`, `rateE9 BigInt`, `asOf`, `source` | | 6.1 |

El **motor de precios** (2.1) es una función pura `price(input, catalogueView, rules, now) → PriceBreakdown`, sin acceso a la base de datos, que se prueba con tablas. Un servicio la rodea y le pasa los datos. `PriceBreakdown` incluye líneas, subtotales, descuentos, total, depósito, fecha del saldo, `priceVersionId` y `engineVersion`. El motor **nunca aplica un efecto fijo (regla, código, penalización) de otra moneda**: con ámbito de paquete o edición se rechaza al guardarlo; con ámbito global solo se aplica a paquetes de su moneda.

### 5.4 Reservas y CRM (`bookings.prisma`, `crm.prisma`)

| Entidad | Campos principales | Restricciones y notas | Tarea |
|---|---|---|---|
| **Customer** (pii, SD, CF, demo) | `userId?` único, `email` citext único, `givenName`, `familyName`, `phone?`, `countryOfResidence Char(2)` (`@pii`), `preferredLocale`, `source`, `anonymisedAt?` | uno por correo | 2.4 (mínimo), 2.5 |
| **Traveller** (pii, CF) | `customerId` (dueño; `@@unique([id, customerId])`), `givenName`, `familyName` (como en el documento), `dateOfBirth @db.Date?` (`@pii`), `email?`, `phone?`, `emergencyContactName?`, `emergencyContactPhone?`, `estimatedFinishSeconds Int?` (`@pii`), `anonymisedAt?` | sin pasaporte ni datos médicos | 2.4 (mínimo), 5.2 |
| **Booking** (CF, demo) | `reference` único, `customerId`, `kind` catalogue/bespoke, `packageId?`, `editionId?`, `status`, `currentSnapshotVersion`, `departureDate`, `returnDate` (`@db.Date`, del paquete o del presupuesto), `currency`, `totalMinor`, `depositMinor`, `balanceDueDate`, `residenceCountry` (`@pii`), `requestedAt`, `approvedAt?`, `approvalExpiresAt?`, `requestExpiresAt?`, `depositPaidAt?`, `confirmedAt?`, `balancePaidAt?`, `completedAt?`, `cancelledAt?`, `statusReason?` (`@pii`, texto libre), `quoteId?`, `sourceChannel`, `version` | FK de 1.1 (paquete o presupuesto); `@@unique([id, currency])` y `([id, customerId])`; `CHECK`: `catalogue ⇒ packageId`, `bespoke ⇒ quoteId` no nulos (la columna `quoteId` y su FK las añade 2.5) y `returnDate ≥ departureDate`; sin borrado: se cancela | 2.4 |
| **BookingSnapshot** (Ap) | `bookingId`, `version`, `kind` original/amendment, `configuration Json`, `priceBreakdown Json`, `cancellationPolicy Json?`, `termsVersionId?`, `totalMinor`, `currency`, `priceVersionId?`, `engineVersion` | `@@unique([bookingId, version])`; disparador anti-modificación; **sin datos personales ni texto libre**: `configuration` y `priceBreakdown` son `@nopii` con esquemas sin texto libre (las líneas a medida llevan `quoteLineId`) | 2.4 |
| **BookingTraveller** | `bookingId`, `customerId`, `slot Int`, `participationType`, `raceDistanceId?`, `travellerId?`, `isLead`, `addedInVersion`, `removedInVersion?` | FK compuestas `(bookingId, customerId)` → `Booking @@unique([id, customerId])` y `(travellerId, customerId)` → `Traveller`: solo se asignan viajeros del cliente de la reserva. La plaza existe desde la solicitud; los datos personales llegan en 5.2 | 2.4 |
| **BookingRoom** | `bookingId`, `roomOptionId`, `occupancy`, `travellerSlots Int[]` | configuración vigente (operativa) | 2.4 |
| **BookingExtra** | `bookingId`, `extraId`, `quantity`, `travellerSlot?` | | 2.4 |
| **InventoryClaim** | `bookingId?`, `waitlistEntryId?`, `poolId`, `quantity`, `status` held/released | `CHECK`: exactamente un dueño; únicos por `(bookingId, poolId)` y `(waitlistEntryId, poolId)`. Desde 6.5, la plaza que libera una cancelación con lista de espera pasa a una retención de la oferta hasta `offerExpiresAt`, y al aceptar se traslada a la reserva nueva (`waitlist_offer_holds_released_slot_against_public_request`) | 2.4 |
| **Quote** (SD) | `reference`, `customerId`, `kind` catalogue/bespoke, `configuration Json` (`@nopii`, sin texto libre), `priceBreakdown Json`, `totalMinor`, `currency`, `departureDate?`, `returnDate?` (`CHECK`: obligatorias si `bespoke`), `expiresAt`, `status` draft/sent/accepted/expired/withdrawn, `bookingId?`, `createdById` | total y desglose del motor de precios; aceptar (compare-and-set `sent → accepted`, `@@unique([bookingId])`, `@@unique([id, currency])`: la reserva hereda su moneda, `bespoke_booking_currency_matches_quote`) respeta el precio hasta `expiresAt` y en la misma transacción crea la reserva y retiene el cupo, o 409 | 2.5 |
| **QuoteLine** | `quoteId`, `description LocalizedText` (`@pii`: texto libre de Oscar), `quantity`, `unitAmountMinor`, `currency` | para viajes a medida: Oscar introduce los importes unitarios; la suma la hace el motor de precios | 2.5 |
| **WaitlistEntry** (pii) | `email` (`@pii`), `customerId?`, `reason` non_resident/sold_out, `raceId?`, `editionId?`, `packageId?`, `countryOfResidence`, `travellers Int`, `position`, `status` waiting/offered/converted/expired/withdrawn, `offeredAt?`, `offerExpiresAt?` | 2.6 crea; 6.5 añade la promoción | 2.6 |
| **TermsVersion** | `kind` booking_terms/privacy/website_terms, `version`, `content LocalizedText`, `publishedAt`, `isProvisional` | `@@unique([kind, version])`; Ap una vez publicada | 3.5 |
| **TermsAcceptance** (pii, Ap) | `customerId`, `bookingId?`, `termsVersionId`, `acceptedAt`, `ipAddress?` (`@pii`), `userAgent?` (`@pii`) | prueba para disputas; excepción de borrado en 4.9 | 3.5 |
| **ConsentRecord** (pii, Ap) | `customerId?`, `email?` (`@pii`), `emailHash` (HMAC con clave), `emailHashKeyVersion`, `purpose` marketing_email, `granted`, `source`, `wordingVersion`, `recordedAt` | el estado vigente es el último registro; excepción de borrado en 4.9 | 5.5 |
| **BookingAmendment** | `bookingId`, `fromVersion`, `toVersion?`, `kind` room/nights/travellers/name_change/extras/other, `priceDifferenceMinor` (`@signed`), `feeMinor`, `currency`, `status` proposed/applied/rejected, `reason` (`@pii`), `createdById`, `appliedAt?` | crea una `BookingSnapshot` nueva; nunca edita la original. Aplicar es compare-and-set sobre `Booking.currentSnapshotVersion = fromVersion` y `@@unique([bookingId, toVersion])`; en la misma transacción reasigna los pagos al plan nuevo (P7, P8) | 6.3 |
| **Cancellation** | `bookingId` único, `requestedBy` customer/staff, `requestedAt`, `daysBeforeDeparture`, `policySnapshot Json`, `penaltyMinor`, `refundableMinor`, `currency`, `reason` (`@pii`) | `bookingId` único: dos clics, una cancelación | 6.4 |

### 5.5 Pagos (`payments.prisma`)

Aquí se fijan el **esquema base y los invariantes del libro**; el diseño de cobros, reparto y reembolsos es de 3.1, 3.2, 4.5 y 6.3, dentro de los **requisitos vinculantes** P1–P12 y de las tablas de 6.2.

| Entidad | Campos principales | Restricciones | Tarea |
|---|---|---|---|
| **ProviderAccount** | `adapterKey`, `displayName`, `mode` test/live, `status` active/paused/retired/archived, `credentialsCiphertext Bytes`, `credentialsKeyVersion`, `webhookSecretCiphertext?`, `webhookPathTokenHash` único (la URL completa se enseña **una sola vez** al crear la cuenta, como una clave de API, y se regenera con step-up; la protección real es la firma), `lastConnectionTestAt?`, `lastConnectionTestResult?`, `createdById` | `@@unique([id, mode])`; disparador rechaza cambiar `mode` (pasar a real = cuenta `live` nueva, con adaptador `verified`, prueba de conexión y step-up); sin borrado físico con historial | 3.3 (mínimo), 4.1 |
| **PaymentMethodConfig** | `method` card/apple_pay/google_pay/payto/becs/payid_transfer/bpay/bnpl/manual_other, `enabled`, `countries String[]`, `displayOrder`, `instructions LocalizedText?` | bnpl nace apagado; editar `instructions` exige step-up (4.2) | 3.4, 4.2 |
| **RoutingRule** | `method`, `providerAccountId`, `countries String[]`, `currencies String[]`, `minAmountMinor?`, `maxAmountMinor?`, `currency?`, `priority`, `fallbackForRuleId?`, `enabled` | con límites, `CHECK (currencies = ARRAY[currency])`: un límite nunca se compara con otra moneda (`routing_limit_ignored_for_other_currency`); editar exige step-up | 4.2 |
| **PaymentSchedule** | `bookingId` único, `currency`, `version` (sube en cada cambio del plan) | FK `(bookingId, currency)`; `@@unique([id, bookingId, currency])` | 3.2 |
| **PaymentScheduleItem** | `scheduleId`, `bookingId`, `kind` deposit/balance/instalment/adjustment, `sequence`, `amountMinor`, `currency`, `dueDate @db.Date`, `state` active/waived/superseded | FK `(scheduleId, bookingId, currency)`; `@@unique([id, bookingId, currency])` y `([id, bookingId])` (enlace de pago); importes de la API; lo pagado y lo pendiente se derivan de `PaymentAllocation` | 3.2 |
| **PaymentLink** | `bookingId`, `targetScheduleItemId?`, `tokenHash` único, `expiresAt`, `status` active/used/expired/revoked, `createdById?` | no guarda importe (P1); FK `(targetScheduleItemId, bookingId)` → plazo de la misma reserva | 3.2 |
| **Payment** | `bookingId`, `origin` collection/manual_intent/inbound, `targetScheduleItemId?`, `payerCustomerId?`, `providerAccountId`, `adapterKey`, `method`, `mode`, `amountMinor`, `currency`, `status` created/pending/requires_action/succeeded/failed/cancelled/expired/voided (solo `inbound`), `idempotencyKey` único (del servidor, 1.2), `providerPaymentRef?`, `payerReference?`, `failureCode?`, `pendingExpiresAt?`, `succeededAt?`, `version` | FK `(bookingId, currency)` → `Booking`, `(providerAccountId, mode)` y `(targetScheduleItemId, bookingId, currency)`; únicos que sostienen las FK de 1.1: `([id, bookingId, currency])`, `([id, mode])`, `([id, bookingId, mode, currency, amountMinor])` y `([id, bookingId, providerAccountId, mode, currency])`; único parcial `(providerAccountId, providerPaymentRef)` donde `status <> 'voided'`, para reconfirmar bien una referencia anulada (`voided_inbound_reference_can_be_reconfirmed`); la `idempotencyKey` de un `inbound` no deriva de la referencia (`booking:<id>:inbound:<n>`); `CHECK`: referencia no nula si `succeeded` o `inbound`; `manual_intent` nunca `succeeded`; índice único parcial: un intento vivo (`created`, `pending`, `requires_action`) de origen `collection` o `manual_intent` por reserva | 3.2 |
| **PaymentAllocation** (Ap) | `paymentId`, `bookingId`, `scheduleItemId?`, `amountMinor` (`@signed`), `currency`, `kind` schedule/overpayment/receivable, `cause` payment/refund/chargeback/chargeback_reinstated/refund_reversed/reallocation, `batchKey`, `ledgerTransactionId?` | FK de 1.1: misma reserva y moneda también en el sobrepago; `@@unique([batchKey, paymentId, scheduleItemId, kind]) NULLS NOT DISTINCT`: **un solo neto por tupla y lote** (P7) | 3.2 (no creada: 4.5 decidió mantener el reparto derivado, `docs/plans/4.5-refunds-disputes.md` §12.1 y §14.6) |
| **Refund** | `paymentId`, `bookingId`, `providerAccountId`, `mode`, `origin` app/external, `purpose` price_reduction/overpayment_return/cancellation, `amountMinor`, `currency`, `reason?` (`@pii`), `status` requested/pending/succeeded/failed/reversed, `idempotencyKey` único (del servidor, 1.2), `providerRefundRef?`, `requestedById?`, `cancellationId?`, `amendmentId?` | FK de 1.1; `@@unique([id, mode])`; `@@unique([providerAccountId, providerRefundRef])`; referencia no nula si `succeeded` o `external` | 3.2, 4.5 |
| **Dispute** | `paymentId`, `bookingId`, `providerAccountId`, `mode`, `providerDisputeRef`, `amountMinor`, `currency`, `reasonCode`, `status` open/evidence_submitted/won/lost/closed, `evidenceDueBy?`, `evidenceDocumentId?` | `@@unique([providerAccountId, providerDisputeRef])`, `([id, mode])`; FK de 1.1 | 4.5 |
| **LedgerAccount** | `code` (p. ej. `customer_funds`, `customer_overpayments`, `provider_clearing:<accountId>`, `payment_fees`, `supplier_payable`, `revenue`, `refunds_payable`), `kind` asset/liability/revenue/expense, `currency`, `mode` | `@@unique([code, currency, mode])`: prueba y real nunca comparten cuenta | 3.2 |
| **LedgerTransaction** (Ap) | `occurredAt`, `kind` payment/refund/fee/chargeback/supplier_payment/adjustment/reversal, `bookingId?`, `paymentId?`, `refundId?`, `disputeId?`, `supplierPaymentId?`, `reversesTransactionId?` único, `mode`, `idempotencyKey` único (P5), `description` | `@@unique([id, mode])`; FK `(paymentId, mode)`, `(refundId, mode)`, `(disputeId, mode)`, `(supplierPaymentId, mode)` hacia `@@unique([id, mode])` de cada uno; corrección = transacción de reversión; disparador diferido: al menos 2 asientos, y su `bookingId` es el del pago, reembolso o disputa (P11) | 3.2 |
| **LedgerEntry** (Ap) | `transactionId`, `accountCode`, `amountMinor` (`@signed`, `<> 0`), `currency`, `mode`, `bookingId?` | FK `(accountCode, currency, mode)` → `LedgerAccount` y `(transactionId, mode)` → `LedgerTransaction`; disparador diferido: cada transacción suma 0 por moneda y cada asiento lleva el `bookingId` de su transacción | 3.2 |
| **WebhookEvent** (pii posible) | `providerAccountId`, `providerEventId`, `bookingId?`, `paymentId?`, `refundId?`, `disputeId?` (FK `Restrict`, rellenadas al casar el evento: registra `customerLink` por la reserva), `type`, `rawBody Bytes?` (`@pii`), `headers Json` (saneadas), `receivedAt`, `status` received/processed/ignored/failed, `attempts`, `processedAt?`, `error?` | solo firma válida; `@@unique([providerAccountId, providerEventId])`; cuerpo vaciado al anonimizar (los casados: `erasure_clears_matched_webhook_raw_body`) y a los 180 días (los `ignored` sin casar solo así: riesgo aceptado) | 3.3 |
| **WebhookRejection** | `providerAccountId?`, `receivedAt`, `reason` bad_signature/too_large/unknown_account, `bodySha256`, `sizeBytes`, `claimedEventId?`, `headers Json` (saneadas) | sin cuerpo; no bloquea el reintento válido; visible en el monitor; límite de 256 KB antes de verificar, límite de peticiones por IP y purga a 30 días | 3.3 |
| **Settlement** | `providerAccountId`, `mode`, `providerSettlementRef`, `payoutDate`, `grossMinor`, `feesMinor`, `netMinor` (los tres `@signed`), `currency` | `@@unique([id, mode, currency])`, `([providerAccountId, providerSettlementRef])`; `CHECK (netMinor = grossMinor - feesMinor)` | 4.6 |
| **SettlementLine** | `settlementId`, `mode`, `providerLineRef`, `paymentId?`, `refundId?`, `kind`, `amountMinor`, `feeMinor` (ambos `@signed`), `currency` | FK de 1.1 (`settlement_line_mode_and_currency_match_settlement`); `@@unique([settlementId, providerLineRef])` | 4.6 |
| **ReconciliationRun** | `providerAccountId`, `forDate`, `status` matched/mismatch/failed, `differences Json` (`@nopii`), `createdAt` | solo lee; alerta si no cuadra | 4.6 |
| **Receipt** | `number` único, `bookingId`, `paymentId`, `mode`, `amountMinor`, `currency`, `gstRegisteredAtIssue`, `gstAmountMinor?`, `issuedAt`, `documentId?`, `voidedAt?`, `voidDocumentId?` | FK de 1.1 (moneda e importe del pago, `receipt_currency_and_amount_match_payment`); `@@unique([paymentId])`; secuencia por modo (`MT-R-`, `MT-T-`); `CHECK (gstAmountMinor <= amountMinor)`; sin GST registrado, ni GST ni "tax invoice" | 4.6 |

**Estado del adaptador** (`verified`, `experimental`, `planned`): en su manifiesto, en código (cambiarlo exige un PR; sin manifiesto = no `verified`). Un adaptador sin pasarela externa (`manual`) es `verified` al pasar su batería de contrato local, y su prueba de conexión comprueba que las instrucciones (PayID o BSB y cuenta) existen y son válidas (`manual_adapter_verified_by_local_contract_suite`). Se comprueba al crear una cuenta `live`, en cada cobro `live` y al arrancar (pausa, auditoría y aviso). Una prueba de CI exige que todo manifiesto `verified` cite su evidencia: una ejecución de `test:sandbox` con fecha registrada en `docs/done/`, o la batería local si el adaptador no tiene pasarela externa (`verified_manifest_requires_sandbox_evidence`).

**Requisitos vinculantes de pagos** (la tarea elige cómo, pero no cierra sin la prueba nombrada).

| # | Requisito | Pruebas | Tarea |
|---|---|---|---|
| P1 | El importe de un cobro o enlace lo calcula el servidor con la reserva bloqueada: `min(pendiente acumulado hasta el plazo objetivo, pendiente de la reserva)`; 0 = "nada que pagar". Las entradas de cobro no tienen campo de importe (confirmar una transferencia sí: P4) | `client_amount_field_rejected`, `single_payment_covers_deposit_and_balance`, `deposit_paid_in_two_parts` | 3.2 |
| P2 | Un solo intento vivo por reserva, de cualquier tipo. Un `collection` en `pending` (débito ya enviado al banco) bloquea un cobro nuevo con 409; un `manual_intent` no bloquea: crear otro cobro o cancelarlo (cliente o personal) lo pasa a `cancelled`; uno `created`/`requires_action` se retoma si coinciden cuenta, método e importe, o se sustituye solo tras confirmar con la pasarela su cancelación o su estado; sin respuesta, no se sustituye (tabla de intentos, 6.2) | `second_live_attempt_for_booking_rejected`, `pending_debit_blocks_new_attempt`, `manual_intent_cancelled_by_new_card_attempt`, `replace_attempt_only_after_provider_confirms_cancel`, `abandoned_3ds_resumed_or_replaced_immediately`, `late_success_of_cancelled_attempt_becomes_overpayment` | 3.2, 4.2 |
| P3 | `pendingExpiresAt` en todo intento no terminal, sin renovarse al retomarlo; al vencer se consulta antes a la pasarela. En `approved`, pasado `approvalExpiresAt` no se crea ningún intento (tabla de reserva, 6.2) | `expiry_of_pending_debit_queries_provider_first`, `new_attempt_after_approval_expiry_rejected`, `resume_does_not_extend_pending_expiry`, `approval_expiry_skipped_while_payment_pending`, `create_charge_vs_expire_concurrent` | 3.2 |
| P4 | Transferencias: cada confirmación crea un `inbound` cuya referencia única por cuenta es el **identificador del movimiento** del extracto (o fecha, importe y descripción normalizados); la del cliente (`payerReference`, la de su reserva) solo localiza la reserva. El **importe que llegó al banco** lo introduce el personal (dato bancario, en la moneda de la reserva, con el tope de 1.1); el `manual_intent` vivo se cierra a la vez. Un error se **anula** (`voided`) y se reconfirma, nunca se edita. Confirmar, anular y editar instrucciones exigen step-up | `manual_confirmation_twice_posts_once`, `manual_confirmation_without_reference_rejected`, `deposit_and_balance_transfers_same_payer_reference`, `inbound_confirmation_amount_from_staff_with_step_up`, `mistaken_inbound_voided_reverses_ledger_and_allocation`, `manual_intent_never_succeeds`, `edit_manual_instructions_requires_step_up_and_is_audited` | 3.4 |
| P5 | Idempotencia por objeto de negocio, no por evento. Todo objeto creado en la pasarela lleva nuestro id en metadatos y nuestra `idempotencyKey` como su clave de idempotencia; la llamada va **fuera** de la transacción con bloqueos (crear fila y confirmar, llamar, guardar la referencia en otra transacción sin retroceder estado). Cada evento busca su objeto **primero por nuestro id** y luego por referencia (si llega antes que la respuesta, completa la fila); si no casa, es `external` o desconocido; con importe o moneda distintos no se anota (tabla de intentos). La transición es compare-and-set y el asiento usa una clave derivada (`payment:<id>:succeeded`, `refund:<id>:succeeded`, `refund:<id>:reversed`, `inbound:<id>:voided`, `chargeback:<disputeId>:withdrawn`, `…:reinstated`, `fee:<settlementLineId>`, `supplier_payment:<id>`, `…:voided`; reasignaciones internas con contador monótono: `schedule:<bookingId>:v<n>:reallocation` con `PaymentSchedule.version`, `amendment:<id>:applied`, `cancellation:<id>:plan`, `approval:<bookingId>:plan`); el reparto usa la misma clave como `batchKey`. Un reembolso hecho desde el panel de la pasarela crea un `Refund` `external` y una tarea | `same_success_via_two_event_types_posts_once`, `same_client_key_different_customers_isolated`, `dispute_created_and_funds_withdrawn_posts_once`, `refund_initiated_outside_app_recorded_once`, `receipt_issued_once_per_payment`, `settlement_fee_posted_once_per_line`, `negative_settlement_reconciles`, `invalid_then_valid_same_event_id_processed_once`, `webhook_before_provider_response_matches_app_refund`, `webhook_before_provider_response_matches_app_payment`, `second_plan_split_does_not_collide_with_first` | 3.3, 4.5, 4.6 |
| P6 | Webhooks: firma verificada antes de guardar, duplicados y fuera de orden tolerados (el estado solo avanza; ante duda se consulta a la pasarela), 413 por encima de 256 KB | `webhook_duplicate_out_of_order_bad_signature`, `oversized_webhook_rejected` | 3.3 |
| P7 | Reparto: el dinero que entra cubre los plazos activos por `sequence`; el resto es sobrepago (pasivo `customer_overpayments` y tarea de reembolso). Reembolsos y contracargos restan de las asignaciones de **ese** pago (primero su sobrepago no reservado por reembolsos en curso, P10; luego del último plazo hacia atrás) y, si no queda nada, el resto va a `receivable` (negativo, cuenta `customer_receivable`, tarea para Oscar); lo que entra después salda primero el `receivable`. Un evento de reembolso o disputa sobre un pago aún no `succeeded` en local sincroniza antes el pago con la pasarela. Al cambiar el plan, se reasigna en la misma transacción con **un solo neto por (lote, pago, plazo, tipo)** | `overpayment_posts_liability_and_creates_refund_task`, `lost_chargeback_reopens_item_pending`, `amendment_supersedes_items_reallocates`, `reallocation_overpayment_to_schedule_nets_per_tuple`, `allocation_to_other_bookings_item_rejected`, `lost_chargeback_on_deposit_flags_unpaid_and_blocks_confirm`, `payment_on_cancelled_booking_does_not_reactivate`, `chargeback_after_full_refund_posts_receivable`, `refund_event_before_payment_success_syncs_payment_first` | 3.2, 4.5, 6.3 |
| P8 | Invariantes (prueba de propiedades), en todo estado con plan vigente: **suma de plazos activos = importe exigible**, que es `Booking.totalMinor` (siempre el de la instantánea vigente, con disparador diferido: `booking_total_equals_current_snapshot_total`; la cancelación no lo cambia) salvo en `cancelled`/`refunded`, donde es `Cancellation.penaltyMinor` (0 si no hay `Cancellation`, antes de 6.4), y en `expired`/`declined`, donde es 0 (`approval_expiry_zeroes_schedule_moves_paid_to_overpayment`); por pago, asignaciones = importe − reembolsos `succeeded` (los `reversed` no cuentan) − fondos retirados + reintegrados, y 0 si está `voided`; por plazo activo, entre 0 y su importe; no activos, 0; sobrepago ≥ 0; `receivable` ≤ 0; lo asignado cuadra con el libro. Condonar un plazo solo es posible con un cambio (6.3) que baja el total | `allocation_and_schedule_invariants_hold` (propiedades), `booking_ledger_balance_equals_collected_minus_refunded` (suma por reserva de `customer_funds`, `customer_overpayments` y `customer_receivable`), `same_idempotency_key_charges_once`, `payment_ledger_entries_in_payment_currency` (asientos de un pago en su moneda, salvo `fx_conversion`), `waive_item_requires_total_change` | 3.2, 6.3 |
| P9 | Todo reembolso declara su finalidad: `price_reduction` exige en la misma transacción un cambio que baje el total (no reabre plazos), así que **hasta 6.3 responde 409**; `cancellation` exige `cancellationId` (`CHECK`) y **hasta 6.4 responde 409** (antes, lo cobrado de una reserva cancelada es sobrepago, 10.2); 4.5 hace los parciales como `overpayment_return`, que solo consume sobrepago | `price_reduction_refund_rejected_until_amendments_exist` (4.5), `cancellation_refund_rejected_until_cancellations_exist` (4.5), `courtesy_refund_lowers_total_without_reopening_balance` (6.3), `overpayment_refund_cannot_touch_schedule_items`, `refund_reversed_moves_refunded_back_to_cancelled` | 4.5, 6.3, 6.4 |
| P10 | Topes de las peticiones de reembolso **desde la app**, con reserva y pago bloqueados (`failed` y `reversed` liberan tope; el panel envía `Payment.version`): **por pago**, `requested` + `pending` + `succeeded` + nuevo ≤ cobrado neto de contracargos; **todo reembolso solo consume el sobrepago asignado a ese mismo pago**: en curso (`requested`, `pending`) + nuevo ≤ ese sobrepago (si está en otro pago, se reembolsa por ese; `overpayment_return_via_other_payment_keeps_schedule_covered`), y ese sobrepago queda **reservado**: ni reasignaciones, ni cambios de total, ni contracargos lo tocan mientras el reembolso esté en curso (`reallocation_does_not_consume_overpayment_reserved_by_pending_refund`); **por finalidad**, `cancellation` `requested` + `pending` + `succeeded` + nuevo ≤ `Cancellation.refundableMinor`, y `price_reduction` ≤ la rebaja de su cambio. Un reembolso `external` ya está hecho: si supera el tope se registra igual, con el exceso en `receivable` (P7) y una tarea | `concurrent_refunds_cannot_exceed_payment`, `concurrent_overpayment_returns_cannot_exceed_overpayment`, `overpayment_return_via_other_payment_keeps_schedule_covered`, `reallocation_does_not_consume_overpayment_reserved_by_pending_refund`, `cancellation_refunds_capped_at_refundable`, `stale_payment_version_refund_rejected`, `reversed_refund_frees_cap`, `external_refund_over_cap_recorded_with_task` | 4.5 |
| P11 | Modo y entorno: `mode` en cada fila de dinero y en la cuenta del libro; informes y estado de cobro solo cuentan el modo del entorno; fuera de producción ninguna llamada `live` (4.8); en `production` el enrutado no ofrece cuentas `test` | `test_mode_payment_not_counted_in_production`, `ledger_entry_mode_must_match_account_and_transaction`, `ledger_transaction_mode_must_match_payment`, `ledger_booking_must_match_payment_and_transaction`, `receipt_mode_must_match_payment`, `ledger_entry_currency_must_match_account`, `provider_account_mode_is_immutable`, `non_production_refund_on_live_account_rejected`, `non_production_start_pauses_live_accounts`, `live_credentials_not_decrypted_outside_production`, `production_routing_excludes_test_accounts`, `live_charge_rejected_when_adapter_not_verified`, `startup_pauses_live_account_with_unverified_adapter`, `archived_account_still_processes_dispute_webhook`, `archive_rejected_within_dispute_window` | 3.2, 3.3, 4.1 |
| P12 | Proveedores: un coste se paga una sola vez; cada línea ≤ su coste y la suma de líneas = el pago (disparador diferido); anular libera el coste y revierte el asiento | `cost_item_cannot_be_paid_twice`, `supplier_payment_items_sum_to_payment`, `voided_supplier_payment_frees_cost_item` | 6.2 |

**Estado de cobro de una reserva** (pendiente, depósito cobrado, pagada, depósito revertido, con reembolso parcial, reembolsada): se deriva del reparto y del plan de pagos, nunca se guarda a mano.

### 5.6 Plantillas, documentos, alertas, privacidad (`templates.prisma`, `alerts.prisma`)

| Entidad | Campos principales | Notas | Tarea |
|---|---|---|---|
| **EmailTemplate** | `key`, `locale`, `version`, `status` draft/active/archived, `subject`, `body`, `variablesSchema Json` | `@@unique([key, locale, version])`; vista previa con datos de ejemplo | 5.4 |
| **DocumentTemplate** | `key` confirmation/itinerary/voucher/receipt/evidence_pack, `locale`, `version`, `status`, `body`, `variablesSchema Json` | | 5.4 |
| **GeneratedDocument** (pii) | `bookingId?`, `kind`, `templateId`, `templateVersion`, `storedFileId`, `createdAt`, `deletedForPrivacyAt?` | el archivo contiene datos personales; tratamiento al borrar en 4.9 | 5.4 |
| **AlertSubscription** (pii) | `email` citext, `customerId?`, `raceId`, `editionId?`, `status` pending/confirmed/unsubscribed, `confirmTokenHash?`, `confirmedAt?`, `unsubscribeTokenHash` único, `lastNotifiedAt?` | `@@unique([email, raceId, editionId]) NULLS NOT DISTINCT`: una suscripción a la carrera y otra por edición | 5.3 |
| **PrivacyRequest** | `customerId`, `kind` export/erasure, `status` received/completed/rejected, `requestedAt`, `completedAt?`, `resultFileId?`, `notes` (`@pii`) | la fila se conserva como prueba de la solicitud; `notes` se redacta | 5.5 |

### 5.7 Proveedores y finanzas (`suppliers.prisma`, `finance.prisma`)

| Entidad | Campos principales | Notas | Tarea |
|---|---|---|---|
| **Supplier** (SD, CF, demo) | `kind` hotel/ground_operator/race_organiser/other, `name`, `countryCode`, `defaultCurrency`, `paymentTerms`, `notes` | | 6.1 |
| **SupplierContact** (pii) | `supplierId`, `name`, `email?`, `phone?`, `role` | | 6.1 |
| **SupplierContract** (SD) | `supplierId`, `editionId?`, `reference`, `signedAt?`, `validFrom?`, `validTo?`, `terms`, `attachmentId?` | | 6.1 |
| **Allotment** | `contractId`, `mode`, `poolId`, `kind` room/entry, `quantity`, `releaseDate @db.Date?`, `unitCostMinor`, `currency`, `status` held/released | contratado al proveedor; alimenta la capacidad del `InventoryPool` | 6.1 |
| **CostItem** | `supplierId`, `mode`, `contractId?`, `packageId?`, `bookingId?`, `description` (`@pii`), `basis` per_person/per_room/per_booking/fixed, `quantity`, `unitAmountMinor`, `amountMinor`, `currency`, `dueDate?`, `status` planned/due/paid/cancelled | coste en su moneda; `@@unique([id, mode, currency])`; `mode` es el del entorno al crearlo, como en `SupplierPayment`. Un pago parcial a un proveedor (señal y resto) son dos `CostItem` | 6.1 |
| **SupplierPayment** | `supplierId`, `mode`, `amountMinor`, `currency`, `paidAt`, `reference`, `status` recorded/voided, `idempotencyKey` único (del servidor, 1.2), `fxRateE9?`, `baseAmountMinor?`, `baseCurrency?` | `@@unique([id, mode, currency])`, `([id, mode])`; genera asiento en el libro (`supplier_payment:<id>`, FK `(supplierPaymentId, mode)` desde `LedgerTransaction`: `supplier_payment_mode_matches_ledger_and_environment`); anular es compare-and-set `recorded → voided` con transacción de reversión; el importe convertido lleva su propia moneda | 6.2 |
| **SupplierPaymentItem** | `supplierPaymentId`, `costItemId`, `mode`, `amountMinor`, `currency`, `active` | FK compuestas con la moneda del pago y del coste; **índice único parcial sobre `costItemId` donde `active`**: un coste no se paga dos veces; anular el pago pone `active = false` en la misma transacción | 6.2 |
| **AccountingExport** | `periodFrom`, `periodTo`, `format`, `storedFileId`, `createdById` | | 6.6 |

"Viaje", para operaciones y resultado económico, **es un `Package`** (una salida). El resultado por edición o carrera suma sus paquetes.

### 5.8 Operaciones, reclamaciones, contenido, informes, automatizaciones, integraciones

| Entidad | Campos principales | Notas | Tarea |
|---|---|---|---|
| **KeyDate** | `entityType`, `entityId`, `kind` allotment_release/balance_due/entry_submission/supplier_payment/custom, `date`, `title`, `taskId?` | mantenida por eventos; genera tareas | 7.3 |
| **Complaint** (pii, SD) | `reference` único, `customerId?`, `bookingId?`, `receivedAt`, `channel`, `category`, `description` (`@pii`), `status` received/acknowledged/investigating/resolved/closed, `ownerId?`, `acknowledgeBy`, `resolveBy`, `resolution?` (`@pii`), `resolvedAt?` | | 7.6 |
| **ComplaintEvent** (pii, Ap) | `complaintId`, `kind`, `body` (`@pii`), `actorId`, `occurredAt` | cronología demostrable; excepción de borrado en 4.9 | 7.6 |
| **AutomationRule** | `name`, `ownerUserId`, `triggerType` event/schedule, `eventType?`, `cron?`, `conditions Json`, `actions Json`, `enabled`, `testMode`, `version` | acciones de una lista cerrada, sin dinero, permisos ni transiciones de reserva con efecto en dinero (aprobar, rechazar, cancelar); crear o activar exige el permiso de cada acción, y cada ejecución usa los permisos **actuales** de su dueño, como `ApiKey`; dueño desactivado = no se ejecuta y se avisa (`automation_cannot_exceed_author_permissions`) | 7.4 |
| **AutomationRun** | `ruleId`, `ruleVersion`, `triggerEventId?`, `scheduledFor?`, `testMode`, `status`, `steps Json` (`@nopii`: acción, estado, entidad y código de error, nunca contenido renderizado), `startedAt`, `finishedAt?` | `@@unique([ruleId, triggerEventId, scheduledFor]) NULLS NOT DISTINCT`: un evento o una hora programada dispara la regla una vez; purga a 90 días | 7.4 |
| **ReportDefinition** | `name`, `entityType`, `columns Json`, `filters Json`, `groupBy Json`, `ownerId`, `shared` | usa el registro de entidades | 7.7 |
| **ReportSchedule** | `reportId`, `cron`, `recipients String[]` (`@pii`), `format`, `enabled` | se ejecuta con los permisos actuales del dueño del informe (`scheduled_report_runs_with_owner_permissions`); un destinatario que no es personal con columnas `@pii` exige step-up y queda auditado | 7.7 |
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
| **SystemErrorEvent** | `occurredAt`, `source`, `message` (solo código y mensaje, 4.1), `requestId?`, `fingerprint` | purga a 30 días | 8.6 |

### 5.9 Más adelante (diseñado; no se crea hasta que Oscar lo pida)

| Entidad | Campos principales | Gancho que ya existe |
|---|---|---|
| **Group**, **GroupMember** | `name`, `leaderCustomerId`, `editionId`; miembro con `customerId`, `bookingId` | `Payment.payerCustomerId`; `Booking.groupId` lo añade ese módulo |
| **Partner**, **PartnerCommission** | `kind` club/coach/agent, `code` único, `commissionBps`, `status`; comisión con `bookingId`, `amountMinor`, `currency`, `status` | `Booking.partnerId` lo añade ese módulo |
| **Segment**, **Campaign**, **CampaignRecipient** | definición de segmento en `Json`; campaña con plantilla, estado, fecha; destinatario solo con consentimiento vigente | `ConsentRecord`, `EmailSuppression` |
| **Survey**, **SurveyResponse** | encuesta por edición; respuesta ligada a una reserva `completed`, `moderationStatus` | `Booking.status = completed` |
| Viajes a medida | sin tablas nuevas: `kind = bespoke` en `Booking` y `Quote` (con sus fechas) y `QuoteLine` | |
| Más monedas y países | sin cambiar el esquema: `Setting.salesCountries`, `PriceVersion.currency`, moneda en cada fila con importe. Sí hace falta crear **filas** nuevas: las cuentas del libro de cada moneda (`LedgerAccount` por código, moneda y modo) y el enrutado de pagos para esa moneda. Los importes ya son `BigInt`, así que monedas con muchas unidades menores caben sin migración | |

### 5.10 Archivos de esquema

Un archivo por módulo: `base.prisma` (generador, datasource, enumerados comunes), `platform-{auth,audit,events,files,common}.prisma` y uno por cada módulo de la sección 3.2. Cada tarea crea solo el suyo. `CHECK`, disparadores, índices parciales y `EXCLUDE` van en SQL dentro de la migración, con un comentario en el modelo. **Toda relación declara `onUpdate: Restrict` y `onDelete: Restrict`**: la prueba de convenciones (0.2) falla si una migración contiene `CASCADE` o `SET NULL` sin `/// @fkException <motivo>`. Un disparador hace **inmutables** las columnas de identidad del dinero: `currency`, `mode`, `bookingId`, `paymentId`, `providerAccountId`, `origin` y `amountMinor` de `Payment`, `Refund`, `Dispute` y `Receipt` (salvo `voidedAt`/`voidDocumentId`); `currency`, `customerId`, `kind`, `packageId` y `quoteId` de `Booking`; `amountMinor`, `currency`, `bookingId` y `sequence` de `PaymentScheduleItem` (un plazo nunca se edita: se sustituye); `PriceVersion.currency`, y `Package.currency` en cuanto tiene una `PriceVersion` (`fk_actions_restrict_only`, `money_identity_columns_immutable`).

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
- **Los datos demo no se publican nunca**, con cualquier `APP_ENV`: un paquete demo no sale de `draft`, una carrera demo no pasa a `published`, `isDemo` no se cambia por la API y la API pública lo excluye. En local hay una vista previa solo con `APP_ENV=development`, con banda "DEMO". El seed se niega con `APP_ENV=production`; las e2e crean sus propios datos.
- Pasar a `open` exige al menos una versión de precio publicada y vigente, y un depósito configurado.

### 6.2 Reserva, intento de cobro y reembolso: estado × evento (2.4, 3.2, 4.5)

Estados de reserva pedidos. Cada celda: transición, "—" (no cambia la reserva) o 409. Una prueba guiada por datos **por tabla** recorre todas las celdas: `booking_state_event_matrix` (2.4 las celdas sin dinero, 3.2 las de dinero), `payment_attempt_state_event_matrix` (3.2) y `refund_state_event_matrix` (4.5).

**Regla de cobertura C.** En la misma transacción que **cualquier** cambio de lo cobrado o del total, con la reserva bloqueada, payments llama a `bookings.applyCoverage`, que aplica la cadena permitida: `approved` con depósito cubierto (plazos activos `deposit` totalmente asignados; `Booking.depositMinor` solo copia la instantánea) → `deposit_paid` (→ `confirmed` si `autoConfirmOnDeposit`); `confirmed` con total cubierto → `balance_paid` (**`deposit_paid` nunca salta a `balance_paid`**: pasa por `confirmed`; `full_payment_before_confirmation_waits_for_oscar`); `balance_paid` con total no cubierto → `confirmed`; `cancelled` con algo cobrado y neto 0 → `refunded` (un pago `voided` no cuenta como cobrado: `voided_only_payment_keeps_cancelled`); `refunded` con neto > 0 → `cancelled`. Un depósito que deja de estar cubierto **no hace retroceder** `deposit_paid` ni `confirmed`: el estado de cobro pasa a "depósito revertido", se bloquea la confirmación y se crea una tarea (`lost_chargeback_on_deposit_flags_unpaid_and_blocks_confirm`). Pruebas: `amendment_lowering_total_to_paid_moves_to_balance_paid`, `reinstated_chargeback_moves_to_balance_paid`. Ningún endpoint fija estados de cobro.

| Evento ↓ / estado → | requested | approved | deposit_paid, confirmed | balance_paid | completed | declined, expired | cancelled, refunded |
|---|---|---|---|---|---|---|---|
| Aprobación (Oscar; o `instantBooking` con cupo retenido **y al menos un método enrutable** para su país, moneda e importe; si no hay ninguno, queda `requested`: `instant_booking_without_routable_method_stays_requested`) | → approved; **en la misma transacción** payments crea el plan de pagos y reasigna el dinero que ya hubiera entrado; C | 409 | 409 | 409 | 409 | 409 | 409 |
| Rechazo | → declined; libera cupo y código | 409 | 409 | 409 | 409 | 409 | 409 |
| Confirmación por Oscar | 409 | 409 | `deposit_paid` con depósito cubierto → confirmed y C (→ `balance_paid` si el total ya está cubierto); si no, 409; `confirmed`: 409 | 409 | 409 | 409 | 409 |
| Cancelación (cliente u Oscar; pasada `departureDate` el cliente recibe 409: `customer_cannot_cancel_after_departure`) | → cancelled; libera cupo y código | → cancelled; ídem; el plan pasa a un solo plazo con la penalización (6.4) y lo cobrado de más queda como sobrepago a devolver; C | ídem | ídem | 409 | 409 | 409 |
| Caducidad de solicitud (tarea) | si `requestExpiresAt` vencido → expired; libera | — (ya aprobada) | — | — | — | — | — |
| Caducidad de aprobación (barrido periódico de `approved` con `approvalExpiresAt < now`, y un trabajo de reevaluación que la transacción en que termina un intento encola y que corre aparte con el orden de bloqueo de "caducar") | — | si vencida, **sin intento vivo y sin depósito cubierto** → expired; libera; plan sustituido y lo cobrado a sobrepago. Si no, — (`approval_expiry_reevaluated_when_live_attempt_ends`) | — | — | — | — | — |
| Fecha de salida pasada (tarea) | —; tarea | —; tarea | —; tarea; 30 días después de `returnDate`, → completed con saldo pendiente marcado y tarea (`unpaid_trip_completed_after_grace_with_balance_flag`) | → completed | — | — | — |
| Crear un intento de cobro | 409 (no cobrable) | si pendiente > 0 y antes de `approvalExpiresAt` (P2, P3); si no, 409 | si pendiente > 0; si no, 409 | 409 (pendiente 0) | 409 | 409 | 409 |
| Intento pasa a pendiente, falla, caduca o se cancela | — | — (un intento vivo frena la caducidad; al terminar, encola la reevaluación) | — | — | — | — | — |
| Entra dinero (pago `succeeded`, `inbound`, fondos reintegrados, reembolso revertido) | sobrepago; tarea; se reasigna al aprobar | reparto y C | reparto y C | reparto (sobrante a sobrepago) | reparto si queda saldo, si no sobrepago; tarea | sobrepago; tarea (no se reactiva: reembolsar y, si el cliente quiere, reserva nueva) | reparto sobre la penalización, sobrante a sobrepago; C |
| Sale dinero (reembolso `succeeded`, fondos retirados por contracargo) | resta de sobrepago | reparto negativo y C | ídem | ídem (→ confirmed) | reparto negativo; tarea | resta de sobrepago | reparto negativo y C (→ refunded) |
| Cambio de total (6.3; reembolso `price_reduction`) | 409 | plan nuevo, reasignación y C | ídem | ídem | 409 | 409 | 409 |
| Cambio del plan sin cambiar el total (dividir el saldo, mover el depósito) | 409 | los plazos afectados pasan a `superseded`, se crean los nuevos y se reasigna, con C (`schedule_split_without_total_change_supersedes_and_reallocates`) | ídem | ídem | 409 | 409 | 409 |
| Reembolso pedido o fallido; disputa abierta, ganada o perdida sin movimiento de fondos | — (tope P10; tarea en disputas) | — | — | — | — | — | — |

El plan de pagos nace con la aprobación por gancho síncrono (3.1): no hay ventana sin plan (`schedule_created_atomically_with_approval`, `payment_before_schedule_reallocated`, `approval_expiry_skipped_when_deposit_covered`, `cancellation_plan_becomes_penalty`). El cupo se libera con `UPDATE inventory_claim SET status = 'released' WHERE … AND status = 'held' RETURNING …`, restando solo lo devuelto: una sola vez aunque dos procesos lo intenten. Una reserva `declined`, `expired`, `cancelled` o `refunded` no se reactiva nunca. Enviar una solicitud exige sesión de cliente y país en `Setting.salesCountries`; si no, `WaitlistEntry` (2.6).

**Intento de cobro (`Payment` de origen `collection`; lo concreta 3.1).** Los eventos de la pasarela solo hacen avanzar; el dinero real manda.

| Evento ↓ / estado → | created | requires_action | pending | succeeded | failed | cancelled, expired |
|---|---|---|---|---|---|---|
| Evento de un pago que no casa por id interno ni referencia | no se crea intento: el evento queda `ignored` con tarea para Oscar, y si entró dinero la conciliación (4.6) lo marca hasta que Oscar lo registre como `inbound` en su reserva | n/a | n/a | n/a | n/a | n/a |
| Pasarela: requiere acción | → requires_action | — | — | — | — | — |
| Pasarela: en proceso | → pending | → pending | — | — | — | — |
| Pasarela: cobrado | → succeeded; asiento y reparto (P5, P7) | ídem | ídem | — (duplicado) | → succeeded (el dinero manda) | → succeeded; lo que sobre, sobrepago |
| Pasarela: cobrado con importe o moneda distintos de los nuestros | no se anota: el evento queda en revisión con tarea para Oscar, sin cambiar estado, libro ni recibo (`provider_amount_or_currency_mismatch_not_posted`) | ídem | ídem | — | ídem | ídem |
| Pasarela: fallido | → failed | → failed | → failed | — (un reembolso o contracargo es otro objeto) | — | — |
| Nuevo cobro de la reserva (P2) | retomar o sustituir tras confirmar la cancelación | ídem | 409 (`collection`) | n/a | n/a | n/a |
| `manual_intent`: nuevo cobro, o cancelación por el cliente o el personal | n/a | n/a | → cancelled (sin llamar a nadie) | — | — | — |
| Cancelación confirmada por la pasarela | → cancelled | → cancelled | n/a (no se cancela) | — | — | — |
| El personal anula un `inbound` confirmado por error (step-up) | n/a | n/a | n/a | solo `inbound`, con reserva y pago bloqueados y **sin reembolsos salvo `failed` ni disputas** (si no, 409: `void_inbound_with_refund_rejected`): → `voided` (compare-and-set), reversión `inbound:<id>:voided`, reparto negativo, C y recibo anulado (`voidedAt` de nulo a valor) con documento rectificativo | n/a | n/a |
| `pendingExpiresAt` vencido (P3) | consultar; si no se completó → expired | ídem | consultar; si sigue en proceso, —, y se reprograma | — | — | — |

Un `manual_intent` vive en `pending` hasta `cancelled` (llega la transferencia, P4, o fila de arriba; si la transferencia llega después, es un `inbound`: reparto o sobrepago) o `expired`. Un `inbound` nace `succeeded` y solo puede pasar a `voided`.

**Reembolso (`Refund`).**

| Evento ↓ / estado → | requested | pending | succeeded | failed | reversed |
|---|---|---|---|---|---|
| Pasarela acepta la petición | → pending | — | — | — | — |
| Sin respuesta, o `requested`/`pending` más de 24 h (tarea periódica) | consultar a la pasarela y reintentar con la misma `idempotencyKey`; sin respuesta, tarea para Oscar (`refund_request_without_response_requeried_and_retried_same_key`) | consultar; si sigue, tarea | — | — | — |
| Pasarela: reembolsado | → succeeded; asiento, reparto negativo, C | ídem | — (duplicado) | — | — |
| Pasarela: fallido | → failed (libera tope) | → failed | se consulta a la pasarela; si lo confirma, como revertido (`refund:<id>:reversed`, → reversed: `refund_failed_after_success_treated_as_reversal`) | — | — |
| Pasarela: revertido tras confirmarse | n/a | n/a | → reversed; asiento `refund:<id>:reversed`, reparto positivo, C; libera tope (`refund_reversed_after_success`) | — | — (duplicado) |
| Evento de un reembolso que no casa por id interno ni referencia | se crea con `origin = external` en el estado que indique la pasarela (P5) | n/a | n/a | n/a | n/a |

**Disputa (`Dispute`; matriz completa en 4.5, `dispute_state_event_matrix`).** El estado solo avanza (`open` → `evidence_submitted` → `won`/`lost` → `closed`; `won` y `lost` son finales y un evento contrario va a revisión con tarea); el dinero solo se mueve con los eventos de fondos (`chargeback:<id>:withdrawn` y `…:reinstated`, P5 y P7), lleguen en el orden que lleguen respecto al estado.

### 6.3 Orden de bloqueos por operación

Todas las operaciones bloquean en este orden global, saltándose lo que no usan: `Role(owner)` → `Customer` → `Quote` → `Booking` → `PromoCode` → `InventoryPool` (por id ascendente) → `Payment` → `Refund`/`Dispute` → `CostItem` (por id ascendente) → `SupplierPayment`. Las cuentas del libro no se bloquean (solo se insertan asientos). Un manejador de webhook busca primero la reserva sin bloquear y la bloquea antes que el pago. El ayudante de transacciones reintenta hasta 3 veces ante `40P01` (interbloqueo) o `40001` (serialización), por si acaso (`opposite_order_requests_do_not_deadlock`, 2.4).

Por operación: solicitar (2.4) `Customer` → `PromoCode` → pools; borrar un cliente (5.5) `Customer` → sus `Booking`; aceptar presupuesto (2.5) `Customer` → `Quote` → `PromoCode` → pools; aprobar, rechazar, confirmar, caducar (también la reevaluación encolada al terminar un intento), cancelar, cambiar el total o el plan (2.4, 3.2, 6.3, 6.4) `Booking` → `PromoCode` → pools → `Payment`; una ruta que ya bloqueó un `Payment` nunca bloquea después cupos ni códigos: encola el trabajo (`attempt_end_requeues_expiry_in_lock_order`, cubierta por la prueba de interbloqueos); cobros, transferencias, anulaciones y sus eventos (3.2–3.4) `Booking` → `Payment`; reembolsos y disputas (4.5) `Booking` → `Payment` (todos los de la reserva, por id) → `Refund`/`Dispute`; pago a proveedor (6.2) `CostItem` → `SupplierPayment`; rol `owner` (0.3) `Role(owner)`; capacidad de un cupo (1.1) el pool.

### 6.4 Otras

- **ProviderAccount:** active ↔ paused; active/paused → retired; retired → archived sin pagos, reembolsos ni disputas pendientes **y pasado el plazo de disputa** (`Setting.disputeWindowDays`, 180 días). `paused`, `retired` y `archived` no aceptan cobros nuevos y sí reembolsos, disputas, conciliación y webhooks, siempre bajo la guarda de entorno (4.8). `mode` no cambia; una cuenta `live` nueva exige adaptador `verified`, prueba de conexión y step-up.
- **Payment:** la define 3.1.
- **AlertSubscription:** pending → confirmed → unsubscribed; pending → unsubscribed.
- **Quote:** draft → sent → accepted/expired/withdrawn.
- **Complaint:** received → acknowledged → investigating → resolved → closed.
- **WaitlistEntry:** waiting → offered → converted/expired; waiting → withdrawn.

---

## 7. Casos de fallo y cómo los cubre el diseño

Solo los casos que no cubre ya otra sección con prueba nombrada: acceso, sesiones y datos personales (4.1–4.9), eventos y correo (3.1, 4.5–4.6), monedas (1.1), pagos y estados (5.5, 6), bloqueos (6.3), automatizaciones (5.8) y criterios de fase (8).

| Caso | Respuesta del diseño | Tarea que lo prueba |
|---|---|---|
| Dos solicitudes por la última plaza a la vez | `UPDATE` condicional del cupo en la transacción y `CHECK`; la segunda falla con 409 | 2.4 |
| Un cupo baja de cero por un ajuste manual | `CHECK (consumed BETWEEN 0 AND capacity)`; reducir capacidad por debajo de lo consumido se rechaza | 1.1 |
| Alguien solicita con el correo de otra persona para retener cupo | la solicitud exige sesión verificada por enlace mágico; límite de peticiones; caducidad de solicitudes | 2.4 |
| El navegador manda un importe | los esquemas de entrada de solicitud y cobro no tienen campo de importe; prueba que un campo extra se rechaza | 2.4, 3.2 |
| Cambia un precio después de una solicitud | la reserva usa su `BookingSnapshot`; nada la recalcula | 2.4 |
| Fecha límite en el cambio de día | fechas de calendario y zona del negocio; pruebas en el día exacto de cada tramo | 3.2, 6.4 |
| Desbordamiento de enteros en sumas | importes en `bigint`; `SUM` de PostgreSQL devuelve `numeric`, que se convierte a `bigint` con comprobación | 4.6, 6.6 |
| Migraciones en paralelo que chocan | un archivo por módulo, más los campos inversos del padre (3.1); regenerar la migración propia encima de `main` | todas |
| Webhook saliente hacia una IP interna | validación de URL y resolución DNS contra rangos privados | 8.4 |
| API dormida pierde webhooks | requisito de alojamiento siempre encendido; reconciliación diaria como red | 0.7, 4.6, 8.7 |

---

## 8. Pruebas que cada tarea escribe primero

Esta tarea no tiene código. Estas son las pruebas que fijan los invariantes del plan; cada tarea las escribe antes de implementar.

- **0.2:** convenciones del esquema: sin `Float` ni `Decimal`; `*Minor` en `BigInt` con su moneda emparejada, moneda no nula si hay importe y moneda opcional nula si no hay ninguno (1.1); `*Bps` en `Int`; `CHECK` de signo salvo `@signed`; `@pii`/`@nopii` en toda columna de texto, `Json` o `Bytes`; ninguna FK con `CASCADE` ni `SET NULL` sin excepción anotada (5.10); `every_composite_fk_has_declared_unique` (recorre el DMMF: toda FK compuesta de la tabla de 1.1 tiene su `@@unique` en el padre); `@secret` en toda columna `*Hash`, `*Ciphertext`, `*Secret*` o `*Token`. `docker compose up` arranca y sana `db`, `mail`, `api` y `web`; la API no arranca sin `APP_ENV`; la API usa `mt_app` y las migraciones `mt_owner`; `mt_app` sin tablas propias ni `TRUNCATE`; `mt_app_has_no_create_privilege`. CI falla con pruebas saltadas y ejecuta `node scripts/check-dependency-table.mjs`. Prueba de humo `compose_up_smoke_has_demo_data` tras `docker compose up`: servicios sanos (0.2), el personal demo entra (0.3) y la lista de `Task` demo tiene filas (0.5); la ejecuta el cierre de la fase 0.
- **0.3:** 403 sin permiso; `every_route_has_exactly_one_access_mark`; `every_owned_route_rejects_other_customer` (recorre toda ruta `@OwnedBy` con dos clientes; cada ruta aporta su dato de prueba y la prueba falla si falta); `step_up_enforced_from_permission_manifest`; `customer_user_audit_pii_has_subject`; auditoría con valor anterior y nuevo, `@pii`, motivo y campos sin anotar en `AuditPiiValue`, secretos solo como `"[changed]"` (`secret_columns_never_serialised_logged_or_audited`); todo modelo `@appendOnly` tiene su disparador y `AuditLog` es inmodificable también para `mt_privacy`; la excepción de `mt_privacy` no deja cambiar otras columnas; `immutable_tables_have_no_fk_to_deletable_rows`; funciones de `mt_privacy` con `search_path` fijo y `EXECUTE` solo para `mt_app`; `non_empty_role_scope_rejected_and_denies`; `last_owner_cannot_be_removed_concurrently`; step-up sin TOTP reciente → 403; `totp_code_cannot_be_reused`; enlace mágico de un solo uso y caducado, respuesta idéntica para correo inexistente; sesión de cliente no entra al panel aunque el correo coincida; retraso progresivo sin bloqueo definitivo; cambiar un flag queda auditado; e2e con contraseña y TOTP.
- **0.4:** transacción deshecha sin evento; entrega doble procesada una vez; `skip` con flag apagado marca `skipped` y **`hold` deja `pending` y procesa al encender**; ningún consumidor de `payments.*`, `bookings.*` o `changes.*` con `skip`; `IdempotencyRecord` sin cuerpo y repetición con el recurso actual; guarda de correo (lista y `MAIL_MODE`); `OutboundEmail.dedupeKey`; la API no arranca sin sus colas de pg-boss ni crea su esquema; `stale_notify_event_skipped_after_reenable`; `unique_violation_error_does_not_store_value`; batería de contrato de `FileStorage`.
- **0.5:** sobre la **lista de `Task` del panel** (tabla de ejemplo de la fase 0): búsqueda global por título; filtros combinados y orden; vista guardada; acción en lote que respeta el permiso de cada elemento; CSV que escapa fórmulas; importación con un error no escribe nada; etiquetas; notas; historial con valor anterior y nuevo; borrado lógico y restauración.
- **1.1:** transiciones de estado de venta; `guaranteedEntry` es falso si falta el `RaceClaim` o algún cupo de dorsales no está confirmado; cupo no baja de cero; paquete en `draft` no sale por la API pública; **un paquete demo no pasa a `open` ni una carrera demo a `published`, con cualquier `APP_ENV`**; `isDemo` no se puede cambiar por la API.
- **2.1/2.2:** tabla de ocupación 1 a 4, noches extra, acompañantes, códigos, combinaciones de reglas, fechas límite y regla de redondeo; **entradas con monedas distintas se rechazan**; `fixed_rule_other_currency_never_applied`; `max_per_customer_concurrent_redemptions`; `rule_direction_sets_sign` (importes siempre ≥ 0).
- **2.4:** dos solicitudes concurrentes por la última plaza; **caducidad y cancelación concurrentes liberan el cupo una sola vez; aprobar y caducar a la vez: solo gana una**; transición no permitida rechazada; cambio de precio no altera la instantánea; importe del cliente rechazado (`client_amount_field_rejected`); celdas sin dinero de `booking_state_event_matrix`; `opposite_order_requests_do_not_deadlock`; `customer_cannot_act_on_other_customers_booking` (también en 3.2).
- **2.5:** `quote_accepted_twice_creates_one_booking`; `quote_acceptance_without_inventory_returns_409`.
- **3.x, 4.x, 6.2, 6.3:** todas las pruebas nombradas en los requisitos P1–P12 (5.5) y en 6.2 (matrices estado × evento, regla de cobertura), escritas antes de implementar por la tarea indicada.
- **Criterios de fase sin otra prueba:** `confirmation_page_says_request_not_booking` (2.3); e2e `search_configure_request_manage` (2.5); `card_data_never_reaches_api` (3.3: esquemas sin campos de tarjeta y campos alojados); `all_gateways_off_ends_in_request_without_errors` (3.5); `gateway_down_checkout_offers_others` (4.2); `report_separates_unpaid_supplier_funds_from_margin` (4.6); `account_with_history_not_deletable` y `pausing_last_account_of_method_warns` (4.1); `reconciliation_detects_injected_difference` (4.6); `only_confirmed_subscribers_get_opening_email` (5.3); `cancellation_promotes_first_waitlisted` (6.5); `trip_result_matches_ledger` (6.6); `organiser_export_contains_only_its_fields` (7.2); `automation_test_mode_sends_and_changes_nothing` (7.4); `custom_field_in_forms_filters_exports` (7.5); `no_surcharge_by_payment_method` (3.2, 4.2); fase 1: e2e `create_publish_and_view_race` (la última de 1.2 y 1.3 en fusionarse), `filters_combined_survive_reload` y `provisional_date_shown` (1.3), `draft_absent_from_sitemap` (1.4); fase 4: `retired_account_refunds_but_rejects_new_charges` y `live_account_creation_rejected_for_unverified_adapter` (4.1, también fase 9); fase 5: e2e `full_customer_journey` (5.7), `no_form_asks_passport_or_medical` (5.2, 5.7); fase 8: `guide_publish_needs_no_deploy` y `legal_pages_marked_pending_review` (8.1), `new_locale_needs_no_migration` (8.2); fase 9: `new_adapters_do_not_change_active_gateways`.
- **5.1/5.2:** `customer_cannot_read_other_customers_booking` (dos clientes, todas las rutas del área); `traveller_of_other_customer_cannot_be_assigned`.
- **5.5:** todo modelo con camino hasta el cliente (DMMF) o polimórfico está en el registro con su manejador; el borrado conserva el libro. **Barrido:** para cada modelo del registro (no una lista a mano) se escribe un marcador en **todas** sus columnas de texto, `String[]`, `Json` y `Bytes`, y un valor centinela en sus `@pii` de fecha, entero y `Char(n)` (`Traveller.dateOfBirth` y `estimatedFinishSeconds`, `countryOfResidence`, `Booking.residenceCountry`) (las `@nopii` deben rechazarlo), más nota, tarea, adjunto y etiqueta sobre cliente, reserva y viajero, documentos, exportaciones, informes, búsqueda, auditoría con motivo, trabajos y correos; se borra sin errores de FK ni `UPDATE` en inmutables, y en **todas** las tablas (incluido `pgboss`) y archivos el marcador solo queda en recibos y paquetes de pruebas de disputas abiertas (`erasure_redacts_polymorphic_notes_and_tasks`, `erasure_removes_user_audit_pii_written_before_customer_existed`); `mt_app` no modifica las inmutables y solo las funciones de `mt_privacy` aplican excepciones.
- **6.4:** `one_cancellation_per_booking` (dos clics); penalización en el día exacto de cada tramo (`cancellation_tier_boundaries`).
- **7.4/7.7:** `registering_money_or_permission_action_fails`; `automation_cannot_exceed_author_permissions`; `scheduled_report_runs_with_owner_permissions`.
- **8.4:** una clave de API pierde un permiso cuando su dueño lo pierde; clave de un dueño desactivado → 401; `outbound_webhook_suppressed_outside_production`.

---

## 9. Decisiones que tomo distinto de lo pedido

Cada una con su motivo y cómo deshacerla. Ninguna cambia lo que Oscar pidió que el producto haga; cambian cómo se modela.

1. **Tipo de viajero por persona, no tipo de paquete** (lo pedido: `Package.type` = `with_entry`/`own_entry`/`supporter`). Una pareja corredor + acompañante en la misma habitación no cabría en el precio por ocupación. Un paquete admite varias `PackageParticipationOption` y cada viajero tiene la suya, con su `ParticipationRate`. Deshacer: una sola opción por paquete.
2. **Cupos unificados en `InventoryPool`** (dorsales, habitaciones, extras), alimentados por los `Allotment` de 6.1. Deshacer: columnas de cupo en cada entidad.
3. **Dorsales por distancia.** Una carrera con maratón y media tiene cupos distintos; `PackageEntryOption` une paquete, distancia y cupo.
4. **Instantáneas sin datos personales y auditoría con tabla aparte para ellos**: inmutables de verdad y compatibles con el borrado.
5. **Personal y clientes como identidades separadas** (`User.kind`); personal con TOTP y sin recuperación por correo.
6. **Solicitar exige sesión de cliente**, porque el cupo se retiene al solicitar; el constructor guarda su estado en la URL para volver tras el enlace mágico. Deshacer: solicitud anónima con verificación posterior y retención corta.
7. **Ninguna columna `Float` ni `Decimal`**, tampoco en tipos de cambio o coordenadas: regla comprobable sin excepciones.
8. **Estado de cobro derivado del libro** y transición nueva `balance_paid → confirmed` cuando sube el total o se pierde un contracargo.
9. **El estado del adaptador vive en código**, no en la base de datos, para que nadie pueda marcarlo `verified` desde el panel.
10. **Fase 9: no escribir treinta adaptadores a ciegas.** Fichas `planned` para todo el catálogo y adaptadores solo a demanda (hoy, aparcada con el dinero).
11. **Sin Redis**, coherente con `docs/architecture.md`.
12. **Módulos de dinero sin feature flag** (`catalogue`, `pricing`, `bookings`, `payments`): apagarlos dejaría reservas y pagos a medias. Deshacer: añadir el flag con consumidores `hold`.
13. **Los datos demo nunca se publican**, ni en desarrollo; para verlos en local hay una vista previa marcada como "DEMO". Deshacer: permitir publicar demo en `development`.
14. **Importes en `BigInt` desde el principio y como cadena en JSON.** Deshacer: imposible sin migración; por eso se elige ya el tipo ancho.
15. **Pendiente derivado del reparto y un solo intento vivo por reserva** (sustituye a "un aplazamiento manual una sola vez"). Deshacer: `Setting` de gracia tras `approvalExpiresAt`.
16. **Roles de base de datos separados**; pg-boss creado por migraciones. Deshacer: `CREATE` en `pgboss` para `mt_app`.
17. **Sin texto libre en lo inmutable ni cuerpos en `IdempotencyRecord`**; anotación `@pii`/`@nopii`/`@secret` en todo modelo (y en toda columna de los ligados al cliente); país anonimizado como `ZZ`. Deshacer: columnas `@pii` con excepción de borrado.
18. **Fuera de producción, ninguna llamada `live`.** Deshacer: no recomendado.
19. **`mode` inmutable y en la cuenta del libro.** Deshacer: migración que lo quita de la clave.
20. **Toda transferencia confirmada es un `inbound`**, deduplicado por el movimiento bancario. Deshacer: `manual_intent` → `succeeded`.
21. **Reparto reversible y reembolsos con finalidad**; plazos activos = total. Deshacer: recalcular el reparto al leer.
22. **Un coste de proveedor, un pago.** Deshacer: tope por suma.
23. **Ámbitos de rol bloqueados** (`CHECK`). Deshacer: lo quita la tarea que filtre.
24. **Contracargo del depósito sin retroceso** y **`refunded → cancelled`** (fuera del flujo pedido: un reembolso revertido devuelve dinero cobrado). Deshacer: `deposit_paid → approved`; dejar `refunded` con tarea.
25. **Avisos de más de 48 h descartados.** Deshacer: subir `maxEventAge`.
26. **Reserva y pagos en la misma transacción**; ninguna reserva cerrada se reactiva; un viaje sin pagar del todo se cierra como `completed` con saldo pendiente 30 días después del regreso, y el cliente no cancela pasada la salida. Deshacer: transición de reactivación; cierre manual.
27. **`direction` en reglas de precio** (importes ≥ 0) y **cuentas `fx_conversion`** por moneda. Deshacer: `@signed` en `valueMinor`; registrar solo la moneda pagada.
28. **`manual_intent` cancelable y cuentas archivadas con webhooks** (archivar tras 180 días). Deshacer: tratar el `manual_intent` como un débito.
29. **Acceso cerrado por defecto**: marca de acceso en toda ruta y step-up desde el permiso; claves de idempotencia del servidor; `price_reduction` y `cancellation` responden 409 hasta 6.3 y 6.4, y 4.5 hace los parciales como devolución de sobrepago. Deshacer: adelantar a 4.5 un `BookingAmendment` y una `Cancellation` mínimos.
30. **Correcciones sin editar nada**: `inbound` erróneo anulado con reversión y recibo rectificativo; código promocional liberado también al cancelar. **Desviación de `docs/architecture.md`** ("cambiar estado" en automatizaciones): no aprueban, rechazan ni cancelan reservas, porque esas transiciones mueven dinero, y actúan con los permisos de su dueño. Deshacer: añadirlas con permiso específico.
31. **Llamadas a la pasarela fuera de la transacción** con nuestro id en metadatos; la URL del webhook entrante se enseña una sola vez (solo se guarda su hash); un reembolso solo consume el sobrepago de su propio pago; un pago desconocido no crea intento: tarea y conciliación. Deshacer: registrarlo como `inbound` sin reserva.
32. **FK siempre `Restrict` e identidad del dinero inmutable** (también el importe de un plazo: se sustituye); un cobro con importe o moneda distintos de la pasarela no se anota; la reserva inmediata solo se aprueba sola con un método enrutable; `deposit_paid` siempre pasa por `confirmed`. Deshacer: excepción anotada por relación.
33. **Exceso de contracargo o reembolso externo como `receivable`** con tarea; **borrado de cliente rechazado con viaje activo**; **GST por componente** pendiente de validar por el contable de Oscar. Deshacer: absorber el exceso en `dispute_losses`; aplazar el borrado con tarea.
34. **La oferta de la lista de espera retiene la plaza liberada**; fechas de viaje en `Booking` (y en `Quote` a medida); `mode` también en costes y pagos a proveedor; campos inversos de Prisma permitidos en el archivo del padre. Deshacer: oferta sin retención.
---

## 10. Riesgos del plan de fases y cambios en la tabla de dependencias

### 10.1 Cambios que aplico en `docs/autonomous.md`

| Tarea | Antes | Ahora | Motivo |
|---|---|---|---|
| 0.3 | 0.2 | 0.2, **0.4** | El enlace mágico necesita el correo y su guarda (0.4). Sin ciclo: tablas y lectura de `FeatureFlag` y `Setting` en 0.4 (sin rutas HTTP); su administración en 0.3. |
| 2.5 | 2.4, 0.5 | 2.4, **2.3**, 0.5 | La e2e de la fase 2 (buscar, configurar, solicitar, gestionar) necesita constructor, solicitud y bandeja; la escribe 2.5. |
| 5.1 | 3.5 | 3.5, **4.6**, **5.4** | El área del cliente descarga recibos (4.6) y documentos PDF (5.4). |
| 7.3 | 1.2, 0.4 | 1.2, 0.4, **3.2**, **6.1** | Fechas clave de saldos (3.2) y de liberación de cupos (6.1). |
| 5.7 | resto de la fase 5, fase 4 cerrada | 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, fase 4 cerrada | Lista explícita. |
| 8.5 | fases 0 a 7 cerradas, 8.4 | fases 0, 1, 2, 3, 4, 5, 6 y 7 cerradas, **8.1, 8.2, 8.3**, 8.4, **8.6**, **8.7** | La revisión de seguridad debe cubrir contenido, monitor, mantenimiento y el alojamiento (mismo sitio para web y API, base de la cookie y el CSRF; roles de base de datos). |
| 9.x | fase 4 cerrada, 8.5 | filas propias 9.1–9.4 | 9.1: fase 4 cerrada, 8.5; 9.2: 9.1; 9.3: 9.2 y 9.4: 9.1, solo con adaptadores propios. Alto salvo 9.4. La cadena respeta las dos variantes y el límite de dos hilos de riesgo alto. |

Con el dinero aparcado (2026-11-12), la tabla de `docs/autonomous.md` quita 4.6 de 5.1, "fase 4 cerrada" de 5.7, 4.5 de 6.3 y 6.4 de 6.5, y 3.5 pasa a depender de 3.2, 3.6 y 2.3. "Fase N cerrada" se define en una nota bajo la tabla. Comprobado con `node scripts/check-dependency-table.mjs`: 61 filas, sin tareas de más ni de menos, sin identificadores inexistentes ni ciclos ("fase N cerrada" se expande a sus tareas; 9.1 y 9.2 aparecen dos veces en `phase-9.md` a propósito).

### 10.2 Riesgos que no cambian la tabla

- **Sin claves de Stripe** la e2e con su tarjeta de prueba queda bloqueada (`test:sandbox` aparte, adaptador `experimental`); hoy está aparcado con el dinero. La prueba semanal de contrato la crea 9.4, o 9.1 con el orquestador.
- **0.3 y 0.5 son grandes**: si hace falta, sub-PR dentro de la misma tarea.
- **El cupo se retiene al solicitar** (caducidad y recordatorio); **la API va siempre encendida** por pg-boss y webhooks (0.7, 8.7).
- **Fase 5 antes que la 6** (y 6.4 aparcada): una reserva cancelada exige 0 y lo cobrado queda como sobrepago a devolver (P8).

---

## 11. Supuestos (las preguntas que haría a Oscar)

Opciones conservadoras y reversibles, casi todas un `Setting`; no se repiten las que fija otra sección.

1. Zona horaria del negocio: `Australia/Brisbane`.
2. Moneda única por paquete: AUD.
3. Depósito fijado por cada paquete (por persona, por reserva o porcentaje), sin valor por defecto: sin depósito no pasa a `open`.
4. Una solicitud sin revisar caduca a los 7 días (recordatorio a los 3); una aprobación sin depósito, a las 72 horas (6.2); un pago manual pendiente, a los 5 días hábiles.
5. Un cliente por correo; los viajeros son del cliente que reserva y se reutilizan.
6. Acompañantes y corredores con dorsal propio no consumen dorsales.
7. Todas las personas de una habitación pagan la tarifa de esa ocupación; sin tarifa infantil.
8. GST desactivado al empezar; los recibos no dicen "tax invoice".
9. Países de venta: solo `AU`.
10. Retención: registros económicos 7 años (la ATO pide 5); cuerpos de webhooks 180 días; analítica 13 meses.
11. Se guardan IP y navegador al aceptar condiciones, como prueba ante disputas.
12. El primer `owner` se crea por consola con el correo de una variable de entorno.

---

## 12. Lo que este plan no hace

No escribe código de producto ni migraciones (solo el script de la tabla, 10.1); no elige pasarela, orquestador ni alojamiento (0.7, 3.1, 8.7); no fija la semántica de reglas de precio ni del libro (2.2, 3.1, dentro de P1–P12); no cambia archivos de fase ni criterios, solo la tabla de `docs/autonomous.md`; no crea tablas "más adelante".
