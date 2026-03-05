import { GetUsersCollection } from '../db/collections.js';

type EnsureUserInput = {
  uid: number;
  first_name?: string;
  last_name?: string;
  username?: string;
};

/**
 * Гарантирует наличие пользовательского документа в коллекции users.
 * Если записи ещё нет — создаёт её. Одновременно обновляет lastSeenAt и
 * базовые поля профиля (имя, фамилия, username) на каждый вызов.
 */
export async function EnsureUserExists(input: EnsureUserInput): Promise<void> {
  const users = GetUsersCollection();

  const now = new Date();

  await users.updateOne(
    { uid: input.uid },
    {
      $setOnInsert: {
        uid: input.uid,
        firstName: input.first_name ?? '',
        lastName: input.last_name ?? '',
        username: input.username ?? '',
        createdAt: now,
      },
      $set: {
        firstName: input.first_name ?? '',
        lastName: input.last_name ?? '',
        username: input.username ?? '',
        lastSeenAt: now,
        subscriptionPlan: 'free',
        subscriptionStatus: 'active',
      },
    },
    { upsert: true },
  );
}
