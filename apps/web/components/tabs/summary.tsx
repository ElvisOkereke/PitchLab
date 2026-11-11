import Link from 'next/link';
import { money } from '@bcg/core/case/export-markdown';
import { safeHttpUrl } from '@bcg/core/case/links';
import { forYouToCheck, linkFlags, type LinkFlags } from '@bcg/core/case/review';
import type { CaseView } from '@bcg/core/dashboard/case-view';
import { isAdvisoryGateCheck } from '@bcg/core/pipeline/gate-checks';
import { FREE_PRICE_CEILING_NOTE, userPaysNothing, type ScaleEstimate, type ScaleResult } from '@bcg/core/pipeline/business-models';
import { checkLabel } from '@/lib/gate';
import { libraryHref } from '@/lib/library-query';
import { ExternalLink } from '../external-link';
import { TextBlock } from '../text-block';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The idea's value source: a library id links to its library entry, a url to the page; anything else is not shown. */
function ValueSource({ source }: { source?: string }) {
  if (!source) return null;
  const s = source.trim();
  if (UUID.test(s)) {
    return (
      <p>
        Source: <Link href={libraryHref({ q: '', status: 'active', page: 1, item: s.toLowerCase() })}>library entry</Link>
      </p>
    );
  }
  if (safeHttpUrl(s)) {
    return (
      <p>
        Source: <ExternalLink url={s} />
      </p>
    );
  }
  return null;
}

const whole = (n: number) => Math.round(n).toLocaleString('en-US');
const STEP_LABELS: Record<string, string> = {
  shareWithProblem: 'with the problem', shareWillingToPay: 'willing to pay', shareReachable: 'reachable in 3 years',
};

/** The idea's scale estimate (ideate.v13): the paying buyers and revenue ceiling worked out in code, then each step as text. */
function ScaleEstimateRow({ estimate: e, result: r, businessModel, priceIsFree }: {
  estimate: ScaleEstimate; result: ScaleResult | null; businessModel?: string | null; priceIsFree?: boolean;
}) {
  // Ads and affiliate: the user pays nothing, so step 3 is the share who become regular users (the gate's wording).
  const free = userPaysNothing(businessModel);
  const ceiling = r?.revenueCeiling == null
    ? (priceIsFree ? `${FREE_PRICE_CEILING_NOTE}.` : 'unknown, because the price cannot be made yearly.')
    : `$${whole(r.revenueCeiling)} a year.`;
  return (
    <div>
      <dt>{free ? 'Realistic regular users' : 'Realistic paying buyers'}</dt>
      <dd>
        {r ? <TextBlock text={`${whole(r.payingBuyers)} ${e.buyerUnit} would realistically ${free ? 'become regular users' : 'pay'}. Revenue ceiling: ${ceiling}`} /> : null}
        <TextBlock text={`Population: ${whole(e.population.count)} ${e.buyerUnit}. ${e.population.basis}`} />
        <ValueSource source={e.population.source} />
        <TextBlock text={`With the problem: ${e.shareWithProblem.pct}%. ${e.shareWithProblem.basis}`} />
        <ValueSource source={e.shareWithProblem.source} />
        <TextBlock text={`${free ? 'Become regular users' : 'Willing to pay'}: ${e.shareWillingToPay.pct}%. ${e.shareWillingToPay.basis}`} />
        <ValueSource source={e.shareWillingToPay.source} />
        <TextBlock text={`Reachable in 3 years: ${e.shareReachable.pct}%. ${e.shareReachable.basis}`} />
        {r && r.capped.length > 0 ? (
          <p>Cut to the cap because it had no source: {r.capped.map((c) => (free && c === 'shareWillingToPay' ? 'become regular users' : STEP_LABELS[c] ?? c)).join(', ')}.</p>
        ) : null}
        {r?.allAssumed ? <p>Every step is an assumption.</p> : null}
        {r?.bandCapped ? <p>Scale band limited to 3: the population has no source.</p> : null}
      </dd>
    </div>
  );
}

