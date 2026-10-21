import { computeNumbers } from '../calc/numbers';
import type { NumberInputs } from '../calc/schema';
import type { CaseSections } from '../case/schema';
import type { CaslBasis, OutreachKind, ProspectSourceId, ProspectStatus } from '../db/schema';
import { defaultRunConfig, type RunConfig } from '../pipeline/types';

// Data only (web-safe: no DB, env or network imports). Everything here is invented: obviously fictional names and
// reserved domains (example.com / example.org / example.net / *.example). The example never spends money.

export const EXAMPLE_SLUG = 'example-booking-form-watchdog';
export const EXAMPLE_MODEL = 'example-data';

const IDEA_TEXT = 'A monitor that tests the online booking and quote forms of small trades businesses every hour and texts the owner when one silently breaks.';
const SRC = 'https://forum.example.com/t/';

const inputs: NumberInputs = {
  price: {
    amount: { value: 39, assumption: 'Priced under one missed job per month for a small trades business.' },
    per: 'month',
    unitsPerBuyer: { value: 1, assumption: 'One website per business.' },
    periodsPerYear: 12,
  },
  problemCost: [{
    label: 'Quote requests lost while a form is broken',
    quantity: { value: 6, source: { url: `${SRC}1`, quote: 'our contact form was dead for three weeks and we only noticed when a customer phoned' } },
    unitCost: { value: 450, assumption: 'Average small job value for an invented example business.' },
    perYear: { value: 1, assumption: 'Counted once per year as a conservative figure.' },
  }],
  expectedReduction: { value: 0.8, assumption: 'Most breakages are caught within an hour instead of weeks.' },
  reachableBuyers: { value: 12000, assumption: 'Illustrative number of small trades sites in the market.' },
  captureRate: { value: 0.01, assumption: 'One in a hundred over the first year.' },
  deliveryCostPerBuyerMonthly: [{ label: 'Hourly checks and SMS alerts', cost: { value: 3, assumption: 'Estimated hosting and SMS cost.' } }],
  fixedCostsMonthly: [{ label: 'Hosting and tooling', cost: { value: 60, assumption: 'Estimated.' } }],
  scenarios: [10, 50, 200],
};

const emailBody = (intro: string) =>
  `${intro}\n\n[Your name]\n[Mailing address]\n[Phone or website]\n[Unsubscribe line]`;

