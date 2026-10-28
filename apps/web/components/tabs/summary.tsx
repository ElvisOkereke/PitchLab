import Link from 'next/link';
import { money } from '@bcg/core/case/export-markdown';
import { safeHttpUrl } from '@bcg/core/case/links';
import { forYouToCheck, linkFlags, type LinkFlags } from '@bcg/core/case/review';
import type { CaseView } from '@bcg/core/dashboard/case-view';
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
  const gate = [...view.gate].sort((a, b) => Number(a.pass) - Number(b.pass));

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
        {gate.map((g) => (
          <li key={g.id} className={g.pass ? 'verdict pass' : 'verdict fail'}>
            <span className="check">
              {g.pass ? '✅' : '❌'} {checkLabel(g.check)}:
            </span>{' '}
            <span className="pre">{g.reasoning}</span>
          </li>
        ))}
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
