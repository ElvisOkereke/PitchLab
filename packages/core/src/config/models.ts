export const MODEL_STAGES = [
  'extract', 'harvest', 'ideate', 'screen', 'gate', 'competitors', 'case', 'verify', 'score', 'embed',
  // Validation pack (Plan 3)
  'pack', 'prospect', 'outreach', 'landing',
  // Research library (Slice A)
  'research', 'library_extract',
  // Engine v2: sketching and the pairwise judge
  'sketch', 'judge',
  // Idea reviewer (gen audit review), outside the run pipeline
  'review',
] as const;

export type ModelStage = (typeof MODEL_STAGES)[number];

export type ModelFamily = 'claude' | 'gpt' | 'gemini' | 'other';

export const DEFAULT_MODELS: Record<ModelStage, string> = {
  extract: 'claude-haiku-5-5',
  harvest: 'claude-sonnet-5-5',
  ideate: 'claude-opus-5-5',
  screen: 'claude-haiku-5-5',
  gate: 'gpt-6-sol',
  competitors: 'claude-sonnet-5-5',
  case: 'claude-opus-5-5',
  verify: 'claude-sonnet-5-5',
  score: 'gemini-3.1-pro',
  embed: 'text-embedding-3-small',
  pack: 'claude-opus-5-5',
  prospect: 'claude-sonnet-5-5',
  outreach: 'claude-sonnet-5-5',
  landing: 'claude-sonnet-5-5',
  research: 'claude-sonnet-5-5',
  library_extract: 'claude-haiku-5-5',
  review: 'gemini-3.1-pro',
  sketch: 'claude-sonnet-5-5',
  judge: 'gpt-6-sol',
};

/** A stage without its own override takes the override of the stage it follows (review follows score, sketch follows ideate, judge follows gate). */
const FOLLOWS: Partial<Record<ModelStage, ModelStage>> = { review: 'score', sketch: 'ideate', judge: 'gate' };

/**
 * Claude models seen rejecting forced tool_choice (`tool`/`any`) with a 400 on the live run (2026-10-17):
 * 'tool_choice: type "tool" and "any" are not supported for this model.' Structured calls on these use
 * `auto` + an instruction from the start; other models fall back to that only after the same rejection.
 */
export const NO_FORCED_TOOL_CHOICE: ReadonlySet<string> = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

/** Stages that use the Anthropic web-search server tool, so must run on a claude model. */
const WEB_SEARCH_STAGES = ['harvest', 'competitors', 'case', 'prospect', 'research'] as const satisfies readonly ModelStage[];

export function isModelStage(value: string): value is ModelStage {
  return (MODEL_STAGES as readonly string[]).includes(value);
}

export function family(model: string): ModelFamily {
  if (model.startsWith('claude')) return 'claude';
  if (model.startsWith('gpt') || model.startsWith('text-embedding-')) return 'gpt';
  if (model.startsWith('gemini')) return 'gemini';
  return 'other';
}

export function adapterFor(model: string): 'anthropic' | 'openai' {
  return family(model) === 'claude' ? 'anthropic' : 'openai';
}

/** The model per stage: the defaults plus `overrides` (unknown keys ignored), with followed stages applied. */
export function resolveModelConfig(overrides: Record<string, string>): Record<ModelStage, string> {
  const own = (s: ModelStage): string | undefined => (Object.hasOwn(overrides, s) ? overrides[s] : undefined);
  return Object.fromEntries(MODEL_STAGES.map((s) => {
    const followed = FOLLOWS[s];
    return [s, own(s) ?? (followed ? own(followed) : undefined) ?? DEFAULT_MODELS[s]];
  })) as Record<ModelStage, string>;
}

export function validateModelConfig(m: Record<ModelStage, string>): void {
  const ideation = family(m.ideate);
  for (const stage of ['gate', 'score', 'review', 'judge'] as const) {
    if (family(m[stage]) === ideation) {
      throw new Error(`Model config: ${stage} model (${m[stage]}) must be a different family from ideate (${m.ideate})`);
    }
  }
  for (const stage of WEB_SEARCH_STAGES) {
    if (family(m[stage]) !== 'claude') {
      throw new Error(`Model config: ${stage} model (${m[stage]}) must be a claude model (it uses web search)`);
    }
  }
}
