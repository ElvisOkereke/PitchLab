import { cleanup, fireEvent, render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { HelpTip } from '@/components/help-tip';
import { GLOSSARY } from '@/lib/glossary';

afterEach(cleanup);

describe('HelpTip', () => {
  it('renders a closed details whose summary names the term, and shows the text on click', () => {
    const { container, getByLabelText, getByText } = render(<HelpTip term="seed" />);
    const details = container.querySelector('details.help-tip') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const summary = getByLabelText(`What is ${GLOSSARY.seed.label}?`);
    expect(summary.tagName).toBe('SUMMARY');
    expect(summary.textContent).toBe('?');
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    expect(getByText(GLOSSARY.seed.text)).toBeTruthy();
  });

  it('is plain details/summary markup without JS', () => {
    const html = renderToStaticMarkup(<HelpTip term="worker" />);
    expect(html).toContain('<details class="help-tip"><summary aria-label="What is Worker?">?</summary><p>');
  });

  it('has a plain 1-3 sentence text for every term', () => {
    for (const { label, text } of Object.values(GLOSSARY)) {
      expect(label.length).toBeGreaterThan(0);
      expect((text.match(/[.!?](\s|$)/g) ?? []).length).toBeGreaterThanOrEqual(1);
      expect((text.match(/[.!?](\s|$)/g) ?? []).length).toBeLessThanOrEqual(3);
    }
  });
});
