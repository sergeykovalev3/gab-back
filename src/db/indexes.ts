import {
  GetGiveawaysCollection,
  GetParticipantsCollection,
  GetTicketsCollection,
  GetChannelConnectionsCollection,
  GetUsersCollection,
} from './collections.js';

/**
 * Создаём индексы для всех коллекций при старте приложения.
 * Без индексов запросы по giveawayId, userId и т.д. приводят к полному скану коллекции.
 */
export async function CreateIndexes(): Promise<void> {
  const giveaways = GetGiveawaysCollection();
  const participants = GetParticipantsCollection();
  const tickets = GetTicketsCollection();
  const channelConnections = GetChannelConnectionsCollection();
  const users = GetUsersCollection();

  // Розыгрыши: по создателю (manage overview), по _id (все роуты)
  await giveaways.createIndex({ creatorId: 1 });
  await giveaways.createIndex({ _id: 1 });

  // Участники: (giveawayId, userId) — основной запрос, upsert, count
  // unique: один участник = одна запись на розыгрыш (если уже есть дубли — индексы пропустим)
  try {
    await participants.createIndex({ giveawayId: 1, userId: 1 }, { unique: true });
  } catch (e) {
    console.warn('[db] не удалось создать unique индекс на participants — возможно есть дубликаты');
  }
  await participants.createIndex({ userId: 1, joinedAt: -1 }); // profile participations
  await participants.createIndex({ giveawayId: 1, referredByUserId: 1, subscribedToChannel: 1 }); // реферальный count

  // Билеты: (giveawayId, userId) — count, findOne с sort
  await tickets.createIndex({ giveawayId: 1, userId: 1 });
  await tickets.createIndex({ giveawayId: 1, userId: 1, sequence: -1 }); // оптимизация sort

  // Каналы: по владельцу
  await channelConnections.createIndex({ ownerId: 1, status: 1 });
  try {
    await channelConnections.createIndex({ ownerId: 1, channelId: 1 }, { unique: true });
  } catch (e) {
    console.warn('[db] не удалось создать unique индекс на channel_connections');
  }

  // Пользователи: один документ на uid
  try {
    await users.createIndex({ uid: 1 }, { unique: true });
  } catch (e) {
    console.warn('[db] не удалось создать unique индекс на users — возможно есть дубликаты');
  }

  console.log('[db] индексы созданы');
}
