import { Inject, Injectable } from '@nestjs/common';
import type { AcceptTerms, CheckoutTermsView } from '@mt/shared';
import { AuditService } from '../../../platform/audit/audit.service';
import type { AuditActor } from '../../../platform/audit/audit.service';
import { canonicalJson, sha256Hex } from '../../../platform/crypto/hmac';
import { PrismaService } from '../../../platform/database/prisma.service';
import { runTransaction } from '../../../platform/database/transaction';
import { conflict, notFound } from '../../../platform/http/api-error';
import { readBookingForPayments } from '../../bookings';
import { CancellationPolicyService, publicPolicyView } from '../../pricing';
import type { FrozenCancellationPolicy } from '../../pricing';
import { PAYABLE_STATES, PAYMENT_TX_OPTIONS } from './payable-states';

/** The published content page that holds the booking terms, and the only language today. */
export const TERMS_SLUG = 'terms';
export const TERMS_LOCALE = 'en-AU';

export interface CurrentTerms {
  slug: string;
  locale: string;
  version: number;
  digest: string;
  title: string;
  intro: string;
  body: string;
}

/** The digest names the exact words: change one character of the page and it changes (plan 3.5, section 2). */
export const termsDigest = (t: { slug: string; locale: string; title: string; intro: string; body: string }): string =>
  sha256Hex(canonicalJson({ slug: t.slug, locale: t.locale, title: t.title, intro: t.intro, body: t.body }));

const unavailable = () => conflict('terms_unavailable', 'The booking terms are not available right now. Try again later.');

/**
 * Terms acceptance (task 3.5, plan section 2). The text always comes from the published `terms` page on the server; the
 * browser only says which version and digest it showed, and the server refuses if they are no longer the current ones.
 */
@Injectable()
export class TermsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CancellationPolicyService) private readonly policies: CancellationPolicyService,
  ) {}

  /** Task 6.4 (plan section 13, M2): the policy the booking was sold under, shown and accepted with the terms. */
  private async bookingPolicy(db: Pick<PrismaService, '$queryRaw' | 'cancellationPolicy' | 'cancellationTier' | 'packageCancellationPolicy'>, bookingId: string): Promise<FrozenCancellationPolicy | null> {
    const rows = await db.$queryRaw<Array<{ policyId: string | null }>>`
      SELECT s."cancellationPolicyId"::text AS "policyId" FROM bookings b JOIN booking_snapshots s ON s."bookingId" = b.id AND s.version = b."currentSnapshotVersion" WHERE b.id = ${bookingId}::uuid`;
    return this.policies.frozen(db, rows[0]?.policyId ?? null);
  }

  /** The published terms, or null when there is none. */
  async current(db: Pick<PrismaService, 'contentPage'> = this.prisma): Promise<CurrentTerms | null> {
    const p = await db.contentPage.findFirst({ where: { slug: TERMS_SLUG, locale: TERMS_LOCALE, status: 'published' }, select: { version: true, title: true, intro: true, body: true } });
    if (!p) return null;
    return { slug: TERMS_SLUG, locale: TERMS_LOCALE, version: p.version, digest: termsDigest({ slug: TERMS_SLUG, locale: TERMS_LOCALE, ...p }), title: p.title, intro: p.intro, body: p.body };
  }

  async view(reference: string): Promise<CheckoutTermsView> {
    const b = await readBookingForPayments(this.prisma, { reference });
    if (!b) throw notFound();
    const terms = await this.current();
    if (!terms) throw unavailable();
    const accepted = await this.prisma.termsAcceptance.findUnique({
      where: { bookingId_documentSlug_locale_textDigest: { bookingId: b.id, documentSlug: terms.slug, locale: terms.locale, textDigest: terms.digest } },
      select: { acceptedAt: true },
    });
    const policy = await this.bookingPolicy(this.prisma, b.id);
    return { slug: terms.slug, version: terms.version, digest: terms.digest, title: terms.title, intro: terms.intro, body: terms.body, acceptedAt: accepted ? accepted.acceptedAt.toISOString() : null, cancellationPolicy: policy ? publicPolicyView(policy) : null };
  }

  /** Records the acceptance of the current text for this booking; accepting the same text again changes nothing. */
  async accept(reference: string, body: AcceptTerms, actor: AuditActor): Promise<{ version: number; acceptedAt: string }> {
    return runTransaction(this.prisma, async (tx) => {
      // Read inside the transaction, so the state and the customer are those at the moment of the insert.
      const b = await readBookingForPayments(tx, { reference });
      if (!b) throw notFound();
      if (!PAYABLE_STATES.includes(b.status)) throw conflict('booking_not_payable', 'This booking cannot take a payment in its current state');
      const terms = await this.current(tx as unknown as Pick<PrismaService, 'contentPage'>);
      if (!terms) throw unavailable();
      if (terms.version !== body.version || terms.digest !== body.digest) throw conflict('terms_changed', 'The booking terms have changed since you opened this page. Read them again.');
      const policy = await this.bookingPolicy(tx as unknown as PrismaService, b.id);
      if ((policy?.digest ?? null) !== (body.cancellationPolicyDigest ?? null)) throw conflict('cancellation_policy_changed', 'The cancellation policy shown is not the one of this booking. Read it again.');
      const inserted = await tx.termsAcceptance.createManyAndReturn({
        data: [{ bookingId: b.id, customerId: b.customerId, documentSlug: terms.slug, locale: terms.locale, contentVersion: terms.version, textDigest: terms.digest, title: terms.title, intro: terms.intro, body: terms.body, cancellationPolicyDigest: policy?.digest ?? null }],
        skipDuplicates: true,
        select: { id: true, acceptedAt: true },
      });
      if (inserted[0]) {
        await this.audit.record(tx, {
          actor, action: 'payments.termsAcceptance.created', entityType: 'TermsAcceptance', entityId: inserted[0].id, model: 'TermsAcceptance',
          after: { documentSlug: terms.slug, locale: terms.locale, contentVersion: terms.version, textDigest: terms.digest, cancellationPolicyDigest: policy?.digest ?? null },
          context: { bookingId: b.id },
        });
        return { version: terms.version, acceptedAt: inserted[0].acceptedAt.toISOString() };
      }
      const first = await tx.termsAcceptance.findUniqueOrThrow({
        where: { bookingId_documentSlug_locale_textDigest: { bookingId: b.id, documentSlug: terms.slug, locale: terms.locale, textDigest: terms.digest } },
        select: { acceptedAt: true, contentVersion: true },
      });
      return { version: first.contentVersion, acceptedAt: first.acceptedAt.toISOString() };
    }, PAYMENT_TX_OPTIONS);
  }

  /** A payment can start only if the current text was accepted for this booking. */
  async assertAccepted(bookingId: string): Promise<void> {
    const terms = await this.current();
    if (!terms) throw unavailable();
    const row = await this.prisma.termsAcceptance.findUnique({
      where: { bookingId_documentSlug_locale_textDigest: { bookingId, documentSlug: terms.slug, locale: terms.locale, textDigest: terms.digest } },
      select: { id: true },
    });
    if (!row) throw conflict('terms_not_accepted', 'Accept the booking terms before you pay.');
  }
}
