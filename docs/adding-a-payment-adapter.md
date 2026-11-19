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

## El simulador

Es el adaptador `simulator`: `testOnly`, `experimental` y sin sandbox. Su página alojada (`/api/payments/simulator/checkout/<token>`) existe solo en `development`, `test` y `ci`. Allí se paga o se rechaza un pago de prueba; el simulador entrega el webhook firmado por la misma entrada que una pasarela real. Sirve para probar a mano (`pnpm dev`) y para Playwright (3.5).

## Stripe (3.3)

Adaptador `stripe`, `experimental`: Checkout Sessions (la página alojada de Stripe), reembolsos y webhooks firmados (`stripe-signature`), con la versión de la API fijada en `STRIPE_API_VERSION`. Solo habla con `https://api.stripe.com`. En CI pasa la batería contra un Stripe falso en memoria (`test/contract/subjects/stripe-fake.ts`); el falso sigue la documentación de Stripe y no sustituye a una ejecución real.

Para probarlo con un sandbox de Stripe (cuando Oscar tenga las claves de prueba):

1. En el panel de Stripe (modo de prueba), crear un endpoint de webhook con la **misma versión de la API** que `STRIPE_API_VERSION` y los eventos `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `refund.created`, `refund.updated` y `refund.failed`.
2. Cuenta en la API, solo en pruebas, desde el panel (4.1, "Payment gateways"): añadir una cuenta Stripe con la clave secreta de prueba; nace pausada, sin secreto de webhook, y enseña una vez la URL del webhook, que se pone en el endpoint del paso 1. Después, "Set webhook secret" con el `whsec_…` que da Stripe, probar la conexión y activar. También por consola: `STRIPE_TEST_SECRET_KEY=sk_test_… STRIPE_TEST_WEBHOOK_SECRET=whsec_… pnpm api:cli payments:stripe-test-account`. Las claves se leen solo del entorno; una clave real se rechaza. Imprime una vez la URL del webhook, que se pone en el endpoint del paso 1.
3. Batería contra el sandbox: añadir antes `playwright` como dependencia de desarrollo de `@mt/api` (el cliente paga en la página de Checkout con la tarjeta de prueba) y ejecutar `SANDBOX_ADAPTER=stripe STRIPE_SANDBOX_SECRET_KEY=… STRIPE_SANDBOX_WEBHOOK_SECRET=… pnpm --filter @mt/api test:sandbox`. Solo con todas las cláusulas en verde y su línea en `docs/done/` puede el manifiesto pasar a `verified`, en un PR revisado.

## Cuentas en el panel (4.1)

Página "Payment gateways" (`/admin/gateways`), con los permisos `payments.providerAccount.manage` y `payments.providerAccount.manageCredentials`, los dos con segundo factor. Solo modo prueba: `CHECK (mode = 'test')` sigue en `provider_accounts` y la API rechaza `live` antes de nada. Quitarlo será una migración futura, solo con un adaptador `verified` y la aprobación de Oscar (plan 4.1, sección 14).

- Una cuenta nace **pausada**; se activa cuando pasa una prueba de conexión de sus credenciales actuales (lo exige también un disparador).
- Cambiar credenciales o secreto: se prueban antes y, si la prueba falla, no cambia nada. Nunca se vuelven a enseñar.
- Pausar o retirar la última cuenta que atiende un método en un país de venta pide confirmación (`coverage_loss_unconfirmed`); apagar un método manual también.
- Archivar exige que no queden cobros vivos ni reembolsos en curso y que haya pasado `paymentDisputeWindowDays` (180) desde el último cobro o reembolso. No se borra ninguna cuenta.
