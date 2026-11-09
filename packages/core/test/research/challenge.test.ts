import { describe, expect, it } from 'vitest';
import { looksLikeChallenge } from '../../src/research/challenge';

describe('looksLikeChallenge', () => {
  it.each([
    ['Cloudflare interstitial', '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>'],
    ['Cloudflare challenge script', '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script><div id="cf-chl-widget"></div>'],
    ['Cloudflare block page', '<title>Attention Required! | Cloudflare</title>'],
    ['human check', '<p>Please verify you are human by completing the action below.</p>'],
    ['are-you-a-robot', '<h1>Are you a robot?</h1>'],
    ['DataDome', '<script src="https://ct.captcha-delivery.com/c.js"></script>'],
    ['PerimeterX', '<div id="px-captcha"></div><script>window._pxAppId="PXabc";</script>'],
    ['Incapsula', '<iframe src="/_Incapsula_Resource?SWJIYLWA=1"></iframe>'],
    ['Akamai', '<title>Access Denied</title><p>You don\'t have permission to access this on this server. Reference #18.abc</p>'],
    ['hCaptcha/Turnstile wall', '<div class="cf-turnstile" data-sitekey="x"></div><p>Checking if the site connection is secure</p>'],
    ['DDoS-Guard', '<title>DDoS-Guard</title>'],
  ])('%s', (_name, html) => expect(looksLikeChallenge(html)).toBe(true));

  it.each([
    ['an article about Cloudflare', `<html><title>How Cloudflare works</title><body>${'Cloudflare runs a big network. '.repeat(100)}</body></html>`],
    ['an article that says "just a moment" in the body', `<html><title>Recipes</title><body><p>${'Just a moment of patience makes good bread. '.repeat(60)}</p></body></html>`],
    ['empty', ''],
    ['plain page', '<html><title>Pricing</title><body>Plans from $9</body></html>'],
  ])('not %s', (_name, html) => expect(looksLikeChallenge(html)).toBe(false));

  it('is bounded on huge input', () => {
    const t0 = Date.now();
    expect(looksLikeChallenge('a'.repeat(5_000_000))).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
