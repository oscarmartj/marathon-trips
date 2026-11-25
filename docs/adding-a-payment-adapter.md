# Añadir un adaptador de pagos

Guía corta para añadir una pasarela nueva tras `PaymentProvider`. La pide `docs/payments.md` y la citan `docs/phases/phase-9.md` y el plan de 3.6. El pedido puede ser una frase: «añade el adaptador de <pasarela> siguiendo `docs/adding-a-payment-adapter.md`».

## Qué es un adaptador

Una carpeta `apps/api/src/modules/payments/adapters/<clave>/` con una clase que implementa `PaymentProvider` (`core/provider.ts`). Solo habla con su pasarela:

- no toca Prisma;
- no lee ajustes ni variables de entorno;
- no escribe en logs;
- no conoce reservas.

Todo eso lo hace el núcleo: guardas de modo y entorno, descifrado de credenciales, idempotencia, estados y webhooks. Lo comprueba `adapter_sources_are_isolated` (`apps/api/test/contract/adapters.contract.test.ts`).

## Pasos

1. **Manifiesto.**
   - `status: 'experimental'` y `testOnly: false`.
   - `cardDataHandling: 'hosted_only'`: los datos de tarjeta se quedan siempre en la página o los campos alojados de la pasarela.
   - Métodos, monedas, países y `checkoutOrigin` en `https`.
   - `capabilities.lookupByIdempotencyKey: true`: el adaptador debe poder encontrar un objeto por nuestra clave.
   - `account` (4.1): los campos de credenciales que se escriben en el panel (`key`, `label` y un `pattern` anclado, solo de modo prueba), los que genera el servidor (`generated`) y de dónde sale el secreto del webhook: `generated` (lo hace el servidor) o `entered` (lo da la pasarela cuando se registra la URL; se pone después de crear la cuenta). `manifestProblems` lo comprueba.
2. **Contrato de la interfaz.** Los comentarios de `core/provider.ts` mandan.
   - Solo se lanza `ProviderError`, con un código de la lista.
   - Un error no reintentable de `createPayment` significa que con esa clave no hay ni habrá objeto.
   - `failed` es terminal en la pasarela.
   - `verifyWebhook` no usa la red y compara en tiempo constante.
   - `verifyWebhook` rechaza (`stale_timestamp`) una firma a más de 300 s del momento actual, hacia atrás o hacia delante. La batería prueba 299 s (aceptada), 301 s y una hora (rechazadas).
   - Opcionales (4.3): `prepareWebhook` trae de la pasarela lo que `verifyWebhook` necesita para verificar sin red (el certificado de PayPal); la pasarela de pagos y la batería lo llaman antes de cada verificación. `completePayment` termina un pago que el cliente aprobó en la pasarela (la captura de PayPal); el núcleo lo llama solo en `sync`, `drive` y `expire`, con el intento vivo, la reserva pagable y la cuenta activa. `retrievePayment` nunca mueve dinero.
3. **Registro.** Una línea en `adapters/index.ts` (`createAdapters`). Si la pasarela tenía ficha `planned` en `adapters/planned.ts` (4.2), se borra esa ficha en el mismo PR (`planned_catalogue_keys_unique_and_unregistered` falla si una clave está en los dos). Cada cuenta nueva recibe sus reglas de enrutado por defecto (todos los métodos del manifiesto salvo `bnpl`, en AUD, cualquier país, sin límites, prioridad 100).
4. **Sujeto local** en `apps/api/test/contract/subjects/<clave>.ts`, añadido a `LOCAL_SUBJECTS`. La pasarela se simula en memoria o con respuestas grabadas de su documentación. La batería completa (`CONTRACT_CLAUSES`) corre con él en CI. Sin sujeto local, CI falla (`every_adapter_has_a_local_contract_subject`).
5. **Sujeto de sandbox**, añadido a `SANDBOX_SUBJECTS`.
   - Usa la misma clase que devuelve `createAdapters`.
   - Lee las credenciales de variables de entorno.
   - `assertSandboxCredentials` rechaza todo lo que no tenga forma de clave de prueba, también un entorno vacío (`sandbox_subjects_reject_an_empty_environment`).
   - La fábrica solo construye objetos: no toca la red, porque corre antes de esa comprobación. La red empieza en `context()`.
