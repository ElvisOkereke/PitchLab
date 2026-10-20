import { safeHttpUrl } from '@bcg/core/case/links';
import type { ReactNode } from 'react';

/**
 * An absolute http(s) URL becomes a new-tab link (`rel="noopener noreferrer nofollow"`) showing its hostname, or
 * `children`; anything else (javascript:, data:, mailto:, relative, garbage) is shown as plain text.
 */
export function ExternalLink({ url, children }: { url: string; children?: ReactNode }) {
  const u = safeHttpUrl(url);
  if (!u) return <span className="url-text">{url}</span>;
  return (
    <a href={u.href} target="_blank" rel="noopener noreferrer nofollow">
      {children ?? u.hostname}
    </a>
  );
}
