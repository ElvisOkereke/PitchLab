import type { Env } from '../../config/env';
import { createAppStoreSource } from './appstore';
import { createGithubSource } from './github';
import { createHnSource } from './hn';
import { createStackExchangeSource } from './stackexchange';
import type { SignalSource } from './types';
import { createWordpressSource } from './wordpress';

export type { RawItem, SignalSource, SearchOpts } from './types';
export { DEFAULT_WP_SLUGS } from './wordpress';
export { createHnSource, createStackExchangeSource, createGithubSource, createWordpressSource, createAppStoreSource };

export function buildSources(env: Env, market?: { countries: string[] }): SignalSource[] {
  return [
    createHnSource(),
    createStackExchangeSource({ key: env.STACKEXCHANGE_KEY }),
    createGithubSource({ token: env.GITHUB_TOKEN }),
    createWordpressSource(),
    createAppStoreSource({ countries: market?.countries ?? ['CA', 'US'] }),
  ];
}