6. **Ejecución contra el sandbox real.** Las claves las pone Oscar en el entorno; nunca van en un archivo:

   ```
   SANDBOX_ADAPTER=<clave> <VARIABLES_DEL_SANDBOX> pnpm --filter @mt/api test:sandbox
   ```

   Si pasan todas las cláusulas, imprime `test:sandbox <clave> <AAAA-MM-DD> N/N`. Cualquier fallo, cláusula saltada o cláusula de menos hace fallar el comando.
7. **Pasar a `verified`**, en un PR revisado:
   - pega esa línea en el `docs/done/` de la tarea;
   - pon en el manifiesto `status: 'verified'` y `evidence: 'docs/done/<tarea>.md'`.

   `verified_manifest_requires_sandbox_evidence` comprueba que la línea es de esa clave, con fecha y con todas las cláusulas actuales. Si se añade una cláusula a la batería, hay que repetir la ejecución.

Sin sandbox, el adaptador se queda en `experimental` y no puede pasar a modo real: `ProviderGateway` lo impide y no hay forma de saltárselo.

## Prueba semanal de contrato (9.4)

El flujo `.github/workflows/weekly-sandbox-contract.yml` corre cada domingo (19:23 UTC) y a mano (Actions > "Weekly sandbox contract" > Run workflow). Pregunta al registro qué adaptadores están en `status: 'verified'` (`apps/api/scripts/weekly-sandbox-plan.ts`) y ejecuta `test:sandbox` solo de ellos, uno por trabajo. Hoy ninguno lo está: el flujo termina en verde y su resumen dice «0 verified adapters, nothing to test». Eso no verifica ninguna pasarela. Un fallo se ve como un trabajo en rojo en Actions; no envía correos ni mensajes.

Para que un adaptador entre en la prueba semanal:

1. Hace falta una cuenta de sandbox del proveedor, que crea Oscar. Después pasa a `verified` por el paso 7 de arriba, en un PR revisado, con su línea de `test:sandbox` en `docs/done/`. Un `verified` sin sujeto de sandbox hace fallar CI (`weekly.test.ts`); `experimental` nunca entra en la lista.
2. Oscar crea estos secretos de repositorio (Settings > Secrets and variables > Actions). Nunca van en un archivo. Solo claves de modo prueba: la suite rechaza el resto.

| Adaptador | Secretos |
|---|---|
| `stripe` | `STRIPE_SANDBOX_SECRET_KEY`, `STRIPE_SANDBOX_WEBHOOK_SECRET` |
| `paypal` | `PAYPAL_SANDBOX_CLIENT_ID`, `PAYPAL_SANDBOX_CLIENT_SECRET`, `PAYPAL_SANDBOX_WEBHOOK_ID`, `PAYPAL_SANDBOX_BUYER_EMAIL`, `PAYPAL_SANDBOX_BUYER_PASSWORD`, `PAYPAL_SANDBOX_RECORDED_DELIVERY_B64` |
| `pin_payments` | `PIN_TEST_SECRET_KEY`, `PIN_TEST_PUBLISHABLE_KEY`, `PIN_TEST_WEBHOOK_KEY`, `PIN_TEST_CARD_PAY`, `PIN_TEST_CARD_DECLINE`, `PIN_TEST_RECORDED_DELIVERY_B64`, `PIN_TEST_ACS_SCRIPT_B64` |
| `stripe_bnpl` | `STRIPE_BNPL_SANDBOX_SECRET_KEY`, `STRIPE_BNPL_SANDBOX_WEBHOOK_SECRET` |
| `airwallex` | `AIRWALLEX_SANDBOX_CLIENT_ID`, `AIRWALLEX_SANDBOX_API_KEY`, `AIRWALLEX_SANDBOX_WEBHOOK_SECRET`, `AIRWALLEX_SANDBOX_CARD_PAY`, `AIRWALLEX_SANDBOX_CARD_DECLINE`, `AIRWALLEX_SANDBOX_RECORDED_DELIVERY_B64` |
| `eway` | `EWAY_SANDBOX_API_KEY`, `EWAY_SANDBOX_API_PASSWORD`, `EWAY_SANDBOX_PUBLIC_KEY`, `EWAY_SANDBOX_BROWSER_SCRIPT_B64` |

