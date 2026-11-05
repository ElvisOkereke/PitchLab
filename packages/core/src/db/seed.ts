import type { Db } from './client';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { lenses, markets } from './schema';

export const CA_US = {
  id: 'ca-us',
  name: 'Canada + US',
  countries: ['CA', 'US'],
  language: 'en',
  currency: 'USD',
  sectors: [
    'web design agencies', 'digital marketing agencies', 'managed IT providers', 'HVAC', 'plumbing',
    'electrical', 'roofing', 'landscaping', 'dental clinics', 'physiotherapy clinics',
    'veterinary clinics', 'law firm operations', 'accounting/bookkeeping firms', 'property management',
    'event rentals', 'auto repair', 'restaurants/multi-location food', 'ecommerce brands (Shopify)',
    'franchise groups', 'logistics/freight brokers',
    'logistics and freight', 'construction and trades', 'healthcare clinics', 'education and tutoring',
  ],
};

/** The sectors bench-v3 names. Existing databases get only these appended when missing (see seedDefaults). */
export const BENCH_V3_SECTORS = ['logistics and freight', 'construction and trades', 'healthcare clinics', 'education and tutoring'];

export const LENSES = [
  {
    id: 'silent-failure',
    name: 'Silent failure monitor',
    pattern: 'Something "looks fine" but is quietly losing money (benchmark lens)',
    promptHint: 'Find processes in the signals that appear healthy yet silently leak revenue, and propose a monitor that detects and alerts on the failure.',
  },
  {
    id: 'aggregator',
    name: 'Sell to the aggregator',
    pattern: 'Find whoever serves *many* affected SMBs (agencies, MSPs, franchisors, bookkeepers, associations) and sell to them',
    promptHint: 'Identify the intermediary that serves many of the affected small businesses and make that intermediary the buyer of the solution.',
  },
  {
    id: 'manual-to-productised',
    name: 'Manual task → productised service',
    pattern: 'Recurring manual work (from job posts/gigs) delivered by an automated engine at a fixed price',
    promptHint: 'Turn recurring manual work visible in the signals into a fixed-price service delivered by an automated engine.',
  },
  {
    id: 'money-leak',
    name: 'Money-leak recovery',
    pattern: 'Recover lost money (billing errors, missed rebates, duplicate charges, unclaimed credits). Price as a % of recovered',
    promptHint: 'Spot money that customers are losing to errors or unclaimed credits and propose a recovery service priced as a percentage of the amount recovered.',
  },
  {
    id: 'platform-shockwave',
    name: 'Platform-change shockwave',
    pattern: 'A platform changes rules (email sender requirements, API deprecations, policy changes) and many businesses need a fix fast',
    promptHint: 'Look for a recent platform rule or API change that forces many businesses to act quickly, and propose a fast fix they would pay for.',
  },
  {
    id: 'compliance-demand',
    name: 'Compliance-driven demand (no license)',
    pattern: 'Customer faces a rule; the owner needs no license to help',
    promptHint: 'Find rules that customers must satisfy where a non-licensed provider can legally help, and propose a service that gets them compliant.',
  },
  {
    id: 'public-data-decision',
    name: 'Public data → paid decision',
    pattern: 'Reformat public/open data into a report someone pays to make a decision',
    promptHint: 'Identify public or open data that is hard to use and propose a report that lets a specific buyer make a paid decision.',
  },
  {
    id: 'review-gap',
    name: 'Incumbent review gap',
    pattern: "Mine incumbents' bad reviews for a narrow, underserved job-to-be-done",
    promptHint: 'Use complaints about incumbent products in the signals to find a narrow, underserved job-to-be-done and build only for that.',
  },
];

const CONSUMER = 'consumer' as const;

