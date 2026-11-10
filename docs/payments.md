# Especificación de pagos

Documento de referencia. La investigación de proveedores va aparte, en `docs/research/payment-providers.md`.

## Pagos

Es el módulo más delicado junto con el motor de precios. Quiero una capa de pagos propia en la API que hable con varias pasarelas a través de una interfaz común (`PaymentProvider`): crear un cobro, confirmar, reembolsar total o parcialmente, verificar webhooks y consultar comisiones y liquidaciones.

**Catálogo de pasarelas: todas instaladas, solo una o dos encendidas**

> Cambiado el 2026-11-10 (`docs/plans/phase-0-architecture.md`, §3.5): solo se escriben adaptadores para pasarelas que acepten la cuenta. El resto aparece en el panel como fichas `planned`.

Quiero que el backend tenga un adaptador para todas las pasarelas relevantes que operan en Australia y para las globales, listas para configurar desde el panel. Al lanzar solo estarán activas dos: **Stripe** (tarjeta, Apple Pay y Google Pay) y **transferencia bancaria con PayID** como método manual. Todas las demás nacen instaladas y apagadas.

| Grupo | Pasarelas |
|---|---|
| Globales | Stripe, PayPal, Braintree, Adyen, Checkout.com, Worldpay, Airwallex, Square, Rapyd, Nuvei, Worldline, Global Payments, Mastercard Payment Gateway Services |
| Australianas de tarjeta | eWAY, Pin Payments, SecurePay (Australia Post), Fat Zebra, Windcave, Tyro, Till Payments, Zai, Merchant Warrior, Bambora Asia-Pacific |
| Pasarelas de bancos australianos | NAB Transact, Westpac PayWay, CommBank BPOINT |
| Cuenta a cuenta en Australia (PayTo, PayID, BECS) | Azupay, Monoova, Zepto, GoCardless, Ezidebit, Hello Clever |
| Especialistas en viajes | TravelPay, Mint Payments |
| Pago aplazado | Afterpay, Zip, Klarna, PayPal Pay in 4 |
| Otros métodos | BPAY; Alipay y WeChat Pay a través de las pasarelas que los ofrezcan |

POLi no se incluye: cerró en Australia en septiembre de 2023. Antes de empezar, revisa esta lista contra el mercado actual, quita las que ya no existan o hayan cambiado de nombre y añade las que falten.

**Cómo llegar a "todas" sin escribir treinta integraciones a ciegas**

1. **Evalúa primero un orquestador de pagos de código abierto.** Hyperswitch (Juspay, licencia Apache 2.0) conecta decenas de pasarelas detrás de una sola API. Si cubre bien las australianas, un único adaptador nuestro hacia el orquestador nos daría la mayor parte del catálogo. Compara su versión gestionada con la autoalojada: coste mensual, infraestructura que exige, quién asume el cumplimiento PCI y qué conectores australianos tiene de verdad. Dame tu recomendación en `docs/research/payment-providers.md` antes de decidir.
2. **Adaptadores nativos por oleadas.** Oleada A: Stripe, método manual, PayPal y una australiana de tarjeta (Pin Payments o eWAY). Oleada B: el resto de australianas de tarjeta, las de cuenta a cuenta y las de viajes. Oleada C: globales para empresa grande y pasarelas de bancos. Oleada D: pago aplazado y otros métodos.
3. **Ningún adaptador sin probar puede cobrar dinero real.** Cada adaptador tiene un estado: `verified` (pasa las pruebas de contrato contra el sandbox real del proveedor), `experimental` (escrito según la documentación, sin sandbox disponible) o `planned` (solo ficha en el catálogo). El panel muestra el estado y solo deja pasar a modo real los `verified`. Muchas pasarelas solo dan acceso al sandbox tras solicitar cuenta de comercio; dime cuáles para que yo la pida.
4. **Mantenimiento.** Una prueba programada semanal ejecuta las pruebas de contrato de cada adaptador `verified` contra su sandbox y me avisa si una API ha cambiado.

**Métodos de pago**, cada uno activable por separado y por país del cliente: tarjeta (Visa, Mastercard, Amex, eftpos), Apple Pay y Google Pay, PayTo, BECS Direct Debit, PayID o transferencia, BPAY y pago aplazado, que nace apagado porque su comisión es varias veces la de una tarjeta y no puedo repercutirla.

