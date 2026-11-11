import type { RunTournament } from '@bcg/core/dashboard/runs';
import { HelpTip } from './help-tip';

const OPERATOR_LABEL: Record<string, string> = { sharpen: 'sharpened', combine: 'combined', simplify: 'simplified' };

/** A run's tournament: the top sketches by Elo with cell, parent and variants. Everything is rendered as text (R13). */
export function TournamentView({ runId, t }: { runId: string; t: RunTournament }) {
  const listed = new Set(t.top.map((s) => s.id));
  const link = (id: string, title: string) => (listed.has(id) ? <a href={`#sketch-${id}`}>{title}</a> : <>{title}</>);
  return (
    <section data-testid="tournament" aria-label="Tournament">
      <p className="muted small">
        <HelpTip term="tournament" /> {t.total} sketches · {t.dropped} dropped as repeats
        {t.uniqueShare !== null ? ` · unique share ${Math.round(t.uniqueShare * 100)}%` : ''}
        {t.cells !== null ? ` · ${t.cells} cells` : ''}
        {t.fallback ? ` · fell back to ${t.fallback} ideation` : ''}
      </p>
      {t.top.length === 0 ? (
        <p className="muted small">No ranked sketches yet.</p>
      ) : (
        <div className="scroll-x">
          <table className="stacked">
            <thead>
              <tr>
                <th scope="col">Sketch</th>
                <th scope="col">Elo</th>
                <th scope="col">Cell</th>
                <th scope="col">Parent</th>
                <th scope="col">Variants</th>
              </tr>
            </thead>
            <tbody>
              {t.top.map((s) => (
                <tr key={s.id} id={`sketch-${s.id}`} data-run={runId}>
                  <td data-label="Sketch">{s.title}</td>
                  <td data-label="Elo">{s.elo === null ? '–' : Math.round(s.elo)}</td>
                  <td data-label="Cell">{s.cell ?? '–'}</td>
                  <td data-label="Parent">
                    {s.parent ? (
                      <>
                        {s.operator ? `${OPERATOR_LABEL[s.operator] ?? s.operator} from ` : ''}
                        {link(s.parent.id, s.parent.title)}
                      </>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td data-label="Variants">
                    {s.variants.length === 0 ? (
                      '–'
                    ) : (
                      <ul className="plain">
                        {s.variants.map((v) => (
                          <li key={v.id}>{link(v.id, v.title)}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
