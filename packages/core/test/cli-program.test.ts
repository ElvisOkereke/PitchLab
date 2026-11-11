import { describe, it, expect, vi } from 'vitest';
import { CliError, buildProgram, checkConfigKey, checkConfigValue, resumeRefusal, type CliHandlers } from '../src/cli-program';

function handlers() {
  const ok = async () => 0;
  return {
    run: vi.fn(ok), resume: vi.fn(ok), export: vi.fn(ok), runs: vi.fn(ok),
    validate: vi.fn(ok), prospectsImport: vi.fn(ok), outreachMark: vi.fn(ok), outreachStatus: vi.fn(ok),
    configSet: vi.fn(ok), configGet: vi.fn(ok), worker: vi.fn(ok), feedsRun: vi.fn(ok), findsAdd: vi.fn(ok), findsList: vi.fn(ok), findsRun: vi.fn(ok), telegramReset: vi.fn(ok),
    benchBaseline: vi.fn(ok), benchRun: vi.fn(ok), benchReport: vi.fn(ok), research: vi.fn(ok), researchStatus: vi.fn(ok),
    auditReview: vi.fn(ok), auditHoldoutAdd: vi.fn(ok), auditHoldoutList: vi.fn(ok), auditHoldoutClear: vi.fn(ok), auditScale: vi.fn(ok), auditBacktest: vi.fn(ok), libraryAssess: vi.fn(ok),
  } satisfies CliHandlers;
}

async function parse(args: string[]) {
  const h = handlers();
  const program = buildProgram(h);
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  const override = (c: typeof program) => {
    c.exitOverride();
    for (const s of c.commands) override(s);
  };
  override(program);
  await program.parseAsync(['node', 'gen', ...args]);
  return h;
}

describe('gen validate', () => {
  it('parses every option', async () => {
    const h = await parse([
      'validate', 'freight', '--prospects', '10', '--source', 'places', '--include-weak', '--pilot-site', 'https://pilot-site.com', '--refresh', '--redraft',
    ]);
    expect(h.validate).toHaveBeenCalledWith('freight', {
      prospects: 10, source: 'places', includeWeak: true, pilotSite: 'https://pilot-site.com', refresh: true, redraft: true,
    });
  });

  it('--redraft is a flag of its own', async () => {
    expect((await parse(['validate', 'freight', '--redraft'])).validate).toHaveBeenCalledWith('freight', { redraft: true });
    expect((await parse(['validate', 'freight', '--skip-prospects', '--redraft'])).validate)
      .toHaveBeenCalledWith('freight', { skipProspects: true, redraft: true });
  });

  it('defaults to no options; --skip-prospects is a flag', async () => {
    expect((await parse(['validate', 'freight'])).validate).toHaveBeenCalledWith('freight', {});
    expect((await parse(['validate', 'freight', '--skip-prospects'])).validate).toHaveBeenCalledWith('freight', { skipProspects: true });
  });

  it('rejects a bad --prospects count and an unknown --source', async () => {
    await expect(parse(['validate', 'freight', '--prospects', '0'])).rejects.toThrow(/positive whole number/);
    await expect(parse(['validate', 'freight', '--prospects', 'ten'])).rejects.toThrow(/positive whole number/);
    await expect(parse(['validate', 'freight', '--prospects', '500'])).rejects.toThrow(/at most 100/);
    await expect(parse(['validate', 'freight', '--source', 'csv'])).rejects.toThrow();
  });

  it('rejects a --pilot-site that is not an http(s) URL with a registrable domain (P3-R21)', async () => {
    for (const bad of ['notaurl', 'ftp://acme.com', 'https://localhost', 'https://10.0.0.1', 'acme.com']) {
      await expect(parse(['validate', 'freight', '--pilot-site', bad]), bad).rejects.toThrow(/--pilot-site must be an http\(s\) URL/);
    }
    expect((await parse(['validate', 'freight', '--pilot-site', 'https://gamersgetaway.ca'])).validate)
      .toHaveBeenCalledWith('freight', { pilotSite: 'https://gamersgetaway.ca' });
  });
});

