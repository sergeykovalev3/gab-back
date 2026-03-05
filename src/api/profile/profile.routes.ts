import { Router, Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import {
  GetGiveawaysCollection,
  GetParticipantsCollection,
  GetTicketsCollection,
} from '../../db/collections.js';

/**
 * Роуты профиля участника розыгрышей.
 *
 * GET /api/profile/participations           — список всех розыгрышей в которых участвует пользователь
 * GET /api/profile/participations/:eventId  — детали участия в конкретном розыгрыше
 */
export class ProfileRoutes {
  public Router: Router;

  constructor() {
    this.Router = Router();
    this._initRoutes();
  }

  private _initRoutes(): void {
    this.Router.get('/participations', this._handleGetParticipations.bind(this));
    this.Router.get('/participations/:eventId', this._handleGetParticipation.bind(this));
  }

  /**
   * Возвращаем список всех розыгрышей пользователя с его статусом участия.
   * Сортировка по дате вступления (новые сверху), лимит 100.
   */
  private _handleGetParticipations = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.uid;

    // Загружаем все участия пользователя
    const participations = await GetParticipantsCollection()
      .find({ userId })
      .sort({ joinedAt: -1 })
      .limit(100)
      .toArray();

    const giveawayIds = participations.map((item) => item.giveawayId);

    // Загружаем данные розыгрышей одним запросом по списку ID
    const giveaways = giveawayIds.length
      ? await GetGiveawaysCollection().find({ _id: { $in: giveawayIds } }).toArray()
      : [];

    // Строим Map для быстрого доступа к розыгрышу по ID
    const giveawayMap = new Map(giveaways.map((g) => [String(g._id), g]));

    // Загружаем все билеты пользователя по всем его розыгрышам одним запросом
    const tickets = giveawayIds.length
      ? await GetTicketsCollection()
          .find({ giveawayId: { $in: giveawayIds }, userId })
          .sort({ sequence: -1 })
          .toArray()
      : [];

    // Строим Map: giveawayId → последний билет (tickets отсортированы по sequence desc)
    const latestTicketByGiveaway = new Map<string, string>();
    for (const row of tickets) {
      const key = String(row.giveawayId);
      if (!latestTicketByGiveaway.has(key)) {
        latestTicketByGiveaway.set(key, row.ticket);
      }
    }

    // Собираем итоговый список, пропуская участия у которых нет розыгрыша в базе
    const items = participations
      .map((item) => {
        const giveaway = giveawayMap.get(String(item.giveawayId));
        if (!giveaway) return null;

        const winnerUserIds = Array.isArray(giveaway.winnerUserIds) ? giveaway.winnerUserIds : [];
        // won: true/false если розыгрыш завершён, null если ещё идёт
        const won = giveaway.status === 'finished' ? winnerUserIds.includes(userId) : null;

        return {
          eventId: String(giveaway._id),
          title: giveaway.title,
          type: giveaway.type,
          status: giveaway.status,
          endsAt: giveaway.endsAt,
          winnersCount: giveaway.winnersCount,
          joinedAt: item.joinedAt ?? null,
          ticket: latestTicketByGiveaway.get(String(giveaway._id)) ?? null,
          won,
          requiredChannels: Array.isArray(giveaway.requiredChannels) ? giveaway.requiredChannels : [],
        };
      })
      .filter(Boolean);

    res.json({ items });
  };

  /**
   * Возвращаем детали участия пользователя в конкретном розыгрыше.
   * Включает список победителей если розыгрыш уже завершён.
   */
  private _handleGetParticipation = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.uid;

    if (!ObjectId.isValid(req.params.eventId)) {
      res.status(400).json({ error: 'bad_event_id' });
      return;
    }
    const giveawayId = new ObjectId(req.params.eventId);

    // Проверяем что пользователь является участником этого розыгрыша
    const participation = await GetParticipantsCollection().findOne({ giveawayId, userId });
    if (!participation) {
      res.status(404).json({ error: 'not_found', message: 'участие не найдено' });
      return;
    }

    const giveaway = await GetGiveawaysCollection().findOne({ _id: giveawayId });
    if (!giveaway) {
      res.status(404).json({ error: 'not_found', message: 'розыгрыш не найден' });
      return;
    }

    const winnerUserIds = Array.isArray(giveaway.winnerUserIds) ? giveaway.winnerUserIds : [];
    const winnerTickets = Array.isArray(giveaway.winnerTickets) ? giveaway.winnerTickets : [];

    // Берём последний (наибольший по sequence) билет пользователя
    const latestTicket = await GetTicketsCollection().findOne(
      { giveawayId, userId },
      { sort: { sequence: -1 } },
    );

    // Формируем список победителей: каждый userId сопоставлен со своим билетом
    const winners = winnerUserIds.map((winnerUserId, index) => ({
      userId: winnerUserId,
      ticket: winnerTickets[index] ?? null,
    }));

    res.json({
      eventId: String(giveaway._id),
      title: giveaway.title,
      type: giveaway.type,
      status: giveaway.status,
      endsAt: giveaway.endsAt,
      winnersCount: giveaway.winnersCount,
      joinedAt: participation.joinedAt ?? null,
      ticket: latestTicket?.ticket ?? null,
      won: giveaway.status === 'finished' ? winnerUserIds.includes(userId) : null,
      requiredChannels: Array.isArray(giveaway.requiredChannels) ? giveaway.requiredChannels : [],
      winners,
    });
  };
}
