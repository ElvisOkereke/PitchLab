import { competitorChecks, linkFlags, type LinkFlags } from '@bcg/core/case/review';
import type { CaseView } from '@bcg/core/dashboard/case-view';
import { ExternalLink } from '../external-link';
import { CheckChip } from '../status-chip';

/**
 * Competitors with their product and pricing checks, then the levels. One table: on wide screens a table, on narrow
 * ones (CSS, `.stacked`) each row becomes a card whose cells are labelled by `data-label`.
 */
export function CompetitorsTab({ view, flags = linkFlags(view.claims) }: { view: CaseView; flags?: LinkFlags }) {
  const { list, levels } = view.case.sections.competitors;
  return (
    <div className="tab tab-competitors">
      <h2>Competitors</h2>
      {list.length === 0 ? <p className="muted">No competitors listed.</p> : null}
      <div className="scroll-x">
        <table className="stacked" data-testid="competitors">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Link</th>
              <th scope="col">Pricing</th>
              <th scope="col">Gap</th>
              <th scope="col">Product</th>
              <th scope="col">Pricing check</th>
            </tr>
          </thead>
          <tbody>
            {list.map((x, i) => {
              const checks = competitorChecks(flags, x);
              return (
                <tr key={`${i}-${x.name}`}>
                  <td data-label="Name">
                    <strong>{x.name}</strong>
                  </td>
                  <td data-label="Link">
                    <ExternalLink url={x.url} />
                  </td>
                  <td data-label="Pricing">{x.pricing}</td>
                  <td data-label="Gap">{x.gap}</td>
                  <td data-label="Product">
                    <CheckChip cell={checks.product} />
                  </td>
                  <td data-label="Pricing check">
                    <CheckChip cell={checks.pricing} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2>Levels</h2>
      <div className="scroll-x">
        <table className="stacked" data-testid="levels">
          <thead>
            <tr>
              <th scope="col">Level</th>
              <th scope="col">What it checks</th>
              <th scope="col">Limitation</th>
            </tr>
          </thead>
          <tbody>
            {levels.map((l, i) => (
              <tr key={i}>
                <td data-label="Level">{l.level}</td>
                <td data-label="What it checks">{l.whatItChecks}</td>
                <td data-label="Limitation">{l.limitation}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
