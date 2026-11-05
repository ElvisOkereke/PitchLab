import type { PassAuditView } from '@/lib/audit-query';
import { HelpTip } from './help-tip';

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const counts = (m: Record<string, number>) =>
  Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => `${k} ${v}`).join(', ');

/** One pass's audit as plain text (R13: every value is a text node). Props only; "no data" where a figure cannot be measured. */
export function PassAuditSection({ label, view }: { label: string; view: PassAuditView }) {
  const { audit: a, holdout } = view;
  const s = a.signals;
  return (
    <section aria-label={`Audit of ${label}`} className="card" data-testid="pass-audit">
      <h3>Audit of {label}</h3>
      <ul className="plain stack small">
        <li>Evidence: {s.total === 0 ? 'no data' : `${s.total} signals`}</li>
        {s.total > 0 ? (
          <>
            <li>Voices: {counts(s.byVoice)}</li>
            <li>Sources: {counts(s.bySource)}</li>
            <li>Top domains: {s.topDomains.map((d) => `${d.domain} ${pct(d.share)}`).join(', ')}</li>
          </>
        ) : null}
        <li>
          Lens yield: {a.lenses.length === 0 ? 'no data' : null}
          {a.lenses.length > 0 ? (
            <ul>
              {a.lenses.map((l) => (
                <li key={l.lensId}>
                  {l.lensId}: {l.ideas} ideas, {l.screenedIn} reached the gate, {l.advanced} advanced, {l.cases} cases
                </li>
              ))}
            </ul>
          ) : null}
        </li>
        <li>Gate kills by check: {Object.keys(a.gateKills).length === 0 ? 'no data' : counts(a.gateKills)}</li>
        <li>Ideas dropped by ideate: {Object.keys(a.dropReasons).length === 0 ? 'none recorded' : counts(a.dropReasons)}</li>
        <li>Ideas resting on a trend, rule change or market: {a.demandShare === null ? 'no data' : pct(a.demandShare)}</li>
        <li>
          Niche share (idea reviewer): {a.nicheShare === null ? 'no data' : pct(a.nicheShare)} <HelpTip term="nicheShare" />
        </li>
      </ul>
      <div className="label-row">
        <h4>Audit flags</h4>
        <HelpTip term="auditFlags" />
      </div>
      {a.flags.length === 0 ? (
        <p className="muted small">None.</p>
      ) : (
        <ul data-testid="audit-flags">
          {a.flags.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      <div className="label-row">
        <h4>Holdout examples</h4>
        <HelpTip term="holdoutExamples" />
      </div>
      {view.holdoutItems === 0 ? (
        <p className="muted small">None set. Add some on the Settings page.</p>
      ) : !holdout || holdout.items.length === 0 ? (
        <p className="muted small">{view.holdoutItems} set. No comparison for this pass yet: run npm run gen -- bench report.</p>
      ) : (
        <>
          <p className="small">Median similarity: {holdout.median === null ? 'no data' : holdout.median.toFixed(2)}</p>
          <ul className="small" data-testid="holdout-results">
            {holdout.items.map((i, n) => (
              <li key={n}>
                {i.text.length > 120 ? `${i.text.slice(0, 120)}…` : i.text}: closest idea {i.bestIdeaTitle} ({i.similarity.toFixed(2)})
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
