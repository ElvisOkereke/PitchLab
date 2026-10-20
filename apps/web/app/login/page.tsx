import type { Metadata } from 'next';
import { safeNext } from '@/lib/auth/safe-next';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Log in · Business cases' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { next } = await searchParams;
  return (
    <main className="login">
      <h1>Business cases</h1>
      <LoginForm next={safeNext(next)} />
    </main>
  );
}
