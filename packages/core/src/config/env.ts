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
  /** Optional: enables the Product Hunt collector in research missions (Reddit is not used). */
  PRODUCTHUNT_TOKEN: z.string().min(1).optional(),
  /** Optional: enables the YouTube comments source (official Data API v3) in research missions. */
  YOUTUBE_API_KEY: z.string().min(1).optional(),
  /** Optional: Bluesky sign-in for the feeds, used only if the public search endpoint demands auth (use an app password, never the account password). */
  BLUESKY_HANDLE: z.string().min(1).optional(),
  BLUESKY_APP_PASSWORD: z.string().min(1).optional(),
  /** Optional: the private Telegram bot the owner shares links to (finds). Only ever put in the Bot API url path, never logged. */
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  /** Optional: pins the bot's owner chat id (skips the /start <code> pairing). */
  TELEGRAM_OWNER_CHAT_ID: z.string().regex(/^-?\d{1,20}$/).optional(),
  /** Optional: a scraping service for pages still blocked after the real browser. Used only when both are set. */
  SCRAPER_PROVIDER: z.enum(['scrapingbee', 'zenrows', 'apify']).optional(),
  /** The provider's key. Only ever put in the provider request; never logged or stored. */
  SCRAPER_API_KEY: z.string().min(1).optional(),
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
