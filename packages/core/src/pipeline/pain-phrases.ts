/** Broad, sector-agnostic pain phrases. */
export const GENERIC_PAIN_PHRASES = [
  'manual every week', 'spreadsheet nightmare', 'keeps breaking', 'wasting hours',
  'double entry', 'copy paste between systems', 'chasing payments', 'no way to know if',
];

/** Search-friendly time/money-loss phrases per seeded `ca-us` sector (keys match src/db/seed.ts exactly). */
export const SECTOR_PAIN_PHRASES: Record<string, string[]> = {
  'web design agencies': ['client site maintenance', 'chasing client content', 'scope creep unpaid', 'plugin update breaks', 'manual client reporting'],
  'digital marketing agencies': ['manual client reporting', 'ad spend wasted', 'client churn reporting', 'tracking broken after update', 'chasing client approvals'],
  'managed IT providers': ['ticket backlog', 'manual patch reporting', 'client onboarding checklist', 'unbilled support hours', 'license renewal tracking'],
  'HVAC': ['missed maintenance renewals', 'dispatch scheduling chaos', 'unpaid service invoices', 'manual quote follow-up', 'warranty claim paperwork'],
  'plumbing': ['missed service calls', 'quote follow-up manual', 'unpaid invoices chasing', 'dispatch scheduling chaos', 'parts inventory tracking'],
  'electrical': ['permit paperwork delays', 'quote follow-up manual', 'unpaid invoices chasing', 'job costing spreadsheet', 'crew scheduling conflicts'],
  'roofing': ['insurance claim paperwork', 'estimate follow-up manual', 'material cost tracking', 'storm lead scheduling', 'unpaid final invoices'],
  'landscaping': ['seasonal route planning', 'recurring invoice chasing', 'crew scheduling conflicts', 'quote follow-up manual', 'equipment maintenance tracking'],
  'dental clinics': ['no-show patients', 'insurance claim denied', 'manual appointment reminders', 'recall list outdated', 'treatment plan follow-up'],
  'physiotherapy clinics': ['no-show patients', 'insurance billing rejected', 'manual appointment reminders', 'patient dropout between visits', 'paperwork double entry'],
  'veterinary clinics': ['vaccine reminder tracking', 'no-show appointments', 'inventory expiry tracking', 'insurance claim paperwork', 'manual client callbacks'],
  'law firm operations': ['unbilled time entries', 'client intake paperwork', 'trust accounting reconciliation', 'deadline tracking manual', 'chasing client retainers'],
  'accounting/bookkeeping firms': ['chasing client documents', 'manual bank reconciliation', 'tax deadline tracking', 'receipt data entry', 'month end close'],
  'property management': ['chasing rent payments', 'maintenance request backlog', 'tenant turnover paperwork', 'lease renewal tracking', 'owner statement reports'],
  'event rentals': ['double booked inventory', 'damage deposit disputes', 'delivery route planning', 'quote follow-up manual', 'equipment return tracking'],
  'auto repair': ['parts order delays', 'customer approval calls', 'warranty claim paperwork', 'service reminder follow-up', 'unpaid repair invoices'],
  'restaurants/multi-location food': ['food cost tracking', 'delivery platform fees', 'inventory count manual', 'staff scheduling chaos', 'supplier invoice mismatch'],
  'ecommerce brands (Shopify)': ['chargeback disputes', 'inventory sync errors', 'abandoned cart recovery', 'returns processing manual', 'supplier stock out'],
  'franchise groups': ['franchisee compliance reporting', 'royalty reporting manual', 'location audit tracking', 'brand standard violations', 'franchisee onboarding paperwork'],
  'logistics/freight brokers': ['invoice disputes carrier', 'manual load tracking', 'detention charges unbilled', 'carrier onboarding paperwork', 'proof of delivery chasing'],
};

/** The sector's phrases plus 2 generic ones chosen with `random`; an unknown sector gets generic phrases only. */
export function phrasesFor(sector: string, random: () => number): string[] {
  const generic = [...GENERIC_PAIN_PHRASES];
  for (let i = generic.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [generic[i], generic[j]] = [generic[j]!, generic[i]!];
  }
  const own = SECTOR_PAIN_PHRASES[sector];
  return own ? [...own, ...generic.slice(0, 2)] : generic;
}
