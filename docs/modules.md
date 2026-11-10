# Módulos del backend

Documento de referencia. Cada fase dice qué módulos construye.

## Módulos del backend y panel de administración

Los módulos van en tres niveles. El **núcleo** es lo que necesito para vender el primer viaje. La **segunda ola** es lo que necesito para operarlo sin hojas de cálculo. **Más adelante** queda diseñado en el modelo y detrás de un flag, pero no se construye hasta que yo lo pida.

**Núcleo**

1. **Catálogo.** Alta y edición de carreras, ediciones, paquetes, hoteles y extras. Duplicar un paquete de una edición anterior como base de la siguiente. Vista previa antes de publicar. Control de cupos de dorsales y habitaciones con aviso cuando queden pocos.
2. **Precios.** Motor de precios con reglas editables (reserva anticipada, suplementos, descuento de grupo), códigos promocionales con límites de uso, y versiones de precio con fechas de validez.
3. **CRM y reservas.** Bandeja de solicitudes con filtros y estados, ficha de cliente con todo su historial (reservas, pagos, correos, notas, consentimientos), presupuestos con caducidad y correos automáticos en cada cambio de estado.
4. **Pagos.** Estado de cobro de cada reserva, pagos vencidos, enlaces de pago, reembolsos, disputas, comisiones por pasarela, conciliación e informe de dinero de clientes. Alta, configuración, pausa y retirada de pasarelas y de métodos desde el panel.
5. **Área privada del cliente.** Ver sus reservas y su estado, pagar depósito y saldo, descargar recibos y documentos, completar datos de los viajeros (nombre como en el documento, fecha de nacimiento, contacto de emergencia, tiempo estimado de carrera), gestionar sus alertas, exportar o borrar su cuenta.
6. **Alertas de apertura.** Al pasar un paquete a `open`, se avisa a los suscritos de esa carrera. El panel muestra cuántos suscritos tiene cada carrera, porque es mi medida de demanda para decidir qué carreras negociar.
7. **Panel de inicio.** Solicitudes nuevas, cobros pendientes, cupos restantes, suscritos por carrera y tareas que vencen.

**Segunda ola**

8. **Proveedores y cupos.** Ficha de proveedor, contratos, cupos contratados con su fecha de liberación, precios de coste en su moneda y calendario de pagos a proveedores.
9. **Cambios y cancelaciones.** Modificar una reserva confirmada (habitación, noches, viajeros, cambio de nombre) recalculando la diferencia. Motor de políticas de cancelación que calcula la penalización y el reembolso según los días que falten. Lista de espera con promoción automática cuando se libera una plaza.
10. **Operaciones del viaje.** Lista de habitaciones por hotel, exportación de datos de corredores en el formato que pida cada organizador, lista de traslados, itinerario día a día y documentos PDF por reserva. Calendario de fechas clave (liberación de cupos, vencimiento de saldos, entrega de inscripciones) con tareas automáticas.
11. **Finanzas.** Resultado por viaje (ingresos, costes de proveedor, comisiones de pago y margen), previsión de caja con cobros y pagos por fecha, y exportación para el contable.
12. **Contenido.** Guías de carrera, páginas, preguntas frecuentes, banners, menú, redirecciones y biblioteca de imágenes, todo editable sin desplegar.
13. **Reclamaciones.** Registro de cada reclamación con plazos, responsable, resolución y documentos, porque necesito un procedimiento de reclamaciones demostrable.
14. **Informes y embudo.** Visitas, uso del constructor, solicitudes y pagos por carrera, más el constructor de informes.

**Más adelante**

15. **Grupos y clubes**: una reserva de grupo con un responsable y pagos individuales.
16. **Socios y comisiones**: clubes, entrenadores o agentes que traen clientes con un código y cobran comisión.
17. **Campañas**: envíos a segmentos de clientes con su consentimiento registrado.
18. **Reseñas y encuestas** tras el viaje, solo de clientes reales y con moderación.
19. **Viajes a medida**: presupuesto de un itinerario único fuera del catálogo.
20. **Más monedas y más países.**
