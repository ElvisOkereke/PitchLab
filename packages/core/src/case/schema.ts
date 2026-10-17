import { z } from 'zod';

/** AI-scored screening criteria (`gut` is owner-only and added elsewhere). */
export const CRITERIA = ['pain', 'roi', 'evidence', 'speed', 'autonomy', 'novelty', 'reach'] as const;
export type Criterion = (typeof CRITERIA)[number];

const criterionScore = z.object({ value: z.number().int().min(1).max(5), note: z.string() });

export const AiScoresSchema = z.object({
  pain: criterionScore,
  roi: criterionScore,
  evidence: criterionScore,
  speed: criterionScore,
  autonomy: criterionScore,
  novelty: criterionScore,
  reach: criterionScore,
});
export type AiScores = z.infer<typeof AiScoresSchema>;
