/**
 * Web-safe (no imports). Text that replaces YouTube data once its source has expired (YouTube data is kept for at most
 * 30 days), shared by maintenance, the case review and the web.
 */
export const EXPIRED_PLACEHOLDER = '[expired YouTube data]';

/** Review note set on a claim whose YouTube quote was removed (true for library and model-chosen YouTube URLs alike). */
export const YOUTUBE_CLAIM_NOTE = 'YouTube quote removed (YouTube data is kept for at most 30 days)';

/** youtube.com and any subdomain (www., m., music.), plus youtu.be; "notyoutube.com" does not match. Same rule as maintenance's SQL. */
export function isYoutubeUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com');
}
