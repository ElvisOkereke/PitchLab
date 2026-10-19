import { z } from 'zod';

const modelOverrides = z.string().transform((raw, ctx) => {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = z.record(z.string(), z.string()).safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // fall through to the issue below
  }
  ctx.addIssue({ code: 'custom', message: 'must be a JSON object of string values' });
  return z.NEVER;
});

const schema = z.object({
  LLM_API_KEY: z.string().min(1),
  LLM_ANTHROPIC_BASE_URL: z.string().min(1).default('https://api.fuelix.ai'),
  LLM_OPENAI_BASE_URL: z.string().min(1).default('https://api.fuelix.ai/v1'),
  DATABASE_URL: z.string().min(1).default('pglite://.data/pglite'),
  LLM_MAX_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  MODEL_OVERRIDES: modelOverrides.default({}),
  GITHUB_TOKEN: z.string().min(1).optional(),
  STACKEXCHANGE_KEY: z.string().min(1).optional(),
  /** Optional: enables the Google Places prospect source (Text Search, New). */
  GOOGLE_PLACES_API_KEY: z.string().min(1).optional(),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // Treat empty strings (e.g. from a copied .env.example) as unset.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((i) => String(i.path[0] ?? 'env')))];
    throw new Error(`Invalid environment: ${names.join(', ')}`);
  }
  return result.data;
}