export function exampleSections(): CaseSections {
  return {
    summary: {
      oneLiner: "Hourly checks of a trades business's booking form, with a text message the moment it breaks.",
      buyer: 'Owner of a small plumbing, HVAC or electrical business with a website that takes quote requests',
      problem: 'Website forms break quietly after plugin updates or hosting changes, and the owner only finds out weeks later from a missed customer.',
      solution: 'A service that submits a harmless test request to the form every hour and alerts the owner by text if it does not arrive.',
      price: { amount: 39, per: 'month', rationale: 'Less than the value of one missed quote request a month.' },
      whyNow: 'More small businesses depend on their site for leads, and updates to website plugins break forms more often than before.',
      whyItWins: 'Existing uptime monitors only check that the page loads, not that the form delivers a lead.',
      nextAction: 'Interview five trades owners about the last time their form broke, then offer a free month to three of them.',
      gateFlags: ['Reachability: small trades owners are hard to find through one channel, so test two before committing.'],
    },
    evidence: {
      signals: [
        { quote: 'Our contact form was dead for three weeks and we only noticed when a customer phoned.', url: `${SRC}1`, sourceName: 'Example Forum', voice: 'operator' },
        { quote: 'After the plugin update the quote form just stopped sending, no error anywhere.', url: `${SRC}2`, sourceName: 'Example Forum', voice: 'operator' },
        { quote: 'Uptime checkers said the site was fine while the booking form was broken.', url: 'https://blog.example.org/forms-fail-quietly', sourceName: 'Example Blog', voice: 'neutral' },
      ],
      claims: [
        { text: 'Trades owners report forms failing for weeks without notice.', sourceUrl: `${SRC}1`, quote: 'dead for three weeks and we only noticed when a customer phoned' },
        { text: 'Plugin updates are a common cause of silent form failures.', sourceUrl: `${SRC}2`, quote: 'After the plugin update the quote form just stopped sending' },
        { text: 'Page-load uptime monitors do not detect broken forms.', sourceUrl: 'https://blog.example.org/forms-fail-quietly', quote: 'site was fine while the booking form was broken' },
        { text: 'A missed quote request costs a small trades business a few hundred dollars.', sourceUrl: 'https://trade-guide.example.net/lead-value', quote: 'an average residential job is worth $300 to $600' },
      ],
    },
    numbers: { inputs, results: computeNumbers(inputs) },
    competitors: {
      list: [
        { name: 'PingBoard (example)', url: 'https://pingboard.example.com', pricing: '$15/mo', gap: 'Checks that pages load; does not submit forms.' },
        { name: 'FormGuard (example)', url: 'https://formguard.example.net', pricing: 'Free tier, $29/mo for hourly checks', gap: 'Built for developers; setup needs scripting.' },
      ],
      levels: [
        { level: 'Page uptime', whatItChecks: 'The site responds.', limitation: 'A broken form still returns a healthy page.' },
        { level: 'Form delivery', whatItChecks: "A test request arrives in the owner's inbox.", limitation: 'Needs a dedicated test address and some setup per site.' },
      ],
    },
    pitch: {
      elevator: 'Booking Form Watchdog tests your quote form every hour and texts you the minute it stops working, so a broken plugin never costs you a job.',
      emails: [
        { subject: 'Is your quote form working right now?', body: emailBody('Hello, we check small business quote forms every hour and message the owner when one fails. Would a free month be useful?') },
        { subject: 'A quick follow-up', body: emailBody('Following up on my note about testing your quote form. Happy to set it up for you at no cost.') },
        { subject: 'Last note from me', body: emailBody('One last note: if your form ever breaks, you would hear about it from us first. Reply if you would like a free month.') },
      ],
      followUps: [
        { subject: 'Your first alert report', body: emailBody('Here is what a weekly report looks like, and what we would watch on your site.') },
        { subject: 'Ready to switch it on?', body: emailBody('If you are ready, I can have your form monitored within a day.') },
      ],
      callScript: 'Ask when the form last broke, how they found out, and what a missed week of requests would have cost.',
      objections: [
        { objection: 'My web person handles that.', response: 'This tells you and your web person within an hour instead of weeks.' },
        { objection: 'Test requests will clutter my inbox.', response: 'They are tagged and filtered, and you can skip them with one rule.' },
      ],
      pricingCopy: '$39 a month, cancel any time. The first month is free while we learn what you need.',
    },
  };
}

export type ExampleProspect = {
  name: string; website: string; domain: string; location: string; country: string; sizeNote: string | null; fitReason: string;
  contactName: string | null; contactRole: string | null; email: string | null; emailSourceUrl: string | null;
  caslBasis: CaslBasis; source: ProspectSourceId; status: ProspectStatus;
};

const prospectList: ExampleProspect[] = [
  {
    name: 'Northwind Plumbing (example)', website: 'https://northwind-plumbing.example.com', domain: 'northwind-plumbing.example.com',
    location: 'Hamilton, ON', country: 'CA', sizeNote: '6 staff', fitReason: 'Takes quote requests through a web form and no visible monitoring.',
    contactName: 'Sam Example', contactRole: 'Owner', email: 'hello@northwind-plumbing.example.com',
    emailSourceUrl: 'https://northwind-plumbing.example.com/contact', caslBasis: 'self_published', source: 'web_research', status: 'drafted',
  },
  {
    name: 'Lakeside Heating (example)', website: 'https://lakeside-heating.example.org', domain: 'lakeside-heating.example.org',
    location: 'Duluth, MN', country: 'US', sizeNote: '12 staff', fitReason: 'Booking form is the main way customers reach them.',
    contactName: null, contactRole: 'Office manager', email: 'office@lakeside-heating.example.org',
    emailSourceUrl: 'https://directory.example.net/lakeside-heating', caslBasis: 'third_party', source: 'web_research', status: 'drafted',
  },
  {
    name: 'Cedar Electric (example)', website: 'https://cedar-electric.example.net', domain: 'cedar-electric.example.net',
    location: 'Kelowna, BC', country: 'CA', sizeNote: null, fitReason: 'Recently redesigned site with a new quote form.',
    contactName: null, contactRole: null, email: 'jobs@cedar-electric.example.net',
    emailSourceUrl: null, caslBasis: 'unknown', source: 'csv', status: 'drafted',
  },
  {
    name: 'Harbour Roofing (example)', website: 'https://harbour-roofing.example.com', domain: 'harbour-roofing.example.com',
    location: 'Halifax, NS', country: 'CA', sizeNote: '4 staff', fitReason: 'Quote form only; no phone number on the home page.',
    contactName: null, contactRole: null, email: null,
    emailSourceUrl: null, caslBasis: 'unknown', source: 'manual', status: 'new',
  },
];

