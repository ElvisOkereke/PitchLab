import { sanitizeError } from '../src/tools';

const dirs = {
  profileDir: 'Y:\CODING PROJECTS\Business_Case_Gen\.data\capture-profile',
  tmpDir: 'C:\Users\someone\AppData\Local\Temp\bcg-capture',
  toolsDir: 'Y:/CODING PROJECTS/Business_Case_Gen/.tools',
};

describe('sanitizeError', () => {
  it('strips paths under the profile, tmp and tools dirs, either slash style', () => {
    const raw = [
      'ERROR: could not read Y:\CODING PROJECTS\Business_Case_Gen\.data\capture-profile\Default\Cookies',
      'wrote C:/Users/someone/AppData/Local/Temp/bcg-capture/capture-1/audio.m4a',
      'Y:\CODING PROJECTS\Business_Case_Gen\.tools\yt-dlp.exe failed',
    ].join('\n');
    const out = sanitizeError(raw, dirs);
    expect(out).not.toMatch(/capture-profile/);
    expect(out).not.toMatch(/AppData/);
    expect(out).not.toMatch(/\.tools/);
    expect(out).not.toMatch(/someone/);
    expect(out).toMatch(/could not read/);
  });

  it('strips any other absolute path and anything under .data', () => {
    const out = sanitizeError('failed at D:\\secret\\place\\file.txt and /home/me/.data/x and C:/x/.data/y', dirs);
    expect(out).not.toMatch(/secret/);
    expect(out).not.toMatch(/\.data/);
    expect(out).not.toMatch(/home\/me/);
  });

  it('redacts tokens, cookies and signed query strings', () => {
    const raw = [
      'Cookie: sessionid=4455667788%3Aabcdefghij; csrftoken=ZZZZtoken',
      'Authorization: Bearer abcdef0123456789abcdef0123456789',
      'url https://scontent.cdninstagram.com/v/t51.mp4?oh=00_SIGNEDsig&oe=65ABC&_nc_sid=8b3546',
      'token=supersecretvalue key: AIzaSyA-1234567890abcdefghijklmnopqrs',
      'blob 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    ].join('\n');
    const out = sanitizeError(raw, dirs);
    for (const s of ['4455667788', 'ZZZZtoken', 'abcdef0123456789', 'SIGNEDsig', '_nc_sid', 'supersecretvalue', 'AIzaSy', '9f86d0818']) {
      expect(out).not.toContain(s);
    }
    expect(out).toContain('scontent.cdninstagram.com');
  });

  it('caps the length', () => {
    expect(sanitizeError('x '.repeat(5000), dirs).length).toBeLessThanOrEqual(500);
  });
});
