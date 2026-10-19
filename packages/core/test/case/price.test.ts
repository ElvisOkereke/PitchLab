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
    // A percentage counts only next to fee vocabulary (contingency and percent-of-spend pricing).
    '20% fee',
    'Fee: 20%',
    'commission of 20%',
    '5-10% of media spend',
    'typically 5-10% of media spend',
    '20 to 30 percent of recovered credits',
    '15 percent of recovered credits',
    '10% commission',
    '12.5 % of savings',
    '25 per cent contingency',
    'takes a 15% cut',
    'charges 3% of collected',
    'Contingency rate 25–35%',
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
    'Up to 5 users included',
    'A percentage of recovered funds (rate not published)',
    // A bare percentage, or one about something other than a fee, is not a price.
    '20%',
    '20 to 30 percent',
    '99.9% uptime',
    'grew 30% YoY',
    '40% faster',
    // A discount off an unstated base gives no checkable price.
    '30% discount for annual plans',
    '',
  ])('treats %j as not a published price', (p) => {
    expect(hasPriceFigure(p)).toBe(false);
  });
});
