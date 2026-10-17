import { describe, expect, it } from 'vitest';
import { hasPriceFigure } from '../../src/case/schema';

describe('hasPriceFigure', () => {
  it.each([
    '$49/mo',
    '49 USD',
    'CA$29',
    '€10',
    '£5',
    '10 €',
    'From $99/month',
    'Starts at US$35.00/month (third-party listing)',
    'USD 15 per site',
    '29 per month',
    '29 per user per month',
    '12/user',
    '8 / site',
    '300/yr',
    '5 per seat',
    '40 per location',
    'Free',
    'Free tier',
    'free plan for 1 form',
    'Agency staff time (hourly rates $75–$200/hour cited)',
  ])('treats %j as a published price', (p) => {
    expect(hasPriceFigure(p)).toBe(true);
  });

  it.each([
    'Not published',
    'Contact sales',
    'Not published (first 150 testers)',
    "Not published (early access: 'The first 150 testers get an account right now.')",
    'Contact sales for 10+ seats',
    'Metered per form; dollar amounts not published',
    'Free trial, then contact sales',
    'Free demo on request',
    'Version 2.0 launched in 2024',
    '',
  ])('treats %j as not a published price', (p) => {
    expect(hasPriceFigure(p)).toBe(false);
  });
});
