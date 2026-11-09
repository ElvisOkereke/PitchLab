import { detectPlatform, isHttpUrl } from '../src/platform';

describe('detectPlatform', () => {
  it.each([
    ['https://www.instagram.com/reel/Cabc123/', 'instagram'],
    ['https://instagram.com/p/xyz', 'instagram'],
    ['https://instagr.am/p/xyz', 'instagram'],
    ['https://www.tiktok.com/@someone/video/123', 'tiktok'],
    ['https://vm.tiktok.com/ZMabc/', 'tiktok'],
    ['https://www.youtube.com/shorts/abc', 'youtube'],
    ['https://m.youtube.com/watch?v=abc', 'youtube'],
    ['https://youtu.be/abc', 'youtube'],
    ['https://x.com/someone/status/1', 'x'],
    ['https://twitter.com/someone/status/1', 'x'],
    ['https://www.threads.net/@someone/post/abc', 'threads'],
    ['https://www.threads.com/@someone/post/abc', 'threads'],
    ['https://www.linkedin.com/posts/abc', 'linkedin'],
    ['https://lnkd.in/abc', 'linkedin'],
    ['https://www.facebook.com/reel/123', 'facebook'],
    ['https://fb.watch/abc/', 'facebook'],
    ['https://m.facebook.com/watch?v=1', 'facebook'],
    ['https://example.com/article', 'other'],
    ['https://notinstagram.com/p/1', 'other'],
    ['https://instagram.com.evil.example/p/1', 'other'],
    ['not a url', 'other'],
  ])('%s -> %s', (url, platform) => {
    expect(detectPlatform(url)).toBe(platform);
  });
});

describe('isHttpUrl', () => {
  it('accepts only http(s)', () => {
    expect(isHttpUrl('https://a.example/x')).toBe(true);
    expect(isHttpUrl('http://a.example/x')).toBe(true);
    expect(isHttpUrl('file:///C:/Windows/win.ini')).toBe(false);
    expect(isHttpUrl('ftp://a.example/')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('nonsense')).toBe(false);
  });
});
