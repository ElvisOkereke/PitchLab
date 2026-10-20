import { and, eq, isNull, ne } from 'drizzle-orm';
import { cases, landingPages, prospects, validationPacks } from '../db/schema';
import { capField } from '../llm/untrusted';
import type { StageDeps } from '../pipeline/types';
import { discoverEmails } from './emails';
import { exportValidation, type ValidationExport } from './export';
import { generateLanding } from './landing';
import { generateDrafts } from './outreach';
import { generatePackDocs } from './pack-docs';
import { pilotSiteDomain, placesSource, prospectDomain, upsertProspects, webResearchSource, type ProspectSource } from './prospects';

export type ValidationDeps = Pick<StageDeps, 'db' | 'router' | 'fetchPage' | 'log'> & {
  /** Root of the validation export; files go to `<outDir>/<slug>/`. */
  outDir: string;
  /** Enables the Places source (GOOGLE_PLACES_API_KEY). */
  placesApiKey?: string;
  /** Injected fetch for the Places API (tests). */
  placesFetch?: typeof fetch;
};

export type ValidationOpts = {
  /** Most prospects to look for (default 25). */
  prospects?: number;
  skipProspects?: boolean;
  source?: 'web_research' | 'places';
  includeWeak?: boolean;
  pilotSite?: string;
  /** Regenerate the pack and landing page even when they exist (otherwise kept: no model call). */
  refresh?: boolean;
  /** Regenerate the outreach drafts of prospects that already have them (draft rows only; owner edits are replaced). */
  redraft?: boolean;
};

export const VALIDATION_STEPS = ['pack', 'prospects', 'emails', 'drafts', 'landing', 'export'] as const;
export type ValidationStep = (typeof VALIDATION_STEPS)[number];
export type StepResult = { step: ValidationStep; status: 'ok' | 'warning' | 'skipped' | 'failed'; detail: string };
export type ValidationResult = { ok: boolean; exitCode: 0 | 1; steps: StepResult[]; export?: ValidationExport };

const DEFAULT_PROSPECTS = 25;
const errText = (err: unknown) => capField(err instanceof Error ? err.message : String(err), 500);

/**
 * The validation pipeline for one case, each step idempotent on its own (R20): pack docs → prospects → emails → drafts
 * → landing → export. Results of finished steps stay saved whatever happens later.
 *
 * Failures: a pack failure stops the run (nothing to export). The outreach chain (prospects → emails → drafts) is
 * independent of the landing page, so a failure inside it skips the rest of that chain but still makes the landing page
 * and the export (plan Review Focus 5: report what we got); a landing failure still runs the export. Any failure gives
 * exit code 1. Finding 0 prospects is a warning, not a failure.
 */
