/** Topics the background collector rotates through (one per background mission). Plain data; web-safe. */
export type BackgroundTopic = { topic: string; audience: 'business' | 'consumer' | 'both'; countries: string[] };

export const BACKGROUND_TOPICS: readonly BackgroundTopic[] = [
  // consumers
  { topic: 'personal finance and budgeting struggles', audience: 'consumer', countries: ['US', 'CA'] },
  { topic: 'paying for health care and managing chronic conditions', audience: 'consumer', countries: ['US', 'CA'] },
  { topic: 'parenting costs and childcare', audience: 'consumer', countries: [] },
  { topic: 'creators earning a living from their audience', audience: 'consumer', countries: [] },
  { topic: 'gig workers handling income, taxes and benefits', audience: 'consumer', countries: ['US', 'CA', 'GB'] },
  { topic: 'renting and buying a home', audience: 'consumer', countries: ['CA', 'US'] },
  { topic: 'adult learning, tutoring and online education', audience: 'consumer', countries: [] },
  { topic: 'subscription fatigue and cancelling services', audience: 'consumer', countries: [] },
  { topic: 'caring for ageing parents', audience: 'consumer', countries: [] },
  { topic: 'student debt and early-career money', audience: 'consumer', countries: ['US', 'CA'] },
  // small and mid businesses
  { topic: 'restaurants and cafes running day-to-day operations', audience: 'business', countries: [] },
  { topic: 'independent clinics and dental practices', audience: 'business', countries: [] },
  { topic: 'trades contractors quoting, scheduling and invoicing', audience: 'business', countries: [] },
  { topic: 'freight, trucking and small logistics companies', audience: 'business', countries: [] },
  { topic: 'independent retailers and online shops', audience: 'business', countries: [] },
  { topic: 'accounting and bookkeeping for small firms', audience: 'business', countries: [] },
  { topic: 'property managers and landlords', audience: 'business', countries: [] },
  { topic: 'farms and small agriculture businesses', audience: 'business', countries: [] },
  { topic: 'manufacturers with small production runs', audience: 'business', countries: [] },
  { topic: 'agencies and consultants managing clients and projects', audience: 'business', countries: [] },
  { topic: 'fitness studios, salons and personal services', audience: 'business', countries: [] },
  { topic: 'nonprofits and community organisations', audience: 'business', countries: [] },
  { topic: 'compliance and paperwork burden for small employers', audience: 'business', countries: ['CA', 'US', 'GB'] },
  { topic: 'hiring and keeping staff in small companies', audience: 'business', countries: [] },
  // emerging markets and regions
  { topic: 'small businesses and payments in Africa', audience: 'both', countries: ['NG', 'KE', 'ZA', 'GH'] },
  { topic: 'everyday money and commerce in South Asia', audience: 'both', countries: ['IN', 'PK', 'BD'] },
  { topic: 'small business tools and credit in Latin America', audience: 'both', countries: ['BR', 'MX', 'CO', 'AR'] },
  { topic: 'online commerce and services in Southeast Asia', audience: 'both', countries: ['ID', 'VN', 'PH', 'TH'] },
  { topic: 'small business regulation and tools in Europe', audience: 'business', countries: ['DE', 'FR', 'ES', 'NL'] },
  { topic: 'remittances and cross-border money for families', audience: 'consumer', countries: ['global'] },
  { topic: 'mobile-first health and education access in rural areas', audience: 'consumer', countries: ['global'] },
  { topic: 'informal sector workers and microbusinesses', audience: 'both', countries: ['global'] },
  // new tech
  { topic: 'AI agents replacing repetitive back-office work', audience: 'business', countries: [] },
  { topic: 'AI assistants for individuals and households', audience: 'consumer', countries: [] },
  { topic: 'climate and energy costs for homes and small firms', audience: 'both', countries: [] },
  { topic: 'home energy retrofits, solar and heat pumps', audience: 'consumer', countries: ['CA', 'US', 'GB'] },
  { topic: 'products and services for an ageing population', audience: 'both', countries: ['JP', 'CA', 'US', 'DE'] },
  { topic: 'cybersecurity and fraud worries for small teams and families', audience: 'both', countries: [] },
  { topic: 'remote and hybrid work tooling', audience: 'business', countries: [] },
  { topic: 'data privacy rules and the cost of complying', audience: 'business', countries: ['US', 'CA', 'GB', 'DE'] },
];

/** Countries and industries a gap topic may target when the library has none of them yet. */
export const GAP_COUNTRIES = ['NG', 'KE', 'IN', 'BR', 'MX', 'ID', 'PH', 'VN', 'DE', 'FR', 'GB', 'ZA', 'CA', 'US'] as const;
export const GAP_INDUSTRIES = [
  'restaurants', 'healthcare', 'construction', 'logistics', 'retail', 'agriculture', 'education', 'real estate',
  'manufacturing', 'professional services', 'hospitality', 'energy',
] as const;
