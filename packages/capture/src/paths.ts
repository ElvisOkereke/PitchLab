import { join } from 'node:path';

/**
 * The capture browser's folders. `npm run capture:login` opens Chromium's persistent user data dir
 * (`.data/capture/browser`, which holds `Local State` with the cookie key) and the logins land in its `Default` profile.
 * yt-dlp gets the profile path (`--cookies-from-browser chromium:<profileDir>`) and takes its parent as the browser
 * folder, so it finds `Local State` there and can decrypt the cookies.
 */
export function captureBrowserDirs(root: string): { userDataDir: string; profileDir: string } {
  const userDataDir = join(root, '.data', 'capture', 'browser');
  return { userDataDir, profileDir: join(userDataDir, 'Default') };
}
