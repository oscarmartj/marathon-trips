# Fase 5: clientes, alertas y documentos

**Objetivo:** al terminar esta fase se puede vender un viaje de principio a fin. Es el hito del proyecto.

**Referencia:** `docs/modules.md`, módulos 5, 6 y 7; `docs/web.md`; `docs/architecture.md`, sección "Plataforma" (plantillas, privacidad).

## Tareas

| # | Tarea | Riesgo | Sesión |
|---|---|---|---|
| 5.1 | Cuenta de cliente y área privada: reservas, estado, pago de depósito y saldo, recibos y documentos. | Alto | `opusplan`, esfuerzo alto, `reviewer` |
| 5.2 | Datos de viajeros con el mínimo necesario, editables por el cliente hasta una fecha límite. | Medio | `opusplan` |
| 5.3 | Alertas de apertura con doble confirmación, baja en un clic y contador de suscritos por carrera en el panel. | Medio | `opusplan` |
| 5.4 | Plantillas editables de correo y de documentos PDF con variables y vista previa. | Bajo | Sonnet |
| 5.5 | Privacidad: exportar y borrar los datos de un cliente; consentimiento de marketing separado. | Alto | `opusplan`, `reviewer` |
| 5.6 | Panel de inicio y recordatorios automáticos de saldo. | Bajo | Sonnet |
| 5.7 | Ensayo general: prueba de extremo a extremo de todo el recorrido y lista de lo que falta para abrir. | Medio | `opusplan` |

## Criterios de aceptación

- Un cliente no puede ver ni pagar la reserva de otro, comprobado con una prueba.
- Al abrir un paquete, los suscritos confirmados reciben un correo y los no confirmados no.
- Borrar un cliente elimina o anonimiza sus datos personales y conserva los asientos del libro de pagos.
- Prueba de extremo a extremo completa: alerta, apertura, configuración, solicitud, aprobación, depósito, datos de viajeros, saldo, documentos.
- No se piden pasaporte ni datos médicos en ningún formulario.

## Fuera de alcance

Cambios y cancelaciones con penalización, proveedores y finanzas.

## Revisión de Oscar

Hacer el recorrido completo como cliente y como administrador con un paquete realista. No abrir la fase 6 hasta haberlo hecho.
