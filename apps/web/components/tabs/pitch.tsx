import type { CaseView } from '@bcg/core/dashboard/case-view';
import { TextBlock } from '../text-block';

type Email = { subject: string; body: string };

function Emails({ heading, emails }: { heading: string; emails: Email[] }) {
  return (
    <>
      {emails.map((e, i) => (
        <article key={i} className="card email" data-testid="email">
          <h4>
            {heading} {i + 1}: {e.subject}
          </h4>
          <TextBlock text={e.body} />
        </article>
      ))}
    </>
  );
}

/**
 * Elevator pitch, the 3 emails and 2 follow-ups, call script, objections and pricing copy, all as text. A consumer pitch
 * has no emails (no cold email to individuals) and shows its channels and landing copy instead.
 */
export function PitchTab({ view }: { view: CaseView }) {
  const p = view.case.sections.pitch;
  return (
    <div className="tab tab-pitch">
      <h2>Elevator pitch</h2>
      <TextBlock text={p.elevator} />

      {p.emails.length > 0 ? (
        <>
          <h2>Emails</h2>
          <div className="stack">
            <Emails heading="Email" emails={p.emails} />
          </div>
        </>
      ) : null}

      {p.followUps.length > 0 ? (
        <>
          <h2>Follow-ups</h2>
          <div className="stack">
            <Emails heading="Follow-up" emails={p.followUps} />
          </div>
        </>
      ) : null}

      {p.channels?.length ? (
        <>
          <h2>Channels</h2>
          <ul className="objections">
            {p.channels.map((c, i) => (
              <li key={i}>
                <strong>{c.channel}</strong>: <span className="pre">{c.plan}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {p.landingCopy ? (
        <>
          <h2>Landing copy</h2>
          <TextBlock text={p.landingCopy} />
        </>
      ) : null}

      <h2>Call script</h2>
      <TextBlock text={p.callScript} />

      <h2>Objections</h2>
      <ul className="objections">
        {p.objections.map((o, i) => (
          <li key={i}>
            <strong>{o.objection}</strong>: <span className="pre">{o.response}</span>
          </li>
        ))}
      </ul>

      <h2>Pricing copy</h2>
      <TextBlock text={p.pricingCopy} />
    </div>
  );
}
