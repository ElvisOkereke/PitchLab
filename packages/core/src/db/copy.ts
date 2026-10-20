import { count, getTableName, is, sql } from 'drizzle-orm';
import { PgTable, getTableConfig, type PgColumn } from 'drizzle-orm/pg-core';
import type { Db } from './client';
import * as schema from './schema';

// One-time copy of the local PGlite database into Postgres (the dashboard and the worker share one Postgres; PGlite
// is single-process). Reads the source only; writes are idempotent (onConflictDoNothing), so a re-run inserts nothing.

/** Every table exported from schema.ts (tables added later are picked up without a list edit). */
export const allTables: PgTable[] = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));

/** Topological order by foreign keys (parents first); ties keep the given order. Throws on a cycle. */
export function tableCopyOrder(tables: PgTable[]): PgTable[] {
  const parentsOf = new Map<PgTable, Set<PgTable>>();
  for (const t of tables) {
    const parents = new Set<PgTable>();
    for (const fk of getTableConfig(t).foreignKeys) {
      const parent = fk.reference().foreignTable;
      if (parent !== t && tables.includes(parent)) parents.add(parent);
    }
    parentsOf.set(t, parents);
  }
  const done = new Set<PgTable>();
  const out: PgTable[] = [];
  while (out.length < tables.length) {
    const next = tables.find((t) => !done.has(t) && [...parentsOf.get(t)!].every((p) => done.has(p)));
    if (!next) throw new Error(`Foreign-key cycle among: ${tables.filter((t) => !done.has(t)).map(getTableName).join(', ')}`);
    done.add(next);
    out.push(next);
  }
  return out;
}

export type CopyReport = { table: string; source: number; inserted: number; target: number; ok: boolean }[];

function primaryKeyColumns(t: PgTable): PgColumn[] {
  const cfg = getTableConfig(t);
  const single = cfg.columns.filter((c) => c.primary);
  const cols = single.length ? single : (cfg.primaryKeys[0]?.columns ?? []);
  if (cols.length === 0) throw new Error(`Table ${getTableName(t)} has no primary key; it cannot be copied in pages`);
  return cols;
}

const countRows = async (db: Db, t: PgTable) => (await db.select({ n: count() }).from(t))[0]?.n ?? 0;

/**
 * Copies every schema table from `from` to `to`, parents first: reads pages ordered by primary key and inserts full
 * rows (ids included) in batches with ON CONFLICT DO NOTHING, so it is idempotent and skips unique-key duplicates.
 * `ok` = target count equals source count afterwards. Ids are uuid/text, so no sequences need resetting.
 */
export async function copyDatabase(from: Db, to: Db, o: { batchSize?: number; log?: (m: string) => void } = {}): Promise<CopyReport> {
  const batchSize = Math.min(Math.max(Math.trunc(o.batchSize ?? 500) || 500, 1), 5000);
  const report: CopyReport = [];
  for (const table of tableCopyOrder(allTables)) {
    const name = getTableName(table);
    const pk = primaryKeyColumns(table);
    const source = await countRows(from, table);
    let inserted = 0;
    for (let offset = 0; offset < source; offset += batchSize) {
      const rows = await from.select().from(table).orderBy(...pk).limit(batchSize).offset(offset);
      if (rows.length === 0) break;
      const added = await to.insert(table).values(rows).onConflictDoNothing().returning({ one: sql<number>`1` });
      inserted += added.length;
    }
    const target = await countRows(to, table);
    report.push({ table: name, source, inserted, target, ok: target === source });
    o.log?.(`${name}: ${source} source, ${inserted} inserted, ${target} target`);
  }
  return report;
}

/** Applied migration hashes in order; empty when the database was never migrated. */
async function migrationHashes(db: Db): Promise<string[]> {
  try {
    const res = await db.execute(sql`select hash from drizzle.__drizzle_migrations order by id`);
    return (res as unknown as { rows: { hash: string }[] }).rows.map((r) => r.hash);
  } catch {
    return [];
  }
}

/** Throws unless both databases have applied exactly the same migrations (same hashes, same order). */
export async function assertSameMigrations(from: Db, to: Db): Promise<void> {
  const [a, b] = await Promise.all([migrationHashes(from), migrationHashes(to)]);
  if (a.length === b.length && a.every((h, i) => h === b[i])) return;
  const where = a.length < b.length ? 'the source is behind the target' : a.length > b.length ? 'the source is ahead of the target' : 'the migration hashes differ';
  throw new Error(`Migration mismatch: ${where} (source ${a.length}, target ${b.length} migrations)`);
}
