import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/actions/auth', () => ({ loginAction: vi.fn(async () => ({})) }));

const { default: LoginPage, metadata } = await import('@/app/login/page');

afterEach(cleanup);

describe('login page', () => {
  it('tells the owner how to reset a forgotten password', async () => {
    const view = render(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(view.container.textContent).toContain('Forgot it? Run npm run reset-password on the computer that runs PitchLab.');
  });

  it('is named PitchLab in the title and the heading', async () => {
    expect(metadata.title).toBe('Log in · PitchLab');
    const view = render(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('PitchLab');
    expect(view.container.textContent).not.toContain('Business cases');
  });
});
