import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckChip, StatusChip } from '@/components/status-chip';

afterEach(cleanup);

describe('StatusChip', () => {
  it.each([
    ['verified', '✅ verified'],
    ['unsupported', '❌ unsupported'],
    ['unreachable', '⚠️ unreachable'],
    ['needs_review', '🔍 needs review'],
    ['unverified', '⏳ unverified'],
  ] as const)('%s → class chip-%s and label %s', (status, label) => {
    const { container } = render(<StatusChip status={status} />);
    const chip = container.querySelector('span.chip')!;
    expect(chip.classList.contains(`chip-${status}`)).toBe(true);
    expect(chip.getAttribute('data-status')).toBe(status);
    expect(chip.textContent).toBe(label);
  });

  it('CheckChip shows a status chip with the export text, or plain text when unchecked', () => {
    const { container } = render(
      <>
        <CheckChip cell={{ status: 'verified', text: '✅ verified (old check: name + pricing)' }} />
        <CheckChip cell={{ status: null, text: '🔍 not published — check' }} />
      </>,
    );
    const chips = container.querySelectorAll('.chip');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toBe('✅ verified (old check: name + pricing)');
    expect(container.textContent).toContain('🔍 not published — check');
  });
});
