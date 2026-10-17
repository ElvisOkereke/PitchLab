// Checks that every link displayed in exported case Markdown resolves (HTTP GET via fetchPage only).
// For each URL it prints the status and the marker shown next to it in the case, if any, so you can see
// whether a dead link is visibly flagged (claims are marked verified/unsupported/unreachable by the verify stage).
// Usage (from packages/core): npx tsx scripts/check-urls.ts ../../output/cases/<slug>.md [more.md ...]
import { readFileSync } from 'node:fs';
import { fetchPage } from '../src/tools/fetch-page';

// The owner's pilot site is never fetched (no permission yet).
const NEVER_FETCH = /(^|\.)gamersgetaway\.ca$/i;

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log('Usage: npx tsx scripts/check-urls.ts <case.md> [...]');
  process.exit(2);
}

for (const file of files) {
  const md = readFileSync(file, 'utf8');
  const lines = md.split('\n');
  // url -> sections it appears in, plus the flag on the line (or the claim line above a "Source:" line)
  const seen = new Map<string, { sections: Set<string>; flags: Set<string> }>();
  let section = '';
  lines.forEach((ln, i) => {
    if (ln.startsWith('## ')) section = ln.slice(3).trim();
    for (const m of ln.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) {
      const url = m[1]!;
      const e = seen.get(url) ?? { sections: new Set<string>(), flags: new Set<string>() };
      e.sections.add(section);
      // A claim's status is on its bullet line, two lines above its "Source:" line (Quote line between).
      const ctx = ln.includes('Source:') ? `${lines[i - 2] ?? ''} ${lines[i - 1] ?? ''} ${ln}` : ln;
      for (const f of ['verified', 'unsupported', 'unreachable', 'needs review', 'unverified']) if (ctx.includes(` ${f}`)) e.flags.add(f);
      seen.set(url, e);
    }
  });

  console.log(`\n${file}: ${seen.size} distinct urls`);
  const tally = { ok: 0, dead: 0, deadFlagged: 0, skipped: 0 };
  for (const [url, e] of seen) {
    const host = new URL(url).hostname;
    if (NEVER_FETCH.test(host)) {
      tally.skipped++;
      console.log(`SKIP  ${url} (pilot site, never fetched)`);
      continue;
    }
    const page = await fetchPage(url);
    const flags = [...e.flags].join(',') || '-';
    const where = [...e.sections].join(',');
    if (page.ok || page.reason === 'not_html') {
      tally.ok++;
      console.log(`OK    ${page.status} ${url} [${where}] flags=${flags}`);
    } else {
      tally.dead++;
      if (e.flags.has('unreachable') || e.flags.has('unsupported')) tally.deadFlagged++;
      console.log(`DEAD  ${page.status} ${page.reason} ${url} [${where}] flags=${flags}`);
    }
  }
  console.log(`summary: ok=${tally.ok} dead=${tally.dead} (flagged ${tally.deadFlagged}) skipped=${tally.skipped}`);
}
