import { caseToMarkdown } from '@bcg/core/case/export-markdown';
import { CASE_SLUG, getCaseView } from '@bcg/core/dashboard/case-view';
import { requireOwner } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';

const COMMON = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } as const;

function notFoundResponse(): Response {
  return new Response('Not found', { status: 404, headers: { ...COMMON, 'Content-Type': 'text/plain; charset=utf-8' } });
}

/**
 * The case as a Markdown download, from the same renderer as `gen export`. The slug is checked against the slug charset
 * (`[a-z0-9-]`, ≤ 120) before it is used anywhere, so no CR/LF, quote or path can reach the Content-Disposition header.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  await requireOwner();
  const { slug } = await ctx.params;
  if (typeof slug !== 'string' || !CASE_SLUG.test(slug)) return notFoundResponse();
  const view = await getCaseView(getDb(), slug);
  if (!view || !CASE_SLUG.test(view.case.slug)) return notFoundResponse();
  return new Response(caseToMarkdown(view.case, view.claims, view.scores), {
    status: 200,
    headers: {
      ...COMMON,
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${view.case.slug}.md"`,
    },
  });
}
