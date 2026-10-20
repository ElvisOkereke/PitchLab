/**
 * The parsed URL when `url` is an absolute http(s) URL, else null. Only such URLs may become links, in the Markdown
 * export and in the dashboard; anything else (javascript:, data:, mailto:, relative paths) is shown as plain text.
 */
export function safeHttpUrl(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
}
