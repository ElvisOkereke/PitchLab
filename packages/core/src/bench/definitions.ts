// Benchmark definitions: data and types only (web-safe; no runtime imports).
// bench-v1 is immutable: a changed seed set is a new version (bench-v2).

export type BenchSeed =
  | { seedType: 'open' }
  | { seedType: 'sector'; sectors: string[] }
  | { seedType: 'lens'; lensIds: string[] };

export type BenchmarkDef = { seeds: readonly BenchSeed[]; ideaCount: 12; advanceCount: 3; costNote: string };

export const BENCHMARKS: Readonly<Record<'bench-v1' | 'bench-v2', BenchmarkDef>> = {
  'bench-v1': {
    seeds: [
      { seedType: 'open' },
      { seedType: 'sector', sectors: ['dental clinics', 'restaurants/multi-location food'] },
      { seedType: 'sector', sectors: ['property management', 'ecommerce brands (Shopify)'] },
      { seedType: 'lens', lensIds: ['platform-shockwave', 'public-data-decision'] },
    ],
    ideaCount: 12,
    advanceCount: 3,
    costNote: 'about $12–28 in model calls (4 runs at about $3–7 each)',
  },
  // bench-v1's four seeds plus a consumer lens run; v1 stays frozen so old passes remain comparable.
  'bench-v2': {
    seeds: [
      { seedType: 'open' },
      { seedType: 'sector', sectors: ['dental clinics', 'restaurants/multi-location food'] },
      { seedType: 'sector', sectors: ['property management', 'ecommerce brands (Shopify)'] },
      { seedType: 'lens', lensIds: ['platform-shockwave', 'public-data-decision'] },
      { seedType: 'lens', lensIds: ['consumer-earn-side', 'consumer-save-auto'] },
    ],
    ideaCount: 12,
    advanceCount: 3,
    costNote: 'about $15–35 in model calls (5 runs at about $3–7 each)',
  },
};

export const CURRENT_BENCHMARK = 'bench-v2' as const;

export type MetricId =
  | 'repetition' | 'nearDuplicates' | 'buyerVariety' | 'consumerShare' | 'modelVariety' | 'realNeed'
  | 'demandEvidence' | 'customerReturn' | 'margin' | 'wastedEntrants' | 'easyStartHardCopy' | 'ownerVerdict' | 'costPerCase';

export const METRIC_DEFS: readonly { id: MetricId; label: string; target: string; phase?: 2 | 3 }[] = [
  { id: 'repetition', label: 'Repetition', target: 'below 0.55' },
  { id: 'nearDuplicates', label: 'Near-duplicates', target: 'below 10%' },
  { id: 'buyerVariety', label: 'Buyer variety', target: 'at least 8 per run' },
  { id: 'consumerShare', label: 'Consumer share', target: 'at least 30%' },
  { id: 'modelVariety', label: 'Business-model variety', target: 'at least 4 per run' },
  { id: 'realNeed', label: 'Real-need evidence', target: 'at least 50%' },
  { id: 'demandEvidence', label: 'Demand evidence', target: 'at least 80%' },
  { id: 'customerReturn', label: 'Customer return', target: '100%, median at least 3×' },
  { id: 'margin', label: 'Our margin', target: '100%' },
  { id: 'wastedEntrants', label: 'Wasted gate entrants', target: 'below 30% of entrants' },
  { id: 'easyStartHardCopy', label: 'Easy to start, hard to copy', target: 'at least 50%' },
  { id: 'ownerVerdict', label: 'Owner verdict', target: 'at least 3.5, all scored' },
  { id: 'costPerCase', label: 'Cost per case', target: 'tracked, no target' },
];
