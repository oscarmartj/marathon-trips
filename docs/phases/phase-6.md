# Fase 6: proveedores, cambios y finanzas

**Objetivo:** operar un viaje vendido sin hojas de cálculo: costes, cupos contratados, cambios, cancelaciones y resultado.

**Referencia:** `docs/modules.md`, módulos 8, 9 y 11; `docs/plans/phase-0-architecture.md`, §1.6 (bolsas de inventario, que aquí reciben contrato y fecha de liberación) y §1.12.

## Tareas

| # | Tarea | Riesgo | Sesión |
|---|---|---|---|
| 6.1 | Proveedores, contratos, cupos contratados con fecha de liberación y precios de coste en su moneda. | Medio | `opusplan` |
| 6.2 | Calendario de pagos a proveedores, enlazado al informe de dinero de clientes. Devengo de costes por reserva y reparto de cada pago entre los costes que salda. | Alto | `opusplan`, `reviewer` |
| 6.3 | Cambios en una reserva confirmada con recálculo de la diferencia. | Alto | `opusplan`, esfuerzo alto, `reviewer` |
| 6.4 | Políticas de cancelación por tramos y cálculo de penalización y reembolso. | Alto | `opusplan`, esfuerzo alto, `reviewer` |
| 6.5 | Lista de espera con promoción automática al liberarse una plaza. | Medio | `opusplan` |
| 6.6 | Resultado por viaje, previsión de caja y exportación para el contable. | Medio | `opusplan` |

## Criterios de aceptación

- Un cambio genera un registro con la diferencia y no modifica la copia original de la reserva.
- La penalización calculada coincide con la política en los días límite de cada tramo.
- Una cancelación devuelve la plaza al cupo y promociona al primero de la lista de espera.
- El resultado por viaje cuadra con el libro de pagos y con los costes registrados.
- El informe separa lo cobrado y no pagado a proveedores del margen (antes en 4A).

## Fuera de alcance

Operaciones en destino, automatizaciones e informes a medida.

## Revisión de Oscar

Simular un viaje con un cambio y una cancelación, y comprobar los números a mano.
