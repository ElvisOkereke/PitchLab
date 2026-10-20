'use client';

import { useActionState } from 'react';
import { loginAction, type LoginState } from '@/actions/auth';

/** One password field and a hidden `next`. Works without JS (the action posts as a plain form). */
export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(loginAction, {});
  return (
    <form action={formAction} className="card login-form">
      <input type="hidden" name="next" value={next} />
      <label htmlFor="password">Password</label>
      <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={1024} autoFocus />
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
      <button type="submit" disabled={pending}>
        {pending ? 'Logging in…' : 'Log in'}
      </button>
    </form>
  );
}
