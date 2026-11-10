# Arquitectura, plataforma y calidad

Documento de referencia. Abre solo la sección que necesite la tarea.

## Arquitectura

Frontend y backend separados, en un monorepo:

- `apps/web`: Next.js (App Router) + TypeScript + Tailwind. Sitio público, área del cliente y panel de administración bajo `/admin` (grupo de rutas protegido, cargado aparte para no penalizar el sitio público).
- `apps/api`: NestJS + Prisma + PostgreSQL. API REST documentada con OpenAPI. Es la única fuente de verdad de precios, cupos, estados, pagos y permisos.
- `packages/shared`: esquemas de validación y tipos compartidos, y un cliente de API tipado generado desde el OpenAPI, para que el frontend no pueda desalinearse del backend.
- pnpm workspaces + Turborepo. `docker-compose` para desarrollo local (PostgreSQL y un servidor de correo de pruebas tipo Mailpit).

Decisiones de backend que quiero, salvo que me propongas algo mejor razonado:

- **Tareas en segundo plano sobre PostgreSQL** (por ejemplo pg-boss) en lugar de Redis, para no pagar otro servicio.
- **Correo, almacenamiento de archivos y pagos detrás de interfaces propias**, con adaptadores intercambiables. Almacenamiento compatible con S3.
- **Autenticación en la API.** Clientes: acceso por enlace mágico al correo. Administrador: contraseña (argon2) más segundo factor TOTP. Sesiones en cookies httpOnly. Roles `admin` y `customer`, con el modelo preparado para añadir más.
- **Registro de auditoría** de toda acción del administrador y de todo cambio de estado, precio, cupo o pago (quién, qué, cuándo, valor anterior y nuevo). Vengo de auditoría de TI y lo voy a usar.
- **Internacionalización preparada.** Se publica solo en inglés, pero las rutas, los textos de interfaz y el contenido editable deben admitir más idiomas sin rehacer el modelo de datos.

## Un backend completo, configurable y extensible

Quiero poder hacer casi cualquier cosa del negocio desde el panel, sin pedir cambios de código cada vez. Eso no significa construirlo todo de golpe, sino diseñar bien tres cosas desde la Fase 0:

1. **Todo pasa por la API.** El panel es un cliente más. Cualquier acción del panel existe como endpoint documentado y con permisos, de modo que más adelante pueda automatizarla, conectarla con otra herramienta o abrirla a un socio.
2. **Configuración antes que código.** Lo que cambia con el negocio se edita en el panel y se guarda en la base de datos: reglas de precio, políticas de cancelación, plantillas de correo y de documentos, campos personalizados, etiquetas, automatizaciones, roles y permisos, textos y páginas.
3. **Módulos independientes que se hablan por eventos.** Monolito modular en NestJS. Cada módulo publica eventos de dominio (patrón outbox, para no perder ninguno) y los demás se suscriben. Añadir un módulo nuevo no debe obligar a modificar los existentes, y cada módulo se enciende con un feature flag.

**Capacidades comunes a todas las entidades.** Constrúyelas una sola vez como piezas reutilizables, porque son las que hacen que el panel sirva para casi todo:

- Búsqueda global, filtros combinables, orden y vistas guardadas.
- Acciones en lote, importación y exportación CSV.
- Campos personalizados definidos desde el panel (tipo, validación y si los ve el cliente) en carreras, paquetes, clientes, viajeros, reservas y proveedores.
- Etiquetas, notas internas, adjuntos y tareas con fecha en cualquier registro.
- Historial de cambios por registro y borrado lógico con restauración.

**Plataforma**

- **Roles y permisos granulares**, con una matriz editable. Hoy solo estoy yo, pero quiero poder dar acceso limitado a un ayudante, un contable o un guía en destino.
- **Automatizaciones**: reglas de disparador, condiciones y acciones (enviar correo, crear tarea, cambiar estado, etiquetar, llamar a un webhook), por evento o por calendario, con modo de prueba y registro de ejecuciones.
- **Plantillas editables** de correos y de documentos PDF (confirmación, itinerario, bono, recibo), con variables y vista previa.
- **Claves de API con ámbitos** y **webhooks salientes** firmados, para integraciones futuras.
- **Constructor de informes**: elegir entidad, columnas, filtros y agrupación; guardar el informe y programar su envío por correo.
- **Monitor del sistema**: cola de tareas, correos, webhooks, errores y estado de salud; modo mantenimiento.
- **Privacidad**: exportar o borrar los datos de un cliente y reglas de retención.
- **Copias de seguridad** con una prueba de restauración documentada.

Si alguna de estas piezas existe ya como librería madura y mantenida, úsala en vez de reinventarla y dime cuál.

## Modelo de dominio (punto de partida, mejóralo)