export const CONSUMER_LENSES = [
  {
    id: 'consumer-earn-side',
    name: 'Earn on the side',
    audience: CONSUMER,
    pattern: "Help an individual earn extra income from a skill, asset or spare time they already have",
    promptHint: "Find people in the signals who want extra income from something they already own or can do, and propose a product that gets them paid, with a clear take rate or fee. The payer must be a named kind of individual spending their own money; where the product is free to them, their attention or data must be what is sold (ads, affiliate, data). Never relabel a business as a consumer.",
  },
  {
    id: 'consumer-save-auto',
    name: 'Save money automatically',
    audience: CONSUMER,
    pattern: "Cut an individual's recurring bills or fees without ongoing effort, priced as a small cut of the savings or a low flat fee",
    promptHint: "Spot recurring costs people overpay for (bills, subscriptions, fees, insurance) and propose a product that finds and captures the saving automatically. The payer must be a named kind of individual spending their own money; where the product is free to them, their attention or data must be what is sold (ads, affiliate, data). Never relabel a business as a consumer.",
  },
  {
    id: 'consumer-life-stage',
    name: 'Life-stage pain',
    audience: CONSUMER,
    pattern: "A predictable life event (new baby, move, divorce, retirement, caring for a parent) creates a burst of paperwork, cost or stress",
    promptHint: "Find the pain that arrives with a specific life stage or event and propose a focused product that people will pay for at exactly that moment. The payer must be a named kind of individual spending their own money; where the product is free to them, their attention or data must be what is sold (ads, affiliate, data). Never relabel a business as a consumer.",
  },
  {
    id: 'consumer-creator-solo',
    name: 'Creator and solo-worker tools',
    audience: CONSUMER,
    pattern: "Freelancers, creators and gig workers run a business of one and pay for tools out of their own pocket",
    promptHint: "Find chores that creators, freelancers and gig workers do by hand (invoicing, taxes, scheduling, audience growth) and propose a tool they would pay for personally. The payer must be a named kind of individual spending their own money; where the product is free to them, their attention or data must be what is sold (ads, affiliate, data). Never relabel a business as a consumer.",
  },
  {
    id: 'consumer-leapfrog',
    name: 'Leapfrog markets',
    audience: CONSUMER,
    pattern: "A proven product from one country, adapted to a market where it does not yet exist or fits badly, for individuals there",
    promptHint: "Look for a product that works well in one market and is missing or poorly served in another, and propose a local version for a named kind of individual there, paid for directly or funded by their attention. The payer must be a named kind of individual spending their own money; where the product is free to them, their attention or data must be what is sold (ads, affiliate, data). Never relabel a business as a consumer.",
  },
  {
    id: 'consumer-ai-chore',
    name: 'AI assistant or free-to-user attention product',
    audience: CONSUMER,
    pattern: "A dull personal task done by an AI assistant for a fee, or a free-to-user product whose attention or data is the product (ads, affiliate, data)",
    promptHint: "Find tedious personal chores in the signals that an AI assistant could finish end to end. The product may charge the individual, or be free to them and funded by ads, affiliate fees or data, with their attention as the product. The payer must be a named kind of individual spending their own money; where the product is free to them, their attention or data must be what is sold (ads, affiliate, data). Never relabel a business as a consumer.",
  },
];

const ANY = 'any' as const;

