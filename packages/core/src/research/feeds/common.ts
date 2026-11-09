import { capField } from '../../llm/untrusted';
import { cleanText, toDate, type RawItem } from '../../tools/sources/types';
import { SourceError } from '../http';
import type { CollectorOpts } from '../sources/federalregister';

/** At most this many items come back from one query. */
export const MAX_PER_QUERY = 25;
/** At most this many items are kept per source per run. */
export const MAX_PER_SOURCE = 200;
/** Each item's text is capped before extraction. */
export const MAX_TEXT = 4000;

/** Every feed collector takes the shared transport options (fetch, sleep, onCall, log, now). */
export type FeedOpts = CollectorOpts;
export type FeedCollector = (query: string, opts: FeedOpts) => Promise<RawItem[]>;

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A https url, or '' (anything else is never stored). */
export function httpsUrl(v: unknown): string {
  try {
    const u = new URL(str(v));
    return u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

/** A cleaned item, or null when it has no usable text. */
export function makeItem(source: string, url: string, title: string, text: string, published?: string | number | null): RawItem | null {
  const t = cleanText(title);
  const body = capField(cleanText(text), MAX_TEXT);
  if (!url || !(body || t)) return null;
  return { source, url, title: t, text: body || t, publishedAt: toDate(published ?? null) };
}

export const looksLikeHtml = (s: string): boolean => /^\s*(<!doctype html|<html)/i.test(s);

/** A response of the wrong shape (HTML where data was expected, a missing list): the source stops for this run. */
export const badResponse = (source: string, why: string): SourceError => new SourceError('bad_response', source, `${source}: ${why}`);
