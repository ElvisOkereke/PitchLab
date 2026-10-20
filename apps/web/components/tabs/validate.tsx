import type { CaseView } from '@bcg/core/dashboard/case-view';
import { PROSPECTS_PAGE_MAX, type ProspectRow, type ValidateView } from '@bcg/core/dashboard/validate-view';
import { LandingCopySchema, PackSectionsSchema, type PackDocs } from '@bcg/core/validation/schema';
import Link from 'next/link';
import { caseHref } from '@/lib/case-query';
import { formatDateTime } from '@/lib/time';
import { ExternalLink } from '../external-link';
import { MarkOutreachForm } from '../mark-outreach-form';
import { TextBlock } from '../text-block';

const CASL: Record<ProspectRow['caslBasis'], { cls: string; label: string }> = {
  self_published: { cls: 'badge-ok', label: 'self-published' },
  third_party: { cls: 'badge-warn', label: 'third-party' },
  unknown: { cls: 'badge-bad', label: 'unknown — do not email' },
};
const KIND_LABEL: Record<string, string> = { cold: 'Cold email', followup1: 'Follow-up 1', followup2: 'Follow-up 2' };
const EVENT_TYPES = ['sent', 'replied', 'positive', 'meeting', 'not_interested', 'unsubscribe', 'note'] as const;

function List({ items }: { items: string[] }) {
  return (
    <ul>
      {items.map((s, i) => (
        <li key={i} className="pre">
          {s}
        </li>
      ))}
    </ul>
  );
}

/** MVP spec, pilot plan and interview kit as text. */
function PackDocuments({ docs }: { docs: PackDocs }) {
  const { mvpSpec: m, pilotPlan: p, interviewKit: k } = docs;
  return (
    <>
      {docs.reviewNotes?.length ? (
        <div className="banner banner-warn" role="note">
          <strong>Review notes:</strong>
          <List items={docs.reviewNotes} />
        </div>
      ) : null}
      <details className="pack-doc" open>
        <summary>
          <h3>MVP spec</h3>
        </summary>
        <TextBlock text={m.summary} />
        <h4>Features</h4>
        <ul>
          {m.features.map((f, i) => (
            <li key={i}>
              <strong>{f.name}</strong>: <span className="pre">{f.why}</span>
              {f.manualAtFirst ? <> <span className="badge badge-info">manual at first</span></> : null}
            </li>
          ))}
        </ul>
        <h4>Architecture</h4>
        <TextBlock text={m.architectureSketch} />
        <h4>Build estimate</h4>
        <p>
          {m.buildEstimate.lowDays}–{m.buildEstimate.highDays} days
        </p>
        <List items={m.buildEstimate.assumptions} />
        <h4>Fake or manual first</h4>
        <List items={m.fakeOrManualFirst} />
        <h4>Risks</h4>
        <List items={m.risks} />
        <h4>Packaging</h4>
        <TextBlock text={m.packaging} />
      </details>
      <details className="pack-doc">
        <summary>
          <h3>Pilot plan</h3>
        </summary>
        <h4>Ideal pilot customer</h4>
        <TextBlock text={p.idealPilotCustomer} />
        <h4>First step</h4>
        <TextBlock text={p.firstStep} />
        <h4>Steps</h4>
        <ol>
          {p.steps.map((s, i) => (
            <li key={i} className="pre">
              {s}
            </li>
          ))}
        </ol>
        <h4>Measures</h4>
        <ul>
          {p.measures.map((x, i) => (
            <li key={i}>
              {x.metric}: {x.successThreshold}
            </li>
          ))}
        </ul>
        <p>Timeline: {p.timelineWeeks} weeks</p>
        <h4>Permissions and risks</h4>
        <List items={p.permissionsAndRisks} />
      </details>
      <details className="pack-doc">
        <summary>
          <h3>Interview kit</h3>
        </summary>
        <h4>Who to talk to</h4>
        <List items={k.targetRoles} />
        <h4>Where to find them</h4>
        <List items={k.whereToFind} />
        <h4>Opening</h4>
        <TextBlock text={k.opening} />
        <h4>Questions</h4>
        <ol>
          {k.questions.map((q, i) => (
            <li key={i}>
              <strong>{q.question}</strong>
              <br />
              <span className="muted">Why ask:</span> {q.whyAsk}
              <br />
              <span className="muted">Listen for:</span> {q.listenFor}
            </li>
          ))}
        </ol>
        <h4>Red flags</h4>
        <List items={k.redFlags} />
      </details>
    </>
  );
}

