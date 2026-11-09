import { listFinds } from '@bcg/core/finds/store';
import { telegramStatus } from '@bcg/core/dashboard/telegram';
import { FindsView } from '@/components/finds-view';
import { requireOwner } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';

/** The Finds page: links shared by Telegram or pasted, and what became of each. */
export default async function FindsPage() {
  await requireOwner();
  const db = getDb();
  const [finds, telegram] = await Promise.all([listFinds(db), telegramStatus(db)]);
  return <FindsView finds={finds} telegram={telegram} now={new Date()} />;
}
