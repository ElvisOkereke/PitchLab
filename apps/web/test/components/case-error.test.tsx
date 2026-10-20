import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import CaseError from '@/app/(app)/cases/[slug]/error';

afterEach(cleanup);

describe('case error boundary', () => {
  it('uses neutral wording (it also catches action errors), keeps data-render-error and never shows the error text', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED postgres://u:secret@db/x'), { digest: 'd1' });
    const { container } = render(<CaseError error={error} reset={() => {}} />);
    expect(container.querySelector('[data-render-error]')).toBeTruthy();
    expect(container.textContent).toContain('Something went wrong on this case page. Reload or go back to the board.');
    expect(container.textContent).not.toContain('This tab could not be rendered');
    expect(container.textContent).not.toMatch(/ECONNREFUSED|secret|postgres/);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/');
  });
});
