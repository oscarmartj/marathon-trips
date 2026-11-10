# Brief: negocio, restricciones y alcance

Documento de referencia. Lo escribe Oscar en primera persona. Abre solo la sección que necesite la tarea.

## Quién soy y qué vamos a construir

Soy Oscar. Estoy montando desde Brisbane (Australia) una agencia de viajes para corredores: paquetes para viajar a maratones y otras carreras de cualquier distancia. Un paquete incluye hotel, servicios en destino y extras, y dorsal solo cuando yo tenga cupo asignado por la carrera. No vendo vuelos.

Quiero una web pública mejor que las de los operadores actuales y, sobre todo, un backend sólido con el que pueda llevar el negocio yo solo. Trabajo solo, con pocas horas a la semana y presupuesto casi cero, así que cada decisión debe ahorrarme tiempo de gestión y evitar costes fijos.

Háblame en español. El código, los commits, los nombres y todos los textos de la web van en inglés (inglés australiano).

## Situación del negocio que condiciona el producto

Estas restricciones son reales y explican varias decisiones de abajo:

- **Los pagos se integran casi desde el principio, pero cada pasarela se enciende por separado.** Los viajes son una categoría de riesgo para los procesadores de pago: algunos exigen aprobación previa, retienen reservas o cierran cuentas. Además, antes de cobrar a clientes reales necesito seguro y condiciones de reserva revisadas. Por eso todo se construye y se prueba en modo sandbox, y cada pasarela y cada método de pago tiene su propio interruptor que solo activo yo.
- **No puedo depender de una sola pasarela.** Si un proveedor rechaza o congela la cuenta, el negocio tiene que seguir cobrando por otro sin tocar código.
- **Todavía no soy operador oficial de ninguna carrera ni tengo acreditaciones.** La web no puede afirmarlo ni insinuarlo. Cualquier distintivo ("official partner", "guaranteed entry", "accredited") debe salir de un dato que yo active en el panel para esa carrera concreta, nunca de un texto fijo.
- **Al principio vendo solo a residentes en Australia.** Vender a consumidores de otros países activa sus propias normas. El formulario pregunta el país de residencia; quien no resida en Australia entra en lista de espera. El modelo y los pagos deben estar listos para abrir otros países más adelante con un cambio de configuración.
- **Precios en AUD, con el total a la vista y sin recargos por método de pago.** La ley de consumo australiana exige mostrar el precio total mínimo. Desde el 1 de octubre de 2026 los recargos por pagar con tarjeta están prohibidos en Australia, así que el precio es el mismo se pague como se pague y las comisiones de pago son un coste interno mío.
- **Los dorsales no se venden sueltos ni se transfieren.** Un dorsal solo existe dentro de un paquete, y el cupo de dorsales es un dato limitado que controlo por carrera.

## Alcance de la primera versión

Catálogo público de carreras y paquetes, buscador, constructor de paquete con precio en vivo, solicitudes de reserva, cobro de depósito y saldo por varias pasarelas, alertas de apertura, área privada del cliente y panel de administración.

Flujo de reserva por defecto: el cliente configura y envía una solicitud, yo confirmo disponibilidad, el cliente paga el depósito y la reserva queda confirmada; después paga el saldo antes de una fecha límite. Cada paquete puede marcarse como "reserva inmediata" para permitir pagar el depósito sin mi revisión cuando hay cupo.
