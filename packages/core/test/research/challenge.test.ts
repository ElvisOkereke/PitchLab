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

  describe('ordinary pages that carry bot-defence infrastructure are not challenges', () => {
    const article = (title: string, extra: string, body = 'Owners told us invoicing eats a full day every week. ') =>
      `<html><head><title>${title}</title>${extra}</head><body><article>${`<p>${body}</p>`.repeat(60)}</article></body></html>`;
    it.each([
      ['a long article with the Cloudflare jsd snippet', article('Pricing guide', '<script>(function(){var a=document.createElement("script");a.src="/cdn-cgi/challenge-platform/scripts/jsd/main.js";document.head.appendChild(a)})();</script>')],
      ['a PerimeterX sensor', article('Shop', '<script>window._pxAppId="PXabc123";</script><script src="//client.perimeterx.net/PXabc123/main.min.js"></script>')],
      ['an Incapsula resource script', article('News', '<script src="/_Incapsula_Resource?SWJIYLWA=719d34d31c8e3a6e6fffd425f7e032f3"></script>')],
      ['an article titled "A 10-point security check for your website"', article('A 10-point security check for your website', '')],
      ['an article about CAPTCHAs quoting "verify you are human"', article('Why CAPTCHAs fail', '', 'Sites ask you to "verify you are human" and then show traffic lights; access denied pages annoy people. ')],
      ['an article titled "Access denied: what a 403 means"', article('Access denied: what a 403 means', '')],
    ])('%s', (_name, html) => expect(looksLikeChallenge(html)).toBe(false));

    it.each([
      ['Cloudflare managed challenge', '<html><head><title>Just a moment...</title><script>window._cf_chl_opt={cvId:"3",cType:"managed"};</script></head><body><noscript>Enable JavaScript and cookies to continue</noscript><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=abc"></script></body></html>'],
      ['Cloudflare challenge without a title', '<html><body><div id="challenge-stage"></div><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script></body></html>'],
      ['Incapsula incident page', '<html><head><META NAME="robots" CONTENT="noindex,nofollow"></head><body><iframe src="/_Incapsula_Resource?CWUDNSAI=9&xinfo=1&incident_id=123-456&edet=12"></iframe>Request unsuccessful. Incapsula incident ID: 123-456</body></html>'],
      ['DataDome interstitial', '<html><head><title>example.com</title></head><body><script>var dd={"cid":"x","hsh":"y","host":"geo.captcha-delivery.com"}</script><script src="https://ct.captcha-delivery.com/c.js"></script></body></html>'],
      ['PerimeterX block page', '<html><head><title>Access to this page has been denied</title></head><body><div id="px-captcha"></div></body></html>'],
    ])('real interstitial: %s', (_name, html) => expect(looksLikeChallenge(html)).toBe(true));
  });

  it('is bounded on huge input', () => {
    const t0 = Date.now();
    expect(looksLikeChallenge('a'.repeat(5_000_000))).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
