import { DEFAULT_MODELS, MODEL_STAGES } from '@bcg/core/config/models';
import { CRITERION_LABEL, OWNER_CRITERIA } from '@bcg/core/dashboard/criteria';
import type { MarketSummary } from '@bcg/core/dashboard/markets';
import type { ResearchSettings } from '@bcg/core/dashboard/missions';
import { EDITABLE_SETTING_KEYS, type EditableSettingKey, type WorkerStatus } from '@bcg/core/dashboard/settings';
import { SETTING_FIELDS } from '@/lib/settings-labels';
import { formatDateTime } from '@/lib/time';
import { SETTINGS_NOTICES, type SettingsNotice } from '@/lib/settings-query';
import { ExampleSettings } from './example-settings';
import { HelpTip } from './help-tip';
import { ResearchSettingsForm } from './research-settings-form';
import { SettingsForm } from './settings-form';

export type SettingsData = {
  values: Record<EditableSettingKey, string>;
  worker: WorkerStatus | null;
  database: boolean;
  lenses: { id: string; name: string }[];
  market: MarketSummary | null;
  example: { hidden: boolean };
  research: ResearchSettings;
};

const PROVIDERS: [keyof WorkerStatus['providers'], string, [string, string]?][] = [
  ['llm', 'LLM API'],
  ['github', 'GitHub'],
  ['stackexchange', 'Stack Exchange'],
  ['places', 'Google Places'],
  ['producthunt', 'Product Hunt'],
  ['youtube', 'YouTube'],
  ['browser', 'Local browser (Chromium)', ['installed', 'not installed']],
];

const HINT_ID: Partial<Record<keyof WorkerStatus['providers'], string>> = { youtube: 'conn-youtube', browser: 'conn-browser' };
const HINT: Partial<Record<keyof WorkerStatus['providers'], string>> = {
  youtube: 'Optional. Add YOUTUBE_API_KEY to your .env file, then restart npm run worker.',
  browser: 'Optional, for pages that need JavaScript. Install it with npx playwright install chromium, run in packages/core.',
};

function Badge({ ok, yes, no }: { ok: boolean | null; yes: string; no: string }) {
  if (ok === null) return <span className="badge badge-muted">unknown (worker not seen)</span>;
  return <span className={`badge ${ok ? 'badge-ok' : 'badge-warn'}`}>{ok ? yes : no}</span>;
}

/**
 * Settings: the editable sender/landing form, then read-only connections (booleans only, never values or URLs),
 * models per stage, lenses and market names, and the scoring criteria.
 */
export function SettingsView({ data, notice }: { data: SettingsData; notice?: SettingsNotice }) {
  const fields = EDITABLE_SETTING_KEYS.map((k) => ({ key: k, ...SETTING_FIELDS[k], value: data.values[k] ?? '' }));
  const models = data.worker?.models ?? DEFAULT_MODELS;
  return (
    <main className="settings-page">
      <h1>Settings</h1>
      {notice ? (
        <p className="notice card" role="status">
          {SETTINGS_NOTICES[notice]}
        </p>
      ) : null}

      <section aria-labelledby="sender-title" className="card" data-tour="settings-sender">
        <h2 id="sender-title">Sender and landing page</h2>
        <SettingsForm fields={fields} />
      </section>

      <section aria-labelledby="research-title" className="card">
        <div className="label-row">
          <h2 id="research-title">Research</h2>
          <HelpTip term="library" />
        </div>
        <p className="muted small">
          Background research starts one small $1 mission at a time while the worker is running, until the daily cap is spent
          (the day ends at midnight in Toronto). It is off until you turn it on. Missions you start yourself on the Library page are not limited by it.
        </p>
        <ResearchSettingsForm background={data.research.background} dailyCapUsd={data.research.dailyCapUsd} />
      </section>

      <ExampleSettings hidden={data.example.hidden} />

      <section aria-labelledby="connections-title" className="card" data-testid="connections" data-tour="settings-connections">
        <h2 id="connections-title">Connections</h2>
        <ul className="plain stack">
          {PROVIDERS.map(([k, label, words]) => {
            const ok = data.worker ? data.worker.providers[k] : null;
            return (
              <li key={k} data-testid={HINT_ID[k]}>
                <span className="name">{label}</span> <Badge ok={ok} yes={words?.[0] ?? 'connected'} no={words?.[1] ?? 'not set'} />
                {ok === false && HINT[k] ? <span className="muted small"> {HINT[k]}</span> : null}
              </li>
            );
          })}
          <li>
            <span className="name">Database</span> <Badge ok={data.database} yes="connected" no="not reachable" />
          </li>
        </ul>
        <p className="muted small">
          {data.worker ? `As reported by the worker at ${formatDateTime(new Date(data.worker.at))}.` : 'Start npm run worker to see which providers it has.'}
        </p>
      </section>

      <section aria-labelledby="models-title" className="card" data-testid="models">
        <h2 id="models-title">Models per stage</h2>
        {data.worker ? null : <p className="muted">defaults (worker not seen)</p>}
        <div className="scroll-x">
          <table>
            <tbody>
              {MODEL_STAGES.map((s) => (
                <tr key={s}>
                  <th scope="row">{s}</th>
                  <td>{models[s] ?? '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="lenses-title" className="card" data-testid="lenses">
        <h2 id="lenses-title">Lenses and market</h2>
        <p>Market: {data.market?.name ?? 'not configured'}</p>
        <ul>
          {data.lenses.map((l) => (
            <li key={l.id}>{l.name}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="criteria-title" className="card">
        <h2 id="criteria-title">Scoring criteria</h2>
        <ul data-testid="criteria">
          {OWNER_CRITERIA.map((c) => (
            <li key={c}>{CRITERION_LABEL[c]}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
