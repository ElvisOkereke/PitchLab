import type { Db } from './client';
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
  ],
};

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

export const CONSUMER_SEGMENTS = [
  'new parents', 'students', 'renters', 'first-time homebuyers', 'retirees',
  'freelancers', 'gig workers', 'content creators', 'immigrants and newcomers', 'pet owners',
  'caregivers of aging parents', 'small landlords', 'job seekers', 'hobbyists',
  'drivers', 'people with disabilities', 'gamers',
];

/** Idempotent; never overwrites rows (lenses are editable in Settings). */
export async function seedDefaults(db: Db): Promise<void> {
  await db.insert(markets).values(CA_US).onConflictDoNothing({ target: markets.id });
  await db.insert(lenses).values([...LENSES, ...CONSUMER_LENSES]).onConflictDoNothing({ target: lenses.id });
}
