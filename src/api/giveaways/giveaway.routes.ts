import { Router, Request, Response } from 'express';
import { Bot } from '@maxhub/max-bot-api';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { loadConfig } from '../../config/index.js';
import type { GiveawayDoc } from '../../types/index.js';
import {
  GetGiveawaysCollection,
  GetParticipantsCollection,
  GetTicketsCollection,
} from '../../db/collections.js';
import { IssueTickets } from '../../services/ticket.service.js';

// Схема валидации тела запроса
const checkBodySchema = z.object({
  eventId: z.string().min(1),
  inviterId: z.number().int().positive().optional(),
});

/**
 * Роуты розыгрышей.
 *
 * GET  /api/giveaways/:eventId — данные конкурса для мини-аппа (только status: active).
 * POST /api/giveaways/check    — проверяем условия участия и выдаём билет если выполнены.
 */
export class GiveawayRoutes {
  public Router: Router;
  private bot: Bot;

  constructor() {
    const config = loadConfig();
    this.bot = new Bot(config.botToken);
    this.Router = Router();
    this._initRoutes();
  }

  private _initRoutes(): void {
    this.Router.post('/check', this._handleCheck.bind(this));
    this.Router.get('/:eventId', this._handleGetByEventId.bind(this));
  }

  /**
   * Возвращает полную информацию о конкурсе по eventId для мини-аппа.
   * Отдаём данные только если status === 'active'.
   */
  private _handleGetByEventId = async (req: Request, res: Response): Promise<void> => {
    const eventIdParam = req.params.eventId;
    const eventId = typeof eventIdParam === 'string' ? eventIdParam : Array.isArray(eventIdParam) ? eventIdParam[0] : '';
    if (!eventId || !ObjectId.isValid(eventId)) {
      res.status(400).json({ error: 'bad_event_id', message: 'Некорректный идентификатор конкурса' });
      return;
    }
    const giveawayId = new ObjectId(eventId);
    const giveawaysCollection = GetGiveawaysCollection();
    const giveaway = await giveawaysCollection.findOne({ _id: giveawayId });
    if (!giveaway) {
      res.status(404).json({ error: 'not_found', message: 'Конкурс не найден' });
      return;
    }
    if (giveaway.status !== 'active') {
      res.status(403).json({
        error: 'contest_not_active',
        message: 'Конкурс недоступен для участия (не активен или уже завершён)',
      });
      return;
    }
    const g = giveaway as GiveawayDoc;
    const participantsCount = await GetTicketsCollection().countDocuments({ giveawayId });
    res.json({
      eventId: giveaway._id.toHexString(),
      title: giveaway.title,
      description: g.description ?? '',
      type: giveaway.type,
      audience: g.audience ?? 'all',
      endsAt: giveaway.endsAt,
      winnersCount: giveaway.winnersCount,
      participantsCount,
      requiredChannels: giveaway.requiredChannels ?? [],
      mediaType: g.mediaType ?? null,
      mediaToken: g.mediaToken ?? null,
      mediaUrl: g.mediaUrl ?? null,
      additionalFiles: g.additionalFiles ?? [],
      buttonText: g.buttonText ?? 'Участвовать',
      referralFriendsPerTicket: g.invitesPerTicket ?? g.requiredInvites ?? null,
    });
  };

