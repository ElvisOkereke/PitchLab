import type { MissionView, ResearchSettings } from '@bcg/core/dashboard/missions';
import type { LibraryCoverage, LibraryRow } from '@bcg/core/library/store';
import type { FetchStats } from '@bcg/core/research/fetch-log';
import Link from 'next/link';
import { LIBRARY_AGES, LIBRARY_AUDIENCES, LIBRARY_KINDS, LIBRARY_STATUSES, LIBRARY_VOICES, libraryHref, type LibraryQuery } from '@/lib/library-query';
import { outcomeLabel, VIA_LABEL } from '@/lib/fetch-labels';
import { formatDateTime, relativeTime, usd } from '@/lib/time';
import { AutoRefresh } from './auto-refresh';
import { HelpTip } from './help-tip';
import { LibraryItem, type LibraryItemDetail } from './library-item';
import { MissionForm } from './mission-form';

const PAGE_SIZE = 50;
const REFRESH_MS = 10_000;
// Library health targets (spec): independent-voice problem entries and country spread.
const TARGET_INDEPENDENT_SHARE = 0.6;
const TARGET_COUNTRIES = 10;

const STATUS_BADGE: Record<string, string> = { queued: 'badge-info', running: 'badge-info', succeeded: 'badge-ok', failed: 'badge-bad' };
const STATUS_LABEL: Record<string, string> = { active: 'Active', rejected: 'Rejected', all: 'All' };
const AGE_LABEL = (d: number) => (d === 365 ? 'Past year' : `Past ${d} days`);

export type LibraryViewProps = {
  query: LibraryQuery;
  rows: LibraryRow[];
  total: number;
  coverage: LibraryCoverage;
  fetches: FetchStats;
  item: LibraryItemDetail | null;
  missions: MissionView[];
  typicalCost: number | null;
  research: ResearchSettings;
  backgroundSpend: number;
  now: Date;
};