Los `*_B64` son los archivos de entrega grabada o de guion de navegador, en base64; el flujo los escribe fuera del repositorio. Un adaptador nuevo con otras variables añade sus secretos al bloque `env` del flujo (`weekly.test.ts` analiza el YAML y comprueba que cada variable que lee un sujeto de sandbox sale de `secrets.*`). Si el sujeto necesita `playwright`, se añade como dependencia de desarrollo en el mismo PR que lo pasa a `verified`.

## Si la batería no encaja con una pasarela

Por ejemplo, una pasarela sin marca de tiempo firmada en sus webhooks. Se cambia el contrato en un plan revisado, para todos los adaptadores. Nunca se añade una excepción en el sujeto de un adaptador.

Así se hizo en 4.4 (plan 4.4, §12.2 y §18 M1), por capacidad y no por adaptador:
- `NO_GATEWAY_EVENT`: un sujeto puede responderlo a `webhookFor` solo si el manifiesto declara `capabilities.preCardSession`, que solo pone `CardSessionProvider`. El registro lo comprueba en los dos sentidos. Entonces las cláusulas de firma usan el evento de un pago cobrado, y "un evento viejo conserva su estado" se comprueba con dos eventos reales de un reembolso (`refundSettles`).
- `capabilities.refundEventOurId: 'via_retrieve'`: los eventos de reembolso no traen nuestro id; `retrieveRefund({ ref })` sí lo trae. El núcleo lo consulta antes de anotar un reembolso como externo.

En 9.1 se añadió `capabilities.gatewayEvents: 'none'` para una pasarela que no envía eventos de servidor a servidor (eWAY). Es estructural, no una excepción: lista cerrada de claves, sin cabeceras de firma, y las cláusulas de webhook se sustituyen por comprobaciones de lectura más estrictas (plan 9.1, §4.2 y §20 M7).

## El simulador

Es el adaptador `simulator`: `testOnly`, `experimental` y sin sandbox. Su página alojada (`/api/payments/simulator/checkout/<token>`) existe solo en `development`, `test` y `ci`. Allí se paga o se rechaza un pago de prueba; el simulador entrega el webhook firmado por la misma entrada que una pasarela real. Sirve para probar a mano (`pnpm dev`) y para Playwright (3.5).

## Stripe (3.3)

Adaptador `stripe`, `experimental`: Checkout Sessions (la página alojada de Stripe), reembolsos y webhooks firmados (`stripe-signature`), con la versión de la API fijada en `STRIPE_API_VERSION`. Solo habla con `https://api.stripe.com`. En CI pasa la batería contra un Stripe falso en memoria (`test/contract/subjects/stripe-fake.ts`); el falso sigue la documentación de Stripe y no sustituye a una ejecución real.

Para probarlo con un sandbox de Stripe (cuando Oscar tenga las claves de prueba):