/** Summary fields, the gate verdicts (failed first) and "For you to check" with the export's wording. */
export function SummaryTab({ view, flags = linkFlags(view.claims) }: { view: CaseView; flags?: LinkFlags }) {
  const s = view.case.sections.summary;
  const fields: [string, string][] = [
    ['One-liner', s.oneLiner],
    ['Buyer', s.buyer],
    ['Problem', s.problem],
    ['Solution', s.solution],
  ];
  const extra: [string, string][] = [];
  if (s.audience) extra.push(['Audience', s.audience]);
  if (s.businessModel) extra.push(['Business model', s.businessModel]);
  const value = s.valueToUser;
  // Barriers stay right after the value row (rendered first among the later rows).
  const barrierRows: [string, string][] = [];
  if (s.barriers) {
    const b = s.barriers;
    barrierRows.push([
      'Barriers',
      `To start: ${b.toStart}/5 (${b.toStartWhy}). To copy: ${b.toCopy}/5 (${b.toCopyWhy}). ${b.soloBuildable ? 'One person can build it.' : 'Not buildable by one person.'}`,
    ]);
  }
  const later: [string, string][] = [
    ...barrierRows,
    ['Why now', s.whyNow],
    ['Why it wins', s.whyItWins],
    ['Next action', s.nextAction],
  ];
  // Core already orders failed checks first; kept stable here so the page never depends on it.
  // Failures first, then flags (a failed advisory verdict, comps), then passes.
  const rank = (g: { pass: boolean; check: string }) => (g.pass ? 2 : isAdvisoryGateCheck(g.check) ? 1 : 0);
  const gate = [...view.gate].sort((a, b) => rank(a) - rank(b));

  return (
    <div className="tab tab-summary">
      <h2>Summary</h2>
      <dl className="fields">
        {fields.map(([label, text]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <TextBlock text={text} />
            </dd>
          </div>
        ))}
        <div>
          <dt>Price</dt>
          <dd>
            <p>
              {money(s.price.amount)} per {s.price.per}
            </p>
            <TextBlock text={s.price.rationale} />
          </dd>
        </div>
        {extra.map(([label, text]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <TextBlock text={text} />
            </dd>
          </div>
        ))}
        {value ? (
          <div>
            <dt>Idea&apos;s estimate of value to the user</dt>
            <dd>
              <TextBlock text={`${value.kind}: ${money(value.amountPerYear)} per year. ${value.basis}`} />
              <ValueSource source={value.source} />
            </dd>
          </div>
        ) : null}
        {later.map(([label, text]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <TextBlock text={text} />
            </dd>
          </div>
        ))}
        {view.edge ? (
          <div>
            <dt>Idea&apos;s edge</dt>
            <dd>
              <TextBlock text={`${view.edge.kind.replace(/_/g, ' ')}: ${view.edge.claim}`} />
              <TextBlock text={`Versus today's option: ${view.edge.versus}`} />
              <TextBlock text={`Why now: ${view.edge.whyNow}`} />
            </dd>
          </div>
        ) : null}
        {view.scale ? (
          <div>
            <dt>Idea&apos;s scale</dt>
            <dd>
              <TextBlock text={view.scale.buyers} />
              <TextBlock text={`Basis: ${view.scale.basis}`} />
              <ValueSource source={view.scale.source} />
            </dd>
          </div>
        ) : null}
        {view.scaleEstimate ? <ScaleEstimateRow estimate={view.scaleEstimate} result={view.scaleResult ?? null} businessModel={view.businessModel} priceIsFree={view.priceIsFree} /> : null}
        {view.lensName ? (
          <div>
            <dt>Lens</dt>
            <dd>{view.lensName}</dd>
          </div>
        ) : null}
      </dl>

      <h2>Gate verdicts</h2>
      {gate.length === 0 ? <p className="muted">No gate verdicts recorded.</p> : null}
      <ul className="plain verdicts" data-testid="gate-verdicts">
        {gate.map((g) => {
          // Advisory verdicts (comps) only flag: a failed one is a flag, never a failure.
          const flag = !g.pass && isAdvisoryGateCheck(g.check);
          return (
            <li key={g.id} className={g.pass ? 'verdict pass' : flag ? 'verdict flag' : 'verdict fail'}>
              <span className="check">
                {g.pass ? '✅' : flag ? '⚠️' : '❌'} {checkLabel(g.check)}{flag ? ' (flag)' : ''}:
              </span>{' '}
              <span className="pre">{g.reasoning}</span>
            </li>
          );
        })}
      </ul>

      <ForYouToCheck view={view} flags={flags} />
    </div>
  );
}

/** Everything the checker could not settle (texts come cleaned but unescaped from core; React renders them as text). */
function ForYouToCheck({ view, flags }: { view: CaseView; flags: LinkFlags }) {
  const r = forYouToCheck(view.case.sections, view.claims, flags);
  return (
    <section data-testid="for-you" aria-labelledby="for-you-title">
      <h2 id="for-you-title">For you to check</h2>
      {r.state === 'no_claims' ? <p>This case has no checked sources — verify everything yourself.</p> : null}
      {r.state === 'all_clear' ? <p>Nothing — every displayed source was confirmed or flagged.</p> : null}
      {r.items.length > 0 ? (
        <ul className="for-you">
          {r.items.map((m) => (
            <li key={`${m.label}\n${m.url}\n${m.reason}\n${m.text}`}>
              <strong>{m.label}:</strong> {m.text} (<ExternalLink url={m.url} />): {m.reason}
              {m.count > 1 ? ` (${m.count} claims)` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
