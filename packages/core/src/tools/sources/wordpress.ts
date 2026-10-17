import { XMLParser } from 'fast-xml-parser';
import { cleanText, getBody, toDate, type RawItem, type SignalSource } from './types';

export const DEFAULT_WP_SLUGS = [
  'contact-form-7',
  'wpforms-lite',
  'ninja-forms',
  'gravityforms',
  'wp-mail-smtp',
  'fluentform',
  'formidable',
];

interface RssItem {
  title?: unknown;
  link?: unknown;
  description?: unknown;
  pubDate?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/**
 * `search(query)` treats `query` as a plugin slug. `opts.slugs` is the list the harvest
 * stage iterates over (defaults to DEFAULT_WP_SLUGS); it is exposed as `slugs`.
 */
export function createWordpressSource(opts: { slugs?: string[] } = {}): SignalSource & { slugs: string[] } {
  return {
    id: 'wordpress',
    slugs: opts.slugs ?? DEFAULT_WP_SLUGS,
    async search(query, { limit, fetchImpl }) {
      const url = `https://wordpress.org/support/plugin/${encodeURIComponent(query)}/feed/`;
      const body = await getBody('wordpress', url, fetchImpl, { Accept: 'application/rss+xml, application/xml' });
      if (body === null) return [];
      try {
        const doc = new XMLParser({ ignoreAttributes: true, parseTagValue: false, processEntities: false }).parse(body) as {
          rss?: { channel?: { item?: RssItem | RssItem[] } };
        };
        if (!doc.rss) throw new Error('no rss element');
        const raw = doc.rss.channel?.item;
        const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
        const items: RawItem[] = list.map((i) => ({
          source: 'wordpress',
          url: str(i.link),
          title: cleanText(str(i.title)),
          text: cleanText(str(i.description)) || cleanText(str(i.title)),
          publishedAt: toDate(str(i.pubDate)),
        }));
        return items.slice(0, limit);
      } catch (e) {
        console.warn(`[source:wordpress] bad XML: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    },
  };
}