1. En el panel de Stripe (modo de prueba), crear un endpoint de webhook con la **misma versión de la API** que `STRIPE_API_VERSION` y los eventos `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `refund.created`, `refund.updated` y `refund.failed`.
2. Cuenta en la API, solo en pruebas, desde el panel (4.1, "Payment gateways"): añadir una cuenta Stripe con la clave secreta de prueba; nace pausada, sin secreto de webhook, y enseña una vez la URL del webhook, que se pone en el endpoint del paso 1. Después, "Set webhook secret" con el `whsec_…` que da Stripe, probar la conexión y activar. También por consola: `STRIPE_TEST_SECRET_KEY=sk_test_… STRIPE_TEST_WEBHOOK_SECRET=whsec_… pnpm api:cli payments:stripe-test-account`. Las claves se leen solo del entorno; una clave real se rechaza. Imprime una vez la URL del webhook, que se pone en el endpoint del paso 1.
3. Batería contra el sandbox: añadir antes `playwright` como dependencia de desarrollo de `@mt/api` (el cliente paga en la página de Checkout con la tarjeta de prueba) y ejecutar `SANDBOX_ADAPTER=stripe STRIPE_SANDBOX_SECRET_KEY=… STRIPE_SANDBOX_WEBHOOK_SECRET=… pnpm --filter @mt/api test:sandbox`. Solo con todas las cláusulas en verde y su línea en `docs/done/` puede el manifiesto pasar a `verified`, en un PR revisado.

## PayPal (4.3)

Adaptador `paypal`, `experimental`: Orders v2 con la página de aprobación de PayPal, captura solo con `completePayment`, reembolsos y webhooks verificados sin red con el certificado de PayPal (descargado antes por `prepareWebhook`, solo de `api(-m).sandbox.paypal.com`, con cadena hasta el almacén raíz de Node). En modo prueba solo habla con `https://api-m.sandbox.paypal.com`: las credenciales de PayPal no distinguen sandbox de real, así que lo que protege es el host. En CI pasa la batería contra un PayPal falso (`test/contract/subjects/paypal-fake.ts`). Plan y supuestos por confirmar: `docs/plans/4.3-paypal-adapter.md`.

Para probarlo con el sandbox (cuando Oscar tenga la app):

1. En developer.paypal.com, una app REST de sandbox de una cuenta business australiana con AUD como moneda de cobro, y una cuenta compradora de sandbox.
2. En el panel ("Payment gateways"), cuenta PayPal con el client ID y el secret de la app; nace pausada y enseña una vez la URL del webhook.
3. En la app de PayPal, un webhook a esa URL con los eventos `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.REFUND.PENDING` y `PAYMENT.REFUND.FAILED`. Su ID va en "Set webhook secret"; después, probar la conexión y activar.
4. Grabar una entrega real de captura y otra de reembolso (cabeceras y cuerpo en base64, en un JSON `[{ headers, bodyBase64 }]`) y ejecutar, con `playwright` añadido antes: `SANDBOX_ADAPTER=paypal PAYPAL_SANDBOX_CLIENT_ID=… PAYPAL_SANDBOX_CLIENT_SECRET=… PAYPAL_SANDBOX_WEBHOOK_ID=… PAYPAL_SANDBOX_BUYER_EMAIL=… PAYPAL_SANDBOX_BUYER_PASSWORD=… PAYPAL_SANDBOX_RECORDED_DELIVERY=<ruta> pnpm --filter @mt/api test:sandbox`. Sin las entregas grabadas falla. Los casos de tarjeta rechazada piden las pruebas negativas del sandbox de PayPal y se completan en esa sesión.

## Pin Payments (4.4)

Adaptador `pin_payments`, `experimental`. Pin no tiene objeto de pago hasta que el cliente mete la tarjeta en sus campos alojados (iframes de Pin en nuestra página `/pay/card/<ref>`), así que la clase registrada es `CardSessionProvider` (`core/card-sessions/`): guarda la sesión antes de la tarjeta y las intenciones de reembolso en la base (migración 0039) y habla con Pin a través de `PinPaymentsGateway`, que implementa la interfaz estrecha `CardTokenGateway` de `core/provider.ts`. Una pasarela nueva de campos alojados implementa esa interfaz y reutiliza sesiones, página y batería. Reglas que no se tocan: un solo `POST /charges` por sesión, 3-D Secure siempre (`fallback_ok: false`), un resultado desconocido nunca reabre la sesión ni repite un reembolso. En modo prueba solo habla con `https://test-api.pinpayments.com/1`. En CI pasa la batería contra un Pin falso (`test/contract/subjects/pin-fake.ts`), con el almacén en memoria y con el de la base. Plan y supuestos A1–A18: `docs/plans/4.4-au-card-gateway.md`.

Para probarlo con la cuenta de prueba de Pin (cuando Oscar la tenga):

