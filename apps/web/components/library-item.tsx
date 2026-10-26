import type { LibraryRow, SourceRow } from '@bcg/core/library/store';
import { rejectItemAction, restoreItemAction } from '@/actions/library';
import { libraryHref, type LibraryQuery } from '@/lib/library-query';
import { formatDateTime } from '@/lib/time';
import { ExternalLink } from './external-link';

export type LibraryItemDetail = LibraryRow & { facts: unknown; sources: SourceRow[] };

/** "frequencyOrCost" as "frequency or cost". */
const humanize = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();

function factValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** One entry in full: quote, sources, facts as a definition list, and Reject or Restore. All text is escaped. */
export function LibraryItem({ item, query }: { item: LibraryItemDetail; query: LibraryQuery }) {
  const facts = item.facts && typeof item.facts === 'object' && !Array.isArray(item.facts) ? Object.entries(item.facts as Record<string, unknown>) : [];
  const back = libraryHref(query);
  return (
    <section aria-labelledby="item-title" className="card library-detail" data-testid="library-detail">
      <h2 id="item-title">{item.title}</h2>
      <p>
        <span className="badge badge-info">{item.kind.replace('_', ' ')}</span> {item.status === 'rejected' ? <span className="badge badge-bad">rejected</span> : null}
      </p>
      <p>{item.summary}</p>
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
            </span>
          </li>
        ))}
      </ul>
      {facts.length > 0 ? (
        <>
          <h3>Facts</h3>
          <dl className="facts">
            {facts.map(([k, v]) => (
              <div key={k}>
                <dt>{humanize(k)}</dt>
                <dd className="pre">{factValue(v)}</dd>
              </div>
            ))}
          </dl>
        </>
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
