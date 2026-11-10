import type { StageFn } from '../types';

/**
 * The stage impl for the engine-v2 stages (sketch, archive, tournament, evolve) on a v1 run: it hands its input on
 * unchanged, so harvest's output reaches ideate exactly as before. The v2 impls replace it stage by stage.
 */
export const passthrough: StageFn = async (_deps, _run, input) => input ?? {};
