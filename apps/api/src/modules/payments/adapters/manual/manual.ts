// The manual adapter (task 3.4): no gateway. It exists so a manual account has a manifest and the gateway wrapper can
// apply its rules (status, mode, environment) to it. Nothing here takes money or calls anyone: a manual intent never
// reaches a gateway, and staff confirm transfers themselves. It is not in createAdapters (the contract suite of 3.6 is for
// gateways), and it stays `experimental`: becoming `verified` is a decision for 4.1, with live mode.
import type { AdapterManifest, PaymentProvider, ProviderContext, WebhookVerification } from '../../core/provider';
import { ProviderError } from '../../core/provider';

export const MANUAL_KEY = 'manual';

export class ManualProvider implements PaymentProvider {
  readonly manifest: AdapterManifest = {
    key: MANUAL_KEY, displayName: 'Bank transfer (manual)', status: 'experimental', testOnly: false, cardDataHandling: 'hosted_only',
    methods: ['payid_transfer', 'manual_other'], currencies: ['AUD'], countries: 'any', checkoutOrigin: 'https://manual.invalid',
    capabilities: { refunds: 'none', deferredCapture: false, lookupByIdempotencyKey: true, declineOutcome: 'failed' },
  };
  readonly signatureHeaders: readonly string[] = [];

  testConnection(_ctx: ProviderContext): Promise<{ ok: true } | { ok: false; code: string }> {
    // The real check is the instructions' validity (ManualMethodsService.test), which needs the database.
    return Promise.resolve({ ok: true });
  }

  createPayment(): Promise<never> {
    return Promise.reject(new ProviderError('provider_rejected', false));
  }

  retrievePayment(): Promise<null> {
    return Promise.resolve(null);
  }

  cancelPayment(): Promise<never> {
    return Promise.reject(new ProviderError('provider_rejected', false));
  }

  /** A transfer is refunded by staff from the bank (task 4.5, finding 1), never through an adapter. */
  createRefund(): Promise<never> {
    return Promise.reject(new ProviderError('provider_rejected', false));
  }

  retrieveRefund(): Promise<null> {
    return Promise.resolve(null);
  }

  verifyWebhook(): WebhookVerification {
    return { ok: false, code: 'bad_signature' };
  }

  parseEvent(): null {
    return null;
  }
}
