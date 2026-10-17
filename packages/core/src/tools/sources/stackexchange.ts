import { cleanText, getJson, toDate, type RawItem, type SignalSource } from './types';

interface SeItem {
  question_id: number;
  title?: string;
  excerpt?: string;
  creation_date?: number;
}

export const DEFAULT_SE_SITES = ['webmasters', 'wordpress', 'softwarerecs'];

export function createStackExchangeSource(opts: { key?: string; sites?: string[] } = {}): SignalSource {
  const sites = opts.sites ?? DEFAULT_SE_SITES;
  return {
    id: 'stackexchange',
    async search(query, { limit, fetchImpl }) {
      const out: RawItem[] = [];
      for (const site of sites) {
        let url = `https://api.stackexchange.com/2.3/search/excerpts?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=${encodeURIComponent(site)}&pagesize=${limit}`;
        if (opts.key) url += `&key=${encodeURIComponent(opts.key)}`;
        const json = (await getJson('stackexchange', url, fetchImpl)) as { items?: SeItem[] } | null;
        if (!json || !Array.isArray(json.items)) continue;
        for (const i of json.items) {
          out.push({
            source: 'stackexchange',
            url: `https://${site}.stackexchange.com/q/${i.question_id}`,
            title: cleanText(i.title),
            text: cleanText(i.excerpt),
            publishedAt: toDate(i.creation_date),
          });
        }
      }
      return out.slice(0, limit);
    },
  };
}
