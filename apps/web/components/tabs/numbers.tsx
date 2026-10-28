import { listInputs } from '@bcg/core/calc/inputs';
import { money } from '@bcg/core/case/export-markdown';
import { cleanQuote, inputStatus, linkFlags, type LinkFlags } from '@bcg/core/case/review';
import type { CaseView } from '@bcg/core/dashboard/case-view';
import { ExternalLink } from '../external-link';
import { StatusChip } from '../status-chip';

const orNone = (x: number | null, fmt: (n: number) => string) => (x === null ? 'n/a' : fmt(x));

/** Key results, formulas, the inputs (source + quote + status, or the assumption) and the scenarios. */
export function NumbersTab({ view, flags = linkFlags(view.claims) }: { view: CaseView; flags?: LinkFlags }) {
  const { inputs, results: r } = view.case.sections.numbers;
  const results: [string, string][] = [
    ['Annual price per buyer', money(r.buyer.annualPrice)],
    ['Annual problem cost per buyer', money(r.buyer.annualProblemCost)],
    ['Annual savings per buyer', money(r.buyer.annualSavings)],
    ['ROI multiple', orNone(r.buyer.roiMultiple, (n) => `${n}×`)],
    ['Payback', orNone(r.buyer.paybackMonths, (n) => `${n} months`)],
    ['Annual revenue potential', money(r.market.annualRevenuePotential)],
    ['Year 1 revenue', money(r.market.year1Revenue)],
    ['Gross margin', orNone(r.unit.grossMarginPct, (n) => `${n}%`)],
    ['Breakeven buyers', r.breakevenBuyers === null ? `none (${r.breakevenReason ?? 'unknown'})` : String(r.breakevenBuyers)],
  ];
  // Business-model rows appear only on cases that have them; older cases render exactly as before.
  const model = inputs.businessModel ?? inputs.revenue?.model;
  if (model) results.unshift(['Business model', model]);
  if (r.revenueFormula) results.splice(1, 0, ['Revenue formula', r.revenueFormula]);
  if (r.buyer.valueMultiple !== undefined) {
    results.splice(results.findIndex(([l]) => l === 'ROI multiple') + 1, 0, ['Value multiple', orNone(r.buyer.valueMultiple, (n) => `${n}×`)]);
  }
  return (
    <div className="tab tab-numbers">
      <h2>Key results</h2>
      <dl className="results">
        {results.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <h2>Formulas</h2>
      <ul className="formulas">
        {r.formulas.map((f, i) => (
          <li key={i}>{f}</li>
        ))}
      </ul>

      <h2>Inputs</h2>
      <div className="scroll-x">
        <table data-testid="inputs">
          <thead>
            <tr>
              <th scope="col">Input</th>
              <th scope="col">Value</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {listInputs(inputs).map(({ label, sourced }) => {
              const status = inputStatus(flags, label, sourced.value);
              return (
                <tr key={label}>
                  <td>{label}</td>
                  <td>{sourced.value}</td>
                  <td>
                    {sourced.source ? (
                      <>
                        <ExternalLink url={sourced.source.url} />: “{cleanQuote(sourced.source.quote)}”{' '}
                        {status ? <StatusChip status={status} /> : null}
                      </>
                    ) : (
                      <>assumption: {sourced.assumption ?? ''}</>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2>Scenarios</h2>
      <div className="scroll-x">
        <table data-testid="scenarios">
          <thead>
            <tr>
              <th scope="col">Buyers</th>
              <th scope="col">MRR</th>
              <th scope="col">ARR</th>
              <th scope="col">Monthly gross profit</th>
              <th scope="col">Monthly net</th>
            </tr>
          </thead>
          <tbody>
            {r.scenarios.map((s, i) => (
              <tr key={i}>
                <td>{s.buyers}</td>
                <td>{money(s.mrr)}</td>
                <td>{money(s.arr)}</td>
                <td>{money(s.monthlyGrossProfit)}</td>
                <td>{money(s.monthlyNet)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