describe('gen prospects import / outreach / config', () => {
  it('prospects import needs --file', async () => {
    expect((await parse(['prospects', 'import', 'freight', '--file', 'list.csv'])).prospectsImport).toHaveBeenCalledWith('freight', { file: 'list.csv' });
    await expect(parse(['prospects', 'import', 'freight'])).rejects.toThrow();
  });

  it('outreach mark takes a prospect id or email, a known type and an optional note', async () => {
    expect((await parse(['outreach', 'mark', 'ops@acme.com', 'sent'])).outreachMark).toHaveBeenCalledWith('ops@acme.com', 'sent', {});
    expect((await parse(['outreach', 'mark', 'ops@acme.com', 'positive', '--note', 'wants a call'])).outreachMark)
      .toHaveBeenCalledWith('ops@acme.com', 'positive', { note: 'wants a call' });
    for (const t of ['replied', 'meeting', 'not_interested', 'unsubscribe']) {
      expect((await parse(['outreach', 'mark', 'x@y.com', t])).outreachMark).toHaveBeenCalledWith('x@y.com', t, {});
    }
    await expect(parse(['outreach', 'mark', 'x@y.com', 'bought'])).rejects.toThrow();
  });

  it('outreach mark note needs --note (interviews are notes starting "interview:")', async () => {
    expect((await parse(['outreach', 'mark', 'x@y.com', 'note', '--note', 'interview: ops'])).outreachMark)
      .toHaveBeenCalledWith('x@y.com', 'note', { note: 'interview: ops' });
    await expect(parse(['outreach', 'mark', 'x@y.com', 'note'])).rejects.toThrow(/--note/);
  });

  it('outreach status and config set/get', async () => {
    expect((await parse(['outreach', 'status', 'freight'])).outreachStatus).toHaveBeenCalledWith('freight');
    expect((await parse(['config', 'set', 'sender.name', 'Ann Owner'])).configSet).toHaveBeenCalledWith('sender.name', 'Ann Owner');
    expect((await parse(['config', 'get', 'sender.name'])).configGet).toHaveBeenCalledWith('sender.name');
    expect((await parse(['config', 'get'])).configGet).toHaveBeenCalledWith(undefined);
  });

  it('config set refuses keys outside sender./landing. and bad endpoint values', async () => {
    await expect(parse(['config', 'set', 'llm.key', 'x'])).rejects.toThrow(/sender\.|landing\./);
    await expect(parse(['config', 'get', 'DATABASE_URL'])).rejects.toThrow(/sender\.|landing\./);
    expect(() => checkConfigKey('sender.name')).not.toThrow();
    expect(() => checkConfigKey('landing.formEndpoint')).not.toThrow();
    expect(() => checkConfigKey('sender.')).toThrow(CliError);
    expect(() => checkConfigKey('sender.name.x')).toThrow(CliError);
    expect(() => checkConfigValue('landing.formEndpoint', 'javascript:alert(1)')).toThrow(/http/);
    expect(() => checkConfigValue('landing.formEndpoint', 'https://forms.owner.ca/x')).not.toThrow();
    expect(() => checkConfigValue('sender.name', 'x'.repeat(600))).toThrow(/too long/);
  });

  it('worker --feeds is passed through, and `feeds run` calls the handler (other actions are refused)', async () => {
    expect((await parse(['worker', '--once', '--feeds'])).worker).toHaveBeenCalledWith({ interval: 10, once: true, feeds: true });
    expect((await parse(['feeds', 'run'])).feedsRun).toHaveBeenCalledTimes(1);
    await expect(parse(['feeds', 'nope'])).rejects.toThrow(/gen feeds run/);
  });

  it('library assess takes --max-usd (default 25, 0.5 to 25) and refuses other actions', async () => {
    expect((await parse(['library', 'assess'])).libraryAssess).toHaveBeenCalledWith({ maxUsd: 25 });
    expect((await parse(['library', 'assess', '--max-usd', '3'])).libraryAssess).toHaveBeenCalledWith({ maxUsd: 3 });
    await expect(parse(['library', 'assess', '--max-usd', '100'])).rejects.toThrow(/--max-usd/);
    await expect(parse(['library', 'nope'])).rejects.toThrow(/gen library assess/);
  });

  it('finds add <url> [note], finds list and finds run call their handlers; other actions are refused', async () => {
    expect((await parse(['finds', 'add', 'https://www.tiktok.com/@a/video/1', 'great', 'idea'])).findsAdd).toHaveBeenCalledWith('https://www.tiktok.com/@a/video/1', 'great idea');
    expect((await parse(['finds', 'add', 'https://example.com/x'])).findsAdd).toHaveBeenCalledWith('https://example.com/x', undefined);
    expect((await parse(['finds', 'list'])).findsList).toHaveBeenCalledTimes(1);
    expect((await parse(['finds', 'run'])).findsRun).toHaveBeenCalledTimes(1);
    await expect(parse(['finds', 'add'])).rejects.toThrow(/gen finds add/);
    await expect(parse(['finds', 'nope'])).rejects.toThrow(/gen finds/);
    await expect(parse(['finds', 'list', 'extra'])).rejects.toThrow(/gen finds/);
  });

  it('telegram reset calls its handler; other actions are refused', async () => {
    expect((await parse(['telegram', 'reset'])).telegramReset).toHaveBeenCalledTimes(1);
    await expect(parse(['telegram', 'nope'])).rejects.toThrow(/gen telegram reset/);
  });

  it('worker takes an --interval in seconds (default 10, minimum 2) and --once', async () => {
    expect((await parse(['worker'])).worker).toHaveBeenCalledWith({ interval: 10 });
    expect((await parse(['worker', '--interval', '2', '--once'])).worker).toHaveBeenCalledWith({ interval: 2, once: true });
    for (const bad of ['1', '0', 'ten', '2.5']) {
      await expect(parse(['worker', '--interval', bad]), bad).rejects.toThrow(/--interval/);
    }
  });

  it('resume takes failed or running runs only (D2-R3)', () => {
    expect(resumeRefusal('failed')).toBeNull();
    expect(resumeRefusal('running')).toBeNull();
    expect(resumeRefusal('queued')).toBe('run is queued for the worker; let the worker take it or requeue after it fails');
    expect(resumeRefusal('succeeded')).toMatch(/already succeeded/);
  });

  it('existing commands keep their options', async () => {
    expect((await parse(['export', 'freight'])).export).toHaveBeenCalledWith('freight', {});
    expect((await parse(['export', '--all'])).export).toHaveBeenCalledWith(undefined, { all: true });
    expect((await parse(['run', '--seed', 'sector', '--sectors', 'a,b'])).run).toHaveBeenCalledWith({ seed: 'sector', sectors: 'a,b' });
    expect((await parse(['runs'])).runs).toHaveBeenCalled();
  });

  it('run --finds seeds a run from finds: the most recent ones, or the ids given (sources expansion §C)', async () => {
    const a = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const b = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    expect((await parse(['run', '--finds'])).run).toHaveBeenCalledWith({ seed: 'finds' });
    expect((await parse(['run', '--finds', a, b, '--ideas', '4'])).run).toHaveBeenCalledWith({ seed: 'finds', findIds: [a, b], ideas: '4' });
    expect((await parse(['run', '--seed', 'finds'])).run).toHaveBeenCalledWith({ seed: 'finds' });
    await expect(parse(['run', '--seed', 'open', '--finds'])).rejects.toThrow(/--finds/);
    await expect(parse(['run'])).rejects.toThrow(/--seed/);
  });
});