**Antes de programar este módulo**, comprueba para cada pasarela, en sus páginas oficiales: si acepta operadores de viajes y qué aprobación previa pide, si acepta a un sole trader con ABN, si tiene cuota mensual o volumen mínimo, comisiones actuales, plazos de liquidación, política de reservas retenidas y cómo se consigue el sandbox. Escríbelo en `docs/research/payment-providers.md` como una tabla, con una recomendación de orden de alta. Yo pediré la confirmación por escrito a cada proveedor; no des por hecho que nos aceptan.

**Gestión de pasarelas desde el panel**

Quiero añadir, quitar y reconfigurar pasarelas yo mismo desde el panel, sin desplegar ni tocar código:

- **Catálogo de pasarelas disponibles.** Cada adaptador instalado aparece en el panel con sus métodos, países y monedas soportados. Desde ahí creo una "cuenta de pasarela": introduzco credenciales, elijo modo prueba o real, y la activo.
- **Varias cuentas por pasarela** (por ejemplo, dos cuentas de Stripe) y varias pasarelas activas a la vez.
- **Reglas de uso editables**: qué métodos ofrece cada cuenta, para qué países y monedas, importes mínimo y máximo, orden de prioridad y cuál es el respaldo de cuál.
- **Botón de prueba de conexión** que valida credenciales y webhook antes de dejarme activar una cuenta. Cada cuenta tiene su propia URL de webhook y su secreto.
- **Métodos manuales creados desde el panel**, sin adaptador: transferencia, PayID u otro, con sus instrucciones para el cliente y confirmación manual del cobro.
- **Quitar una pasarela tiene tres niveles**: pausar (deja de ofrecerse en el checkout), retirar (no admite cobros nuevos, pero sigue procesando reembolsos, disputas y webhooks de los pagos que ya tiene) y archivar (solo cuando no le queda nada pendiente). Nunca se borra una cuenta con historial, porque el libro de pagos la referencia.
- **Avisos antes de dejarme sin cobro**: si pauso la última cuenta que atiende un método o un país, el panel me lo advierte.
- **Credenciales seguras**: se guardan cifradas (clave maestra en variable de entorno), no se vuelven a mostrar una vez guardadas, cambiarlas exige volver a pasar el segundo factor y todo queda en el registro de auditoría.

Una pasarela totalmente nueva sí necesita código: un adaptador que implemente `PaymentProvider`. Haz que eso sea barato y seguro. Cada adaptador es un módulo aislado que se registra solo en el catálogo, declara sus capacidades (métodos, monedas, reembolso parcial, cobro diferido) y debe pasar una batería de pruebas de contrato común a todos. Documenta en `docs/adding-a-payment-adapter.md` cómo añadir uno, de forma que pueda pedírtelo en una frase.

**Requisitos**

- Los datos de tarjeta nunca pasan por nuestros servidores ni se guardan: solo campos alojados o checkout de la pasarela, para quedar en el nivel más bajo de PCI DSS.
- **Plan de pagos por reserva**: depósito, saldo y plazos opcionales, con fechas límite, recordatorios automáticos y enlaces de pago que puedo generar desde el panel.
- **Libro de pagos inmutable**: cada cobro, reembolso, comisión y contracargo es un asiento que no se edita. Claves de idempotencia en toda operación. Webhooks firmados, idempotentes y con reintentos. Conciliación diaria entre el libro y lo que dice cada pasarela, con alerta si no cuadra.
- **Enrutado y respaldo**: qué pasarela atiende cada método se decide por configuración. Si una está caída o desactivada, el checkout ofrece las demás sin errores.
- **Reembolsos y contracargos**: reembolso parcial o total con motivo, y para cada disputa un paquete de pruebas listo para enviar (condiciones aceptadas con fecha, copia de la configuración y del precio, correos enviados).
- **Dinero de clientes**: un informe que separe en todo momento lo cobrado a clientes y aún no pagado a proveedores de lo que ya es margen mío, porque ese dinero debe estar en una cuenta bancaria aparte.
- **Moneda**: se cobra en AUD. El modelo guarda moneda e importe en unidades menores para admitir más monedas después.
- **Recibos**: mi estado de registro en GST es un ajuste. Mientras esté desactivado, los recibos no muestran GST ni se llaman "tax invoice".
- **Claves**: en desarrollo solo claves de sandbox. Las claves reales las introduzco yo desde el panel y se guardan cifradas; nunca van en el repositorio ni en los registros.
