import type { CancellationPolicyPublicView } from '@mt/shared';
import { t } from '@/lib/i18n';
import { tierLines } from '@/lib/cancellation';

/**
 * A cancellation policy as customers read it before they commit (task 6.4, plan section 13, M2): the description and
 * one line per tier, from the API. When there is none, it says so.
 */
export function CancellationPolicyTerms({ policy, headingLevel = 2 }: { policy: CancellationPolicyPublicView | null; headingLevel?: 2 | 3 }) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className="stack" aria-labelledby="cancellation-policy-heading">
      <Heading id="cancellation-policy-heading">{t('cancellation.policyHeading')}</Heading>
      {policy ? (
        <>
          {policy.description['en-AU'] ? <p>{policy.description['en-AU']}</p> : null}
          <ul>
            {tierLines(policy).map((l, i) => <li key={i}>{t(l.key, l.params)}</li>)}
          </ul>
          <p className="field__hint">{t('cancellation.policyNote')}</p>
        </>
      ) : (
        <p>{t('cancellation.noPolicy')}</p>
      )}
    </section>
  );
}
