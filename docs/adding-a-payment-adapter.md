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
- **Datos del pagador.** El 3-D Secure 2 pide nombre, correo y teléfono del pagador del cobro; sin teléfono, 409 `card_session_phone_required`.

En CI pasa la batería contra un eWAY falso (`test/contract/subjects/eway-fake.ts`), con el almacén en memoria y con el de la base (`test/modules/payments/eway-store.test.ts`). Plan, supuestos A1–A14 y cambios de la revisión: `docs/plans/9.1-eway.md` (sección 20).

Para probarlo con el sandbox (cuando Oscar tenga la cuenta de partner de eWAY, gratuita):

1. En MYeWAY (sandbox), la clave de API, la contraseña y la clave pública (`epk-…`). Respuestas del sandbox en "Use Cents Value". Recargos apagados. Confirmar con eWAY por escrito los supuestos A1, A5 y A14.
2. En el panel ("Payment gateways"), una cuenta eWAY con las tres claves; nace pausada. No hay webhook que configurar. Probar la conexión y activar.
3. Escribir el guion de navegador para Secure Fields y `Cerberus` (Playwright, añadido solo para esa ejecución) y ejecutar `SANDBOX_ADAPTER=eway EWAY_SANDBOX_API_KEY=… EWAY_SANDBOX_API_PASSWORD=… EWAY_SANDBOX_PUBLIC_KEY=… EWAY_SANDBOX_BROWSER_SCRIPT=<ruta> pnpm --filter @mt/api test:sandbox`. Aunque pase, eWAY sigue `experimental` hasta 9.1-F2.

## Cuentas en el panel (4.1)

Página "Payment gateways" (`/admin/gateways`), con los permisos `payments.providerAccount.manage` y `payments.providerAccount.manageCredentials`, los dos con segundo factor. Solo modo prueba: `CHECK (mode = 'test')` sigue en `provider_accounts` y la API rechaza `live` antes de nada. Quitarlo será una migración futura, solo con un adaptador `verified` y la aprobación de Oscar (plan 4.1, sección 14).

- Una cuenta nace **pausada**; se activa cuando pasa una prueba de conexión de sus credenciales actuales (lo exige también un disparador).
- Cambiar credenciales o secreto: se prueban antes y, si la prueba falla, no cambia nada. Nunca se vuelven a enseñar.
- Pausar o retirar la última cuenta que atiende un método en un país de venta pide confirmación (`coverage_loss_unconfirmed`); apagar un método manual también.
- Archivar exige que no queden cobros vivos ni reembolsos en curso y que haya pasado `paymentDisputeWindowDays` (180) desde el último cobro o reembolso. No se borra ninguna cuenta.
