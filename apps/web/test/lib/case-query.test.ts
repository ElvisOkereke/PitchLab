import { describe, expect, it } from 'vitest';
import { caseHref, parseCaseQuery } from '@/lib/case-query';
import { returnPath, withNotice } from '@/lib/return-to';

describe('parseCaseQuery', () => {
  it('validates tab, page and notice; anything else falls back', () => {
    expect(parseCaseQuery({})).toEqual({ tab: 'summary', page: 1 });
    expect(parseCaseQuery({ tab: 'pitch', page: '3', notice: 'overturn_refused' })).toEqual({ tab: 'pitch', page: 3, notice: 'overturn_refused' });
    expect(parseCaseQuery({ tab: ['score', 'pitch'] }).tab).toBe('score');
    for (const tab of ['', 'SUMMARY', '<script>', 'validate;drop']) expect(parseCaseQuery({ tab }).tab).toBe('summary');
    for (const page of ['-3', '0', 'abc', '1.5', '1e9999', '99999999999']) expect(parseCaseQuery({ page }).page).toBeGreaterThanOrEqual(1);
    expect(parseCaseQuery({ page: '-3' }).page).toBe(1);
    expect(parseCaseQuery({ page: '99999999999' }).page).toBe(1_000_000);
    expect(parseCaseQuery({ notice: '<b>hi</b>' }).notice).toBeUndefined();
  });

  it('caseHref builds tab links (summary has no tab param)', () => {
    expect(caseHref('a-b')).toBe('/cases/a-b');
    expect(caseHref('a-b', 'summary')).toBe('/cases/a-b');
    expect(caseHref('a-b', 'validate', 2)).toBe('/cases/a-b?tab=validate&page=2');
    expect(caseHref('a-b', 'validate', 1)).toBe('/cases/a-b?tab=validate');
  });
});

describe('returnTo', () => {
  it('returnPath: absent → undefined; otherwise the safeNext-normalised path', () => {
    expect(returnPath(undefined)).toBeUndefined();
    expect(returnPath('')).toBeUndefined();
    expect(returnPath('/cases/a-b?tab=score')).toBe('/cases/a-b?tab=score');
    for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', '/%2F%2Fevil.com', 'javascript:alert(1)', 42]) expect(returnPath(bad)).toBe('/');
  });

  it('withNotice sets (or replaces) the notice parameter and stays same-origin', () => {
    expect(withNotice('/?stage=killed', 'overturn_refused')).toBe('/?stage=killed&notice=overturn_refused');
    expect(withNotice('/cases/a-b?tab=score&notice=old', 'overturn_refused')).toBe('/cases/a-b?tab=score&notice=overturn_refused');
    expect(withNotice('/cases/a-b', 'x y')).toBe('/cases/a-b?notice=x+y');
  });
});
