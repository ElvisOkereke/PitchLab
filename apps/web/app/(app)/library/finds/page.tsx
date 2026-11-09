import { listFinds } from '@bcg/core/finds/store';
import { getSetting } from '@bcg/core/validation/settings';
import { FindsView } from '@/components/finds-view';
import { requireOwner } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';

/** The Finds page: links shared by Telegram or pasted, and what became of each. */
export default async function FindsPage() {
  await requireOwner();
  const db = getDb();
  const [finds, chat] = await Promise.all([listFinds(db), getSetting(db, 'telegram.ownerChatId')]);
  return <FindsView finds={finds} telegramConnected={chat !== null && chat !== ''} now={new Date()} />;
}
