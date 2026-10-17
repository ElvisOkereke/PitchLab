import { z } from 'zod';
import { DEFAULT_MODELS, type ModelStage } from '../../src/config/models';
import { StructuredOutputError, type ModelRouter, type Source } from '../../src/llm/types';

export type FakeCall = { stage: ModelStage; kind: 'text' | 'structured' | 'research' | 'embed'; prompt: string };

export type FakeScript = {
  structured?: Partial<Record<ModelStage, unknown[]>>;
  research?: Partial<Record<ModelStage, { text: string; sources: Source[] }[]>>;
  text?: Partial<Record<ModelStage, string[]>>;
  embed?: (t: string[]) => number[][];
  models?: Partial<Record<ModelStage, string>>;
};

/** Scripted ModelRouter for stage tests: shifts queued responses per stage, records every call. */
export function fakeRouter(script: FakeScript): ModelRouter & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const models = { ...DEFAULT_MODELS, ...script.models };

  function next<T>(queues: Partial<Record<ModelStage, T[]>> | undefined, stage: ModelStage, kind: FakeCall['kind']): T {
    const queue = queues?.[stage];
    if (!queue || queue.length === 0) throw new Error(`fakeRouter: no scripted ${kind} response left for stage "${stage}"`);
    return queue.shift() as T;
  }

  return {
    calls,
    modelFor: (stage) => models[stage],

    async text(stage, { prompt }) {
      calls.push({ stage, kind: 'text', prompt });
      return next(script.text, stage, 'text');
    },

    async structured(stage, { prompt, schema }) {
      calls.push({ stage, kind: 'structured', prompt });
      const parsed = schema.safeParse(next(script.structured, stage, 'structured'));
      if (!parsed.success) {
        throw new StructuredOutputError(`${stage}: scripted structured response failed validation`, z.prettifyError(parsed.error));
      }
      return parsed.data;
    },

    async research(stage, { prompt }) {
      calls.push({ stage, kind: 'research', prompt });
      return next(script.research, stage, 'research');
    },

    async embed(texts) {
      calls.push({ stage: 'embed', kind: 'embed', prompt: texts.join('\n') });
      if (!script.embed) throw new Error('fakeRouter: no scripted embed function');
      return script.embed(texts);
    },
  };
}
