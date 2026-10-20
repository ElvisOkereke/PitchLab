import type { CaseView } from '@bcg/core/dashboard/case-view';
import Link from 'next/link';
import { CASE_NOTICES, CASE_TABS, CASE_TAB_LABEL, caseHref, type CaseNotice, type CaseTab } from '@/lib/case-query';
import { STAGE_LABEL } from '@/lib/stages';
import { StageMoveForm } from './stage-move-form';

/**
 * Top of the case page: title, stage chip, stage-move form (and "Overturn kill" when killed), kill reason, gate-flag
 * banner, export link and the tab links. Both forms return to this tab (`returnTo`). Legacy sections without
 * `gateFlags` still render.
 */
export function CaseHeader({ view, tab, notice }: { view: CaseView; tab: CaseTab; notice?: CaseNotice }) {
  const c = view.case;
  const gateFlags: string[] = Array.isArray(c.sections?.summary?.gateFlags) ? c.sections.summary.gateFlags : [];
  return (
    <header className="case-header">
      <p className="crumbs">
        <Link href="/">← Board</Link>
      </p>
      <h1>{c.title}</h1>
      {notice ? (
        <p className="notice card" role="status">
          {CASE_NOTICES[notice]}
        </p>
      ) : null}
      <div className="case-meta">
        <span className={`stage-chip stage-${c.stage}`}>{STAGE_LABEL[c.stage]}</span>
        <a href={`${caseHref(c.slug)}/export.md`} className="button secondary" download>
          Export Markdown
        </a>
      </div>
      {c.stage === 'killed' && c.killReason ? (
        <p className="kill-reason card">
          <strong>Kill reason:</strong> <span className="pre">{c.killReason}</span>
        </p>
      ) : null}
      {gateFlags.length > 0 ? (
        <p className="banner banner-warn" role="note">
          ⚠️ Gate flags: {gateFlags.join(', ')}
        </p>
      ) : null}
      <section className="case-move card" aria-label="Move stage">
        <StageMoveForm caseId={c.id} slug={c.slug} stage={c.stage} returnTo={caseHref(c.slug, tab)} />
      </section>
      <nav aria-label="Case sections" className="tabs">
        {CASE_TABS.map((t) => (
          <Link key={t} href={caseHref(c.slug, t)} className="tab-link" aria-current={t === tab ? 'page' : undefined}>
            {CASE_TAB_LABEL[t]}
          </Link>
        ))}
      </nav>
    </header>
  );
}
