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
2. **Contrato de la interfaz.** Los comentarios de `core/provider.ts` mandan.
   - Solo se lanza `ProviderError`, con un código de la lista.
   - Un error no reintentable de `createPayment` significa que con esa clave no hay ni habrá objeto.
   - `failed` es terminal en la pasarela.
   - `verifyWebhook` no usa la red, compara en tiempo constante y rechaza firmas con más de 300 s.
3. **Registro.** Una línea en `adapters/index.ts` (`createAdapters`).
4. **Sujeto local** en `apps/api/test/contract/subjects/<clave>.ts`, añadido a `LOCAL_SUBJECTS`. La pasarela se simula en memoria o con respuestas grabadas de su documentación. La batería completa (`CONTRACT_CLAUSES`) corre con él en CI. Sin sujeto local, CI falla (`every_adapter_has_a_local_contract_subject`).
5. **Sujeto de sandbox**, añadido a `SANDBOX_SUBJECTS`.
   - Usa la misma clase que devuelve `createAdapters`.
   - Lee las credenciales de variables de entorno.
   - `assertSandboxCredentials` rechaza todo lo que no tenga forma de clave de prueba.
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