describe('gen bench', () => {
  it('parses baseline, run and report', async () => {
    expect((await parse(['bench', 'baseline', '--force'])).benchBaseline).toHaveBeenCalledWith({ force: true });
    expect((await parse(['bench', 'baseline'])).benchBaseline).toHaveBeenCalledWith({});
    expect((await parse(['bench', 'baseline', '--dry-run'])).benchBaseline).toHaveBeenCalledWith({ dryRun: true });
    expect((await parse(['bench', 'run'])).benchRun).toHaveBeenCalledWith();
    expect((await parse(['bench', 'report', 'abc', '--recompute'])).benchReport).toHaveBeenCalledWith('abc', { recompute: true });
    expect((await parse(['bench', 'report'])).benchReport).toHaveBeenCalledWith(undefined, {});
  });
});

describe('gen audit review', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  it('takes a pass id or --last, plus --dry-run', async () => {
    expect((await parse(['audit', 'review', id])).auditReview).toHaveBeenCalledWith(id, {});
    expect((await parse(['audit', 'review', '--last'])).auditReview).toHaveBeenCalledWith(undefined, { last: true });
    expect((await parse(['audit', 'review', id, '--dry-run'])).auditReview).toHaveBeenCalledWith(id, { dryRun: true });
    expect((await parse(['audit', 'review', '--last', '--dry-run'])).auditReview).toHaveBeenCalledWith(undefined, { last: true, dryRun: true });
  });

  it('needs exactly one of a pass id and --last, and a well-formed id', async () => {
    await expect(parse(['audit', 'review'])).rejects.toThrow(/pass id or --last/);
    await expect(parse(['audit', 'review', id, '--last'])).rejects.toThrow(/pass id or --last/);
    await expect(parse(['audit', 'review', 'abc'])).rejects.toThrow(/not a pass id/);
    await expect(parse(['audit', 'review', 'abc'])).rejects.toBeInstanceOf(CliError);
  });
});