1. En el panel de Pin (modo prueba), las claves secreta y publicable, y un endpoint de webhook (Account > Webhooks) a la URL que enseña nuestro panel al crear la cuenta. Confirmar con Pin que no envía recibos a los pagadores (A13) y apagar cualquier recargo: en esta integración no hay ninguno.
2. En el panel ("Payment gateways"), cuenta Pin Payments con las dos claves; nace pausada. "Set webhook secret" con el `key` del endpoint (la prueba de conexión comprueba que ese endpoint existe en Pin); después, probar la conexión y activar.
3. Grabar entregas reales de un cargo y de un reembolso, y dos reintentos (`[{ headers, bodyBase64, receivedAt }]`; A1–A3, A16), y ejecutar: `SANDBOX_ADAPTER=pin_payments PIN_TEST_SECRET_KEY=… PIN_TEST_PUBLISHABLE_KEY=… PIN_TEST_WEBHOOK_KEY=… PIN_TEST_CARD_PAY=… PIN_TEST_CARD_DECLINE=… PIN_TEST_RECORDED_DELIVERY=<ruta> pnpm --filter @mt/api test:sandbox`. El desafío de 3-D Secure en el banco de pruebas puede necesitar a una persona.

## eWAY (9.1)

Adaptador `eway`, `experimental`. **Todo lo de eWAY está sin verificar**: se leyó la referencia Rapid v3 con una herramienta que resume, y el revisor del plan no pudo abrir eway.io. Clase registrada: `CardSessionProvider` sobre `EwayGateway`, que declara `authentication: 'before_charge'`.

Flujo: los Secure Fields de eWAY en nuestra página `/pay/secure-fields/<ref>`, que tiene su propia CSP. Primero se inicia el 3-D Secure (`3dsenrol`), que no mueve dinero. El banco pide la confirmación con `Cerberus.run`. Después llega el único `POST /Transaction` de la sesión (`submittedAt`, una vez), con nuestra referencia en `InvoiceReference`.

Lo que hace distinta a eWAY:
- **Sin eventos.** eWAY no avisa nunca al servidor. El adapter declara `capabilities.gatewayEvents: 'none'`, que solo se admite para las claves de `EVENTLESS_ADAPTER_KEYS`. Rechaza toda entrega de webhook (`malformed`).
- **La batería se adapta sin perder comprobaciones.** Sustituye las cláusulas de webhook por las de lectura: una respuesta perdida después de que eWAY actuó se encuentra leyendo, se enlaza y no se reenvía (hooks `loseNextAnswer` y `postCount` del sujeto).
- **No puede pasar a `verified`.** El registro lo impide sin conciliación (actividad o liquidaciones) ni disputas, y eWAY todavía no tiene ninguna de las dos: seguimiento 9.1-F2.
- **Sin clave de idempotencia.** Un solo envío por sesión; ante un resultado desconocido se busca por `InvoiceReference` y nunca se reenvía.
- **Un cobro desconocido no se da por perdido enseguida.** Solo pasa a `failed`/`outcome_unknown` con un "no existe" definitivo, pasados 15 minutos desde el envío y la caducidad de la sesión.
- **`D4494`** (duplicado) abre una tarea y vuelve a leer las sesiones sin resolver de la misma reserva.
- **Reembolsos con nuestra referencia** (`mtr_…`); se enlazan por coincidencia exacta.
- **Referencia en varias transacciones.** Si eWAY la tiene en más de una, se abre una tarea y el personal la enlaza con `pnpm api:cli payments:card-session-bind --ref cs_… --transaction <id>`.
- **Datos del pagador.** El 3-D Secure 2 pide nombre, correo y teléfono del pagador del cobro; si al pagador le falta el teléfono, el nombre o el apellido, 409 `card_session_phone_required`.
- **Un `TransactionStatus: false` con un código fuera de la lista** (`mapping.ts`) se toma como resultado desconocido: la sesión sigue en `submitting`, el intento sigue vivo y bloquea otro pago de la reserva (P2), y a las 24 h salta la tarea "Payment attempt unresolved". El personal lo comprueba en MYeWAY, y el código se añade a la lista en un PR revisado.
- **Una búsqueda que no se puede leer** (una transacción sin nuestra referencia, o un 404 sin el código de "no existe" de eWAY) es desconocida, nunca "no existe": no se da un cobro por perdido.