export async function runValidation(deps: ValidationDeps, caseId: string, opts: ValidationOpts = {}): Promise<ValidationResult> {
  const { db, log } = deps;
  // P3-R21: a given --pilot-site must be a real http(s) URL; checked before any step, model call or fetch.
  const pilotDomain = opts.pilotSite === undefined ? null : pilotSiteDomain(opts.pilotSite);
  const steps: StepResult[] = [];
  const record = (step: ValidationStep, status: StepResult['status'], detail: string) => {
    steps.push({ step, status, detail });
    log(`validate: ${step} ${status}${detail ? ` — ${detail}` : ''}`);
  };
  const done = (exp?: ValidationExport): ValidationResult => {
    const ok = steps.every((s) => s.status !== 'failed');
    return { ok, exitCode: ok ? 0 : 1, steps, ...(exp ? { export: exp } : {}) };
  };

  const [kase] = await db.select().from(cases).where(eq(cases.id, caseId));
  if (!kase) throw new Error(`runValidation: unknown case ${caseId}`);
  if (opts.redraft) {
    log('validate: WARNING: --redraft replaces the outreach drafts of prospects not yet contacted (new or drafted); drafts you edited in the database are replaced (status, events and suppressions are kept)');
  }

  // 1. Pack documents (kept when present unless --refresh: the model call is the expensive part).
  try {
    const [existing] = await db.select({ id: validationPacks.id }).from(validationPacks).where(eq(validationPacks.caseId, caseId));
    if (existing && !opts.refresh) {
      record('pack', 'skipped', `kept the existing pack (use --refresh to regenerate${opts.pilotSite ? ' with the new --pilot-site' : ''})`);
    } else {
      await generatePackDocs(deps, caseId, opts.pilotSite === undefined ? {} : { pilotSite: opts.pilotSite });
      record('pack', 'ok', existing ? 'regenerated' : 'generated');
    }
  } catch (err) {
    record('pack', 'failed', errText(err));
    return done();
  }

  // 2–4. Outreach chain.
  let chainBroken = false;
  // The pilot site domain is excluded at every step (P3-R21): dropped from new prospects, refused by fetchPage on every
  // hop (blockHosts), never drafted for and never exported. isBannedSource covers the static NEVER_FETCH_HOSTS,
  // BANNED_DOMAINS and IP hosts, but not this per-run pilot site. Existing rows are kept as they are (not deleted, not
  // marked unsubscribed).
  const blockHosts = pilotDomain ? [pilotDomain] : [];
  const fetchDeps: ValidationDeps = pilotDomain
    ? { ...deps, fetchPage: ((url: string, o = {}) => deps.fetchPage(url, { ...o, blockHosts })) as ValidationDeps['fetchPage'] }
    : deps;
  if (opts.skipProspects) {
    record('prospects', 'skipped', '--skip-prospects');
  } else {
    try {
      const source: ProspectSource = opts.source === 'places'
        ? placesSource({ apiKey: deps.placesApiKey, ...(deps.placesFetch ? { fetchImpl: deps.placesFetch } : {}) })
        : webResearchSource;
      const all = await source.find({ db, router: deps.router, log, caseId, limit: opts.prospects ?? DEFAULT_PROSPECTS });
      // The pilot site is the owner's pilot, never a prospect.
      const found = pilotDomain ? all.filter((c) => prospectDomain(c.website) !== pilotDomain) : all;
      if (found.length < all.length) log(`validate: dropped ${all.length - found.length} prospect(s) on the pilot site domain ${pilotDomain}`);
      const r = await upsertProspects(db, caseId, found, source.id);
      if (found.length === 0) {
        log(`validate: 0 prospects found by ${source.id}; continuing with existing prospects`);
        record('prospects', 'warning', `0 prospects found by ${source.id}`);
      } else {
        record('prospects', 'ok', `${found.length} found by ${source.id}: ${r.inserted} new, ${r.existing} already listed${r.skipped ? `, ${r.skipped} skipped` : ''}`);
      }
    } catch (err) {
      record('prospects', 'failed', errText(err));
      chainBroken = true;
    }
  }

  if (chainBroken) {
    record('emails', 'skipped', 'prospects step failed');
  } else {
    try {
      const pending = await db.select().from(prospects)
        .where(and(eq(prospects.caseId, caseId), isNull(prospects.email), ne(prospects.status, 'unsubscribed')))
        .orderBy(prospects.createdAt, prospects.id);
      const todo = pending.filter((p) => p.domain !== pilotDomain);
      if (todo.length < pending.length) log(`validate: not fetching the pilot site domain ${pilotDomain} for emails`);
      const tally = { found: 0, none: 0, blocked: 0, kept: 0, errors: 0 };
      for (const p of todo) {
        try {
          const r = await discoverEmails(fetchDeps, p);
          tally[r.status]++;
        } catch (err) {
          tally.errors++;
          log(`emails: ${p.domain} failed: ${errText(err)}`);
        }
      }
      const detail = `${todo.length} prospect(s) without an email checked: ${tally.found} found, ${tally.none} none, ${tally.blocked} blocked` +
        (tally.errors ? `, ${tally.errors} errors` : '');
      record('emails', tally.errors > 0 && tally.errors === todo.length ? 'failed' : tally.errors ? 'warning' : 'ok', detail);
      if (tally.errors > 0 && tally.errors === todo.length) chainBroken = true;
    } catch (err) {
      record('emails', 'failed', errText(err));
      chainBroken = true;
    }
  }

  if (chainBroken) {
    record('drafts', 'skipped', 'an earlier outreach step failed');
  } else {
    try {
      const r = await generateDrafts(fetchDeps, caseId, { includeWeak: opts.includeWeak ?? false, pilotDomain, regenerate: opts.redraft ?? false });
      const detail = `${r.generated} drafted, ${r.refreshed} footers refreshed, ${r.unchanged} kept, ${r.failed} failed` +
        (r.excludedWeak ? `, ${r.excludedWeak} weak-basis left out` : '');
      // Every attempted prospect failing is a real failure; some failing is a warning (the rest are saved).
      record('drafts', r.failed > 0 && r.generated === 0 ? 'failed' : r.failed > 0 ? 'warning' : 'ok', detail);
    } catch (err) {
      record('drafts', 'failed', errText(err));
    }
  }

  // 5. Landing page (kept when present unless --refresh).
  try {
    const [existing] = await db.select({ id: landingPages.id }).from(landingPages).where(eq(landingPages.caseId, caseId));
    if (existing && !opts.refresh) {
      record('landing', 'skipped', 'kept the existing landing page (use --refresh to regenerate)');
    } else {
      await generateLanding(deps, caseId);
      record('landing', 'ok', existing ? 'regenerated' : 'generated');
    }
  } catch (err) {
    // The export does not need the landing page: it still runs so the owner gets what was made (exit code stays 1).
    record('landing', 'failed', errText(err));
  }

  // 6. Export.
  try {
    const exp = await exportValidation(db, caseId, deps.outDir, { includeWeak: opts.includeWeak ?? false, pilotDomain, log });
    record('export', 'ok', `${exp.files.length} files in ${exp.dir}; ${exp.outreachRows} prospect(s) in outreach.csv`);
    return done(exp);
  } catch (err) {
    record('export', 'failed', errText(err));
    return done();
  }
}
