import { CRITERION_LABEL, OWNER_CRITERIA } from '@bcg/core/dashboard/criteria';
import type { LeaderRow, LeaderSort } from '@bcg/core/dashboard/leaderboard';
import Link from 'next/link';
import { leaderHref } from '@/lib/leaderboard-query';
import { formatScore, STAGE_LABEL } from '@/lib/stages';
import { ExampleBadge } from './example-badge';

type Key = LeaderSort['key'];

/** The link a header sorts by: the current key flips direction; another key starts descending (title ascending). */
function sortLink(sort: LeaderSort, key: Key): string {
  const dir = sort.key === key ? (sort.dir === 'asc' ? 'desc' : 'asc') : key === 'title' ? 'asc' : 'desc';
  return leaderHref({ key, by: sort.by, dir });
}

const ariaSort = (sort: LeaderSort, key: Key) => (sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined);
const arrow = (sort: LeaderSort, key: Key) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');
const n = (v: number | undefined) => (v === undefined ? '–' : String(v));

function SortHeader({ sort, k, label }: { sort: LeaderSort; k: Key; label: string }) {
  return (
    <th scope="col" aria-sort={ariaSort(sort, k)}>
      <Link href={sortLink(sort, k)}>
        {label}
        {arrow(sort, k)}
      </Link>
    </th>
  );
}

/**
 * Every case with its totals and per-criterion `ai/owner` scores (gut: owner only). Headers sort (toggling direction,
 * keeping `by`); under each AI criterion an `AI | You` toggle picks whose score that column sorts by.
 */
export function LeaderboardTable({ rows, sort }: { rows: LeaderRow[]; sort: LeaderSort }) {
  return (
    <div className="scroll-x">
      <table className="leaderboard">
        <thead>
          <tr>
            <SortHeader sort={sort} k="title" label="Title" />
            <th scope="col">Stage</th>
            <SortHeader sort={sort} k="ai" label="AI" />
            <SortHeader sort={sort} k="owner" label="You" />
            {OWNER_CRITERIA.map((c) => (
              <th key={c} scope="col" data-criterion={c} aria-sort={ariaSort(sort, c)}>
                <Link href={sortLink(sort, c)}>
                  {CRITERION_LABEL[c]}
                  {arrow(sort, c)}
                </Link>
                {c === 'gut' ? null : (
                  <span className="by-toggle">
                    {(['ai', 'owner'] as const).map((by, i) => (
                      <span key={by}>
                        {i > 0 ? ' | ' : ''}
                        <Link href={leaderHref({ key: c, by, dir: sort.dir })} aria-current={sort.key === c && sort.by === by ? 'true' : undefined}>
                          {by === 'ai' ? 'AI' : 'You'}
                        </Link>
                      </span>
                    ))}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4 + OWNER_CRITERIA.length} className="muted">
                No cases yet.
              </td>
            </tr>
          ) : null}
          {rows.map((r) => (
            <tr key={r.slug} data-slug={r.slug}>
              <th scope="row">
                <Link href={`/cases/${encodeURIComponent(r.slug)}`}>{r.title}</Link>
                {r.isExample ? <> <ExampleBadge /></> : null}
              </th>
              <td>{STAGE_LABEL[r.stage]}</td>
              <td data-col="ai">{formatScore(r.aiTotal)}</td>
              <td data-col="owner">{formatScore(r.ownerTotal)}</td>
              {OWNER_CRITERIA.map((c) => (
                <td key={c} data-col={c}>
                  {c === 'gut' ? n(r.owner.gut) : `${n(r.ai[c])}/${n(r.owner[c])}`}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
