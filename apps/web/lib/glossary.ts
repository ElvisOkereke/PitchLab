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
  | 'notionalSpend'
  | 'benchmark'
  | 'library'
  | 'researchMission'
  | 'businessModel'
  | 'valueMultiple'
  | 'barriers'
  | 'archivedCopy'
  | 'socialShare'
  | 'pagesRead'
  | 'trend'
  | 'ruleChange'
  | 'market'
  | 'demandEvidence';

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
    text: 'The background program that does the work in your queued runs and validation packs. Run it with npm run worker. It checks in regularly, and it shows as not seen after 60 seconds of silence.',
  },
  notionalSpend: {
    label: 'Notional spend',
    text: 'An estimate of what the AI calls cost, worked out from a price table. It is not a billed amount, so your provider’s invoice is the real figure.',
  },
  benchmark: {
    label: 'Benchmark',
    text: 'A fixed set of 5 runs you repeat after each change, so you can compare idea quality before and after. The scorecard measures how varied and well-evidenced the ideas are, and your own gut scores on its cases count too.',
  },
  library: {
    label: 'Library',
    text: 'The research PitchLab keeps between runs: problems people describe, what products charge and how startups fared. Each entry links to its sources, and runs draw on entries whose quotes were checked against the source text.',
  },
  researchMission: {
    label: 'Research mission',
    text: 'A research job on a topic you choose. The worker searches public sources, adds what it finds to the library and shows the cost first. You set the budget, and a mission stops starting new steps once it is spent.',
  },
  businessModel: {
    label: 'Business model',
    text: 'The way an idea earns money, such as a subscription, a one-off sale, a fee per transaction, ads or affiliate links. Ideas are written with one of these models, and an idea from before this existed reads as a subscription (the scorecard leaves them out).',
  },
  valueMultiple: {
    label: 'Value multiple',
    text: 'How much a year of the product is worth to the person who pays, divided by what it costs them for a year. A multiple of 3× means they get three times the price back, and ad- or affiliate-funded ideas, where the user pays nothing, have none (they sit in the middle of the money ranking). Data sales use the value and price for the client who buys the data, and freemium the paid tier\'s price.',
  },
  barriers: {
    label: 'Barriers',
    text: 'Two 1 to 5 scores on an idea: how hard it is for someone to start it (1 is easy) and how hard it is for a rival to copy it (5 is hard). The best ideas are easy to start and hard to copy.',
  },
  archivedCopy: {
    label: 'Archived copy',
    text: 'A saved copy of a web page from the Internet Archive (the Wayback Machine). PitchLab uses one only when the live page refuses it or does not answer, robots.txt allows it, and the copy is no more than three years old. The entry says it came from an archived copy and shows the date of the copy.',
  },
  socialShare: {
    label: 'Social share',
    text: 'The share of sources in the library that come from community sites, such as Hacker News, Stack Exchange, GitHub, Product Hunt, app stores and YouTube comments, where people describe problems in their own words. A higher share means more real voices and fewer company pages.',
  },
  pagesRead: {
    label: 'Pages read',
    text: 'How many of the pages PitchLab tried to read over the last 30 days came through with usable text, overall and by route (directly, from an archived copy, or in the local browser). The sites that fail most are listed with their main reason.',
  },
  trend: {
    label: 'Trend',
    text: 'A topic that people are searching for or posting about more, less or about the same as before, shown with the numbers behind it. Pageview and Hacker News counts are measured by PitchLab, and a figure from an article is kept only when its quote contains the number.',
  },
  ruleChange: {
    label: 'Rule change',
    text: 'A new or proposed rule, or a platform policy change, that forces people to act, with what changed, who is affected and the dates it was published and takes effect. Rules published over three years ago, or in force for over two, are left out.',
  },
  market: {
    label: 'Market',
    text: 'How big a group of customers is and whether it is growing, for example the people in a country or the clinics in a province, shown as size and growth clues with their year and source.',
  },
  demandEvidence: {
    label: 'Demand evidence',
    text: 'The share of generated ideas that rest on a trend, a rule change or a market entry from the library. Ideas cite one only when they depend on it, and the benchmark aims for 80 percent.',
  },
};
