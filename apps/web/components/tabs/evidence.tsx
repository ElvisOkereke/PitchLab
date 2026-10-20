import { cleanQuote, linkFlags, signalStatus, type LinkFlags } from '@bcg/core/case/review';
import type { CaseView } from '@bcg/core/dashboard/case-view';
import { ExternalLink } from '../external-link';
import { StatusChip } from '../status-chip';

/** Claim sections listed under "Claims"; signal and competitor rows are flagged where their link is shown. */
const LISTED_SECTIONS = new Set(['evidence', 'numbers']);

/** Harvested signals (with their check status) and the case's evidence and number claims. */
export function EvidenceTab({ view, flags = linkFlags(view.claims) }: { view: CaseView; flags?: LinkFlags }) {
  const { signals } = view.case.sections.evidence;
  const listed = view.claims.filter((c) => LISTED_SECTIONS.has(c.section));
  return (
    <div className="tab tab-evidence">
      <h2>Signals</h2>
      {signals.length === 0 ? <p className="muted">No harvested signals.</p> : null}
      <ul className="plain stack" data-testid="signals">
        {signals.map((s, i) => {
          const status = signalStatus(flags, s);
          return (
            <li key={`${i}-${s.url}`} className="card evidence-item">
              <blockquote className="pre">“{cleanQuote(s.quote)}”</blockquote>
              <p className="meta">
                {s.sourceName} · <ExternalLink url={s.url} />
                {s.voice ? <> · voice: {s.voice}</> : null} · {status ? <StatusChip status={status} /> : <span className="muted">not checked</span>}
              </p>
            </li>
          );
        })}
      </ul>

      <h2>Claims</h2>
      {listed.length === 0 ? <p className="muted">No claims recorded.</p> : null}
      <ul className="plain stack" data-testid="claims">
        {listed.map((c) => (
          <li key={c.id} className="card evidence-item">
            <p>
              <StatusChip status={c.verified} /> <span className="pre">{c.text}</span>
            </p>
            {c.quote ? <blockquote className="pre">Quote: “{cleanQuote(c.quote)}”</blockquote> : null}
            <p className="meta">
              Source: <ExternalLink url={c.sourceUrl} />
            </p>
            {c.reviewNote ? <p className="meta muted pre">Checker: {c.reviewNote}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
