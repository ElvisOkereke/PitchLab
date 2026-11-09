import type { TelegramStatus } from '@bcg/core/dashboard/telegram';
import { FINDS_SEED_DEFAULT, type FindRow } from '@bcg/core/finds/store';
import Link from 'next/link';
import { deleteFindAction, retryFindAction } from '@/actions/finds';
import { formatDateTime, relativeTime } from '@/lib/time';
import { AutoRefresh } from './auto-refresh';
import { FindsPasteForm } from './finds-paste-form';
import { FindsRunForm } from './finds-run-form';
import { HelpTip } from './help-tip';

const REFRESH_MS = 10_000;
const BADGE: Record<string, string> = { queued: 'badge-info', capturing: 'badge-info', done: 'badge-ok', failed: 'badge-bad' };
const num = (n: number) => n.toLocaleString('en-US');

function duration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Views, likes and length as one line ("12,345 views · 678 likes · 1:15"); empty when the platform showed none. */
function statsLine(stats: FindRow['stats']): string {
  if (!stats) return '';
  const parts: string[] = [];
  if (typeof stats.views === 'number') parts.push(`${num(stats.views)} views`);
  if (typeof stats.likes === 'number') parts.push(`${num(stats.likes)} likes`);
  if (typeof stats.durationSec === 'number') parts.push(duration(stats.durationSec));
  return parts.join(' · ');
}

function FindItem({ find, now }: { find: FindRow; now: Date }) {
  const stats = statsLine(find.stats);
  /** Names the find in the per-row button labels (its title, else its address). */
  const name = find.title ?? find.url;
  return (
    <li className="find-row" data-testid={`find-${find.id}`}>
      <div className="label-row">
        <span className={`badge ${BADGE[find.status] ?? ''}`}>{find.status}</span>
        <span>{find.platform}</span>
        <strong>{find.title ?? 'Untitled'}</strong>
      </div>
      {/* The address is text only, never a link: a shared page could be hostile. */}
      <p className="muted find-url">{find.url}</p>
      {find.note ? <p>Note: {find.note}</p> : null}
      {stats ? <p className="muted">{stats}</p> : null}
      {find.error ? <p role="alert" className="error">{find.error}</p> : null}
      {find.warnings.length > 0 ? <ul className="muted">{find.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul> : null}
      <p className="muted">
        Shared {relativeTime(find.createdAt, now)} by {find.source}
        {find.capturedAt ? `, captured ${formatDateTime(find.capturedAt)}` : ''}
      </p>
      <div className="row-actions">
        {find.status === 'done' && find.knowledgeItemId ? <Link href={`/library?item=${find.knowledgeItemId}`}>Open the library entry</Link> : null}
        {find.status === 'failed' ? (
          <form action={retryFindAction}>
            <input type="hidden" name="id" value={find.id} />
            <button type="submit" aria-label={`Retry ${name}`}>Retry</button>
          </form>
        ) : null}
        {find.status !== 'capturing' ? (
          <form action={deleteFindAction}>
            <input type="hidden" name="id" value={find.id} />
            <button type="submit" aria-label={`Delete ${name}`}>Delete</button>
          </form>
        ) : null}
      </div>
    </li>
  );
}

export type FindsViewProps = { finds: FindRow[]; telegram: TelegramStatus; now: Date };

/** How to connect the bot (no token on the worker), the pairing code while unpaired, nothing once paired. */
function TelegramHint({ telegram }: { telegram: TelegramStatus }) {
  if (!telegram.connected) return <p className="muted">Telegram is not connected yet. The steps to connect your bot are in docs/OWNER-TODO.md.</p>;
  if (telegram.paired) return null;
  return (
    <p className="muted" data-testid="telegram-hint">
      {telegram.pairingCode
        ? <>Your Telegram bot is not paired yet. Send <code>/start {telegram.pairingCode}</code> to it to pair it.</>
        : 'Your Telegram bot is not paired yet: restart npm run worker to get a pairing code (shown in Settings → Connections).'}
    </p>
  );
}

/**
 * The Finds page: paste links, see each one's capture status, and start a run from the captured ones. Everything is
 * rendered as text (R13).
 */
export function FindsView({ finds, telegram, now }: FindsViewProps) {
  const busy = finds.some((f) => f.status === 'queued' || f.status === 'capturing');
  const captured = finds.some((f) => f.status === 'done');
  return (
    <main className="library-page">
      <div className="label-row">
        <h1>Finds</h1>
        <HelpTip term="finds" />
        <HelpTip term="seenInTheWild" />
      </div>
      <p><Link href="/library">Back to the library</Link></p>
      <p>Share links to your Telegram bot or paste them here. PitchLab downloads each one, transcribes it, reads on-screen text and adds it to your library.</p>
      <TelegramHint telegram={telegram} />
      <FindsPasteForm />
      {captured ? <FindsRunForm count={FINDS_SEED_DEFAULT} /> : null}
      <h2>Your finds</h2>
      {finds.length === 0 ? <p className="muted">No finds yet.</p> : <ul className="find-list">{finds.map((f) => <FindItem key={f.id} find={f} now={now} />)}</ul>}
      {busy ? <AutoRefresh everyMs={REFRESH_MS} /> : null}
    </main>
  );
}
