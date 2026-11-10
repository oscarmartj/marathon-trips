# Fase 2: precios, constructor y reservas

**Objetivo:** un corredor configura un paquete, ve el precio total y envía una solicitud; Oscar la gestiona en el panel.

**Referencia:** `docs/modules.md`, módulos 2 y 3; `docs/architecture.md`, sección "Modelo de dominio" (Booking, PriceRule, PromoCode, Quote); `docs/brief.md`, sección "Situación del negocio".

## Tareas

| # | Tarea | Riesgo | Sesión |
|---|---|---|---|
| 2.1 | Motor de precios en la API: paquete, hotel, ocupación, noches, viajeros y extras devuelven total y desglose. Pruebas en tabla. | Alto | `opusplan`, esfuerzo alto, `reviewer` |
| 2.2 | Reglas de precio editables, códigos promocionales con límites y versiones de precio con validez. | Alto | `opusplan`, esfuerzo alto, `reviewer` |
| 2.3 | Constructor de paquete en la web, que solo pinta lo que devuelve la API. | Medio | `opusplan` |
| 2.4 | Solicitud de reserva: copia inmutable de configuración y precio, máquina de estados, descuento de cupos en transacción. | Alto | `opusplan`, esfuerzo alto, `reviewer` |
| 2.5 | CRM: bandeja de solicitudes, ficha de cliente con historial, notas, presupuestos con caducidad y correos por cambio de estado. | Medio | `opusplan` |
| 2.6 | País de residencia: quien no reside en Australia entra en lista de espera en vez de en solicitud. | Bajo | Sonnet |

## Criterios de aceptación

- El motor de precios tiene pruebas para ocupación de 1 a 4, noches extra, acompañantes, códigos y combinaciones de reglas.
- Cambiar un precio después de una solicitud no altera esa solicitud.
- Dos solicitudes simultáneas por la última plaza: solo una la obtiene.
- Una transición de estado no permitida es rechazada por la API.
- La web nunca envía un importe; la API lo recalcula.
- Prueba de extremo a extremo: buscar, configurar, solicitar y gestionar en el panel.
- La pantalla de confirmación dice con claridad que es una solicitud y no una reserva confirmada.

## Fuera de alcance

Cobros, área privada del cliente y cancelaciones con penalización.

## Revisión de Oscar

Leer las pruebas del motor de precios como si fueran una tabla de tarifas y comprobar a mano tres casos. Leer los informes del `reviewer`.
