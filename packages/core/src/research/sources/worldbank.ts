import type { KnowledgeDraft } from '../../library/kinds';
import { request, throttle } from '../http';
import { httpOf, type CollectorOpts } from './federalregister';

export const sourceType = 'worldbank';
export const MIN_INTERVAL_MS = 300;
const HOST = 'api.worldbank.org';

export const INDICATORS = [
  { code: 'SP.POP.TOTL', metric: 'Population', unit: 'people' },
  { code: 'NY.GDP.PCAP.CD', metric: 'GDP per person', unit: 'US dollars' },
  { code: 'IT.NET.USER.ZS', metric: 'Internet users', unit: '% of people', points: true },
  { code: 'IT.CEL.SETS.P2', metric: 'Mobile subscriptions', unit: 'per 100 people' },
  { code: 'IC.BUS.NDNS.ZS', metric: 'New businesses', unit: 'per 1,000 working-age people' },
  { code: 'SP.URB.TOTL.IN.ZS', metric: 'Urban population', unit: '% of people', points: true },
] as const;

type Point = { year: number; value: number };

const fmt = (n: number): string => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : String(Math.round(n * 100) / 100));

/** Non-null yearly points, oldest first, plus the country name; null for the error-object shape or anything unexpected. */
function parseSeries(json: unknown): { points: Point[]; country: string } | null {
  if (!Array.isArray(json) || !Array.isArray(json[1])) return null;
  const points: Point[] = [];
  let country = '';
  for (const r of json[1] as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue;
    const c = (r.country as { value?: unknown } | undefined)?.value;
    if (!country && typeof c === 'string') country = c;
    const year = typeof r.date === 'string' ? Number(r.date) : NaN;
    if (typeof r.value !== 'number' || !Number.isFinite(r.value) || !Number.isInteger(year)) continue;
    points.push({ year, value: r.value });
  }
  points.sort((a, b) => a.year - b.year);
  return { points, country };
}

/** One market draft for a country (two-letter code) from the fixed indicator set; null when nothing usable came back. */
export async function worldBankMarket(countryIso2: string, opts: CollectorOpts = {}): Promise<KnowledgeDraft | null> {
  const iso = countryIso2.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(iso)) return null;
  const sizeClues: { metric: string; value: string; unit: string; year: string }[] = [];
  const growthClues: { metric: string; change: string; period: string }[] = [];
  let name = '';
  for (const ind of INDICATORS) {
    await throttle(HOST, MIN_INTERVAL_MS, { sleep: opts.sleep });
    const json = await request('worldbank', `https://${HOST}/v2/country/${iso}/indicator/${ind.code}?format=json&mrv=6`, {}, httpOf(opts));
    const s = parseSeries(json);
    if (!s) {
      opts.log?.(`worldbank: unexpected response for ${ind.code}`);
      continue;
    }
    if (!s.points.length) continue;
    if (!name && s.country) name = s.country;
    const newest = s.points[s.points.length - 1]!;
    const oldest = s.points[0]!;
    sizeClues.push({ metric: ind.metric, value: fmt(newest.value), unit: ind.unit, year: String(newest.year) });
    // A share of people (%) changes in percentage points; a count or rate changes by a relative %.
    const period = `${oldest.year}–${newest.year}`;
    if (s.points.length >= 2 && 'points' in ind) {
      const diff = newest.value - oldest.value;
      growthClues.push({ metric: ind.metric, change: `${diff >= 0 ? '+' : '-'}${Math.abs(diff).toFixed(1)} points`, period });
    } else if (s.points.length >= 2 && oldest.value !== 0) {
      const pct = ((newest.value - oldest.value) / Math.abs(oldest.value)) * 100;
      growthClues.push({ metric: ind.metric, change: `${pct >= 0 ? '+' : '-'}${Math.abs(pct).toFixed(1)}%`, period });
    }
  }
  if (!sizeClues.length) return null;
  const place = name || iso;
  const lead = sizeClues.slice(0, 3).map((c) => `${c.metric.toLowerCase()} ${c.value} (${c.year})`).join(', ');
  return {
    kind: 'market',
    title: `Market size clues for ${place}`,
    summary: `World Bank figures for ${place}: ${lead}`,
    audience: 'both',
    countries: [iso],
    industries: [],
    voice: 'neutral',
    facts: { segment: `everyone in ${place}`, geography: place, sizeClues, growthClues },
    source: { url: `https://data.worldbank.org/country/${iso}`, domain: 'data.worldbank.org', sourceType, quoteVerified: false },
  };
}
