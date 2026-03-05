import { createHash, randomUUID } from 'crypto';
import { ObjectId } from 'mongodb';
import { GetTicketsCollection } from '../db/collections.js';
import { TicketDoc } from '../types/index.js';

type IssueTicketsInput = {
  giveawayId: ObjectId;
  userId: number;
  desiredCount: number;
  sourceUserId?: number;
};

type IssueTicketsResult = {
  total: number;
  issued: number;
  latestTicket: string | null;
};

/**
 * Выдаём билеты участнику розыгрыша по принципу идемпотентности:
 * если у участника уже есть N билетов, а нам нужно M — выдаём только (M - N).
 * Повторный вызов с тем же desiredCount ничего лишнего не создаст.
 *
 * Каждый билет — уникальный 12-символьный хэш (SHA-256 от UUID + timestamp).
 *
 * @param input.giveawayId — ID розыгрыша
 * @param input.userId — ID пользователя которому выдаём билеты
 * @param input.desiredCount — сколько билетов должно быть итого у участника
 * @param input.sourceUserId — ID пользователя, чьё действие вызвало выдачу (для реферальных)
 * @returns IssueTicketsResult — сколько всего билетов, сколько выдали, последний билет
 */
export async function IssueTickets(input: IssueTicketsInput): Promise<IssueTicketsResult> {
  const ticketsCollection = GetTicketsCollection();
  const safeDesired = Math.max(0, Math.floor(input.desiredCount));

  // Считаем сколько билетов у участника уже есть
  const currentCount = await ticketsCollection.countDocuments({
    giveawayId: input.giveawayId,
    userId: input.userId,
  });

  // Вычисляем сколько нужно добавить (не больше нужного)
  const toIssue = Math.max(0, safeDesired - currentCount);

  if (toIssue > 0) {
    const now = new Date();

    // Генерируем нужное количество новых билетов
    const docs: TicketDoc[] = Array.from({ length: toIssue }, (_, index) => ({
      giveawayId: input.giveawayId,
      userId: input.userId,
      // Уникальный билет: первые 12 символов SHA-256 от giveawayId + userId + timestamp + uuid
      ticket: createHash('sha256')
        .update(`${input.giveawayId.toHexString()}:${input.userId}:${Date.now()}:${randomUUID()}`)
        .digest('hex')
        .slice(0, 12)
        .toUpperCase(),
      sequence: currentCount + index + 1,
      createdAt: now,
      source: 'backend_check',
      ...(typeof input.sourceUserId === 'number' ? { sourceUserId: input.sourceUserId } : {}),
    }));

    await ticketsCollection.insertMany(docs, { ordered: true });
  }

  // Получаем последний выданный билет для отображения пользователю
  const latest = await ticketsCollection.findOne(
    { giveawayId: input.giveawayId, userId: input.userId },
    { sort: { sequence: -1 } },
  );

  return {
    total: currentCount + toIssue,
    issued: toIssue,
    latestTicket: latest?.ticket ?? null,
  };
}
