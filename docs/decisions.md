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

## Abiertas

- Orquestador de pagos (Hyperswitch) frente a adaptadores propios: se decide con `docs/research/payment-providers.md`.
- Proveedor de alojamiento: se decide con `docs/research/hosting.md`.
- Lanzar solo con tarjeta o también con transferencia.