export type ExampleDraft = { domain: string; kind: OutreachKind; subject: string; body: string };

const draftFor = (p: ExampleProspect): ExampleDraft[] => [
  { domain: p.domain, kind: 'cold', subject: `Is the quote form at ${p.name} working?`, body: emailBody(`Hello, we test small business quote forms every hour and message the owner when one fails. Would a free month help ${p.name}?`) },
  { domain: p.domain, kind: 'followup1', subject: 'Following up', body: emailBody('Just checking that my earlier note reached you. Happy to set up form monitoring at no cost.') },
  { domain: p.domain, kind: 'followup2', subject: 'One last note', body: emailBody('If your form ever breaks, you would hear about it from us first. Reply if a free month would be useful.') },
];

export type ExampleFixture = ReturnType<typeof exampleFixture>;

/** A fresh copy of the example data each call (callers may mutate it). */
export function exampleFixture() {
  const sections = exampleSections();
  const config: RunConfig = defaultRunConfig({ seedType: 'idea', marketId: 'ca-us', ideaText: IDEA_TEXT });
  const criteria = ['pain', 'roi', 'evidence', 'speed', 'autonomy', 'novelty', 'reach'] as const;
  const values = [4, 4, 3, 4, 4, 3, 2];
  const notes = [
    'Owners describe weeks of lost requests.', 'A $39 plan is covered by one saved job.', 'Three signals, one from a neutral source.',
    'An MVP is a scheduled script and an SMS gateway.', 'Fully automatic once set up.', 'Few tools check form delivery.', 'Trades owners are scattered across many channels.',
  ];
  const verifiedByClaim = ['verified', 'verified', 'unverified', 'needs_review'] as const;
  return {
    config,
    run: { config, status: 'succeeded' as const, costUsd: '0', isExample: true, currentStage: 'score' },
    idea: {
      origin: 'owner' as const, title: 'Booking Form Watchdog', oneLiner: sections.summary.oneLiner, buyer: sections.summary.buyer,
      problem: sections.summary.problem, solution: sections.summary.solution, signalIds: [] as string[], status: 'advanced' as const,
    },
    case: {
      slug: EXAMPLE_SLUG, title: 'Booking Form Watchdog (example)', stage: 'new' as const, sections, gateAdvisory: true,
      model: EXAMPLE_MODEL, promptVersion: 'example', isExample: true,
    },
    sections,
    claims: [
      ...sections.evidence.claims.map((c, i) => ({
        section: 'evidence', text: c.text, sourceUrl: c.sourceUrl, quote: c.quote as string | null,
        verified: verifiedByClaim[i]!,
        confidence: (i < 2 ? 0.9 : null) as number | null,
        reviewNote: (i === 3 ? 'The page was reachable but the figure was in a chart; check it yourself.' : null) as string | null,
      })),
      { section: 'competitors', text: 'PingBoard (example) pricing: $15/mo', sourceUrl: 'https://pingboard.example.com/pricing', quote: 'Plans from $15 per month' as string | null, verified: 'verified' as const, confidence: 0.85 as number | null, reviewNote: null as string | null },
      { section: 'competitors', text: 'FormGuard (example) pricing: Free tier, $29/mo for hourly checks', sourceUrl: 'https://formguard.example.net/pricing', quote: null as string | null, verified: 'unverified' as const, confidence: null as number | null, reviewNote: null as string | null },
      { section: 'numbers', text: 'A missed quote request costs about $450.', sourceUrl: 'https://trade-guide.example.net/lead-value', quote: 'an average residential job is worth $300 to $600' as string | null, verified: 'needs_review' as const, confidence: 0.4 as number | null, reviewNote: 'Range is wide; confirm with two owners.' as string | null },
      { section: 'evidence', text: 'Hourly checks are enough to catch most breakages.', sourceUrl: `${SRC}2`, quote: null as string | null, verified: 'unverified' as const, confidence: null as number | null, reviewNote: null as string | null },
    ],
    scores: criteria.map((criterion, i) => ({
      criterion, value: values[i]!, note: notes[i]!, by: 'ai' as const, model: EXAMPLE_MODEL, promptVersion: 'example',
    })),
    pack: {
      model: EXAMPLE_MODEL, promptVersion: 'example',
      sections: {
        mvpSpec: {
          summary: "A scheduled job that submits a tagged test request to a customer's form and checks that it arrives.",
          features: [
            { name: 'Hourly form test', why: 'Catches breakage within an hour.', manualAtFirst: false },
            { name: 'Text alert', why: 'Owners read texts faster than email.', manualAtFirst: false },
            { name: 'Weekly report', why: 'Shows the owner the value they pay for.', manualAtFirst: true },
          ],
          architectureSketch: 'A scheduler calls a headless browser, fills the form with a tagged test, and listens on a catch-all inbox.',
          buildEstimate: { lowDays: 10, highDays: 20, assumptions: ['One form type at first', 'A hosted SMS gateway'] },
          fakeOrManualFirst: ['Run the checks by hand for the first three customers'],
          risks: ['Sites with bot protection may block test requests'],
          packaging: 'Sold as a flat monthly plan per website.',
        },
        pilotPlan: {
          idealPilotCustomer: 'A plumbing or HVAC business with a quote form and a webmaster who answers email.',
          firstStep: "Ask the owner for written permission to send tagged test requests to their form.",
          steps: ["Get the owner's permission in writing", 'Set up a tagged test address', 'Run checks by hand for two weeks'],
          measures: [
            { metric: 'Breakages caught', successThreshold: 'At least one real or simulated failure caught' },
            { metric: 'Owner would pay', successThreshold: 'Two of three pilots say yes' },
          ],
          timelineWeeks: 4,
          permissionsAndRisks: ['Only test forms whose owner has given permission.'],
        },
        interviewKit: {
          targetRoles: ['Owner of a small trades business'],
          whereToFind: ['Local trade association events'],
          opening: 'Thanks for talking; I am learning how small businesses handle their website forms, and I am not selling anything today.',
          questions: Array.from({ length: 8 }, (_, i) => ({
            question: `Example question ${i + 1}: tell me about the last time your website did not work as expected.`,
            whyAsk: 'Finds real stories instead of opinions.', listenFor: 'Specific dates, costs and who found out first.',
          })),
          redFlags: ['They do not use the website for leads.'],
        },
        checklist: {
          gates: [
            { id: 'emails-sent', description: 'Send at least 50 personalised cold emails', metricKey: 'emails_sent', threshold: 50 },
            { id: 'positive-replies', description: 'At least 3 positive replies from 50 emails', metricKey: 'positive_replies', threshold: 3 },
            { id: 'meetings', description: 'At least 2 discovery calls booked', metricKey: 'meetings', threshold: 2 },
          ],
        },
      },
    },
    landing: {
      slug: 'booking-form-watchdog-example',
      copy: {
        headline: 'Know the minute your quote form stops working',
        subhead: 'We test your booking form every hour and text you if a request does not arrive.',
        whoItsFor: 'Owners of small plumbing, heating and electrical businesses who win work through their website.',
        problem: 'Forms break quietly after updates. Most owners find out weeks later, from a customer who could not reach them.',
        howItWorks: [
          { title: 'Connect your form', text: 'Tell us where your quote form lives and give us a test inbox.' },
          { title: 'We test it hourly', text: 'A tagged test request goes through the form every hour.' },
          { title: 'You get a text', text: 'If a test does not arrive, you hear about it right away.' },
        ],
        offer: 'Your first month is free. After that it is $39 a month, and you can cancel any time.',
        faq: [
          { q: 'Will test requests clutter my inbox?', a: 'They are tagged so you can filter them out with one rule.' },
          { q: 'Do you need my login?', a: 'No. We only use the public form, with your permission.' },
          { q: 'Can I cancel?', a: 'Yes, any time, with no fee.' },
        ],
        ctaLabel: 'Get my free month',
        metaDescription: 'Hourly checks of your quote form, with a text alert when it breaks.',
      },
      html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Booking Form Watchdog (example)</title></head><body><h1>Know the minute your quote form stops working</h1><p>This is an example page with invented content.</p></body></html>',
      publishedUrl: null as string | null,
    },
    prospects: prospectList.map((p) => ({ ...p })),
    drafts: prospectList.filter((p) => p.email).flatMap(draftFor),
    draftModel: EXAMPLE_MODEL,
  };
}
