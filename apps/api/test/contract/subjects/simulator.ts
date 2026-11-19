// The simulator's local contract subject (plan 3.6, section 2.1): random accounts in a world of their own, and the
// customer pays or declines through completeCheckout, the same code as the hosted checkout page.
import { randomBytes, randomUUID } from 'node:crypto';
import { SimulatorControl, SimulatorProvider, SimulatorWorld } from '../../../src/modules/payments/adapters/simulator/simulator';
import type { ContractSubject } from '../payment-provider.contract';

export function simulatorLocalSubject(): ContractSubject {
  const world = new SimulatorWorld();
  const provider = new SimulatorProvider({ webOrigin: 'http://localhost:3000' }, world);
  const control = new SimulatorControl(world);
  return {
    provider,
    async context() {
      return { accountId: randomUUID(), mode: 'test', credentials: { apiKey: `sim_test_${randomBytes(12).toString('hex')}` }, webhookSecret: randomBytes(32).toString('hex') };
    },
    badCredentials: (ctx) => ({ ...ctx, credentials: { apiKey: `sim_test_${randomBytes(3).toString('hex')}` } }),
    async customerCompletes(ctx, payment, outcome) {
      const url = payment.nextAction?.url;
      if (!url) throw new Error('simulator: this payment has no hosted page');
      const result = provider.completeCheckout(ctx, url.slice(url.lastIndexOf('/') + 1), outcome);
      if (!result.changed) throw new Error('simulator: the payment is already finished');
    },
    async endAtGateway(ctx, payment) {
      // The simulator's unpaid end is a declined card (declineOutcome failed).
      const url = payment.nextAction?.url;
      if (!url) throw new Error('simulator: this payment has no hosted page');
      provider.completeCheckout(ctx, url.slice(url.lastIndexOf('/') + 1), 'decline');
    },
    async webhookFor(ctx, ref, at) {
      const w = provider.currentWebhook(ctx, ref, at);
      return { body: w.body, headers: w.headers };
    },
    async gatewayRefunds(ctx, payment, amountMinor) {
      return control.gatewayRefund(ctx.accountId, payment.ref, amountMinor);
    },
    async refundWebhookFor(ctx, refundRef, at) {
      const w = provider.currentRefundWebhook(ctx, refundRef, at);
      return { body: w.body, headers: w.headers };
    },
    async cardholderDisputes(ctx, payment) {
      return { ref: control.openDispute(ctx.accountId, payment.ref).ref };
    },
    async disputeMoves(ctx, ref, to) {
      control.moveDispute(ctx.accountId, ref, { ...(to.status ? { status: to.status } : {}), ...(to.withdraw ? { fundsWithdrawn: true } : {}), ...(to.reinstate ? { fundsReinstated: true } : {}) });
    },
    async disputeWebhookFor(ctx, ref, at) {
      const w = provider.currentDisputeWebhook(ctx, ref, at);
      return { body: w.body, headers: w.headers };
    },
    unsupportedCurrency: 'NZD',
    assertSandboxCredentials() {
      throw new Error('the simulator has no sandbox: it is test-only');
    },
  };
}
