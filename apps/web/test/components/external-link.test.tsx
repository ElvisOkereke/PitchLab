import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ExternalLink } from '@/components/external-link';
import { TextBlock } from '@/components/text-block';

afterEach(cleanup);

describe('ExternalLink', () => {
  it('external links carry rel="noopener noreferrer nofollow" and target _blank', () => {
    const { container } = render(<ExternalLink url="https://a.test/x?y=1" />);
    const a = container.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://a.test/x?y=1');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(a.textContent).toBe('a.test');
  });

  it('uses the given label', () => {
    const { container } = render(<ExternalLink url="http://b.test/">open</ExternalLink>);
    expect(container.querySelector('a')!.textContent).toBe('open');
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'mailto:a@b.c', '/relative', 'notaurl', ' javascript:alert(1)'])(
    'renders %s as plain text, never a link',
    (url) => {
      const { container } = render(<ExternalLink url={url} />);
      expect(container.querySelector('a')).toBeNull();
      expect(container.querySelector('script')).toBeNull();
      expect(container.textContent).toBe(url);
    },
  );
});

describe('TextBlock', () => {
  it('keeps line breaks (pre-wrap) and renders markup as text', () => {
    const { container } = render(<TextBlock text={'line 1\n<b>line 2</b>'} />);
    const p = container.querySelector('p.pre')!;
    expect(p.textContent).toBe('line 1\n<b>line 2</b>');
    expect(container.querySelector('b')).toBeNull();
  });
});
