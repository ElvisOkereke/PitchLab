export type GlossaryTerm =
  | 'seed'
  | 'lens'
  | 'sector'
  | 'ideaCount'
  | 'advanceCount'
  | 'gateFlags'
  | 'stage'
  | 'aiScore'
  | 'caslBasis'
  | 'checklist'
  | 'overturnKill'
  | 'worker'
  | 'notionalSpend';

/** In-app help text. docs/glossary.md has a `### <label>` heading for each entry (a test keeps them in sync). */
export const GLOSSARY: Record<GlossaryTerm, { label: string; text: string }> = {
  seed: {
    label: 'Seed',
    text: 'The starting point for a run. Open looks across every sector, Sectors and Lenses narrow it to the ones you tick, and Your idea builds a case for an idea you describe.',
  },
  lens: {
    label: 'Lenses',
    text: 'A lens is a pattern for spotting a business idea, such as a silent failure to monitor or a task to turn into a fixed-price service. Tick lenses to make the run look only through those patterns.',
  },
  sector: {
    label: 'Sectors',
    text: 'The kinds of small business the run can research, such as HVAC, dental clinics or managed IT providers. Tick some to keep the run to those sectors.',
  },
  ideaCount: {
    label: 'Ideas to generate',
    text: 'How many raw ideas the run writes down before it filters them. More ideas give the filters more to choose from.',
  },
  advanceCount: {
    label: 'Ideas to turn into cases',
    text: 'How many of the surviving ideas get a full business case with sources and numbers. Each case is the expensive part of a run, so keep this small.',
  },
  gateFlags: {
    label: 'Gate flags',
    text: 'The gate runs checks on each idea (not generic, regulation, control, autonomy, reachability, evidence), and a flag means one failed. For an idea you wrote yourself it only advises, so you still get the case and decide whether to keep or kill it.',
  },
  stage: {
    label: 'Stage',
    text: 'Where this case is in your own process: New, Validating, Pilot, Live or Killed. You move it by hand; PitchLab never changes it for you.',
  },
  aiScore: {
    label: 'AI scores',
    text: 'The AI rates the case on each criterion from the sources it found. They are a starting opinion, separate from your own scores, which you enter below.',
  },
  caslBasis: {
    label: 'CASL basis',
    text: 'CASL is Canada’s anti-spam law. This says how the prospect’s email address was found: published by the business itself, on a third-party site, or unknown. If it says unknown, do not email; PitchLab never sends email itself.',
  },
  checklist: {
    label: 'Checklist',
    text: 'The targets that decide whether an idea is worth pursuing, such as 50 emails sent, 3 positive replies and 5 buyer interviews. Each one passes when your tracked numbers reach its target.',
  },
  overturnKill: {
    label: 'Overturn kill',
    text: 'Moves a killed case back to New so you can work on it again. Use it when you killed an idea too early or the facts changed.',
  },
  worker: {
    label: 'Worker',
    text: 'The background program that does the work in your queued runs. Run it with npm run worker. It checks in regularly, and it shows as not seen after 60 seconds of silence.',
  },
  notionalSpend: {
    label: 'Notional spend',
    text: 'An estimate of what the AI calls cost, worked out from a price table. It is not a billed amount, so your provider’s invoice is the real figure.',
  },
};
