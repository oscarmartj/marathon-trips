# Payments and ledger

Applies to any change under `apps/api/src/modules/payments/` (core: ledger, payment plan, routing, accounts, webhooks, reconciliation; adapters: one folder per gateway), to `apps/api/prisma/schema/payments.prisma` and `finance.prisma`, and to their migrations.

- Amounts are integers in minor units with an explicit currency. No floats anywhere near money.
- Ledger entries are append-only. A correction is a new entry that references the original.
- Every operation that moves money takes an idempotency key and is safe to retry.
- Webhooks: verify the signature, store the raw event, process idempotently, tolerate duplicates and out-of-order delivery.
- Card data never reaches our servers. Hosted fields or the provider's checkout only.
- Provider credentials are encrypted at rest and never returned by the API or written to logs.
- A provider adapter that is not `verified` cannot be switched to live mode. Do not add a way around that.
- The amount to charge comes from the pricing engine on the server, never from the request body.
- No surcharge depends on the payment method.
- Any change here needs tests for the failure paths, not only the happy path, and goes through the `reviewer` subagent before the task is closed.