- **Race**: nombre, slug, país, ciudad, distancias, tipo (ruta, trail, ultra), mes habitual. Incluye `externalSource` y `externalId` para poder importar carreras desde un catálogo externo más adelante.
- **RaceEdition**: año, fecha, indicador de fecha confirmada o provisional, estado.
- **Package**: pertenece a una edición. Tipo (`with_entry`, `own_entry` para quien ya tiene dorsal, `supporter` para acompañantes), noches, fechas de entrada y salida, incluye y no incluye, cupo de dorsales y si ese cupo está confirmado por la carrera, importe del depósito y fecha límite del saldo.
- **Estados de venta del paquete**: `draft`, `coming_soon` (solo alertas), `open`, `waitlist`, `sold_out`, `closed`.
- **Hotel** y **RoomOption**: tipo de habitación, ocupación de 1 a 4 personas, precio por persona según ocupación, cupo de habitaciones.
- **Extra**: noches adicionales, excursiones, traslados; precio por persona o por reserva; cupo opcional.
- **Customer**, **Traveller** (corredor o acompañante) y **Booking**.
- **Booking** guarda una copia inmutable de la configuración y del desglose de precio en el momento de enviarla, y sigue un flujo: `requested → approved → deposit_paid → confirmed → balance_paid → completed`, con salidas `declined`, `cancelled`, `expired` y `refunded`.
- **PaymentSchedule**, **Payment**, **Refund**, **Dispute**, **LedgerEntry** y **WebhookEvent**.
- **ProviderAccount** (cuenta de pasarela con credenciales cifradas, modo y estado `active`, `paused`, `retired` o `archived`), **PaymentMethodConfig** y **RoutingRule** (método, país, moneda, límites, prioridad y respaldo).
- **Supplier** (hoteles, operadores en destino, organizadores), **SupplierContract**, **Allotment** (cupo contratado con fecha de liberación) y **CostItem** (precio de coste, en su moneda, con fecha de pago al proveedor).
- **PriceRule** (reserva anticipada, suplementos, descuento de grupo), **PromoCode**, **Quote** (presupuesto con caducidad) y **CancellationPolicy** (tramos por días antes de la salida).
- **BookingAmendment**: cada cambio de una reserva confirmada, con su diferencia de precio.
- **AlertSubscription**: correo + carrera o edición, con doble confirmación.
- **Guide** y **Page**: contenido editorial, con campos SEO y estado de publicación.
- **Task**, **Complaint**, **TermsVersion** y **TermsAcceptance**.
- **CustomFieldDefinition**, **AutomationRule**, **SavedView**, **Role**, **Permission**, **ApiKey**, **WebhookSubscription**.
- **Document**, **Note**, **Tag**, **MediaAsset**, **EmailLog**, **AuditLog**, **FeatureFlag**.

El **motor de precios vive en la API**: dado un paquete, hotel, ocupación, noches, viajeros y extras, devuelve el total y el desglose. El constructor del frontend solo lo consulta y lo pinta, y el importe que se cobra sale siempre de la API, nunca del navegador.

Minimiza datos personales: en esta versión no se recogen números de pasaporte ni datos médicos, y nunca se almacenan datos de tarjeta.

## Seguridad y calidad

- Validación de entrada en toda la API, límites de peticiones, CORS restringido al origen de la web, cabeceras de seguridad, protección CSRF y registros sin datos personales ni de pago. Toma OWASP ASVS como referencia.
- Secretos solo en variables de entorno, nunca en el repositorio. Incluye `.env.example`.
- Pruebas: unitarias del motor de precios, de las transiciones de estado y del libro de pagos; de integración de la API y de cada adaptador contra su sandbox o un simulador (webhooks duplicados, fuera de orden y fallidos; reembolsos parciales; pasarela caída); y de extremo a extremo (Playwright) del flujo buscar → configurar → solicitar → pagar depósito → gestionar en el panel.
- CI en GitHub Actions: lint, tipos, pruebas y análisis de dependencias.
- Datos de ejemplo ficticios y marcados como demo, que no puedan publicarse por accidente.

## Coste y despliegue

El objetivo es A$0 durante el desarrollo y el mínimo posible al lanzar. Empaqueta la API en Docker para no depender de un proveedor. Prefiero pasarelas sin cuota mensual, que cobren solo por transacción.

Antes de elegir alojamiento, comprueba precios y condiciones actuales y escríbeme `docs/research/hosting.md` con dos o tres combinaciones (web, API y base de datos), su coste mensual y sus límites. Dos cosas a verificar en concreto: si el plan gratuito del alojamiento de la web permite uso comercial, y qué pasa con los planes gratuitos de API que se duermen tras un rato sin tráfico, porque una API dormida puede perder webhooks de pago.

No despliegues, no crees cuentas en servicios externos, no actives claves reales y no contrates nada sin preguntarme.