/** Lenses that push toward scale and an edge, not just a fix for a complaint. Open and sector runs always include at least two. */
export const AMBITION_LENSES = [
  {
    id: 'ai-replaces-labour',
    name: 'AI replaces expensive labour',
    audience: ANY,
    pattern: 'Expensive, repeated human work done across many companies or people, done by software at a fraction of the cost',
    promptHint: "Find work in the signals that people are paid to do by hand again and again across many buyers, and propose software that does most of it end to end at a fraction of the cost. Name today's option (the staff, agency or tool people use now), what it costs, and the concrete advantage in cost, speed or accuracy. Skip work that legally needs a licensed professional (legal, medical, tax or financial advice, engineering sign-off): software cannot replace the licence.",
  },
  {
    id: 'ten-x-incumbent',
    name: '10x on an incumbent',
    audience: ANY,
    pattern: 'Something people already buy in volume, made 10x cheaper, faster or easier for a segment the incumbent serves badly',
    promptHint: "Find a product or service that many people already pay for, and a segment it serves badly (too expensive, too slow, too hard). Propose a version that is about ten times better on one of those for that segment. Name today's option, who it fails, and the concrete advantage. Skip services that legally need a licensed professional (legal, medical, tax or financial advice, engineering sign-off): software cannot replace the licence.",
  },
  {
    id: 'new-capability',
    name: 'New capability',
    audience: ANY,
    pattern: 'Something that was not feasible two years ago because of recent model, data or hardware advances',
    promptHint: "Think of a job that software could not do well until recently, because of better models, new data access or cheaper hardware, and that the signals show people still doing by hand or going without. Name today's option, the advance that makes this possible now, and the concrete advantage.",
  },
  {
    id: 'marketplace-network',
    name: 'Marketplace or network',
    audience: ANY,
    pattern: 'Connect two sides where trust or matching is broken, so the value grows with each side that joins',
    promptHint: "Find a place in the signals where buyers and sellers (or two other sides) struggle to find, trust or price each other, and propose a marketplace or network that fixes the matching. Software runs the matching, trust and operations, not a team doing it by hand. Name how they connect today, which side is hardest to win first, and why each new member makes it better for the rest.",
  },
  {
    id: 'data-flywheel',
    name: 'Data flywheel',
    audience: ANY,
    pattern: 'A product whose everyday use produces data that makes it better and is hard for others to copy',
    promptHint: "Propose a product that is useful on day one and whose usage generates data (outcomes, prices, patterns) that improves the product for every user and that a late entrant could not easily collect. Name today's option, what data builds up, and how that becomes the concrete advantage.",
  },
  {
    id: 'picks-and-shovels',
    name: 'Picks and shovels',
    audience: ANY,
    pattern: 'Tools for the many people riding a rising trend, who all need the same thing to take part',
    promptHint: "Look at the rising trends in <changing> and find what the many people or companies joining them all need and lack: tooling, compliance, data, payments or setup. Propose a product for them. Name today's option for that need, the trend it rides, and the concrete advantage.",
  },
];

/** Sampling weight for the fix-it lenses, so the ambition lenses get more of the six slots. */
export const LENS_WEIGHTS: Record<string, number> = { 'review-gap': 0.5, 'platform-shockwave': 0.5 };

export const CONSUMER_SEGMENTS = [
  'new parents', 'students', 'renters', 'first-time homebuyers', 'retirees',
  'freelancers', 'gig workers', 'content creators', 'immigrants and newcomers', 'pet owners',
  'caregivers of aging parents', 'small landlords', 'job seekers', 'hobbyists',
  'drivers', 'people with disabilities', 'gamers',
];

/** Idempotent; never overwrites rows (lenses are editable in Settings). */
export async function seedDefaults(db: Db): Promise<void> {
  await db.insert(markets).values(CA_US).onConflictDoNothing({ target: markets.id });
  await db.insert(lenses).values([...LENSES, ...CONSUMER_LENSES, ...AMBITION_LENSES]).onConflictDoNothing({ target: lenses.id });
  // Existing databases: append a bench-v3 sector the market lacks; never remove or reorder. Other defaults are not
  // re-added, so a default sector the owner removed stays removed.
  for (const sector of BENCH_V3_SECTORS) {
    await db.update(markets).set({ sectors: sql`array_append(${markets.sectors}, ${sector})` })
      .where(and(eq(markets.id, CA_US.id), sql`not (${sector} = any(${markets.sectors}))`));
  }
  // Existing databases: set a weight only where none is set, so this stays idempotent.
  for (const [id, weight] of Object.entries(LENS_WEIGHTS)) {
    await db.update(lenses).set({ weight }).where(and(eq(lenses.id, id), isNull(lenses.weight)));
  }
}
