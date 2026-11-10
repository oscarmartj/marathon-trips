# Fase 4: gestión de pasarelas y operativa de pagos

**Objetivo:** Oscar añade, configura, pausa y retira pasarelas desde el panel, y tiene reembolsos, disputas y conciliación.

**Referencia:** `docs/payments.md`, secciones "Gestión de pasarelas desde el panel", "Catálogo de pasarelas" y "Requisitos"; `.claude/rules/payments.md`.

## Tareas

| # | Tarea | Riesgo | Sesión |
|---|---|---|---|
| 4.1 | Cuentas de pasarela en el panel: credenciales cifradas, modo prueba o real, estados (activa, pausada, retirada, archivada), prueba de conexión y avisos. | Alto | `opusplan`, esfuerzo alto, `reviewer` |
| 4.2 | Reglas de enrutado: método, país, moneda, límites, prioridad y respaldo. Estados de adaptador `verified`, `experimental`, `planned`. | Alto | `opusplan`, esfuerzo alto, `reviewer` |
| 4.3 | Adaptador de PayPal en sandbox. | Alto | `opusplan`, `reviewer` |
| 4.4 | Adaptador de una pasarela australiana de tarjeta (la que recomiende la investigación). | Alto | `opusplan`, `reviewer` |
| 4.5 | Reembolsos totales y parciales con motivo; disputas con paquete de pruebas. | Alto | `opusplan`, esfuerzo alto, `reviewer` |
| 4.6 | Conciliación diaria con alerta, informe de dinero de clientes y recibos con el ajuste de GST. | Alto | `opusplan`, `reviewer` |

## Criterios de aceptación

- Las credenciales no se devuelven por la API ni aparecen en los registros; cambiarlas exige el segundo factor y queda auditado.
- Un adaptador que no es `verified` no puede pasar a modo real.
- Una pasarela retirada no acepta cobros nuevos, pero sí reembolsa pagos antiguos.
- Una cuenta con historial no se puede borrar.
- Pausar la última cuenta que atiende un método muestra un aviso.
- Con una pasarela caída, el checkout ofrece las demás sin error.
- La conciliación detecta una diferencia introducida a propósito en la prueba.
- El informe separa lo cobrado y no pagado a proveedores del margen.

## Fuera de alcance

El resto del catálogo de pasarelas (fase 9).

## Revisión de Oscar

Crear, pausar y retirar una cuenta de pasarela a mano. Leer los informes del `reviewer`.
