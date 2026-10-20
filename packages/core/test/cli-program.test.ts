import { describe, it, expect, vi } from 'vitest';
import { CliError, buildProgram, checkConfigKey, checkConfigValue, resumeRefusal, type CliHandlers } from '../src/cli-program';

function handlers() {
  const ok = async () => 0;
  return {
    run: vi.fn(ok), resume: vi.fn(ok), export: vi.fn(ok), runs: vi.fn(ok),
    validate: vi.fn(ok), prospectsImport: vi.fn(ok), outreachMark: vi.fn(ok), outreachStatus: vi.fn(ok),
    configSet: vi.fn(ok), configGet: vi.fn(ok), worker: vi.fn(ok),
  } satisfies CliHandlers;
}

async function parse(args: string[]) {
  const h = handlers();
  const program = buildProgram(h);
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  for (const c of program.commands) {
    c.exitOverride();
    for (const s of c.commands) s.exitOverride();
  }
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
});
