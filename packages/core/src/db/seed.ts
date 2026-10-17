import type { Db } from './client';
import { lenses, markets } from './schema';

const CA_US = {
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

const LENSES = [
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

/** Idempotent; never overwrites rows (lenses are editable in Settings). */
export async function seedDefaults(db: Db): Promise<void> {
  await db.insert(markets).values(CA_US).onConflictDoNothing({ target: markets.id });
  await db.insert(lenses).values(LENSES).onConflictDoNothing({ target: lenses.id });
}