describe('gen research', () => {
  it('queues a topic with defaults', async () => {
    expect((await parse(['research', 'freight brokers'])).research).toHaveBeenCalledWith('freight brokers', {});
  });

  it('parses every option', async () => {
    const h = await parse(['research', 'freight brokers', '--kinds', 'problem,pricing', '--countries', 'CA,US', '--audience', 'business', '--budget', '3.5']);
    expect(h.research).toHaveBeenCalledWith('freight brokers', { kinds: ['problem', 'pricing'], countries: ['CA', 'US'], audience: 'business', budget: 3.5 });
  });

  it('status lists missions instead of queueing', async () => {
    const h = await parse(['research', 'status']);
    expect(h.researchStatus).toHaveBeenCalled();
    expect(h.research).not.toHaveBeenCalled();
  });

  it('status refuses options', async () => {
    await expect(parse(['research', 'status', '--budget', '3'])).rejects.toThrow(/no options/);
  });

  it('uppercases lowercase country codes', async () => {
    const h = await parse(['research', 'freight brokers', '--countries', 'ca, us,Global']);
    expect(h.research).toHaveBeenCalledWith('freight brokers', { countries: ['CA', 'US', 'global'] });
  });

  it('accepts all six kinds', async () => {
    const h = await parse(['research', 'x topic', '--kinds', 'problem,startup,pricing,trend,rule_change,market']);
    expect(h.research).toHaveBeenCalledWith('x topic', { kinds: ['problem', 'startup', 'pricing', 'trend', 'rule_change', 'market'] });
  });

  it('rejects bad kinds, audience, countries and budget', async () => {
    await expect(parse(['research', 'x topic', '--kinds', 'gossip'])).rejects.toThrow(/kinds/);
    await expect(parse(['research', 'x topic', '--audience', 'everyone'])).rejects.toThrow();
    await expect(parse(['research', 'x topic', '--countries', 'canada'])).rejects.toThrow(/countries/);
    await expect(parse(['research', 'x topic', '--budget', '0.1'])).rejects.toThrow(/budget/);
    await expect(parse(['research', 'x topic', '--budget', 'lots'])).rejects.toThrow(/budget/);
    await expect(parse(['research', 'x topic', '--budget', '25.01'])).rejects.toThrow(/budget/);
  });

  it('accepts a budget up to 25', async () => {
    const h = await parse(['research', 'x topic', '--budget', '25']);
    expect(h.research).toHaveBeenCalledWith('x topic', { budget: 25 });
  });
});

describe('gen audit holdout', () => {
  it('routes add, list and clear', async () => {
    expect((await parse(['audit', 'holdout', 'add', 'an AI bookkeeper'])).auditHoldoutAdd).toHaveBeenCalledWith('an AI bookkeeper');
    expect((await parse(['audit', 'holdout', 'list'])).auditHoldoutList).toHaveBeenCalled();
    expect((await parse(['audit', 'holdout', 'clear'])).auditHoldoutClear).toHaveBeenCalled();
  });

  it('add needs text', async () => {
    await expect(parse(['audit', 'holdout', 'add'])).rejects.toThrow();
  });
});

describe('gen audit scale and backtest', () => {
  const id = '123e4567-e89b-12d3-a456-426614174000';
  it('parses a pass id, --last or --decided, with --dry-run', async () => {
    expect((await parse(['audit', 'scale', id])).auditScale).toHaveBeenCalledWith(id, {});
    expect((await parse(['audit', 'scale', '--last', '--dry-run'])).auditScale).toHaveBeenCalledWith(undefined, { last: true, dryRun: true });
    expect((await parse(['audit', 'scale', '--decided'])).auditScale).toHaveBeenCalledWith(undefined, { decided: true });
  });
  it('needs exactly one target and a valid id', async () => {
    await expect(parse(['audit', 'scale'])).rejects.toThrow(/pass id, --last or --decided/);
    await expect(parse(['audit', 'scale', id, '--decided'])).rejects.toThrow(/pass id, --last or --decided/);
    await expect(parse(['audit', 'scale', '--last', '--decided'])).rejects.toThrow(/pass id, --last or --decided/);
    await expect(parse(['audit', 'scale', 'abc'])).rejects.toThrow(/not a pass id/);
  });
  it('wires backtest', async () => {
    expect((await parse(['audit', 'backtest'])).auditBacktest).toHaveBeenCalled();
  });
});
