import type { z } from 'zod';
import type { ModelStage } from '../config/models';

export type { ModelStage } from '../config/models';

export type Source = { url: string; title?: string; citedText?: string };

export type AdapterRequest = {
  model: string;
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens: number;
  jsonSchema?: { name: string; schema: object };
  webSearch?: { maxUses: number };
};

export type AdapterResponse = {
  text: string;
  json?: unknown;
  sources: Source[];
  usage: { inputTokens: number; outputTokens: number; searchRequests: number };
};

export interface ProviderAdapter {
  complete(r: AdapterRequest): Promise<AdapterResponse>;
  embed(model: string, texts: string[]): Promise<{ vectors: number[][]; inputTokens: number }>;
}

export type CallCtx = { runId: string | null; promptVersion: string };

export interface ModelRouter {
  text(stage: ModelStage, req: { system?: string; prompt: string; maxTokens?: number }, ctx: CallCtx): Promise<string>;
  structured<T>(
    stage: ModelStage,
    req: { system?: string; prompt: string; schema: z.ZodType<T>; schemaName: string; maxTokens?: number },
    ctx: CallCtx,
  ): Promise<T>;
  research(
    stage: ModelStage,
    req: { system?: string; prompt: string; maxSearches: number; maxTokens?: number },
    ctx: CallCtx,
  ): Promise<{ text: string; sources: Source[] }>;
  embed(texts: string[], ctx: CallCtx): Promise<number[][]>;
  /** The resolved model id for a stage. */
  modelFor(stage: ModelStage): string;
}

export class StructuredOutputError extends Error {
  issues: string;
  constructor(message: string, issues: string) {
    super(message);
    this.name = 'StructuredOutputError';
    this.issues = issues;
  }
}