/** Landing page summary: copy as text, published URL, size. The page HTML is never rendered or framed. */
function LandingSummary({ landing }: { landing: NonNullable<ValidateView['landing']> }) {
  const copy = LandingCopySchema.safeParse(landing.copy);
  return (
    <section data-testid="landing" aria-labelledby="landing-title">
      <h2 id="landing-title">Landing page</h2>
      <p>
        {landing.publishedUrl ? (
          <>
            Published at <ExternalLink url={landing.publishedUrl}>{landing.publishedUrl}</ExternalLink>
          </>
        ) : (
          'Not published.'
        )}{' '}
        · {(landing.htmlBytes / 1024).toFixed(1)} KB · updated {formatDateTime(landing.updatedAt)}
      </p>
      {copy.success ? (
        <dl className="fields">
          {(
            [
              ['Headline', copy.data.headline],
              ['Subhead', copy.data.subhead],
              ['Who it is for', copy.data.whoItsFor],
              ['Problem', copy.data.problem],
              ['Offer', copy.data.offer],
              ['Call to action', copy.data.ctaLabel],
            ] as const
          ).map(([label, text]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                <TextBlock text={text} />
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="muted">The landing copy could not be read.</p>
      )}
    </section>
  );
}

/** The Validate tab: pack documents, checklist, outreach tracking, prospects (100 per page) and the landing summary. */
export function ValidateTab({ view, validate, page }: { view: CaseView; validate: ValidateView; page: number }) {
  const slug = view.case.slug;
  if (!validate.pack) {
    return (
      <div className="tab tab-validate">
        <p className="card">Validation pack not generated yet. Run: npm run gen -- validate {slug}</p>
      </div>
    );
  }
  const docs = PackSectionsSchema.safeParse(validate.pack.sections);
  const { rows, total } = validate.prospects;
  const pages = Math.max(1, Math.ceil(total / PROSPECTS_PAGE_MAX));
  const names = new Map(rows.map((p) => [p.id, p.name]));
  const c = validate.counts;

  return (
    <div className="tab tab-validate">
      <h2>Validation pack</h2>
      <p className="muted small">
        Generated {formatDateTime(validate.pack.updatedAt)} · {validate.pack.model}
      </p>
      {docs.success ? <PackDocuments docs={docs.data} /> : <p className="muted">The pack documents could not be read.</p>}

      <h2>Checklist</h2>
      {validate.checklist && validate.checklist.length > 0 ? (
        <ul className="plain stack" data-testid="checklist">
          {validate.checklist.map((g) => (
            <li key={g.id}>
              <span className={`badge ${g.state === 'pass' ? 'badge-ok' : 'badge-muted'}`}>{g.state}</span> {g.description}{' '}
              <span className="muted">
                ({g.value === null ? '–' : g.value} / {g.threshold})
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No checklist.</p>
      )}

      <h2>Outreach</h2>
      <p data-testid="outreach-counts">
        {c.prospects} prospects · {c.withEmail} with email ·{' '}
        {EVENT_TYPES.filter((t) => t !== 'note').map((t, i) => (
          <span key={t}>
            {i > 0 ? ' · ' : ''}
            {t.replace('_', ' ')}: {c.events[t]?.prospects ?? 0}
          </span>
        ))}
      </p>

      <h2>Prospects</h2>
      {rows.length === 0 ? <p className="muted">No prospects on this page.</p> : null}
      {rows.length > 0 ? (
        <div className="scroll-x">
          <table className="stacked" data-testid="prospects">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Website</th>
                <th scope="col">Location</th>
                <th scope="col">Email</th>
                <th scope="col">CASL basis</th>
                <th scope="col">Status</th>
                <th scope="col">Fit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td data-label="Name">
                    <strong>{p.name}</strong>
                  </td>
                  <td data-label="Website">
                    <ExternalLink url={p.website} />
                  </td>
                  <td data-label="Location">{p.location}</td>
                  <td data-label="Email">{p.email ?? <span className="muted">no email</span>}</td>
                  <td data-label="CASL basis">
                    <span className={`badge ${CASL[p.caslBasis].cls}`}>{CASL[p.caslBasis].label}</span>
                  </td>
                  <td data-label="Status">{p.status.replace('_', ' ')}</td>
                  <td data-label="Fit" className="pre">
                    {p.fitReason}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {pages > 1 ? (
        <nav className="pager" aria-label="Prospect pages" data-testid="prospects-pager">
          {page > 1 ? <Link href={caseHref(slug, 'validate', page - 1)}>← Previous</Link> : null}
          <span>
            Page {page} of {pages}
          </span>
          {page < pages ? <Link href={caseHref(slug, 'validate', page + 1)}>Next →</Link> : null}
        </nav>
      ) : null}

      {rows.length > 0 ? (
        <>
          <h2>Drafts and tracking</h2>
          <div className="stack">
            {rows.map((p) => (
              <details key={p.id} className="card" data-testid="prospect-drafts">
                <summary>
                  {p.name} · {p.status.replace('_', ' ')}
                </summary>
                {(validate.drafts.get(p.id) ?? []).map((d) => (
                  <article key={d.id} className="email">
                    <h4>
                      {KIND_LABEL[d.kind] ?? d.kind}: {d.subject}
                    </h4>
                    <TextBlock text={d.body} />
                  </article>
                ))}
                {(validate.drafts.get(p.id) ?? []).length === 0 ? <p className="muted">No drafts.</p> : null}
                <MarkOutreachForm prospectId={p.id} slug={slug} />
              </details>
            ))}
          </div>
        </>
      ) : null}

      <h2>Recent events</h2>
      {validate.events.length === 0 ? <p className="muted">No outreach recorded yet.</p> : null}
      <ul className="plain stack" data-testid="events">
        {validate.events.map((e) => (
          <li key={e.id}>
            {formatDateTime(e.at)} · {e.type.replace('_', ' ')} · {names.get(e.prospectId) ?? 'a prospect on another page'}
            {e.note ? <span className="pre"> · {e.note}</span> : null}
          </li>
        ))}
      </ul>

      {validate.landing ? <LandingSummary landing={validate.landing} /> : null}
    </div>
  );
}
