import { strengthLabel } from '@bcg/core/library/strength';
import type { LibraryRow, SourceRow } from '@bcg/core/library/store';
import { rejectItemAction, restoreItemAction } from '@/actions/library';
import { libraryHref, type LibraryQuery } from '@/lib/library-query';
import { formatDate, formatDateTime } from '@/lib/time';
import { ExternalLink } from './external-link';

export type LibraryItemDetail = LibraryRow & { facts: unknown; sources: SourceRow[] };

/** "frequencyOrCost" as "frequency or cost". */
const humanize = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();

/** Facts that are lists of small records, shown one line each (all text). */
const LINE_FORMATS: Record<string, (r: Record<string, unknown>) => string> = {
  evidence: (r) => `${r.metric}: ${r.value} (${r.period})`,
  sizeClues: (r) => `${r.metric}: ${r.value} ${r.unit} (${r.year})`,
  growthClues: (r) => `${r.metric}: ${r.change} (${r.period})`,
};
const NEW_KIND_DATES = new Set(['effectiveDate', 'publishedDate']);

function factValue(v: unknown, key = ''): string {
  const line = LINE_FORMATS[key];
  if (line && Array.isArray(v)) {
    const lines = v.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object').map((r) => line(r));
    return lines.length > 0 ? lines.join('\n') : 'none';
  }
  if (v === null && NEW_KIND_DATES.has(key)) return 'not stated';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) return v.join('\n');
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x))) {
    const lines = Object.entries(v).filter(([, x]) => x !== null && x !== undefined).map(([k, x]) => `${humanize(k)}: ${typeof x === 'boolean' ? (x ? 'yes' : 'no') : String(x)}`);
    return lines.length > 0 ? lines.join('\n') : 'none';
  }
  return JSON.stringify(v);
}

/** The company dossier fields of a startup entry (shown apart from the older facts), in reading order. */
const DOSSIER_FIELDS = ['whoPays', 'pricingUnit', 'priceRange', 'revenueDrivers', 'acquisition', 'moat', 'useCases', 'whyItWorked', 'whyItDied', 'comps', 'funding', 'traction'] as const;
const DOSSIER_META = new Set<string>([...DOSSIER_FIELDS, 'dossierAt', 'dossierStatus']);

/** One entry in full: quote, sources, facts as a definition list, and Reject or Restore. All text is escaped. */
export function LibraryItem({ item, query }: { item: LibraryItemDetail; query: LibraryQuery }) {
  const facts = item.facts && typeof item.facts === 'object' && !Array.isArray(item.facts) ? Object.entries(item.facts as Record<string, unknown>) : [];
  const back = libraryHref(query);
  const record = item.facts && typeof item.facts === 'object' && !Array.isArray(item.facts) ? (item.facts as Record<string, unknown>) : {};
  const isStartup = item.kind === 'startup';
  const dossier = isStartup ? DOSSIER_FIELDS.filter((k) => record[k] !== undefined && record[k] !== null) : [];
  const dossierStatus = isStartup && typeof record.dossierStatus === 'string' ? record.dossierStatus : null;
  const dossierAt = isStartup && typeof record.dossierAt === 'string' && !Number.isNaN(Date.parse(record.dossierAt)) ? new Date(record.dossierAt) : null;
  const shown = isStartup ? facts.filter(([k]) => !DOSSIER_META.has(k)) : facts;
  return (
    <section aria-labelledby="item-title" className="card library-detail" data-testid="library-detail">
      <h2 id="item-title">{item.title}</h2>
      <p>
        <span className="badge badge-info">{item.kind.replace('_', ' ')}</span> {item.status === 'rejected' ? <span className="badge badge-bad">rejected</span> : null}
      </p>
      <p>{item.summary}</p>
      {item.assessment ? (
        <p data-testid="library-assessment">
          <span className="badge badge-info">{strengthLabel(item.assessment)}</span>{' '}
          <span className="muted small">
            {item.assessment.why}
            {item.assessment.bias ? ` (bias: ${item.assessment.bias})` : ''}
          </span>
        </p>
      ) : null}
      {item.quote ? (
        <blockquote className="pre">
          {item.quote}{' '}
          <span className={`badge ${item.quoteVerified ? 'badge-ok' : 'badge-muted'}`}>{item.quoteVerified ? 'verified quote' : 'unverified'}</span>
        </blockquote>
      ) : null}
      <h3>Sources</h3>
      <ul className="plain stack">
        {item.sources.map((s) => (
          <li key={s.id}>
            <ExternalLink url={s.url} />{' '}
            <span className="muted small">
              {s.sourceType} · {s.publishedAt ? `published ${formatDateTime(s.publishedAt)}` : `fetched ${formatDateTime(s.fetchedAt)}`}
              {s.via === 'archive' ? ` · from an archived copy (${formatDate(s.snapshotAt)})` : ''}
              {s.via === 'browser' ? ' · rendered in the local browser' : ''}
              {s.via === 'real_browser' ? ' · through the real browser' : ''}
              {s.via === 'scraper' ? ' · through the scraping service' : ''}
              {s.expiresAt ? ` · expires on ${formatDate(s.expiresAt)}` : ''}
            </span>
          </li>
        ))}
      </ul>
      {shown.length > 0 ? (
        <>
          <h3>Facts</h3>
          <dl className="facts">
            {shown.map(([k, v]) => (
              <div key={k}>
                <dt>{humanize(k)}</dt>
                <dd className="pre">{factValue(v, k)}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}
      {dossier.length > 0 || dossierStatus ? (
        <div data-testid="library-dossier">
          <h3>Company dossier</h3>
          <p className="muted small">
            {dossierStatus === 'unmatched'
              ? 'No page matched this company, so nothing was added.'
              : dossierStatus === 'failed'
                ? 'The last attempt failed; it will be tried again.'
                : 'Each field was checked against a quote on a fetched page.'}
            {dossierAt ? ` Last built ${formatDate(dossierAt)}.` : ''}
          </p>
          {dossier.length > 0 ? (
            <dl className="facts">
              {dossier.map((k) => (
                <div key={k}>
                  <dt>{humanize(k)}</dt>
                  <dd className="pre">{factValue(record[k], k)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : null}
      {item.status === 'rejected' ? (
        <form action={restoreItemAction} className="inline-form">
          <input type="hidden" name="id" value={item.id} />
          <input type="hidden" name="returnTo" value={back} />
          <button type="submit" className="secondary">
            Restore
          </button>
        </form>
      ) : (
        <form action={rejectItemAction} className="reject-form">
          <input type="hidden" name="id" value={item.id} />
          <input type="hidden" name="returnTo" value={back} />
          <label htmlFor="reject-reason">Reason (optional)</label>
          <input id="reject-reason" type="text" name="reason" maxLength={200} />
          <button type="submit" className="secondary">
            Reject
          </button>
        </form>
      )}
    </section>
  );
}
