// Task 6.2 (plan docs/plans/6.2-supplier-payments.md, section 5): the narrow door through which the suppliers module posts
// the supplier payments it records. LedgerService stays the only writer of the ledger; payments never imports suppliers.
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { ProviderGateway } from './gateway';
import type { PaymentModeName } from './provider';
import { LedgerService } from './ledger.service';
import type { SupplierPaymentRef } from './ledger.service';

@Injectable()
export class SupplierLedger {
  constructor(
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
  ) {}

  /** The environment's mode (plan 0.1, P11): every supplier payment is recorded in it. */
  get mode(): PaymentModeName {
    return this.gateway.mode;
  }

  postRecorded(tx: Prisma.TransactionClient, sp: SupplierPaymentRef): Promise<string> {
    return this.ledger.postSupplierPayment(tx, sp);
  }

  postVoided(tx: Prisma.TransactionClient, sp: SupplierPaymentRef): Promise<string> {
    return this.ledger.postSupplierPaymentVoided(tx, sp);
  }
}