En CI pasa la batería contra un eWAY falso (`test/contract/subjects/eway-fake.ts`), con el almacén en memoria y con el de la base (`test/modules/payments/eway-store.test.ts`). Plan, supuestos A1–A14 y cambios de la revisión: `docs/plans/9.1-eway.md` (sección 20).

Para probarlo con el sandbox (cuando Oscar tenga la cuenta de partner de eWAY, gratuita):

1. En MYeWAY (sandbox), la clave de API, la contraseña y la clave pública (`epk-…`). Respuestas del sandbox en "Use Cents Value". Recargos apagados. Confirmar con eWAY por escrito los supuestos A1, A5 y A14.
2. En el panel ("Payment gateways"), una cuenta eWAY con las tres claves; nace pausada. No hay webhook que configurar. Probar la conexión y activar.
3. Escribir el guion de navegador para Secure Fields y `Cerberus` (Playwright, añadido solo para esa ejecución) y ejecutar `SANDBOX_ADAPTER=eway EWAY_SANDBOX_API_KEY=… EWAY_SANDBOX_API_PASSWORD=… EWAY_SANDBOX_PUBLIC_KEY=… EWAY_SANDBOX_BROWSER_SCRIPT=<ruta> pnpm --filter @mt/api test:sandbox`. Aunque pase, eWAY sigue `experimental` hasta 9.1-F2.

## Airwallex (9.2)

Adaptador `airwallex`, `experimental`. **Todo lo de Airwallex está sin verificar**: se leyó su documentación con una herramienta que resume. Clase registrada: `AirwallexProvider`, un `PaymentProvider` normal como Stripe, sin sesión de tarjeta, sin capacidad nueva y sin migración. Plan, supuestos A1–A25 y las dos rondas de revisión: `docs/plans/9.2-airwallex.md` (§19 y §20).

Lo que hace distinta a Airwallex:
- **Checkout Session** (beta, versión de API `2026-05-29`, `AIRWALLEX_API_VERSION`). El cliente paga en la página alojada de Airwallex. Solo se permiten tarjetas (`payment_method_types: ['card']`), así que no se ofrece pago aplazado.
- **Nuestra referencia es el `merchant_order_id`** que le damos (`mt-<id de pago>-<createdAt>`). Lo llevan la sesión y el PaymentIntent, así que los eventos casan sin red. Antes de cada creación se busca la sesión, para que nunca haya dos.
- **Importes en decimal.** Se convierten exactos con bigint y el texto fuente del JSON, nunca con coma flotante. Solo se lee AUD: `"1250"` en JPY o `"12.500"` en KWD son ilegibles.
- **Toda lista se comprueba elemento a elemento.** Si Airwallex ignorase un filtro, nunca se tomaría el pago de otro cliente. Un elemento sin los campos que lo identifican es "desconocido" (se reintenta) hasta que el sandbox confirme A25 (`GET_RETURNS_ORDER_FIELDS`). **No crear checkout sessions desde la web de Airwallex:** una sesión ajena en la ventana bloquea los cobros de ese tramo (hasta 6 h 10 min) hasta que se confirme A25.
- **Reembolsos** con nuestra referencia en `metadata`. Cuentan como hechos solo en `SETTLED`; `RECEIVED` y `ACCEPTED` son `pending` (D5).
- **Sin disputas ni conciliación declaradas** (seguimiento 9.2-F6). Cualquier evento con `dispute`, `chargeback` o `reversal` en el nombre abre una tarea de revisión. Lo mismo un evento de reembolso ilegible.

En CI pasa la batería contra un Airwallex falso (`test/contract/subjects/airwallex-fake.ts`, con un modo que ignora filtros). Las pruebas propias están en `test/modules/payments/airwallex.unit.test.ts` y `airwallex-flow.test.ts`.

Para probarlo con el sandbox (cuando Oscar tenga la cuenta de sandbox, que es autoservicio):

1. En la web de sandbox, crear la clave de API (client ID y API key) con permisos de Checkout Session y Payments.
2. Crear **una sola** suscripción de webhook por cuenta (cada suscripción tiene su propio secreto), con la versión `2026-05-29`, apuntando a la URL que enseña nuestro panel. Debe incluir:
   - `checkout_session.created` y `checkout_session.cancelled`;
   - todos los `payment_intent.*` y todos los `refund.*`;
   - **todos** los eventos de disputas (todo lo que lleve `dispute`, `chargeback` o `reversal`).
