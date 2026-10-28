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
  // Business-model rows appear only on cases that have them; older cases render exactly as before.
  const model = inputs.businessModel ?? inputs.revenue?.model;
  const perUser = model === 'ads' || model === 'freemium';
  const hasValue = r.buyer.valueMultiple !== undefined;
  const results: [string, string][] = [
    ...(model ? ([['Business model', model]] as [string, string][]) : []),
    ...(r.revenueFormula ? ([['Revenue formula', r.revenueFormula]] as [string, string][]) : []),
    [perUser ? 'Annual revenue per user' : 'Annual price per buyer', money(r.buyer.annualPrice)],
    ...(hasValue
      ? ([['Annual value to the user', money(r.buyer.annualSavings)]] as [string, string][])
      : ([
          ['Annual problem cost per buyer', money(r.buyer.annualProblemCost)],
          ['Annual savings per buyer', money(r.buyer.annualSavings)],
        ] as [string, string][])),
    ['ROI multiple', r.buyer.roiNote ? `n/a (${r.buyer.roiNote})` : orNone(r.buyer.roiMultiple, (n) => `${n}×`)],
    ...(hasValue
      ? ([[
          'Value multiple',
          r.buyer.valueMultiple === null
            ? `n/a${r.buyer.valueMultipleNote ? ` (${r.buyer.valueMultipleNote})` : ''}`
            : `${r.buyer.valueMultiple}×`,
        ]] as [string, string][])
      : []),
    ['Payback', r.buyer.roiNote ? `n/a (${r.buyer.roiNote})` : orNone(r.buyer.paybackMonths, (n) => `${n} months`)],
    ['Annual revenue potential', money(r.market.annualRevenuePotential)],
    ['Year 1 revenue', money(r.market.year1Revenue)],
    ...(r.buyer.setupFeePerBuyer !== undefined
      ? ([['Setup fee per buyer (year 1 only)', money(r.buyer.setupFeePerBuyer)]] as [string, string][])
      : []),
    ['Gross margin', orNone(r.unit.grossMarginPct, (n) => `${n}%`)],
    [perUser ? 'Breakeven users' : 'Breakeven buyers', r.breakevenBuyers === null ? `none (${r.breakevenReason ?? 'unknown'})` : String(r.breakevenBuyers)],
  ];
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
                  <td>{inputs.revenue && label.startsWith('price.') ? `${label} (not used for revenue)` : label}</td>
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
              <th scope="col">{perUser ? 'Users' : 'Buyers'}</th>
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
