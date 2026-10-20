import { DEFAULT_MODELS, MODEL_STAGES } from '@bcg/core/config/models';
import { CRITERION_LABEL, OWNER_CRITERIA } from '@bcg/core/dashboard/criteria';
import type { MarketSummary } from '@bcg/core/dashboard/markets';
import { EDITABLE_SETTING_KEYS, type EditableSettingKey, type WorkerStatus } from '@bcg/core/dashboard/settings';
import { SETTING_FIELDS } from '@/lib/settings-labels';
import { formatDateTime } from '@/lib/time';
import { SettingsForm } from './settings-form';

export type SettingsData = {
  values: Record<EditableSettingKey, string>;
  worker: WorkerStatus | null;
  database: boolean;
  lenses: { id: string; name: string }[];
  market: MarketSummary | null;
};

const PROVIDERS: [keyof WorkerStatus['providers'], string][] = [
  ['llm', 'LLM API'],
  ['github', 'GitHub'],
  ['stackexchange', 'Stack Exchange'],
  ['places', 'Google Places'],
];

function Badge({ ok, yes, no }: { ok: boolean | null; yes: string; no: string }) {
  if (ok === null) return <span className="badge badge-muted">unknown (worker not seen)</span>;
  return <span className={`badge ${ok ? 'badge-ok' : 'badge-warn'}`}>{ok ? yes : no}</span>;
}

/**
 * Settings: the editable sender/landing form, then read-only connections (booleans only, never values or URLs),
 * models per stage, lenses and market names, and the scoring criteria.
 */
export function SettingsView({ data }: { data: SettingsData }) {
  const fields = EDITABLE_SETTING_KEYS.map((k) => ({ key: k, ...SETTING_FIELDS[k], value: data.values[k] ?? '' }));
  const models = data.worker?.models ?? DEFAULT_MODELS;
  return (
    <main className="settings-page">
      <h1>Settings</h1>

      <section aria-labelledby="sender-title" className="card">
        <h2 id="sender-title">Sender and landing page</h2>
        <SettingsForm fields={fields} />
      </section>

      <section aria-labelledby="connections-title" className="card" data-testid="connections">
        <h2 id="connections-title">Connections</h2>
        <ul className="plain stack">
          {PROVIDERS.map(([k, label]) => (
            <li key={k}>
              <span className="name">{label}</span> <Badge ok={data.worker ? data.worker.providers[k] : null} yes="connected" no="not set" />
            </li>
          ))}
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