3. Apagar los recargos y comprobar que no salen recibos llamados "tax invoice" (A17).
4. En el panel ("Payment gateways"), dar de alta la cuenta con las dos claves; nace pausada. Usar "Set webhook secret" con el secreto de la suscripción; después, probar la conexión y activar.
5. **Rotar el secreto:** crear el nuevo en Airwallex, ponerlo con "Set webhook secret" (se prueba antes de cambiar) y retirar el viejo. Las entregas firmadas con el viejo entre medias se rechazan y Airwallex las reintenta.
6. Grabar entregas reales (`[{ headers, bodyBase64, receivedAt }]`):
   - un `checkout_session.created` (A20);
   - un `payment_intent.succeeded`;
   - un `refund.*`;
   - y **el mismo evento dos veces**: nuestro endpoint responde 500 durante más de 300 s y se graba el reintento, que debe llegar con un `x-timestamp` nuevo (A19).
   Comprobar A2 con al menos dos pagos.
7. Con `playwright` añadido solo para esa ejecución, ejecutar `SANDBOX_ADAPTER=airwallex AIRWALLEX_SANDBOX_CLIENT_ID=… AIRWALLEX_SANDBOX_API_KEY=… AIRWALLEX_SANDBOX_WEBHOOK_SECRET=… AIRWALLEX_SANDBOX_CARD_PAY=… AIRWALLEX_SANDBOX_CARD_DECLINE=… AIRWALLEX_SANDBOX_RECORDED_DELIVERY=<ruta> pnpm --filter @mt/api test:sandbox`. Sin esas entregas la ejecución falla.
8. Una comprobación a mano: crear una sesión, esperar más de una hora y leerla. Debe dar `EXPIRED`, y nuestro estado `cancelled`. Anotarlo en el `docs/done/` de la ejecución.

Si A19 resulta falsa (los reintentos conservan el `x-timestamp` original), Airwallex sigue `experimental` hasta 9.2-F6. Mientras tanto, reembolsar solo desde nuestro panel.

## Stripe pago aplazado (9.3)

Adaptador `stripe_bnpl`, `experimental`: Afterpay, Klarna y Zip en el Checkout alojado de Stripe. **Todo lo de Stripe, Afterpay, Klarna y Zip está sin verificar** (leído con una herramienta que resume), y **ningún proveedor ha aprobado este negocio**: Afterpay prohíbe "Pre-orders" y el MCC 5962 de viajes, y un viaje prepagado puede contar como tal. Clase registrada: `StripeBnplProvider` (`adapters/stripe/bnpl.ts`), la de Stripe con otra sesión. Plan, supuestos A1–A16 y la revisión: `docs/plans/9.3-stripe-pay-later.md` (§19).