  /**
   * Проверяем условия участия пользователя в розыгрыше:
   * 1. Проверяем подписку на все обязательные каналы через Bot API
   * 2. Для реферального типа — считаем количество приглашённых участников
   * 3. Если все условия выполнены — выдаём билет(ы) через IssueTickets
   * 4. Если есть реферер — проверяем и его условия, возможно выдаём билет рефереру
   */
  private _handleCheck = async (req: Request, res: Response): Promise<void> => {
    const config = loadConfig();

    // req.user заполняется в AuthMiddleware перед этим роутом
    const userId = req.user!.uid;

    // Валидируем тело запроса
    const parsedBody = checkBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: 'bad_request', details: parsedBody.error.flatten() });
      return;
    }

    // Проверяем что eventId — валидный MongoDB ObjectId
    if (!ObjectId.isValid(parsedBody.data.eventId)) {
      res.status(400).json({ error: 'bad_event_id', message: 'eventId невалидный' });
      return;
    }

    const giveawayId = new ObjectId(parsedBody.data.eventId);
    const inviterIdFromPayload = parsedBody.data.inviterId;

    const giveawaysCollection = GetGiveawaysCollection();
    const participantsCollection = GetParticipantsCollection();
    const ticketsCollection = GetTicketsCollection();

    // Загружаем розыгрыш из базы
    const giveaway = await giveawaysCollection.findOne({ _id: giveawayId });
    if (!giveaway) {
      res.status(404).json({ error: 'not_found', message: 'розыгрыш не найден' });
      return;
    }

    // Проверка участвует только в активном конкурсе
    if (giveaway.status !== 'active') {
      res.status(403).json({
        error: 'contest_not_active',
        message: 'Конкурс недоступен для участия (не активен или уже завершён)',
      });
      return;
    }

    // Создатель конкурса не может в нём участвовать
    if (giveaway.creatorId === userId) {
      res.status(403).json({
        error: 'creator_cannot_participate',
        message: 'Создатель конкурса не может участвовать в нём',
      });
      return;
    }

    // Определяем список каналов для проверки подписки
    const requiredChannels =
      Array.isArray(giveaway.requiredChannels) && giveaway.requiredChannels.length > 0
        ? giveaway.requiredChannels
        : [{ channelId: giveaway.channelId }];

    // Загружаем участника заранее — чтобы не дергать Bot API лишний раз,
    // если уже знаем, что он подписан и участвует.
    let participant = await participantsCollection.findOne({ giveawayId, userId });

    // Результаты проверки подписки на каналы
    let channelChecks: Array<{
      channelId: number;
      channelTitle: string | null;
      channelJoinLink: string | null;
      subscribed: boolean;
    }> = [];
    let missingChannels: typeof channelChecks = [];
    let allChannelsSubscribed = false;

    if (participant?.subscribedToChannel) {
      // Пользователь уже отмечен как подписанный на все каналы — считаем условие выполненным,
      // чтобы не вызывать Bot API повторно. Список каналов берём из requiredChannels.
      channelChecks = requiredChannels
        .map((channel) => {
          const channelId = Number(channel.channelId);
          if (!Number.isInteger(channelId)) return null;
          return {
            channelId,
            channelTitle: typeof channel.channelTitle === 'string' ? channel.channelTitle : null,
            channelJoinLink:
              typeof channel.channelJoinLink === 'string' ? channel.channelJoinLink : null,
            subscribed: true,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);
      missingChannels = [];
      allChannelsSubscribed = true;
    } else {
      // Проверяем подписку пользователя на каждый обязательный канал через Bot API
      for (const channel of requiredChannels) {
        const channelId = Number(channel.channelId);
        if (!Number.isInteger(channelId)) continue;

        try {
          const members = await this.bot.api.getChatMembers(channelId, {
            user_ids: [userId],
            count: 1,
          });
          const subscribed = members.members.some((member) => member.user_id === userId);
          channelChecks.push({
            channelId,
            channelTitle:
              typeof channel.channelTitle === 'string' ? channel.channelTitle : null,
            channelJoinLink:
              typeof channel.channelJoinLink === 'string' ? channel.channelJoinLink : null,
            subscribed,
          });
        } catch (err) {
          console.error('[giveaways] ошибка проверки подписки:', {
            eventId: parsedBody.data.eventId,
            userId,
            channelId,
            error: err,
          });
          res.status(502).json({
            error: 'membership_check_failed',
            message: `Не удалось проверить подписку на канал ${channelId}`,
          });
          return;
        }
      }

      missingChannels = channelChecks.filter((item) => !item.subscribed);
      allChannelsSubscribed = missingChannels.length === 0;
    }

    // Определяем реферера: сначала смотрим в базе, потом берём из запроса (если не сам себя пригласил)
    const effectiveInviterId =
      typeof participant?.referredByUserId === 'number'
        ? participant.referredByUserId
        : typeof inviterIdFromPayload === 'number' && inviterIdFromPayload !== userId
          ? inviterIdFromPayload
          : undefined;

    // Определяем статус квалификации участника
    const baseQualificationStatus =
      giveaway.type === 'referral'
        ? allChannelsSubscribed ? 'pending_referrals' : 'pending_subscription'
        : allChannelsSubscribed ? 'qualified' : 'pending_subscription';

    // Upsert участника: создаём если нет, обновляем статус подписки
    const participantUpdate = await participantsCollection.findOneAndUpdate(
      { giveawayId, userId },
      {
        $setOnInsert: { giveawayId, userId, joinedAt: new Date() },
        $set: {
          subscribedToChannel: allChannelsSubscribed,
          qualificationStatus: baseQualificationStatus,
          ...(typeof effectiveInviterId === 'number' ? { referredByUserId: effectiveInviterId } : {}),
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    participant = participantUpdate ?? participant;

    // Считаем количество приглашённых участников которые подписались на каналы
    const referralRequired = Math.max(
      1,
      Number(giveaway.invitesPerTicket ?? giveaway.requiredInvites ?? 1),
    );
    const referralCompletedCount =
      giveaway.type === 'referral'
        ? await participantsCollection.countDocuments({
            giveawayId,
            referredByUserId: userId,
            subscribedToChannel: true,
          })
        : 0;
    const referralMet = giveaway.type === 'referral'
      ? referralCompletedCount >= referralRequired
      : true;

    const allConditionsMet = allChannelsSubscribed && referralMet;

    // Вычисляем сколько билетов должно быть у участника
    const desiredTicketCount =
      giveaway.type === 'referral'
        ? Math.floor(referralCompletedCount / referralRequired)
        : allConditionsMet ? 1 : 0;

    const participantTicketCountBefore = await ticketsCollection.countDocuments({ giveawayId, userId });

    // Выдаём билеты только если все условия выполнены и нужно больше билетов чем есть
    const shouldIssueTicket =
      allConditionsMet &&
      giveaway.status === 'active' &&
      desiredTicketCount > 0 &&
      participantTicketCountBefore < desiredTicketCount;

    if (shouldIssueTicket) {
      await IssueTickets({ giveawayId, userId, desiredCount: desiredTicketCount });

      await participantsCollection.updateOne(
        { giveawayId, userId },
        {
          $set: {
            subscribedToChannel: allChannelsSubscribed,
            ...(giveaway.type === 'referral' ? { qualificationStatus: 'qualified' } : {}),
          },
        },
        { upsert: true },
      );
      participant = await participantsCollection.findOne({ giveawayId, userId });
    }

    // Если есть реферер и розыгрыш реферальный — проверяем не заработал ли реферер новый билет
    if (giveaway.type === 'referral' && typeof effectiveInviterId === 'number') {
      const inviterCompletedCount = await participantsCollection.countDocuments({
        giveawayId,
        referredByUserId: effectiveInviterId,
        subscribedToChannel: true,
      });
      const inviterDesiredTicketCount = Math.floor(inviterCompletedCount / referralRequired);
      const inviter = await participantsCollection.findOne({ giveawayId, userId: effectiveInviterId });

      // Выдаём билет рефереру только если он сам подписан на каналы
      if (inviter?.subscribedToChannel && inviterDesiredTicketCount > 0) {
        await IssueTickets({
          giveawayId,
          userId: effectiveInviterId,
          desiredCount: inviterDesiredTicketCount,
          sourceUserId: userId,
        });
        await participantsCollection.updateOne(
          { giveawayId, userId: effectiveInviterId },
          { $set: { qualificationStatus: 'qualified' } },
        );
      }
    }

    // Получаем итоговые данные о билетах участника
    const latestParticipantTicket = await ticketsCollection.findOne(
      { giveawayId, userId },
      { sort: { sequence: -1 } },
    );
    const participantTicketCount = await ticketsCollection.countDocuments({ giveawayId, userId });

    // Для реферального розыгрыша: если подписан но билетов нет — статус pending_referrals
    if (giveaway.type === 'referral' && allChannelsSubscribed && participantTicketCount === 0) {
      await participantsCollection.updateOne(
        { giveawayId, userId },
        { $set: { qualificationStatus: 'pending_referrals' } },
      );
      participant = await participantsCollection.findOne({ giveawayId, userId });
    }

    // Генерируем реферальную ссылку если пользователь подписан
    const referralInviteLink =
      giveaway.type === 'referral' && allChannelsSubscribed
        ? `https://max.ru/${config.botPublicName}?startapp=invite_${giveawayId.toHexString()}_${userId}`
        : null;

    res.json({
      eventId: parsedBody.data.eventId,
      title: giveaway.title,
      type: giveaway.type,
      status: giveaway.status,
      allConditionsMet,
      channels: channelChecks,
      missingChannels,
      participant: participant
        ? {
            ticket: latestParticipantTicket?.ticket ?? null,
            ticketCount: participantTicketCount,
            joinedAt: participant.joinedAt ?? null,
          }
        : null,
      referral:
        giveaway.type === 'referral'
          ? {
              requiredInvites: referralRequired,
              invitesPerTicket: referralRequired,
              completedInvites: referralCompletedCount,
              earnedTickets: Math.floor(referralCompletedCount / referralRequired),
              met: referralMet,
              inviteLink: referralInviteLink,
            }
          : null,
    });
  };
}
