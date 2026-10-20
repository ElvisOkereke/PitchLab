// Local acceptance of the running dashboard (Plan 2 Task 16). No browser: forms are submitted the way a browser
// without JavaScript does (the form's hidden Next action fields + the visible fields, multipart/form-data, POSTed to the
// form's action URL with Origin = the app origin, cookies kept in a jar).
//
//   BASE_URL=http://127.0.0.1:3000 ACCEPT_PASSWORD=... npm run acceptance -w apps/web
//
// Env (process env first, else the repo-root .env, like the server): BASE_URL (default http://127.0.0.1:3000),
// ACCEPT_PASSWORD (the owner password, never printed), DATABASE_URL (the same database the server uses; the script
// reads it and undoes its own writes), SESSION_SECRET / OWNER_PASSWORD_HASH / LLM_API_KEY (only searched for in the
// bundle check), ACCEPT_IDEA (idea text for the queued run), KEEP_QUEUED_RUN=1 (leave the run the script queues for
// `npm run worker -- --once`; by default it is deleted again).
// Run it against a production build (`next build && next start`) with `.next` from the same env. It trips the login
// rate limiter on purpose (last check): restart the server before running it again.
// Prints PASS/FAIL per check; exit 0 only when every check passes. Never prints a secret, a cookie or a URL with a password.
import { readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import pg from 'pg';
import { checkBundle, loadEnv } from './check-bundle.mjs';

const ENV = loadEnv();
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const BASE = new URL(ENV.BASE_URL ?? 'http://127.0.0.1:3000');
const ORIGIN = BASE.origin;
const PASSWORD = ENV.ACCEPT_PASSWORD ?? '';
const COOKIE = 'bcg_session'; // COOKIE_SECURE=false (plain http on localhost); `__Host-bcg_session` over https
const IDEA = ENV.ACCEPT_IDEA
  ?? 'A weekly email for Ontario landlords with 3-20 units listing new Landlord and Tenant Board rule changes and the exact notice forms affected.';
const KEEP_QUEUED_RUN = ENV.KEEP_QUEUED_RUN === '1';
const UNKNOWN_SLUG = 'no-such-case-acceptance';

// ---- results ----------------------------------------------------------------------------------------------------------

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` - ${detail}` : ''}`);
}
/** Runs one check; a throw is a FAIL with the message (messages here never contain secrets). */
async function check(id, fn) {
  try {
    const detail = await fn();
    record(id, true, typeof detail === 'string' ? detail : '');
  } catch (err) {
    record(id, false, err instanceof Error ? err.message : String(err));
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// ---- HTTP with a cookie jar -------------------------------------------------------------------------------------------

class Jar {
  constructor() {
    this.map = new Map();
  }
  header() {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  absorb(setCookies) {
    for (const line of setCookies) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a)) || value === '';
      if (expired) this.map.delete(name);
      else this.map.set(name, value);
    }
  }
}

/** One request with full control over the headers (no automatic Origin, no redirects followed). */
function request(method, path, { jar, headers = {}, body } = {}) {
  const url = new URL(path, BASE);
  const h = { Accept: 'text/html', ...headers };
  if (jar && jar.map.size && !('Cookie' in h)) h.Cookie = jar.header();
  if (body) h['Content-Length'] = String(body.length);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const setCookies = res.headers['set-cookie'] ?? [];
        if (jar) jar.absorb(setCookies);
        resolve({ status: res.statusCode, headers: res.headers, setCookies, text: Buffer.concat(chunks).toString('utf8'), url });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const get = (path, jar) => request('GET', path, { jar });
const locationPath = (res) => (res.headers.location ? new URL(res.headers.location, BASE) : null);
const isLoginRedirect = (res) => [303, 307, 308].includes(res.status) && locationPath(res)?.pathname === '/login';
const docOf = (html) => parseHTML(html).document;

// ---- no-JS form submission --------------------------------------------------------------------------------------------

/** The name/value pairs a browser would submit for `form` (no submitter button), in tree order. */
function formEntries(form) {
  const out = [];
  for (const el of form.querySelectorAll('input, select, textarea')) {
    const name = el.getAttribute('name');
    if (!name || el.hasAttribute('disabled') || el.closest('fieldset[disabled]')) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      const opts = [...el.querySelectorAll('option')];
      const chosen = opts.filter((o) => o.hasAttribute('selected'));
      for (const o of chosen.length ? chosen : opts.slice(0, 1)) out.push([name, o.getAttribute('value') ?? o.textContent]);
    } else if (tag === 'textarea') {
      out.push([name, el.textContent ?? '']);
    } else {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (['submit', 'button', 'reset', 'image', 'file'].includes(type)) continue;
      if ((type === 'checkbox' || type === 'radio') && !el.hasAttribute('checked')) continue;
      out.push([name, el.getAttribute('value') ?? (type === 'checkbox' || type === 'radio' ? 'on' : '')]);
    }
  }
  return out;
}

/** Field names in `form` (for picking criteria etc.). */
const fieldNames = (form) => [...form.querySelectorAll('[name]')].map((e) => e.getAttribute('name'));

/**
 * Submits `form` (found on the page at `pageUrl`) as multipart/form-data. `overrides`: name → value | value[] | null
 * (null removes the field). `origin`: the Origin header (default the app origin; null = send none).
 */
async function submit(pageUrl, form, overrides = {}, { jar, origin = ORIGIN, cookieHeader } = {}) {
  let entries = formEntries(form);
  for (const [name, v] of Object.entries(overrides)) {
    entries = entries.filter(([n]) => n !== name);
    if (v === null) continue;
    for (const one of Array.isArray(v) ? v : [v]) entries.push([name, one]);
  }
  const fd = new FormData();
  for (const [n, v] of entries) fd.append(n, v);
  const encoded = new Request('http://local/', { method: 'POST', body: fd });
  const body = Buffer.from(await encoded.arrayBuffer());
  const action = form.getAttribute('action');
  const target = action ? new URL(action, new URL(pageUrl, BASE)) : new URL(pageUrl, BASE);
  const headers = { 'Content-Type': encoded.headers.get('content-type') };
  if (origin !== null) headers.Origin = origin;
  if (cookieHeader !== undefined) headers.Cookie = cookieHeader;
  return request('POST', target.pathname + target.search, { jar: cookieHeader !== undefined ? undefined : jar, headers, body });
}

async function loadForm(pageUrl, selector, jar) {
  const res = await get(pageUrl, jar);
  assert(res.status === 200, `GET ${pageUrl} → ${res.status}`);
  const form = docOf(res.text).querySelector(selector);
  assert(form, `no ${selector} on ${pageUrl}`);
  return form;
}

// ---- routes from the app directory ------------------------------------------------------------------------------------

/** Every page/route under apps/web/app as a URL pattern (route groups dropped), so a new route is checked too. */
function appRoutes(dir = join(webRoot, 'app'), segs = []) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      const seg = /^\(.*\)$/.test(name) ? [] : [name];
      out.push(...appRoutes(full, [...segs, ...seg]));
    } else if (/^(page|route)\.(tsx?|jsx?)$/.test(name)) {
      out.push({ pattern: `/${segs.join('/')}`, kind: name.startsWith('page') ? 'page' : 'route' });
    }
  }
  return out;
}

/** Concrete paths for a pattern: `[slug]` → each real slug plus an unknown one; any other dynamic segment is unhandled. */
function expand(pattern, slugs) {
  const dyn = pattern.match(/\[[^\]]+\]/g) ?? [];
  if (dyn.length === 0) return [{ path: pattern, unknown: false }];
  if (dyn.length === 1 && dyn[0] === '[slug]') {
    return [...slugs.map((s) => ({ path: pattern.replace('[slug]', s), unknown: false })),
      { path: pattern.replace('[slug]', UNKNOWN_SLUG), unknown: true }];
  }
  return null;
}

// ---- forged session tokens --------------------------------------------------------------------------------------------

const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function forgedTokens() {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: 'owner', iat: now, exp: now + 3600, jti: 'acceptance' };
  const head = b64u({ alg: 'HS256' });
  const signed = `${head}.${b64u(payload)}`;
  const wrongKey = createHmac('sha256', 'not-the-session-secret-acceptance-0000').update(signed).digest('base64url');
  return { wrongSecret: `${signed}.${wrongKey}`, algNone: `${b64u({ alg: 'none' })}.${b64u(payload)}.` };
}

// ---- main -------------------------------------------------------------------------------------------------------------

async function main() {
  assert(PASSWORD.length >= 12, 'set ACCEPT_PASSWORD (the owner password)');
  assert(/^postgres(ql)?:\/\//.test(ENV.DATABASE_URL ?? ''), 'set DATABASE_URL (postgres://) to the server database');
  const db = new pg.Client({ connectionString: ENV.DATABASE_URL });
  await db.connect();
  const q = async (text, params = []) => (await db.query(text, params)).rows;

  try {
    const cases = await q('select id, slug, stage from cases order by slug');
    const slugs = cases.map((c) => c.slug);
    console.log(`Server ${ORIGIN}; ${cases.length} cases in the database.`);
    const routes = appRoutes();
    const expanded = [];
    const unhandled = [];
    for (const r of routes) {
      const e = expand(r.pattern, slugs);
      if (e) expanded.push(...e.map((x) => ({ ...x, pattern: r.pattern })));
      else unhandled.push(r.pattern);
    }
    console.log(`Routes from apps/web/app: ${routes.map((r) => r.pattern).join(', ')}`);

    // (a) unauthenticated: every route except /login redirects to /login (unknown slugs too: auth comes first).
    await check('a. unauthenticated GET of every route → /login', async () => {
      assert(unhandled.length === 0, `routes with an unhandled dynamic segment: ${unhandled.join(', ')}`);
      const bad = [];
      let n = 0;
      for (const { path } of expanded) {
        const res = await get(path);
        n += 1;
        if (path === '/login') {
          if (res.status !== 200) bad.push(`/login → ${res.status}`);
        } else if (!isLoginRedirect(res)) bad.push(`${path} → ${res.status} ${res.headers.location ?? ''}`);
      }
      assert(bad.length === 0, bad.join('; '));
      return `${n} paths (incl. ${UNKNOWN_SLUG}); all non-login → 307 /login`;
    });

    // (b) login
    const jar = new Jar();
    await check('b. wrong password → error, no cookie; right password → HttpOnly SameSite=Lax cookie, lands on /', async () => {
      const page = '/login?next=%2F%2Fevil.com';
      const form = await loadForm(page, 'form', new Jar());
      const nextValue = form.querySelector('input[name="next"]')?.getAttribute('value');
      assert(nextValue === '/', `login page next=//evil.com rendered next=${nextValue}`);
      const wrong = await submit(page, form, { password: 'definitely-not-the-password' }, { jar });
      assert(wrong.status === 200, `wrong password → ${wrong.status}`);
      assert(wrong.text.includes('Wrong password.'), 'wrong password: no "Wrong password." message');
      assert(!wrong.setCookies.some((c) => c.startsWith(`${COOKIE}=`)), 'wrong password set a session cookie');
      assert(jar.map.size === 0, 'cookie jar not empty after a wrong password');
      // The server must also ignore a hostile next in the POST body itself.
      const right = await submit(page, form, { password: PASSWORD, next: '//evil.com' }, { jar });
      assert(right.status === 303, `right password → ${right.status}`);
      const loc = locationPath(right);
      assert(loc && loc.origin === ORIGIN && loc.pathname === '/', `right password redirected to ${loc ? loc.pathname : 'nowhere'} (expected /)`);
      const sc = right.setCookies.find((c) => c.startsWith(`${COOKIE}=`));
      assert(sc, 'no session cookie set');
      assert(/;\s*httponly/i.test(sc), 'cookie is not HttpOnly');
      assert(/;\s*samesite=lax/i.test(sc), 'cookie is not SameSite=Lax');
      assert(/;\s*path=\//i.test(sc), 'cookie path is not /');
      const home = await get('/', jar);
      assert(home.status === 200, `GET / after login → ${home.status}`);
      const loginAgain = await get('/login', jar);
      assert([307, 308].includes(loginAgain.status) && locationPath(loginAgain)?.pathname === '/', 'authed /login does not go home');
      return 'wrong → "Wrong password.", no Set-Cookie; right → 303 /, HttpOnly; SameSite=Lax; Path=/ (next=//evil.com ignored)';
    });

    await check('a2. authenticated GET of every route → 200; unknown slug → 404', async () => {
      const bad = [];
      for (const { path, unknown } of expanded) {
        if (path === '/login') continue;
        const res = await get(path, jar);
        const want = unknown ? 404 : 200;
        if (res.status !== want) bad.push(`${path} → ${res.status} (want ${want})`);
      }
      for (const path of ['/cases/Not%20A%20Slug', '/cases/..%2F..%2Fetc', '/cases/UPPER-case/export.md']) {
        const res = await get(path, jar);
        if (res.status !== 404) bad.push(`${path} → ${res.status} (want 404)`);
      }
      assert(bad.length === 0, bad.join('; '));
      return `${expanded.length - 1} paths + 3 malformed slugs`;
    });

    // (a) unauthenticated Server Action posts change nothing (forms collected while logged in, replayed without a cookie).
    await check('a3. unauthenticated Server Action POSTs → /login, DB unchanged', async () => {
      const c = cases[0];
      const before = await q('select (select count(*)::int from stage_events) ev, (select count(*)::int from runs) runs, (select count(*)::int from scores) sc, (select stage from cases where id=$1) stage', [c.id]);
      const caseUrl = `/cases/${c.slug}?tab=score`;
      const move = await loadForm(caseUrl, 'form[data-testid="move-stage"]', jar);
      const score = await loadForm(caseUrl, 'form[data-testid="score-form"]', jar);
      const queue = await loadForm('/runs', 'form[data-testid="queue-run"]', jar);
      const posts = [
        await submit(caseUrl, move, { to: 'validating' }, { cookieHeader: '' }),
        await submit(caseUrl, score, { [fieldNames(score).find((n) => n.startsWith('value_'))]: '1' }, { cookieHeader: '' }),
        await submit('/runs', queue, { seedType: 'idea', ideaText: IDEA, ideaCount: '1', advanceCount: '1' }, { cookieHeader: '' }),
      ];
      const after = await q('select (select count(*)::int from stage_events) ev, (select count(*)::int from runs) runs, (select count(*)::int from scores) sc, (select stage from cases where id=$1) stage', [c.id]);
      assert(posts.every(isLoginRedirect), `statuses ${posts.map((p) => p.status).join(',')}`);
      assert(JSON.stringify(before) === JSON.stringify(after), 'DB changed');
      return 'move-stage, score, queue-run → 307 /login; stage_events/runs/scores/stage unchanged';
    });

    // (c) board counts
    await check('c. Board per-stage counts equal the DB', async () => {
      const res = await get('/', jar);
      const doc = docOf(res.text);
      const shown = Object.fromEntries([...doc.querySelectorAll('section[data-stage]')].map((s) => [s.getAttribute('data-stage'), Number(s.getAttribute('data-count'))]));
      const dbCounts = Object.fromEntries((await q('select stage::text, count(*)::int n from cases group by stage')).map((r) => [r.stage, r.n]));
      const stages = ['new', 'validating', 'pilot', 'live', 'killed'];
      for (const s of stages) assert(shown[s] === (dbCounts[s] ?? 0), `stage ${s}: board ${shown[s]} vs DB ${dbCounts[s] ?? 0}`);
      const total = Object.values(shown).reduce((a, b) => a + b, 0);
      assert(total === cases.length, `board total ${total} vs ${cases.length}`);
      const missing = slugs.filter((s) => !doc.querySelector(`a[href="/cases/${s}"]`));
      assert(missing.length === 0, `cases missing from the board: ${missing.join(', ')}`);
      return `${stages.map((s) => `${s}=${shown[s]}`).join(' ')} (DB total ${cases.length}); every slug linked`;
    });

    // (d) every case × 7 tabs + export
    await check('d. every case × 7 tabs → 200, no render error, no markup from case text; export.md', async () => {
      const tabs = ['summary', 'evidence', 'numbers', 'competitors', 'pitch', 'validate', 'score'];
      const bad = [];
      for (const slug of slugs) {
        for (const tab of tabs) {
          const res = await get(`/cases/${slug}?tab=${tab}`, jar);
          if (res.status !== 200) {
            bad.push(`${slug}/${tab} → ${res.status}`);
            continue;
          }
          const doc = docOf(res.text);
          if (doc.querySelector('[data-render-error]')) bad.push(`${slug}/${tab}: data-render-error`);
          const main = doc.querySelector('#case-content');
          if (!main || main.getAttribute('data-tab') !== tab) {
            bad.push(`${slug}/${tab}: #case-content data-tab=${main?.getAttribute('data-tab')}`);
            continue;
          }
          if (main.querySelector('script, iframe, img, style, object, embed')) bad.push(`${slug}/${tab}: active element in content`);
          for (const el of doc.querySelectorAll('*')) {
            for (const attr of el.attributes ?? []) {
              if (/^on/i.test(attr.name)) bad.push(`${slug}/${tab}: ${el.tagName.toLowerCase()}[${attr.name}]`);
            }
          }
          for (const a of main.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href').trim().toLowerCase();
            if (!/^(https?:|\/|#|\?)/.test(href)) bad.push(`${slug}/${tab}: link scheme ${href.slice(0, 12)}`);
            if (/^https?:/.test(href) && !(a.getAttribute('rel') ?? '').includes('noopener')) bad.push(`${slug}/${tab}: external link without noopener`);
          }
        }
        const ex = await get(`/cases/${slug}/export.md`, jar);
        if (ex.status !== 200) bad.push(`${slug} export → ${ex.status}`);
        else {
          if (!String(ex.headers['content-type']).startsWith('text/markdown')) bad.push(`${slug} export type ${ex.headers['content-type']}`);
          if (ex.headers['content-disposition'] !== `attachment; filename="${slug}.md"`) bad.push(`${slug} export disposition ${ex.headers['content-disposition']}`);
          if (!ex.text.startsWith('# ')) bad.push(`${slug} export does not start with "# "`);
        }
      }
      assert(bad.length === 0, bad.slice(0, 12).join('; ') + (bad.length > 12 ? ` (+${bad.length - 12} more)` : ''));
      return `${slugs.length} cases × ${tabs.length} tabs = ${slugs.length * tabs.length} pages; ${slugs.length} exports text/markdown + attachment filename`;
    });

    // (e) stage moves, restored afterwards (events the script created are deleted by id; updated_at/kill_reason restored)
    const target = cases.find((c) => c.stage === 'new');
    await check('e. stage move persists; Killed without a note refused; overturn works', async () => {
      assert(target, 'no case in stage new to move');
      const [snap] = await q('select stage::text, kill_reason, updated_at from cases where id=$1', [target.id]);
      const baseEvents = (await q('select id from stage_events where case_id=$1', [target.id])).map((r) => r.id);
      const page = `/cases/${target.slug}?tab=summary`;
      const stageNow = async () => (await q('select stage::text, kill_reason from cases where id=$1', [target.id]))[0];
      const newEvents = async () => q('select id, kind::text, from_stage::text f, to_stage::text t from stage_events where case_id=$1 and not (id = any($2::uuid[])) order by at', [target.id, baseEvents]);
      const steps = [];
      try {
        let res = await submit(page, await loadForm(page, 'form[data-testid="move-stage"]', jar), { to: 'validating', note: '' }, { jar });
        assert(res.status === 303 && locationPath(res)?.pathname === `/cases/${target.slug}`, `move → ${res.status} ${res.headers.location ?? ''}`);
        assert((await stageNow()).stage === 'validating', 'stage not validating after the move');
        let ev = await newEvents();
        assert(ev.length === 1 && ev[0].kind === 'move' && ev[0].f === 'new' && ev[0].t === 'validating', `events after move: ${JSON.stringify(ev)}`);
        const reloaded = await get(page, jar);
        assert(docOf(reloaded.text).querySelector('input[name="from"]')?.getAttribute('value') === 'validating', 'page does not show the new stage');
        steps.push('new→validating persisted (+1 move event)');

        res = await submit(page, await loadForm(page, 'form[data-testid="move-stage"]', jar), { to: 'new', note: '' }, { jar });
        assert(res.status === 303 && (await stageNow()).stage === 'new', `move back → ${res.status}`);
        steps.push('back to new');

        res = await submit(page, await loadForm(page, 'form[data-testid="move-stage"]', jar), { to: 'killed', note: '' }, { jar });
        assert(res.status === 200 && res.text.includes('Add a note saying why you are killing it.'), `kill without note → ${res.status}`);
        assert((await stageNow()).stage === 'new' && (await newEvents()).length === 2, 'kill without a note changed the DB');
        steps.push('Killed without note refused');

        res = await submit(page, await loadForm(page, 'form[data-testid="move-stage"]', jar), { to: 'killed', note: 'acceptance test kill (reverted)' }, { jar });
        assert(res.status === 303, `kill with note → ${res.status}`);
        let s = await stageNow();
        assert(s.stage === 'killed' && s.kill_reason === 'acceptance test kill (reverted)', 'kill not stored');
        res = await submit(page, await loadForm(page, 'form[data-testid="overturn-kill"]', jar), {}, { jar });
        assert(res.status === 303, `overturn → ${res.status}`);
        s = await stageNow();
        assert(s.stage === 'new' && s.kill_reason === null, `after overturn stage=${s.stage}`);
        ev = await newEvents();
        assert(ev.map((e) => e.kind).join(',') === 'move,move,kill,overturn', `event kinds ${ev.map((e) => e.kind).join(',')}`);
        steps.push('kill with note + overturn → new, events move,move,kill,overturn');
      } finally {
        const created = (await newEvents()).map((e) => e.id);
        if (created.length) await q('delete from stage_events where id = any($1::uuid[])', [created]);
        await q('update cases set stage=$2, kill_reason=$3, updated_at=$4 where id=$1', [target.id, snap.stage, snap.kill_reason, snap.updated_at]);
        const [after] = await q('select stage::text, kill_reason, updated_at from cases where id=$1', [target.id]);
        const left = await q('select count(*)::int n from stage_events where case_id=$1', [target.id]);
        assert(after.stage === snap.stage && left[0].n === baseEvents.length && +after.updated_at === +snap.updated_at,
          'restore failed: the case or its stage_events differ from before');
        steps.push(`restored (deleted ${created.length} events created by this script)`);
      }
      return steps.join('; ');
    });

    // (f) owner scores, restored afterwards
    await check('f. owner scores persist; a second save keeps the first values', async () => {
      const c = target ?? cases[0];
      const snapshot = await q('select * from scores where case_id=$1 and "by"=\'owner\'', [c.id]);
      const aiBefore = await q('select count(*)::int n from scores where case_id=$1 and "by"=\'ai\'', [c.id]);
      const page = `/cases/${c.slug}?tab=score`;
      const owner = async () => Object.fromEntries((await q('select criterion::text, value, note from scores where case_id=$1 and "by"=\'owner\' order by criterion::text', [c.id])).map((r) => [r.criterion, `${r.value}|${r.note}`]));
      const steps = [];
      try {
        const form = await loadForm(page, 'form[data-testid="score-form"]', jar);
        const criteria = fieldNames(form).filter((n) => n.startsWith('value_')).map((n) => n.slice('value_'.length));
        assert(criteria.length === 8 && criteria.includes('gut'), `score form criteria: ${criteria.join(',')}`);
        const [c1, c2, c3] = ['gut', ...criteria.filter((x) => x !== 'gut')];
        const blank = Object.fromEntries(criteria.flatMap((x) => [[`value_${x}`, ''], [`note_${x}`, '']]));
        let res = await submit(page, form, { ...blank, [`value_${c1}`]: '4', [`note_${c1}`]: 'acceptance A', [`value_${c2}`]: '2' }, { jar });
        assert(res.status === 200 && res.text.includes('Saved.'), `first save → ${res.status}`);
        let o = await owner();
        assert(o[c1] === '4|acceptance A' && o[c2] === '2|', `after first save: ${JSON.stringify(o)}`);
        const shown = await loadForm(page, 'form[data-testid="score-form"]', jar);
        const sel = (x) => shown.querySelector(`select[name="value_${x}"] option[selected]`)?.getAttribute('value');
        assert(sel(c1) === '4' && sel(c2) === '2', `reloaded form shows ${c1}=${sel(c1)} ${c2}=${sel(c2)}`);
        steps.push(`saved ${c1}=4 ${c2}=2, page shows them`);
        res = await submit(page, shown, { ...blank, [`value_${c3}`]: '5', [`note_${c3}`]: 'acceptance B' }, { jar });
        assert(res.status === 200 && res.text.includes('Saved.'), `second save → ${res.status}`);
        o = await owner();
        assert(o[c1] === '4|acceptance A' && o[c2] === '2|' && o[c3] === '5|acceptance B', `after second save: ${JSON.stringify(o)}`);
        steps.push(`second save (only ${c3}=5) kept ${c1}, ${c2}`);
        res = await submit(page, await loadForm(page, 'form[data-testid="score-form"]', jar), {}, { jar });
        assert(res.status === 200 && res.text.includes('Saved.'), `resubmit as rendered → ${res.status}`);
        assert(JSON.stringify(await owner()) === JSON.stringify(o), 'resubmitting the rendered form changed the scores');
        steps.push('resubmitting the rendered form changed nothing');
        const aiAfter = await q('select count(*)::int n from scores where case_id=$1 and "by"=\'ai\'', [c.id]);
        assert(aiAfter[0].n === aiBefore[0].n, 'AI score rows changed');
      } finally {
        await db.query('begin');
        await db.query('delete from scores where case_id=$1 and "by"=\'owner\'', [c.id]);
        for (const r of snapshot) {
          await db.query('insert into scores (id, case_id, criterion, value, note, "by", model, prompt_version, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [r.id, r.case_id, r.criterion, r.value, r.note, r.by, r.model, r.prompt_version, r.created_at]);
        }
        await db.query('commit');
        const n = await q('select count(*)::int n from scores where case_id=$1 and "by"=\'owner\'', [c.id]);
        assert(n[0].n === snapshot.length, 'owner scores not restored');
        steps.push(`restored ${snapshot.length} prior owner rows`);
      }
      return steps.join('; ');
    });

    // (g) hostile posts change nothing
    await check('g. foreign Origin, missing Origin, forged session cookie → refused, DB unchanged', async () => {
      const c = target ?? cases[0];
      const page = `/cases/${c.slug}?tab=summary`;
      const state = async () => JSON.stringify(await q('select stage::text, updated_at, (select count(*)::int from stage_events) ev from cases where id=$1', [c.id]));
      const before = await state();
      const form = await loadForm(page, 'form[data-testid="move-stage"]', jar);
      const out = [];
      const foreign = await submit(page, form, { to: 'validating' }, { jar, origin: 'http://evil.example' });
      out.push(`foreign ${foreign.status}`);
      assert(foreign.status >= 400, `foreign Origin → ${foreign.status}`);
      const missing = await submit(page, form, { to: 'validating' }, { jar, origin: null });
      out.push(`missing ${missing.status}`);
      assert(missing.status >= 400, `missing Origin → ${missing.status}`);
      const nullOrigin = await submit(page, form, { to: 'validating' }, { jar, origin: 'null' });
      out.push(`null ${nullOrigin.status}`);
      assert(nullOrigin.status >= 400, `Origin: null → ${nullOrigin.status}`);
      const { wrongSecret, algNone } = forgedTokens();
      for (const [label, tok] of [['wrong-secret', wrongSecret], ['alg-none', algNone]]) {
        const res = await submit(page, form, { to: 'validating' }, { cookieHeader: `${COOKIE}=${tok}` });
        out.push(`${label} ${res.status}`);
        assert(isLoginRedirect(res), `forged cookie (${label}) POST → ${res.status}`);
        const g = await request('GET', '/', { headers: { Cookie: `${COOKIE}=${tok}` } });
        assert(isLoginRedirect(g), `forged cookie (${label}) GET / → ${g.status}`);
      }
      assert((await state()) === before, 'DB changed');
      return `${out.join(', ')}; DB unchanged`;
    });

    // (h) queue a run
    await check('h. queue a run via the Runs form → a queued row', async () => {
      const queued = await q('select count(*)::int n from runs where status=\'queued\'');
      assert(queued[0].n < 3, `${queued[0].n} runs already queued (max 3)`);
      const baseIds = (await q('select id from runs')).map((r) => r.id);
      const form = await loadForm('/runs', 'form[data-testid="queue-run"]', jar);
      const res = await submit('/runs', form, { seedType: 'idea', ideaText: IDEA, ideaCount: '1', advanceCount: '1' }, { jar });
      assert(res.status === 200 && res.text.includes('Queued.'), `queue → ${res.status}`);
      const rows = await q('select id, status::text, config from runs where not (id = any($1::uuid[]))', [baseIds]);
      assert(rows.length === 1 && rows[0].status === 'queued', `new runs: ${rows.length}`);
      const cfg = rows[0].config;
      assert(cfg.seedType === 'idea' && cfg.ideaText === IDEA && cfg.ideaCount === 1 && cfg.advanceCount === 1 && cfg.marketId === 'ca-us', 'stored config differs');
      const runsPage = await get('/runs', jar);
      assert(runsPage.status === 200 && /badge[^"]*">queued</.test(runsPage.text), 'Runs page does not show a queued run');
      if (KEEP_QUEUED_RUN) {
        console.log(`  queued run kept for the worker: ${rows[0].id}`);
        return 'queued row stored (seed idea, 1/1, ca-us), shown on /runs; kept for the worker';
      }
      await q('delete from runs where id=$1 and status=\'queued\'', [rows[0].id]);
      return 'queued row stored (seed idea, 1/1, ca-us), shown on /runs; deleted again';
    });

    await check('logout → cookie cleared, / redirects to /login', async () => {
      const res = await get('/', jar);
      const form = [...docOf(res.text).querySelectorAll('form')].find((f) => /log ?out/i.test(f.textContent ?? ''));
      assert(form, 'no logout form');
      const out = await submit('/', form, {}, { jar });
      assert(out.status === 303 && locationPath(out)?.pathname === '/login', `logout → ${out.status}`);
      const sc = out.setCookies.find((c) => c.startsWith(`${COOKIE}=`));
      assert(sc && /max-age=0/i.test(sc), 'logout did not expire the cookie');
      assert(isLoginRedirect(await get('/', jar)), '/ after logout is not a login redirect');
      return '303 /login, Max-Age=0';
    });

    // (i) rate limit: last, because it locks logins until the server restarts.
    await check('i. repeated wrong logins are rate limited (also the right password)', async () => {
      const page = '/login';
      const messages = [];
      for (let i = 1; i <= 8; i += 1) {
        const form = await loadForm(page, 'form', new Jar());
        const res = await submit(page, form, { password: `wrong-password-${i}` }, { jar: new Jar() });
        assert(!res.setCookies.some((c) => c.startsWith(`${COOKIE}=`)), `attempt ${i} set a cookie`);
        messages.push(res.text.includes('Too many attempts') ? 'limited' : res.text.includes('Wrong password.') ? 'wrong' : `?${res.status}`);
      }
      const firstLimited = messages.indexOf('limited') + 1;
      assert(firstLimited >= 2 && firstLimited <= 7 && messages.slice(firstLimited - 1).every((m) => m === 'limited'), `attempts: ${messages.join(',')}`);
      const form = await loadForm(page, 'form', new Jar());
      const right = await submit(page, form, { password: PASSWORD }, { jar: new Jar() });
      assert(right.text.includes('Too many attempts') && !right.setCookies.some((c) => c.startsWith(`${COOKIE}=`)), 'right password accepted while limited');
      return `attempts 1-${firstLimited - 1} "Wrong password.", ${firstLimited}-8 "Too many attempts"; right password also refused while limited`;
    });

    // (j) bundle
    await check('j. .next/static holds no secret and no server markers', async () => {
      const r = checkBundle(ENV);
      assert(!r.missing, 'no .next/static (build first)');
      assert(r.skipped.length === 0 || r.skipped.every((s) => s === 'ACCEPT_PASSWORD'), `secrets not available to search: ${r.skipped.join(', ')}`);
      assert(r.ok, r.hits.map((h) => `${h.label} in ${h.file}`).join('; '));
      return `${r.files} files; searched ${r.needles.length} needles (${r.needles.join(', ')}); 0 hits`;
    });
  } finally {
    await db.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  console.log('The login limiter is now tripped: restart the server before using it or running this again.');
  return failed.length ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(`acceptance aborted: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
