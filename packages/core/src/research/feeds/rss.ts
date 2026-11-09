import { XMLParser } from 'fast-xml-parser';
import type { RawItem } from '../../tools/sources/types';
import { cleanText } from '../../tools/sources/types';
import { BANNED_DOMAINS } from '../../tools/banned-sources';
import type { fetchPage as fetchPageFn } from '../../tools/fetch-page';
import { SourceError, USER_AGENT } from '../http';
import { badResponse, list, looksLikeHtml, makeItem, MAX_PER_QUERY, rec, str, type FeedOpts } from './common';

export const sourceType = 'rss';

/**
 * The newsletters and launch feeds read by default (setting `feeds.rss` replaces the list). Each URL is the feed
 * address the publisher documents or its platform's standard path (Substack and beehiiv `/feed`, WordPress `/feed/`).
 */
export const DEFAULT_RSS_FEEDS: readonly string[] = [
  'https://alphasignalai.substack.com/feed', // AlphaSignal (Substack)
  'https://tldr.tech/api/rss/tech', // TLDR
  'https://www.bensbites.com/feed', // Ben's Bites (beehiiv)
  'https://trends.vc/feed/', // Trends.vc
  'https://techcrunch.com/category/startups/feed/', // TechCrunch startups (WordPress)
  'https://news.crunchbase.com/feed/', // Crunchbase News (WordPress)
  'https://betalist.com/feed', // BetaList
  'https://www.indiehackers.com/feed.xml', // Indie Hackers
];

export type FeedEntry = { title: string; url: string; text: string; published: string | null };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  processEntities: false,
  isArray: (name) => name === 'item' || name === 'entry' || name === 'link',
});

/** Text of a node that may be a plain string, an object with attributes (`#text`) or an array of either. */
function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return textOf(v[0]);
  return str(rec(v)['#text']);
}

function linkOf(d: Record<string, unknown>): string {
  const links = list(d.link);
  for (const l of links) {
    if (typeof l === 'string' && l.trim()) return l.trim();
  }
  const alt = links.map(rec).find((l) => !str(l['@_rel']) || str(l['@_rel']) === 'alternate');
  if (alt && str(alt['@_href'])) return str(alt['@_href']).trim();
  return (textOf(d.guid) || textOf(d.id)).trim();
}

/** RSS 2.0 items or Atom entries. Throws a bad_response SourceError when the text is not a feed (for example an HTML page). */
export function parseFeed(source: string, xml: string): FeedEntry[] {
  if (looksLikeHtml(xml) || !/<(rss|feed|rdf:RDF)\b/i.test(xml)) throw badResponse(source, 'response was not an RSS or Atom feed');
  let doc: Record<string, unknown>;
  try {
    doc = rec(parser.parse(xml));
  } catch {
    throw badResponse(source, 'feed XML could not be read');
  }
  const channel = rec(rec(doc.rss).channel);
  const raw = list(channel.item).length ? list(channel.item) : list(rec(doc.feed).entry).length ? list(rec(doc.feed).entry) : list(rec(rec(doc['rdf:RDF'])).item);
  const out: FeedEntry[] = [];
  for (const r of raw) {
    const d = rec(r);
    const body = textOf(d['content:encoded']) || textOf(d.description) || textOf(d.summary) || textOf(d.content);
    out.push({
      title: cleanText(textOf(d.title)),
      url: linkOf(d),
      text: cleanText(body),
      published: textOf(d.pubDate) || textOf(d.published) || textOf(d.updated) || textOf(d['dc:date']) || null,
    });
  }
  return out;
}

/** The url, only when it is an http(s) address (anything else, such as javascript:, is dropped). */
export function webUrl(v: string): string {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch {
    return '';
  }
}

export interface RssOpts extends FeedOpts {
  /** The SSRF-guarded page fetcher (feed urls come from a setting, so they never go through the fixed-host helpers). */
  fetchPage: typeof fetchPageFn;
}

/** One feed. `q` is the feed url. Newest entries first as the feed lists them, at most 25. */
export async function rssFeed(q: string, opts: RssOpts): Promise<RawItem[]> {
  const url = webUrl(q);
  if (!url) throw new SourceError('bad_response', 'rss', 'rss: feed address is not a web address');
  const res = await opts.fetchPage(url, { userAgent: USER_AGENT, accept: 'feed', blockHosts: BANNED_DOMAINS, maxBytes: 1_500_000 });
  if (!res.ok) {
    if (res.status === 429) throw new SourceError('rate_limited', 'rss');
    if (res.status === 401 || res.status === 403) throw new SourceError('auth', 'rss', `rss: HTTP ${res.status}`);
    if (res.reason === 'not_html') throw badResponse('rss', 'response was not an RSS or Atom feed');
    throw new SourceError('http_error', 'rss', `rss: ${res.status ? `HTTP ${res.status}` : (res.reason ?? 'request failed')}`);
  }
  const out: RawItem[] = [];
  for (const e of parseFeed('rss', res.text)) {
    const link = webUrl(e.url);
    const it = link ? makeItem(sourceType, link, e.title, e.text || e.title, e.published) : null;
    if (it) out.push(it);
    if (out.length >= MAX_PER_QUERY) break;
  }
  return out;
}
