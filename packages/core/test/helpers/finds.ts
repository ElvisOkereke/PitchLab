import { eq } from 'drizzle-orm';
import type { Db } from '../../src/db/client';
import { finds } from '../../src/db/schema';
import type { FindStatus } from '../../src/finds/store';
import { upsertKnowledgeItem } from '../../src/library/store';

let n = 0;

/**
 * A find row with its `find` library entry (as the worker stores it), for ideation and seed tests. Give each find a
 * distinct vector: near-identical ones merge into one library entry.
 */
export async function seedFind(
  db: Db,
  o: { what: string; vec: number[]; whoPays?: string; howItEarns?: string; status?: FindStatus; createdAt?: Date; countries?: string[]; itemNow?: Date; noItem?: boolean },
): Promise<{ findId: string; itemId: string | null; url: string }> {
  n++;
  const url = `https://www.tiktok.com/@c${n}/video/${1000 + n}`;
  let itemId: string | null = null;
  if (!o.noItem) {
    const r = await upsertKnowledgeItem(db, {
      kind: 'find', title: `Find ${n}: ${o.what}`, summary: `S${n}`, audience: 'consumer', countries: o.countries ?? ['US'], industries: [],
      facts: { what: o.what, whoPays: o.whoPays ?? 'small shops', howItEarns: o.howItEarns ?? '$20 a month', whyItWorks: 'saves time', claims: [], platform: 'tiktok' },
      source: { url, domain: 'www.tiktok.com', sourceType: 'tiktok-find', quoteVerified: false },
    }, o.vec, o.itemNow ? { now: o.itemNow } : {});
    itemId = r.itemId;
  }
  const [row] = await db.insert(finds).values({
    url, platform: 'tiktok', source: 'paste', status: o.status ?? 'done', knowledgeItemId: itemId,
    ...(o.createdAt ? { createdAt: o.createdAt } : {}),
  }).returning({ id: finds.id });
  return { findId: row!.id, itemId, url };
}

export async function setFindStatus(db: Db, id: string, status: FindStatus): Promise<void> {
  await db.update(finds).set({ status }).where(eq(finds.id, id));
}