const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);
const tally = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k} ${v}`).join(' · ') || '–';

function Select({ id, name, label, value, options }: { id: string; name: string; label: string; value: string; options: { value: string; label: string }[] }) {
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <select id={id} name={name} defaultValue={value}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function Filters({ query, coverage }: { query: LibraryQuery; coverage: LibraryCoverage }) {
  const countries = [...new Set([...coverage.countries, ...(query.country ? [query.country] : [])])].sort();
  const sources = [...new Set([...Object.keys(coverage.bySourceType), ...(query.source ? [query.source] : [])])].sort();
  const any = (label: string) => ({ value: '', label });
  return (
    <form method="get" action="/library" className="library-filters" data-testid="library-filters">
      <div>
        <label htmlFor="lib-q">Search</label>
        <input id="lib-q" type="search" name="q" maxLength={100} defaultValue={query.q} placeholder="words in the title or summary" />
      </div>
      <Select id="lib-kind" name="kind" label="Kind" value={query.kind ?? ''} options={[any('Any kind'), ...LIBRARY_KINDS.map((k) => ({ value: k, label: k.replace('_', ' ') }))]} />
      <Select id="lib-audience" name="audience" label="Audience" value={query.audience ?? ''} options={[any('Any audience'), ...LIBRARY_AUDIENCES.map((a) => ({ value: a, label: a }))]} />
      <Select id="lib-country" name="country" label="Country" value={query.country ?? ''} options={[any('Any country'), ...countries.map((c) => ({ value: c, label: c }))]} />
      <Select id="lib-voice" name="voice" label="Voice" value={query.voice ?? ''} options={[any('Any voice'), ...LIBRARY_VOICES.map((v) => ({ value: v, label: v }))]} />
      <Select id="lib-source" name="source" label="Source" value={query.source ?? ''} options={[any('Any source'), ...sources.map((s) => ({ value: s, label: s }))]} />
      <Select id="lib-age" name="age" label="Age" value={query.age ? String(query.age) : ''} options={[any('Any age'), ...LIBRARY_AGES.map((a) => ({ value: String(a), label: AGE_LABEL(a) }))]} />
      <Select id="lib-status" name="status" label="Status" value={query.status} options={LIBRARY_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s]! }))} />
      <div className="library-filter-actions">
        <button type="submit" className="secondary">
          Search
        </button>
        <Link href="/library" className="button secondary">
          Clear
        </Link>
      </div>
    </form>
  );
}

function Results({ query, rows, total, now, empty }: { query: LibraryQuery; rows: LibraryRow[]; total: number; now: Date; empty: boolean }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const at = (page: number) => libraryHref({ ...query, page, item: undefined });
  return (
    <section aria-labelledby="entries-title" data-testid="library-results">
      <h2 id="entries-title">Entries</h2>
      {rows.length === 0 ? (
        <p className="muted">{empty ? 'The library is empty. Start a research mission below.' : 'No entries match these filters.'}</p>
      ) : (
        <>
          <p className="muted small">{total} {total === 1 ? 'entry' : 'entries'}</p>
          <ul className="plain library-list">
            {rows.map((r) => (
              <li key={r.id} className="card library-row">
                <p>
                  <span className="badge badge-info">{r.kind.replace('_', ' ')}</span>{' '}
                  <span className={`badge ${r.quoteVerified ? 'badge-ok' : 'badge-muted'}`}>{r.quoteVerified ? 'verified quote' : 'unverified'}</span>
                </p>
                <p>
                  <Link href={libraryHref({ ...query, item: r.id })}>
                    <strong>{r.title}</strong>
                  </Link>
                </p>
                <p>{r.summary}</p>
                <p className="muted small">
                  {r.voice ?? 'voice unknown'} · {r.countries.length > 0 ? r.countries.join(', ') : 'no country'} · {relativeTime(r.newestSourceAt ?? r.updatedAt, now)} ·{' '}
                  {r.sourceCount} {r.sourceCount === 1 ? 'source' : 'sources'}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
      {pages > 1 ? (
        <nav className="pager" aria-label="Library pages" data-testid="library-pager">
          {query.page > 1 ? <Link href={at(query.page - 1)}>← Newer</Link> : null}
          <span>
            Page {query.page} of {pages}
          </span>
          {query.page < pages ? <Link href={at(query.page + 1)}>Older →</Link> : null}
        </nav>
      ) : null}
    </section>
  );
}

function Coverage({ coverage }: { coverage: LibraryCoverage }) {
  const total = Object.values(coverage.byKind).reduce((a, b) => a + b, 0);
  const shareOk = coverage.problemIndependentShare !== null && coverage.problemIndependentShare >= TARGET_INDEPENDENT_SHARE;
  const countriesOk = coverage.countries.length >= TARGET_COUNTRIES;
  const badge = (ok: boolean) => <span className={`badge ${ok ? 'badge-ok' : 'badge-warn'}`}>{ok ? 'on target' : 'below target'}</span>;
  return (
    <section aria-labelledby="coverage-title" className="card" data-testid="library-coverage">
      <h2 id="coverage-title">Coverage</h2>
      <p>
        {total} {total === 1 ? 'entry' : 'entries'}
      </p>
      <ul className="plain stack">
        <li>
          Problem entries in operator or neutral voice: <strong>{pct(coverage.problemIndependentShare)}</strong> (target: 60% or more) {badge(shareOk)}
        </li>
        <li>
          Countries: <strong>{coverage.countries.length}</strong> (target: 10 or more) {badge(countriesOk)}
        </li>
        <li>Quotes verified: {pct(coverage.verifiedQuoteShare)}</li>
        <li>
          Social share: <strong>{pct(coverage.socialShare)}</strong> of sources come from community sites such as Hacker News, Stack Exchange, GitHub or YouTube
          <HelpTip term="socialShare" />
        </li>
        <li>By kind: {tally(coverage.byKind)}</li>
        <li>By source: {tally(coverage.bySourceType)}</li>
        <li>By voice: {tally(coverage.byVoice)}</li>
        <li>
          Newest {coverage.newest ? formatDateTime(coverage.newest) : '–'} · oldest {coverage.oldest ? formatDateTime(coverage.oldest) : '–'}
        </li>
      </ul>
    </section>
  );
}

const ofTotal = (ok: number, total: number) => (total === 0 ? '–' : `${ok} of ${total} (${Math.round((ok / total) * 100)}%)`);

/** How well page fetching has worked over the last 30 days: overall, by route, the outcomes, and the sites that fail most. */
function FetchDiagnostics({ fetches }: { fetches: FetchStats }) {
  const outcomes = Object.entries(fetches.byOutcome).filter(([k]) => k !== 'ok').sort((a, b) => b[1] - a[1]);
  return (
    <section aria-labelledby="fetch-title" className="card" data-testid="fetch-diagnostics">
      <div className="label-row">
        <h2 id="fetch-title">Page fetching, last 30 days</h2>
        <HelpTip term="fetchSuccess" />
      </div>
      {fetches.total === 0 ? (
        <p className="muted">No page fetches logged yet — they appear after your next mission.</p>
      ) : (
        <>
          <p>
            Pages read: <strong>{ofTotal(fetches.ok, fetches.total)}</strong>
          </p>
          <ul className="plain stack">
            {(Object.keys(VIA_LABEL) as (keyof FetchStats['byVia'])[]).map((v) => (
              <li key={v}>
                {VIA_LABEL[v]}: {ofTotal(fetches.byVia[v].ok, fetches.byVia[v].total)}
              </li>
            ))}
          </ul>
          {outcomes.length > 0 ? (
            <p className="muted small">What went wrong: {outcomes.map(([k, n]) => `${outcomeLabel(k)} ${n}`).join(' · ')}</p>
          ) : null}
          {fetches.topFailing.length > 0 ? (
            <div className="scroll-x" data-testid="fetch-failing">
              <table className="stacked">
                <thead>
                  <tr>
                    <th scope="col">Site</th>
                    <th scope="col">Failed fetches</th>
                    <th scope="col">Main reason</th>
                  </tr>
                </thead>
                <tbody>
                  {fetches.topFailing.map((r) => (
                    <tr key={r.domain}>
                      <td data-label="Site">{r.domain}</td>
                      <td data-label="Failed fetches">{r.failures}</td>
                      <td data-label="Main reason">{outcomeLabel(r.topOutcome)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function Missions({ missions, typicalCost, research, backgroundSpend }: Pick<LibraryViewProps, 'missions' | 'typicalCost' | 'research' | 'backgroundSpend'>) {
  const busy = missions.some((m) => m.status === 'queued' || m.status === 'running');
  return (
    <section aria-labelledby="missions-title" className="card" data-testid="library-missions" data-tour="library-missions" data-refreshing={busy ? 'true' : 'false'}>
      <h2 id="missions-title">Research missions</h2>
      <HelpTip term="researchMission" />
      <MissionForm typicalCost={typicalCost} />
      <p className="muted small">
        Missions run when <code>npm run worker</code> is running.{' '}
        {research.background ? (
          <>Background research is on: {usd(backgroundSpend)} of {usd(research.dailyCapUsd)} spent today.</>
        ) : (
          <>
            Background research is off (turn it on in <Link href="/settings">Settings</Link>).
          </>
        )}
        {busy ? ' This page refreshes every 10 s.' : ''}
      </p>
      {missions.length === 0 ? (
        <p className="muted">No missions yet.</p>
      ) : (
        <div className="scroll-x">
          <table className="stacked" data-testid="mission-list">
            <thead>
              <tr>
                <th scope="col">Started</th>
                <th scope="col">Topic</th>
                <th scope="col">Status</th>
                <th scope="col">Added</th>
                <th scope="col">Merged</th>
                <th scope="col">Cost</th>
                <th scope="col">Warnings</th>
                <th scope="col">Error</th>
              </tr>
            </thead>
            <tbody>
              {missions.map((m) => (
                <tr key={m.id}>
                  <td data-label="Started">{m.startedAt ? formatDateTime(m.startedAt) : 'not started'}</td>
                  <td data-label="Topic" className="pre">
                    {m.topic}
                  </td>
                  <td data-label="Status">
                    <span className={`badge ${STATUS_BADGE[m.status] ?? 'badge-muted'}`}>{m.status}</span>
                    {m.stalled ? <span className="badge badge-warn">stalled</span> : null}
                  </td>
                  <td data-label="Added">{m.itemsAdded}</td>
                  <td data-label="Merged">{m.itemsMerged}</td>
                  <td data-label="Cost">{m.status === 'queued' || m.status === 'running' ? 'pending' : usd(m.costUsd)}</td>
                  <td data-label="Warnings">
                    {m.warnings.length > 0 ? (
                      <details>
                        <summary>
                          {m.warnings.length} {m.warnings.length === 1 ? 'warning' : 'warnings'}
                        </summary>
                        <ul className="plain">
                          {m.warnings.map((w, i) => (
                            <li key={i} className="pre">
                              {w}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </td>
                  <td data-label="Error" className="pre">
                    {m.error ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {busy ? <AutoRefresh everyMs={REFRESH_MS} /> : null}
    </section>
  );
}

/** The Library: search and filter the stored research, read one entry, see coverage, and start research missions. */
export function LibraryView({ query, rows, total, coverage, fetches, item, missions, typicalCost, research, backgroundSpend, now }: LibraryViewProps) {
  const filtered = Boolean(query.q || query.kind || query.audience || query.country || query.voice || query.source || query.age || query.status !== 'active');
  return (
    <main className="library-page">
      <div className="label-row">
        <h1>Library</h1>
        <HelpTip term="library" />
      </div>
      <Filters query={query} coverage={coverage} />
      {item ? <LibraryItem item={item} query={query} /> : null}
      <Results query={query} rows={rows} total={total} now={now} empty={!filtered && total === 0} />
      <Coverage coverage={coverage} />
      <FetchDiagnostics fetches={fetches} />
      <Missions missions={missions} typicalCost={typicalCost} research={research} backgroundSpend={backgroundSpend} />
    </main>
  );
}