Lo que lo hace distinto:
- **Nace apagado.** Una cuenta nueva no recibe reglas de enrutado (`defaultRules` se salta `bnpl`). Para ofrecerlo, el personal añade una regla `bnpl` (AU, AUD). El manifiesto declara `amountRange` de A$1 a A$5.000, así que fuera de ese tramo nunca se ofrece aunque la regla no tenga límites.
- **Métodos por importe**, en orden fijo: Afterpay hasta A$4.000, Klarna hasta A$2.000 (Pay in 4) y Zip hasta A$5.000. Solo clientes de AU. Nunca `card`, nunca recargo. El importe sale del plan de pagos.
- **Necesita su propia cuenta de Stripe**, distinta de la de tarjeta. Si las dos cuentas del panel usaran la misma cuenta de Stripe, cada una recibiría los eventos de la otra. Por eso este adaptador ignora las sesiones con `card`; aun así, la cuenta de tarjeta abriría tareas de "pago desconocido" con los eventos de pago aplazado. Esas tareas piden ahora no registrar nada a mano.
- **Una sesión caducada se lee por su PaymentIntent** (Afterpay da 3 horas al cliente; la sesión vive 45 minutos). Mientras el PaymentIntent siga abierto, el intento sigue vivo. `cancelPayment` primero caduca la sesión, después cancela el PaymentIntent y por último vuelve a leer. Nunca devuelve `requires_action`: si Stripe no deja cancelar, el error es reintentable y salta la tarea de 24 h.
- **Plazos de reembolso:** Afterpay 120 días y Klarna y Zip 180. Pasado el plazo menos un día, el reembolso se rechaza antes de llamar a Stripe y el personal ve un 409. Hoy la app no tiene forma de registrar un reembolso por transferencia de un pago de pasarela (9.3-F7). Si un reembolso falla después de aceptarse, el núcleo abre la tarea "Refund failed at the payment gateway on booking …", una sola vez por reembolso.
- **Comisiones** (Stripe AU, sin verificar): Afterpay 6 % + A$0,30; Klarna 4,99 % + A$0,55; Zip del 5,49 % al 11 % + A$0,30 según el plazo. No se pueden repercutir.
- **Sin promoción en la web:** solo la etiqueta "Pay later", nunca "interest-free" ni recargo. Sin verificar: en 2025 Australia pasó a regular el pago aplazado como crédito. Esta nota no afirma que el negocio cumpla ni que el dato sea exacto; los prestamistas son los proveedores.

En CI pasa la batería contra el Stripe falso (`test/contract/subjects/stripe-bnpl.ts`). Las pruebas propias están en `test/modules/payments/stripe-bnpl.unit.test.ts` y `stripe-bnpl-flow.test.ts`.

Para probarlo con el sandbox (cuando Oscar tenga **una segunda cuenta de Stripe** solo para pago aplazado):
1. En su Dashboard, en modo prueba:
   - activar Afterpay, Klarna y Zip;
   - comprobar que no hay recargos;
   - crear un endpoint de webhook a la URL del panel, con la versión `STRIPE_API_VERSION` y estos eventos: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `refund.created`, `refund.updated`, `refund.failed` y todos los `charge.dispute.*`.
2. En el panel, dar de alta una cuenta "Stripe pay later" con su clave de prueba. Después: "Set webhook secret", probar la conexión y activar. La regla `bnpl` se añade solo cuando Oscar decida ofrecerlo.
3. Con `playwright` añadido solo para esa ejecución: `SANDBOX_ADAPTER=stripe_bnpl STRIPE_BNPL_SANDBOX_SECRET_KEY=… STRIPE_BNPL_SANDBOX_WEBHOOK_SECRET=… pnpm --filter @mt/api test:sandbox`. Comprobar a mano:
   - A1: la página no muestra tarjetas;
   - A3: Checkout pide lo que necesita cada proveedor;
   - A15: qué hace Stripe con un PaymentIntent abierto cuando caduca la sesión;
   - A16: el tipo y la fecha del cargo.
4. Preguntar a Stripe por escrito si acepta viajes prepagados (depósito y saldo) de un sole trader con ABN para los tres métodos. Preguntar a PayPal si Pay in 4 aparece en la página de aprobación de Orders v2 (9.3-F1).

## Cuentas en el panel (4.1)

Página "Payment gateways" (`/admin/gateways`), con los permisos `payments.providerAccount.manage` y `payments.providerAccount.manageCredentials`, los dos con segundo factor. Solo modo prueba: `CHECK (mode = 'test')` sigue en `provider_accounts` y la API rechaza `live` antes de nada. Quitarlo será una migración futura, solo con un adaptador `verified` y la aprobación de Oscar (plan 4.1, sección 14).

- Una cuenta nace **pausada**; se activa cuando pasa una prueba de conexión de sus credenciales actuales (lo exige también un disparador).
- Cambiar credenciales o secreto: se prueban antes y, si la prueba falla, no cambia nada. Nunca se vuelven a enseñar.
- Pausar o retirar la última cuenta que atiende un método en un país de venta pide confirmación (`coverage_loss_unconfirmed`); apagar un método manual también.
- Archivar exige que no queden cobros vivos ni reembolsos en curso y que haya pasado `paymentDisputeWindowDays` (180) desde el último cobro o reembolso. No se borra ninguna cuenta.
