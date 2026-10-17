import { cleanText, getJson, toDate, type RawItem, type SignalSource } from './types';

interface Label {
  label?: string;
}
interface Entry {
  'im:rating'?: Label;
  title?: Label;
  content?: Label;
  updated?: Label;
}

/** `search(query)` treats `query` as a numeric app id. */
export function createAppStoreSource(opts: { countries: string[] }): SignalSource {
  return {
    id: 'appstore',
    async search(query, { limit, fetchImpl }) {
      const out: RawItem[] = [];
      for (const country of opts.countries) {
        const cc = country.toLowerCase();
        const url = `https://itunes.apple.com/${cc}/rss/customerreviews/id=${encodeURIComponent(query)}/sortby=mostrecent/json`;
        const json = (await getJson('appstore', url, fetchImpl)) as { feed?: { entry?: Entry | Entry[] } } | null;
        const raw = json?.feed?.entry;
        if (!raw) continue;
        for (const e of Array.isArray(raw) ? raw : [raw]) {
          const rating = Number(e['im:rating']?.label);
          // No rating = app metadata entry; skip it along with 4-5 star reviews.
          if (!Number.isFinite(rating) || rating > 3) continue;
          out.push({
            source: 'appstore',
            url: `https://apps.apple.com/${cc}/app/id${query}`,
            title: cleanText(e.title?.label),
            text: cleanText(e.content?.label) || cleanText(e.title?.label),
            publishedAt: toDate(e.updated?.label),
          });
        }
      }
      return out.slice(0, limit);
    },
  };
}
