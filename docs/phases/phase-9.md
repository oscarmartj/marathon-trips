# Fase 9: catálogo ampliado de pasarelas

**Objetivo:** tener disponibles en el panel el resto de pasarelas australianas y globales, por la vía decidida en la fase 0.

> **Bajo demanda (decidido el 2026-11-10).** No es una fase del plan. Se escribe un adaptador cuando una pasarela acepta la cuenta, con `docs/adding-a-payment-adapter.md`. Mientras tanto, el resto del catálogo aparece en el panel como fichas `planned`.

**Referencia:** `docs/payments.md`, sección "Catálogo de pasarelas"; `docs/research/payment-providers.md`; `docs/adding-a-payment-adapter.md`.

Antes de empezar, actualiza la investigación de proveedores: las condiciones y las API cambian.

## Si se eligió el orquestador

| # | Tarea | Riesgo | Sesión |
|---|---|---|---|
| 9.1 | Adaptador hacia el orquestador y mapeo de sus conectores al catálogo del panel. | Alto | `opusplan`, esfuerzo alto, `reviewer` |
| 9.2 | Adaptadores propios solo para las pasarelas australianas que el orquestador no cubra. | Alto | `opusplan`, `reviewer` |

## Si se eligieron adaptadores propios

Una pasarela por sesión. Orden: las que acepten a un sole trader de viajes y den sandbox sin trámite primero.

| # | Oleada | Riesgo | Sesión |
|---|---|---|---|
| 9.1 | B: resto de australianas de tarjeta, cuenta a cuenta (PayTo, PayID, BECS) y especialistas en viajes. | Alto | `opusplan`, `reviewer` |
| 9.2 | C: globales para empresa grande y pasarelas de bancos. | Alto | `opusplan`, `reviewer` |
| 9.3 | D: pago aplazado y otros métodos. | Alto | `opusplan`, `reviewer` |
| 9.4 | Hecha en 3.6: prueba semanal programada de contrato para los adaptadores `verified`. | — | — |

## Criterios de aceptación

- Cada adaptador pasa la batería de pruebas de contrato de la fase 3.
- Uno sin sandbox disponible queda como `experimental` y no puede pasar a modo real.
- El catálogo del panel muestra el estado y las capacidades de cada adaptador.
- Añadir estas pasarelas no cambia el comportamiento de las que ya estaban activas.

## Revisión de Oscar

Pedir el sandbox de cada proveedor que lo exija. No activar ninguna pasarela en real sin confirmación escrita del proveedor.
