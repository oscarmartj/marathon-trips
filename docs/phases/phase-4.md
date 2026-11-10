# Fase 4: gestión de pasarelas y operativa de pagos

**Objetivo:** Oscar añade, configura, pausa y retira pasarelas desde el panel, y tiene reembolsos, disputas y conciliación.

La fase se ejecuta en dos partes. **4A** va entre la fase 3 y la fase 5, porque hace falta para vender: las claves reales se introducen desde el panel. **4B** va después de la fase 5. El orden completo está en `docs/phases/README.md`.

**Referencia:** `docs/payments.md`, secciones "Gestión de pasarelas desde el panel", "Catálogo de pasarelas" y "Requisitos"; `docs/plans/phase-0-architecture.md`, §1.9 y §1.10; `docs/plans/phase-3-payments.md`; `.claude/rules/payments.md`.

## 4A: antes de la fase 5

| # | Tarea | Riesgo | Sesión |
|---|---|---|---|
| 4.1 | Cuentas de pasarela en el panel: credenciales cifradas, modo prueba o real, estados (activa, pausada, retirada, archivada), prueba de conexión y avisos. Solo un adaptador `verified` puede pasar a modo real; su estado lo declara el código. | Alto | `opusplan`, esfuerzo alto, `reviewer` |
| 4.5a | Reembolsos totales y parciales con motivo, también para pagos manuales. | Alto | `opusplan`, esfuerzo alto, `reviewer` |
| 4.6a | Informe de dinero de clientes y recibos con el ajuste de GST. | Alto | `opusplan`, `reviewer` |

### Criterios de aceptación de 4A

- Las credenciales no se devuelven por la API ni aparecen en los registros. Cambiarlas exige el segundo factor y queda auditado.
- Un adaptador que no es `verified` no puede pasar a modo real.
- Una pasarela retirada no acepta cobros nuevos, pero sí reembolsa pagos antiguos.
- Una cuenta con historial no se puede borrar.
- Pausar la última cuenta que atiende un método muestra un aviso.
- El informe separa lo cobrado y no pagado a proveedores del margen.
- Con el GST desactivado, un recibo no muestra GST ni se llama "tax invoice".

## 4B: después de la fase 5

| # | Tarea | Riesgo | Sesión |
|---|---|---|---|
| 4.2 | Reglas de enrutado: método, país, moneda, límites, prioridad y respaldo. | Alto | `opusplan`, esfuerzo alto, `reviewer` |
| 4.3 | Adaptador de PayPal en sandbox. | Alto | `opusplan`, `reviewer` |
| 4.4 | Adaptador de una pasarela australiana de tarjeta (la que recomiende la investigación). Si Stripe no acepta la cuenta, esta tarea pasa a 4A. | Alto | `opusplan`, `reviewer` |
| 4.5b | Disputas con paquete de pruebas. | Alto | `opusplan`, esfuerzo alto, `reviewer` |
| 4.6b | Conciliación diaria con alerta. | Alto | `opusplan`, `reviewer` |

### Criterios de aceptación de 4B

- Con una pasarela caída, el checkout ofrece las demás sin error.
- El paquete de pruebas de una disputa incluye las condiciones aceptadas con fecha, la copia de la configuración y del precio, y los correos enviados.
- La conciliación detecta una diferencia introducida a propósito en la prueba.

## Fuera de alcance

El resto del catálogo de pasarelas: se añade bajo demanda (fase 9).

## Revisión de Oscar

En 4A, crear, pausar y retirar una cuenta de pasarela a mano. En las dos partes, leer los informes del `reviewer`.
