import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/actions/auth', () => ({ loginAction: vi.fn(async () => ({})) }));

const { default: LoginPage, metadata } = await import('@/app/login/page');

afterEach(cleanup);

describe('login page', () => {
  it('is named PitchLab in the title and the heading', async () => {
    expect(metadata.title).toBe('Log in · PitchLab');
    const view = render(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('PitchLab');
    expect(view.container.textContent).not.toContain('Business cases');
  });
});
