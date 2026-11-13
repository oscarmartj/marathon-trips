# Decisiones

Una línea por decisión, con fecha. Si una decisión cambia, se añade otra línea; no se borra la anterior.

| Fecha | Decisión | Motivo |
|---|---|---|
| 2026-11-10 | Frontend y backend separados en un monorepo: Next.js y NestJS + Prisma + PostgreSQL | Estructura profesional con tipos compartidos y coste bajo |
| 2026-11-10 | Se publica en inglés, con la internacionalización preparada | Mercado inicial en Australia |
| 2026-11-10 | Solo residentes en Australia pueden reservar; el resto va a lista de espera | Vender en otros países activa sus normas |
| 2026-11-10 | Flujo por defecto: solicitud, confirmación de Oscar, depósito, saldo | Cupos limitados y un solo operador |
| 2026-11-10 | Capa de pagos propia con adaptadores; catálogo amplio de pasarelas; al lanzar solo Stripe y transferencia con PayID activas | No depender de un proveedor; los viajes son categoría de riesgo |
| 2026-11-10 | Sin recargos por método de pago | Prohibidos en Australia desde el 1 de octubre de 2026 |
| 2026-11-10 | Estilo visual deportivo y enérgico; marca provisional "Marathon Trips" | Preferencia de Oscar; nombre pendiente |
| 2026-11-10 | Backend configurable y extensible, construido por niveles: núcleo, segunda ola, más adelante | Ambición en el diseño, disciplina en el orden |
| 2026-11-10 | Orquestación por riesgo: Sonnet por defecto, Opus para planificar y revisar | Optimizar el uso |
| 2026-11-11 | Modo autónomo con Projects: coordinador, hilos en paralelo, revisor independiente en lugar de la aprobación de Oscar, y fusión automática con CI en verde | Terminar antes sin que Oscar esté pendiente de cada fase |
| 2026-11-11 | Las reglas de `.claude/rules/` se cargan siempre, sin `paths` | Las reglas con rutas no se cargan en los hilos en la nube |
| 2026-11-12 | Dinero aparcado: cobros reales, libro contable real, reembolsos, contracargos, conciliación, recibos y GST, divisas, pagos a proveedores y cancelación con penalización. Queda listo, sin modo real: tipos con dinero entero, motor de precios, `PaymentProvider` con simulador y checkout contra el simulador | Decisión de Oscar (0.1; sección "Aparcado: dinero" del plan). 15 tareas aparcadas y 6 parciales en `docs/autonomous.md`; se retoma quitando la etiqueta |
| 2026-11-12 | Orquestador o adaptadores propios: adaptadores propios tras `PaymentProvider` (Hyperswitch solo como adaptador futuro, 9.1) | Desempate de `docs/autonomous.md` y 0.7: el orquestador no cubre la mayoría de pasarelas australianas y añade un servicio que operar |
| 2026-11-12 | Alojamiento: un servidor en Sídney con Docker Compose y Caddy (combinación B de `docs/research/hosting.md`) | Es la más barata con todos los precios confirmados (0.7, 8.7) |
| 2026-11-12 | Solo tarjeta o también transferencia: se construyen las dos, cada una con su interruptor | Decisión prevista en `docs/autonomous.md` |
| 2026-11-12 | Ninguna pasarela nueva en el catálogo de pagos | Sin evidencia oficial en 0.7 |
| 2026-11-12 | Autenticación propia en lugar de Better Auth (enlace mágico, contraseña con argon2id, TOTP, step-up, límites en memoria sin `@nestjs/throttler`) | Plan 0.3 §3.1: menos superficie y control de los fallos (retraso progresivo, un solo uso bajo concurrencia); se deshace con una migración |
| 2026-11-12 | El proxy de la web no reenvía la IP del cliente salvo con `WEB_TRUSTED_PROXY_HOPS`; `TRUST_PROXY=uniquelocal`, `WEB_TRUSTED_PROXY_HOPS=1` y puerto 4000 sin publicar en producción (comprobado por `scripts/check-deploy-config.mjs`) | Evitar suplantar `X-Forwarded-For` (0.3, 8.7) |
| 2026-11-12 | El acceso de clientes va tras el flag `auth.customer_sign_in` (apagado si falta; el seed lo enciende en desarrollo) | Nada visible al público hasta decidirlo (0.3) |
| 2026-11-12 | Versiones conservadoras: Nest 11, TypeScript 5.9, ESLint 9, Vitest 4, Prisma 7.10 (no Nest 12, TS 7, ESLint 10 ni Prisma 8 RC) | Estabilidad; se suben con un PR (0.2) |
| 2026-11-12 | La prueba de convenciones del esquema analiza el texto de los `.prisma`, no el DMMF | No depende de internos de Prisma (0.2) |
| 2026-11-12 | Una sola cola `events.deliver` para todos los consumidores; faltante de flag = apagado; el fallo de idempotencia borra el registro | Evita DDL por módulo y estados a medias (0.4) |
| 2026-11-12 | Adaptador S3 de `FileStorage` no construido; la batería de contrato queda lista | Sin emulador libre y ligero comprobado (0.4) |
| 2026-11-12 | `Attachment` fuera de 0.5; importar y exportar CSV síncronos (`CsvJob` sin archivos); el índice de búsqueda se escribe en la misma transacción | Alcance de 0.5; se amplía con una migración |
| 2026-11-12 | Fuentes del sistema y marca provisional (naranja rojizo, lima, azul noche; logotipo de dos chevrones); un solo idioma `en-AU`; sin sitemap ni datos estructurados hasta la fase de SEO | Sin descargar tipografías ni fotos (0.6); se edita `brand.config.ts` |
| 2026-11-12 | Copias: cifrado obligatorio en producción, diaria 03:30, 14 locales, pérdida máxima 24 h (sin WAL), copia externa con `rclone` tras `BACKUP_REMOTE_KIND` | Simple y verificable (8.6); alternativa: SDK de S3 |
| 2026-11-12 | El modo mantenimiento deja pasar `/admin/*`, el acceso del personal y `GET /health` | El personal debe poder terminar el mantenimiento (8.6) |
| 2026-11-12 | Imagen de producción construida en el servidor con el Dockerfile de desarrollo; Caddy con TLS automático; correo en `catch` hasta que Oscar ponga SMTP | Sin registro de imágenes ni cuentas (8.7) |
| 2026-11-12 | Catálogo: solo `AUD`; `InventoryPool.editionId`; `InventoryMovement` sin `@appendOnly` pero con disparadores; activar un reclamo exige nota y step-up; un `guaranteedEntry` exige al menos una opción de dorsal; eventos en snake_case | Plan 1.1; se deshacen con una migración |
| 2026-11-12 | Las pruebas que desactivan a todos los owners usan una base propia por hilo | Evita carreras entre hilos (0.fix-1) |
| 2026-11-12 | Las automatizaciones no aprueban, rechazan ni cancelan reservas (desviación de `docs/architecture.md`) | Plan 0.1, sección 9 punto 30 |
| 2026-11-12 | Las 34 decisiones de la sección 9 del plan de 0.1 y los 12 supuestos de la 11 valen salvo que una línea posterior diga otra cosa (participación por viajero, cupos en `InventoryPool`, importes `BigInt` con signo, sin `Float`/`Decimal`, roles de base de datos sin `CREATE`, `@pii`/`@nopii`/`@secret`, toda ruta con marca de acceso, ninguna llamada `live` fuera de producción) | Plan 0.1; cada una lleva allí cómo deshacerla |
| 2026-11-12 | `scripts/check-dependency-table.mjs` (solo Node, sin dependencias) entra en 0.1 como excepción a «sin código» y 0.2 lo añade a `pnpm lint` | Comprobar mecánicamente la tabla de dependencias |
| 2026-11-12 | Panel de catálogo: duplicar un paquete solo dentro de la misma carrera, con cupos nuevos, vacíos y sin confirmar; el CSV de paquetes no importa depósito (dinero) y todo entra como borrador; sin permisos nuevos (exportar = leer, importar = gestionar); el panel solo edita `en-AU` y conserva otros idiomas | Plan 1.2; se deshace revirtiendo el PR |
| 2026-11-12 | Web pública: filtros del buscador solo los que admite la API (texto, distancia, tipo, mes, año, país); la guía de carrera solo muestra lo que hay en la API; «Construir» solo con el paquete en `open`; `/races/[slug]/build` acepta carreras nuevas (`dynamicParams`) | 1.3; se amplían cuando la API ofrezca más (precio, tipo de entrada, estado, continente) |
| 2026-11-12 | SEO: la dirección pública es `WEB_ORIGIN` (debe estar también al construir); solo `SportsEvent` con fecha confirmada; sin `Offer` (la API pública no tiene precios) ni `FAQPage` (la FAQ está vacía); el sitemap falla en lugar de publicarse sin carreras si el catálogo no responde, y no lleva `lastmod`; checkout en `noindex`. Sustituye a «sin sitemap ni datos estructurados hasta la fase de SEO» (fila de 0.6) | 1.4; se deshace revirtiendo el PR |
| 2026-11-12 | Datos demo: tres carreras ficticias con `isDemo`, creadas solo en `development`, `test` y `ci` (no en `staging`), sin precios, imposibles de publicar por los `CHECK` y disparadores de 1.1 | 1.5; más conservador; se quita el paso del seed y las filas se borran a mano |
| 2026-11-13 | Precios: semántica de reglas y códigos fijada en el motor; «no apilable» excluye todo descuento o recargo de la misma dirección sobre un objetivo solapado; `stackable` es `false` por defecto; cambiar reglas y códigos exige step-up; respuesta pública `invalid` única | 2.1, 2.2; el valor por defecto de `stackable` está pendiente de Oscar |
| 2026-11-13 | Solicitudes: sin `Traveller` hasta 5.2; caducidad 168 h o inicio del día de salida; 3 solicitudes abiertas y 12 plazas por cliente (`Setting`); ningún permiso de reservas ni de CRM es alcance de clave de API; cancelar exige step-up | 2.4, 2.5; se cambia con otra migración o el ajuste |
| 2026-11-13 | Aceptar un presupuesto crea la reserva ya `approved` (el precio lo fijó el equipo); validez 14 días por defecto, máximo 60; sin códigos promocionales en presupuestos | 2.5; alternativa: `requested`; se deshace en `createApprovedFromQuote` |
| 2026-11-13 | Quien declara un país fuera de `salesCountries` entra en lista de espera por la misma ruta de solicitud (decide el servidor); anonimizar redacta la entrada en lugar de borrarla | 2.6; el borrado con `mt_privacy` queda a 5.5 |
| 2026-11-13 | Campos personalizados: solo Race, Package y Supplier; mostrar un campo a clientes exige `common.customField.publish` con step-up; permisos sin alcance de clave | 7.5; los roles actuales no reciben `publish` solos |
| 2026-11-13 | Núcleo de pagos: cuentas solo `mode = 'test'` (`CHECK` hasta 4.1); simulador solo en development, test y ci y su cuenta solo por consola; intento de cobro de 60 min; 3.1 absorbe el plan, los intentos y el registro de cobros que eran de 3.2 | 3.1; la fila 3.2 de `docs/autonomous.md` queda con reparto, cobertura, caducidad de aprobaciones, enlaces y recordatorios |
| 2026-11-13 | Panel de precios: fechas de vigencia en la zona horaria del navegador (se muestra cuál); el panel no calcula importes (texto puro, sin floats) | 2.2b |
| 2026-11-13 | Regla C de cobertura en pagos de entradas: el depósito pasa la reserva a `deposit_paid` y el saldo a `balance_paid`; `confirmed` solo lo pone Oscar (`bookings.booking.confirm`, con step-up) | 3.2; sin `PaymentAllocation` (reparto derivado) |
| 2026-11-13 | La aprobación caduca en el instante exacto de `approvalExpiresAt` y el panel y la web muestran `depositDueBy`; no se alarga la retención | 3.2; el gancho `expire_approval` lo aplica |
| 2026-11-13 | Una tabla `message_templates` con columna de canal en lugar de plantillas de correo y de documento por separado; variables permitidas en código | 5.4; se separa en dos si hace falta |
| 2026-11-13 | Automatizaciones con lista cerrada de acciones (tarea, etiqueta, cerrar tareas automáticas, correo por plantilla, webhook); sin dinero ni permisos; horario estructurado en vez de `cron` | 7.4; coherente con la fila de automatizaciones del 2026-11-12 |
| 2026-11-13 | Ofertas de lista de espera de 48 h (`waitlistOfferHours`), a la primera entrada a la que le caben las plazas; aceptar crea una solicitud normal | 6.5; se cambia con el ajuste |
| 2026-11-13 | Aceptación de condiciones inmutable, con instantánea del texto, versión, huella, fecha y `customerId`; las condiciones son la página publicada `terms` y sin ella no hay pago | 3.5 (migración 0023) |

## Abiertas

- Orquestador de pagos: **resuelta** (adaptadores propios; fila del 2026-11-12). Alojamiento: **resuelta** (combinación B). Solo tarjeta o también transferencia: **resuelta** (las dos, con interruptor).
- Nombre de marca definitivo (hoy «Marathon Trips», en `brand.config.ts`).
- Valor por defecto de `stackable` (`false`) en reglas y códigos (2.2).
- Cuándo retomar el dinero (Oscar quita la etiqueta «aparcada» de `docs/autonomous.md`).
- Si el límite por IP en memoria basta con más de una instancia de API (hoy una; con más, mover los contadores a PostgreSQL).
