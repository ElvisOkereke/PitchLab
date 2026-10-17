import { cleanText, getJson, toDate, type RawItem, type SignalSource } from './types';

interface Issue {
  html_url: string;
  title?: string;
  body?: string | null;
  created_at?: string;
}

export function createGithubSource(opts: { token?: string } = {}): SignalSource {
  return {
    id: 'github',
    async search(query, { limit, fetchImpl }) {
      const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}+is:issue&per_page=${limit}`;
      const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
      const json = (await getJson('github', url, fetchImpl, headers)) as { items?: Issue[] } | null;
      if (!json || !Array.isArray(json.items)) return [];
      const items: RawItem[] = json.items.map((i) => ({
        source: 'github',
        url: i.html_url,
        title: cleanText(i.title),
        text: cleanText((i.body ?? '').slice(0, 2000)) || cleanText(i.title),
        publishedAt: toDate(i.created_at),
      }));
      return items.slice(0, limit);
    },
  };
}
