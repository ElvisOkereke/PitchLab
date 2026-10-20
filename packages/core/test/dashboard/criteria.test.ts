import { describe, expect, it } from 'vitest';
import { CRITERION_LABEL, OWNER_CRITERIA, scoreSummary } from '../../src/dashboard/criteria';

const at = (s: number) => new Date(Date.UTC(2026, 9, 19, 0, 0, s));
type Row = Parameters<typeof scoreSummary>[0][number];
const row = (by: 'ai' | 'owner', criterion: Row['criterion'], value: number, s = 0, note = ''): Row =>
  ({ by, criterion, value, note, createdAt: at(s) });

describe('criteria', () => {
  it('has the 7 AI criteria plus gut, each labelled', () => {
    expect(OWNER_CRITERIA).toEqual(['pain', 'roi', 'evidence', 'speed', 'autonomy', 'novelty', 'reach', 'gut']);
    expect(CRITERION_LABEL).toEqual({
      pain: 'Pain severity', roi: 'Buyer ROI clarity', evidence: 'Evidence strength', speed: 'Speed to market',
      autonomy: 'Autonomy', novelty: 'Novelty/non-generic', reach: 'Reachability', gut: 'Your gut',
    });
  });

  it('scoreSummary uses the latest row per criterion and rounds to 1 dp', () => {
    const s = scoreSummary([
      row('ai', 'pain', 1, 0), row('ai', 'pain', 3, 5, 'newer'),
      row('ai', 'roi', 3), row('ai', 'evidence', 3), row('ai', 'speed', 4), row('ai', 'autonomy', 4), row('ai', 'novelty', 3), row('ai', 'reach', 4),
    ]);
    expect(s.ai).toBe(3.4);
    expect(s.owner).toBeNull();
    expect(s.latest.pain).toEqual({ ai: { value: 3, note: 'newer' } });
  });

  it('owner mean includes gut; latest keeps ai and owner apart', () => {
    const s = scoreSummary([
      row('ai', 'pain', 2), row('owner', 'pain', 5, 1, 'mine'), row('owner', 'gut', 4, 1), row('owner', 'gut', 2, 0),
    ]);
    expect(s.ai).toBe(2);
    expect(s.owner).toBe(4.5);
    expect(s.latest.pain).toEqual({ ai: { value: 2, note: '' }, owner: { value: 5, note: 'mine' } });
    expect(s.latest.gut).toEqual({ owner: { value: 4, note: '' } });
  });

  it('an AI row for gut is ignored by the AI mean', () => {
    expect(scoreSummary([row('ai', 'gut', 5), row('ai', 'pain', 1)]).ai).toBe(1);
    expect(scoreSummary([]).ai).toBeNull();
  });
});
