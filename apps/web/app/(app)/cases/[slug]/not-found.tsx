import Link from 'next/link';

/** Unknown or malformed case slug. */
export default function CaseNotFound() {
  return (
    <main className="case-page">
      <h1>Case not found</h1>
      <p>
        <Link href="/">Back to the board</Link>
      </p>
    </main>
  );
}
