import { EventEmitter } from 'node:events';
import type { ChildLike, SpawnLike } from '../src/tools';

export interface Call {
  command: string;
  args: string[];
  options: Record<string, unknown>;
  killed: boolean;
}

export interface Behaviour {
  code?: number;
  stdout?: string;
  stderr?: string;
  /** Never exits unless killed. */
  hang?: boolean;
  /** Fail to start (as when the exe is missing). */
  error?: NodeJS.ErrnoException;
  /** Runs before the process "exits" (e.g. to write the files a tool would write). */
  effect?: (args: string[]) => void;
}

/** A spawn stand-in: `decide` picks each call's behaviour from its command and args. Never starts a real process. */
export function fakeSpawn(decide: (command: string, args: string[]) => Behaviour) {
  const calls: Call[] = [];
  const spawn: SpawnLike = (command, args, options) => {
    const call: Call = { command, args: [...args], options: { ...options }, killed: false };
    calls.push(call);
    const child = new EventEmitter() as EventEmitter & ChildLike;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    Object.assign(child, {
      stdout,
      stderr,
      kill: () => {
        call.killed = true;
        queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
        return true;
      },
    });
    const b = decide(command, args);
    setImmediate(() => {
      if (b.error) {
        child.emit('error', b.error);
        return;
      }
      if (b.hang) return;
      b.effect?.(args);
      if (b.stdout) stdout.emit('data', Buffer.from(b.stdout));
      if (b.stderr) stderr.emit('data', Buffer.from(b.stderr));
      child.emit('close', b.code ?? 0, null);
    });
    return child;
  };
  return { spawn, calls };
}
