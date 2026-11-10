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
| 2026-11-10 | Modelo de datos y estructura del monorepo según `docs/plans/phase-0-architecture.md` | Plan de la tarea 0.1 aprobado |
| 2026-11-10 | La reserva tiene dos estados: ciclo de vida y cobro | Una sola cadena no expresa saldos vencidos, reembolsos ni disputas |
| 2026-11-10 | El tipo (con dorsal, con dorsal propio, acompañante) es de cada viajero, no del paquete | Corredor y acompañante comparten habitación en una sola reserva |
| 2026-11-10 | Cupos como bolsas de inventario compartidas por los paquetes de una edición, desde la fase 1 | Evita vender más dorsales o habitaciones de los que hay |
| 2026-11-10 | Las solicitudes retienen plaza; los plazos de revisión y de pago del depósito los fija cada carrera | Respuesta de Oscar |
| 2026-11-10 | Libro de pagos de partida doble | Dinero de clientes, conciliación y resultado por viaje salen del mismo libro |
| 2026-11-10 | Auditoría con triggers en la base de datos, sin valores de campos personales | Completa y compatible con el borrado de clientes |
| 2026-11-10 | Autenticación propia sobre argon2id y otplib, sin framework de autenticación | Dos flujos distintos y control total para revisarla |
| 2026-11-10 | Orden de fases: 0, 1 (con alertas), 2, 3, 4A, 5, 4B, 6, 7, 8 y un único lanzamiento al final con todo | Respuesta de Oscar; detalle en `docs/phases/README.md` |
| 2026-11-10 | Adaptadores de pasarela solo para las que acepten la cuenta; fase 9 bajo demanda | Un adaptador sin cuenta real no se puede verificar |
| 2026-11-10 | Dependencias de §6 del plan aprobadas | Respuesta de Oscar |
| 2026-11-10 | Preguntas 2–9 y 12–14 del plan: se aplica lo propuesto por defecto | Sin respuesta; se puede cambiar antes de la tarea que bloquean |
| 2026-11-10 | Correcciones de la revisión independiente de 0.1 aplicadas al plan (§8) | Tres hallazgos graves: borrado frente a tablas inmutables, caducidad con pago en curso y doble cobro de un plazo |
| 2026-11-10 | Las tareas 1.1 y 1.6 pasan a riesgo alto con `reviewer` | Tocan cupos y datos personales (CLAUDE.md). Pendiente de confirmar por Oscar |

## Abiertas

- Orquestador de pagos (Hyperswitch) frente a adaptadores propios: se decide con `docs/research/payment-providers.md`.
- Proveedor de alojamiento: se decide con `docs/research/hosting.md`.
- Lanzar solo con tarjeta o también con transferencia.
- Cuándo pasa el dinero de un cliente a ser margen (pregunta 8 del plan). Confirmar con el contable antes de la tarea 3.1.
- Auditoría con valores personales, redactados al borrar un cliente. Sustituiría a la línea "Auditoría con triggers en la base de datos, sin valores de campos personales". Aplicado en el plan como propuesta (§8); falta confirmación antes de 0.3b.
- Retención provisional de 30 minutos hasta que el cliente confirma su correo (plan §8). Antes de 2.4.
- Pago confirmado tras la caducidad: reasignar la plaza o, si no la hay, reembolsar entero (plan §8). Antes de 2.4.
