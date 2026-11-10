# Fase 3: pagos, núcleo

**Objetivo:** cobrar depósito y saldo en modo de pruebas con Stripe y con transferencia por PayID, sobre un libro de pagos fiable.

**Referencia:** `docs/payments.md`, secciones "Requisitos" y "Cómo llegar a todas"; `docs/plans/phase-0-architecture.md`, §1.9, §1.10 y §3.4; `docs/research/payment-providers.md`; `.claude/rules/payments.md`.

## Tareas

| # | Tarea | Riesgo | Sesión |
|---|---|---|---|
| 3.1 | Diseño de la capa de pagos: interfaz `PaymentProvider`, libro de pagos, plan de pagos, enrutado, estados de adaptador. Sin código. Plan en `docs/plans/phase-3-payments.md`. | Arquitectura | Opus, esfuerzo alto |
| 3.2 | Libro de pagos inmutable, claves de idempotencia y plan de depósito y saldo con fechas límite. | Alto | `opusplan`, esfuerzo alto, `reviewer` |
| 3.3 | Adaptador de Stripe en sandbox: cobro, confirmación, reembolso y webhooks firmados e idempotentes. La cuenta de pasarela ya vive en la base de datos (cargada desde variables de entorno), con su propia URL de webhook. | Alto | `opusplan`, esfuerzo alto, `reviewer` |
| 3.4 | Método manual: transferencia con PayID, referencia única y confirmación manual en el panel. | Medio | `opusplan` |
| 3.5 | Checkout en la web: métodos activos por país, aceptación de condiciones con versión y fecha, y política de cancelación visible antes de pagar. Editor mínimo de versiones de condiciones en el panel. | Medio | `opusplan` |
| 3.6 | Batería de pruebas de contrato para adaptadores y simulador de pasarela para CI. | Alto | `opusplan`, esfuerzo alto, `reviewer` |

## Criterios de aceptación

- Ningún dato de tarjeta pasa por la API ni se guarda.
- Un webhook duplicado no genera dos asientos; uno fuera de orden no deja la reserva en un estado incorrecto.
- Repetir una operación con la misma clave de idempotencia no cobra dos veces.
- Los asientos del libro no se pueden editar ni borrar por la API.
- La suma del libro de una reserva coincide con lo cobrado menos lo reembolsado.
- Con todas las pasarelas apagadas, el flujo termina en solicitud sin cobro y sin errores.
- Prueba de extremo a extremo: pagar un depósito con la tarjeta de prueba de Stripe y ver la reserva confirmada.
- Las claves de sandbox están en variables de entorno, no en el repositorio.

## Fuera de alcance

Otras pasarelas, gestión de pasarelas desde el panel, reembolsos parciales y disputas.

## Revisión de Oscar

Aprobar el plan de 3.1. Leer los tres informes del `reviewer` y el diff del libro de pagos. Hacer un pago de prueba completo.
