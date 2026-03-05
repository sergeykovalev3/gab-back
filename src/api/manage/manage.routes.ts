import { Router, Request, Response } from 'express';
import { Bot, ImageAttachment, Keyboard, VideoAttachment } from '@maxhub/max-bot-api';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { loadConfig } from '../../config/index.js';
import {
  GetGiveawaysCollection,
  GetChannelConnectionsCollection,
  GetTicketsCollection,
  GetUsersCollection,
} from '../../db/collections.js';
import { GiveawayDoc } from '../../types/index.js';

export type LaunchValidationError =
  | { code: 'channel_bot_not_admin'; channelId: number; channelTitle: string | null }
  | { code: 'channel_invalid_join_link'; channelId: number; channelTitle: string | null }
  | { code: 'date_past'; endsAt: string };

// Схема для обновления канала: ссылка на вступление и/или флаг прав бота (хотя бы одно поле).
const channelUpdateSchema = z
  .object({
    channelJoinLink: z.string().trim().url().max(500).optional(),
    botIsAdmin: z.boolean().optional(),
  })
  .refine((data) => data.channelJoinLink !== undefined || data.botIsAdmin !== undefined, {
    message: 'Нужно передать channelJoinLink или botIsAdmin',
  });

// Схема для подключения канала (вызывается ботом при событии bot_added).
// channelId и ownerId — всё, что нужно. Название и тип канала backend получает через getChat.
const channelConnectSchema = z.object({
  channelId: z.number().int().refine((n) => n !== 0, {
    message: 'channelId не должен быть 0',
  }),
});

// Дополнительный файл: название, токен, url, filename.
const additionalFileSchema = z.object({
  name: z.string().trim().min(1).max(100),
  token: z.string().min(1),
  url: z.string().url().optional(),
  filename: z.string().min(1),
});

/**
 * Схема частичного обновления черновика (только status: not_started).
 * Все поля опциональны — обновляем только переданные.
 */
const giveawayDraftUpdateSchema = z
  .object({
    title: z.string().trim().min(10).max(50).optional(),
    description: z.string().trim().min(100).max(2500).optional(),
    mediaType: z.enum(['image', 'video']).optional().nullable(),
    mediaToken: z.string().min(1).optional().nullable(),
    mediaUrl: z.string().url().optional().nullable(),
    additionalFiles: z.array(additionalFileSchema).max(20).optional(),
    buttonText: z.string().trim().min(1).max(20).optional(),
    winnersCount: z.number().int().min(1).max(50).optional(),
    endsAt: z.string().datetime().optional(),
    audience: z.enum(['all', 'new']).optional(),
    participantChannelIds: z.array(z.number().int()).max(10).optional(),
    publishChannelIds: z
      .array(z.number().int())
      .min(1)
      .max(10)
      .refine((arr) => arr.every((id) => id !== 0), { message: 'channelId не должен быть 0' })
      .optional(),
    referralEnabled: z.boolean().optional(),
    referralFriendsPerTicket: z.number().int().min(1).max(10).optional().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.audience === 'all' && (value.participantChannelIds?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'participantChannelIds обязателен для аудитории all',
        path: ['participantChannelIds'],
      });
    }
    if (value.referralEnabled && typeof value.referralFriendsPerTicket !== 'number') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'referralFriendsPerTicket обязателен при referralEnabled',
        path: ['referralFriendsPerTicket'],
      });
    }
    if (value.referralEnabled === false && value.referralFriendsPerTicket != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'referralFriendsPerTicket не нужен при referralEnabled=false',
        path: ['referralFriendsPerTicket'],
      });
    }
    if (value.endsAt) {
      const endsAt = new Date(value.endsAt);
      if (endsAt.getTime() <= Date.now()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'endsAt должна быть в будущем',
          path: ['endsAt'],
        });
      }
    }
    if (value.mediaType && !value.mediaToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mediaToken обязателен при mediaType',
        path: ['mediaToken'],
      });
    }
  });

/**
 * Схема создания розыгрыша (бот + мини-апп). Источник в createdVia, каждое поле валидируется на сервере.
 */
const giveawayCreateSchema = z
  .object({
    createdVia: z.enum(['bot', 'miniapp']),
    audience: z.enum(['all', 'new']),
    participantChannelIds: z
      .array(z.number().int())
      .max(10)
      .refine((arr) => arr.every((id) => id !== 0), { message: 'channelId не должен быть 0' }),
    publishChannelIds: z
      .array(z.number().int())
      .min(1)
      .max(10)
      .refine((arr) => arr.every((id) => id !== 0), { message: 'channelId не должен быть 0' }),
    title: z.string().trim().min(10).max(50),
    description: z.string().trim().min(100).max(2500),
    mediaType: z.enum(['image', 'video']).optional(),
    mediaToken: z.string().min(1).optional(),
    mediaUrl: z.string().url().optional(),
    additionalFiles: z.array(additionalFileSchema).max(20).optional(),
    buttonText: z.string().trim().min(1).max(20).optional(),
    winnersCount: z.number().int().min(1).max(50),
    endsAt: z.string().datetime(),
    referralEnabled: z.boolean(),
    referralFriendsPerTicket: z.number().int().min(1).max(10).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.audience === 'all' && (value.participantChannelIds?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'participantChannelIds обязателен для аудитории all',
        path: ['participantChannelIds'],
      });
    }
    if (value.referralEnabled && typeof value.referralFriendsPerTicket !== 'number') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'referralFriendsPerTicket обязателен при referralEnabled',
        path: ['referralFriendsPerTicket'],
      });
    }
    if (!value.referralEnabled && value.referralFriendsPerTicket != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'referralFriendsPerTicket не должен передаваться при referralEnabled=false',
        path: ['referralFriendsPerTicket'],
      });
    }
    const endsAt = new Date(value.endsAt);
    if (endsAt.getTime() <= Date.now()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endsAt должна быть в будущем',
        path: ['endsAt'],
      });
    }
    if (value.mediaType && !value.mediaToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mediaToken обязателен при mediaType',
        path: ['mediaToken'],
      });
    }
  });

/**
 * Формируем ссылку на мини-апп для конкретного розыгрыша.
 */
function _buildMiniAppLink(giveawayIdHex: string, botPublicName: string): string {
  return `https://max.ru/${botPublicName}?startapp=eventId_${giveawayIdHex}`;
}

/** Проверка, что строка похожа на валидную ссылку (http/https, не пустая). */
function _isValidJoinLink(link: string | null | undefined): boolean {
  if (typeof link !== 'string') return false;
  const trimmed = link.trim();
  if (trimmed.length === 0) return false;
  return trimmed.startsWith('http://') || trimmed.startsWith('https://');
}

/** Декодирует URL-encoded название файла. */
function _safeDecodeFileName(str: string): string {
  if (!str || typeof str !== 'string') return str;
  try {
    if (/%[0-9A-Fa-f]{2}/.test(str)) return decodeURIComponent(str);
    return str;
  } catch {
    return str;
  }
}

/** Форматирует дату в MSK (HH:mm dd.MM.yyyy). */
function _formatEndsAtMsk(isoOrDate: Date | string): string {
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const parts = formatter.formatToParts(d);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const year = parts.find((p) => p.type === 'year')?.value ?? '2025';
  return `${hour}:${minute} ${day}.${month}.${year}`;
}

/** Дней до завершения (округление вверх). */
function _daysLeftUntil(isoString: string): number {
  const end = new Date(isoString).getTime();
  const now = Date.now();
  return Math.max(0, Math.ceil((end - now) / (24 * 60 * 60 * 1000)));
}

/** Часов до завершения. */
function _hoursLeftUntil(isoString: string): number {
  const end = new Date(isoString).getTime();
  const now = Date.now();
  return Math.max(0, (end - now) / (60 * 60 * 1000));
}

/**
 * Формируем текст поста для канала — тот же формат, что и предпросмотр,
 * но без блока «Техническая информация».
 * @param participantCount — текущее количество участников (билетов), по умолчанию 0
 */
function _buildChannelPostText(
  giveaway: GiveawayDoc,
  publicApiUrl?: string,
  participantCount = 0
): string {
  const lines: string[] = [];
  const title = giveaway.title ?? '';
  const description = giveaway.description ?? '';
  const endsAtStr = typeof giveaway.endsAt === 'string' ? giveaway.endsAt : giveaway.endsAt.toISOString();

  lines.push('**' + title + '**', '', description, '', '');

  lines.push(`_Участники: ${participantCount}_`);
  lines.push(`_Количество мест: ${giveaway.winnersCount ?? '—'}_`);

  if (endsAtStr) {
    const dateStr = _formatEndsAtMsk(endsAtStr);
    const hoursLeft = _hoursLeftUntil(endsAtStr);
    const dateNote =
      hoursLeft < 24
        ? 'заканчивается сегодня'
        : (() => {
            const days = _daysLeftUntil(endsAtStr);
            const mod10 = days % 10;
            const mod100 = days % 100;
            const daysWord =
              mod10 === 1 && mod100 !== 11
                ? 'день'
                : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)
                  ? 'дня'
                  : 'дней';
            return `${days} ${daysWord} до завершения`;
          })();
    lines.push(`_Дата завершения: ${dateStr} (${dateNote})_`);
  } else {
    lines.push('_Дата завершения: —_');
  }

  const files = giveaway.additionalFiles ?? [];
  if (files.length) {
    lines.push('', '', 'Дополнительные файлы:', '');
    for (const f of files) {
      const displayName = _safeDecodeFileName(f.name);
      if (f.url) {
        const fileExt = f.filename ? (/\.(pdf|docx?)$/i.exec(f.filename)?.[1] ?? '') : '';
        const hasExt = /\.(pdf|docx?)$/i.test(displayName);
        const downloadName = fileExt && !hasExt ? `${displayName}.${fileExt}` : displayName;
        const fileUrl = publicApiUrl
          ? `${publicApiUrl}/api/files/download?url=${encodeURIComponent(f.url)}&filename=${encodeURIComponent(downloadName)}`
          : f.url;
        lines.push(`• [${displayName}](${fileUrl})`);
      } else {
        lines.push(`• ${displayName}`);
      }
    }
  }

  return lines.join('\n').trim();
}

/**
 * Собирает вложения для поста в канал: медиа (если есть) + клавиатура.
 */
function _buildChannelPostAttachments(
  giveaway: GiveawayDoc,
  botPublicName: string
): object[] {
  const attachments: object[] = [];

  const mediaToken = giveaway.mediaToken;
  const mediaType = giveaway.mediaType;

  if (mediaToken && mediaType === 'image') {
    attachments.push(new ImageAttachment({ token: mediaToken }).toJson());
  } else if (mediaToken && mediaType === 'video') {
    attachments.push(new VideoAttachment({ token: mediaToken }).toJson());
  }

  attachments.push(_buildKeyboard(giveaway, botPublicName));
  return attachments;
}

/**
 * Формируем инлайн-клавиатуру с кнопкой участия и ссылками на каналы.
 */
function _buildKeyboard(giveaway: GiveawayDoc, botPublicName: string) {
  const buttonLabel = giveaway.buttonText?.trim() || 'Участвовать';
  const rows: Parameters<typeof Keyboard.inlineKeyboard>[0] = [
    [
      Keyboard.button.link(
        buttonLabel,
        _buildMiniAppLink(giveaway._id.toHexString(), botPublicName),
      ),
    ],
  ];

  // Добавляем кнопки-ссылки на каждый обязательный канал
  for (const channel of giveaway.requiredChannels ?? []) {
    if (!channel.channelJoinLink) continue;
    rows.push([
      Keyboard.button.link(
        channel.channelTitle ?? `Канал ${channel.channelId}`,
        channel.channelJoinLink,
      ),
    ]);
  }

  return Keyboard.inlineKeyboard(rows);
}

/**
 * Роуты управления розыгрышами и каналами (только для создателя).
 *
 * POST   /api/manage/giveaways                     — создать розыгрыш
 * GET    /api/manage/overview                      — список своих розыгрышей и каналов
 * GET    /api/manage/giveaways/:eventId            — детали розыгрыша
 * PATCH  /api/manage/giveaways/:eventId            — обновить название
 * POST   /api/manage/giveaways/:eventId/launch    — запустить черновик (публикация в каналы)
 * POST   /api/manage/giveaways/:eventId/stop      — остановить конкурс
 * POST   /api/manage/giveaways/:eventId/finish    — подвести итоги, выбрать победителей
 * POST   /api/manage/giveaways/:eventId/finish-early — досрочно завершить конкурс (без выбора победителей)
 * POST   /api/manage/giveaways/:eventId/restart   — создать новый черновик на основе завершённого конкурса
 * POST   /api/manage/giveaways/:eventId/refresh-channel-links — обновить ссылки каналов
 * POST   /api/manage/giveaways/:eventId/republish  — переопубликовать в каналы
 * POST   /api/manage/channels/connect               — подключить канал (бот при bot_added)
 * POST   /api/manage/channels/:channelId/check-admin — проверить права бота (бот, мини-апп)
 * GET    /api/manage/channels/:channelId           — детали канала
 * PATCH  /api/manage/channels/:channelId           — обновить ссылку канала
 * DELETE /api/manage/channels/:channelId           — отключить канал (бот выходит, запись в БД, уведомление пользователю)
 */
export class ManageRoutes {
  public Router: Router;
  private bot: Bot;
  private botPublicName: string;
  private publicApiUrl?: string;

  constructor() {
    const config = loadConfig();
    this.bot = new Bot(config.botToken);
    this.botPublicName = config.botPublicName;
    this.publicApiUrl = config.publicApiUrl;
    this.Router = Router();
    this._initRoutes();
  }

  private _initRoutes(): void {
    this.Router.post('/giveaways', this._handleCreateGiveaway.bind(this));
    this.Router.get('/overview', this._handleOverview.bind(this));
    this.Router.get('/subscription', this._handleGetSubscription.bind(this));
    this.Router.get('/giveaways/:eventId', this._handleGetGiveaway.bind(this));
    this.Router.patch('/giveaways/:eventId', this._handleUpdateGiveaway.bind(this));
    this.Router.delete('/giveaways/:eventId', this._handleDeleteGiveaway.bind(this));
    this.Router.get('/giveaways/:eventId/launch-readiness', this._handleLaunchReadiness.bind(this));
    this.Router.post('/giveaways/:eventId/launch', this._handleLaunchGiveaway.bind(this));
    this.Router.post('/giveaways/:eventId/stop', this._handleStopGiveaway.bind(this));
    this.Router.post('/giveaways/:eventId/finish', this._handleFinishGiveaway.bind(this));
    this.Router.post('/giveaways/:eventId/finish-early', this._handleFinishEarlyGiveaway.bind(this));
    this.Router.post('/giveaways/:eventId/restart', this._handleRestartGiveaway.bind(this));
    this.Router.post(
      '/giveaways/:eventId/refresh-channel-links',
      this._handleRefreshChannelLinks.bind(this),
    );
    this.Router.post('/giveaways/:eventId/republish', this._handleRepublish.bind(this));
    this.Router.post('/channels/connect', this._handleConnectChannel.bind(this));
    this.Router.post('/channels/:channelId/check-admin', this._handleCheckChannelAdmin.bind(this));
    this.Router.get('/channels/:channelId', this._handleGetChannel.bind(this));
    this.Router.patch('/channels/:channelId', this._handleUpdateChannel.bind(this));
    this.Router.delete('/channels/:channelId', this._handleDeleteChannel.bind(this));
  }

  /**
   * Проверяет, является ли бот администратором канала с правом write.
   * getChatAdmins доступен только админам — при 403 считаем botIsAdmin = false.
   */
  private async _checkBotIsAdminInChannel(channelId: number): Promise<boolean> {
    try {
      const [botInfo, adminsResponse] = await Promise.all([
        this.bot.api.getMyInfo(),
        this.bot.api.getChatAdmins(channelId),
      ]);
      const botUserId = (botInfo as { user_id?: number }).user_id;
      const members =
        (adminsResponse as {
          members?: Array<{
            user_id: number;
            is_admin?: boolean;
            is_owner?: boolean;
            permissions?: string[] | null;
          }>;
        }).members ?? [];
      const me = botUserId != null ? members.find((m) => m.user_id === botUserId) : undefined;
      if (!me) return false;
      const hasWrite = Array.isArray(me.permissions) && me.permissions.includes('write');
      return me.is_owner === true || (me.is_admin === true && hasWrite);
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string; response?: { code?: string } };
      const status = e?.status;
      const code = e?.response?.code;
      const msg = (e?.message ?? '').toLowerCase();
      const isAdminOnly =
        status === 403 ||
        code === 'chat.denied' ||
        msg.includes('chat administrator') ||
        msg.includes('chat.denied');
      if (isAdminOnly) return false;
      throw err;
    }
  }

  /**
   * Создаём новый розыгрыш как черновик (status: not_started).
   * Публикация в каналы — отдельным вызовом launch.
   * Схема валидирует каждое поле — endpoint используется и ботом, и мини-аппом.
   */
  private _handleCreateGiveaway = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.uid;
    const parsed = giveawayCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }

    const d = parsed.data;
    const publishChannelIds = [...new Set(d.publishChannelIds)];
    const requiredChannelIds =
      d.audience === 'all' ? [...new Set(d.participantChannelIds ?? [])] : [];
    const allChannelIds = [...new Set([...publishChannelIds, ...requiredChannelIds])];

    const channelConnectionsCollection = GetChannelConnectionsCollection();

    const channels = await channelConnectionsCollection
      .find({ ownerId: userId, status: 'connected', channelId: { $in: allChannelIds } })
      .toArray();

    const channelMap = new Map(channels.map((ch) => [ch.channelId, ch]));
    const missed = allChannelIds.filter((id) => !channelMap.has(id));
    if (missed.length) {
      res.status(400).json({
        error: 'channels_not_connected',
        message: `Каналы не подключены: ${missed.join(', ')}`,
      });
      return;
    }

    const giveawayId = new ObjectId();
    const type = d.referralEnabled ? 'referral' : 'regular';
    const requiredChannels = requiredChannelIds.map((channelId) => {
      const ch = channelMap.get(channelId)!;
      return {
        channelId,
        channelTitle: ch.channelTitle ?? null,
        channelJoinLink: ch.channelJoinLink ?? null,
      };
    });

    const giveaway: GiveawayDoc = {
      _id: giveawayId,
      creatorId: userId,
      createdVia: d.createdVia,
      title: d.title,
      description: d.description,
      type,
      audience: d.audience,
      status: 'not_started',
      endsAt: new Date(d.endsAt),
      winnersCount: d.winnersCount,
      channelId: publishChannelIds[0],
      channelIds: publishChannelIds,
      requiredInvites:
        type === 'referral' ? Number(d.referralFriendsPerTicket ?? 1) : undefined,
      invitesPerTicket:
        type === 'referral' ? Number(d.referralFriendsPerTicket ?? 1) : undefined,
      channelJoinLink:
        type === 'referral'
          ? (requiredChannels.find((ch) => typeof ch.channelJoinLink === 'string')
              ?.channelJoinLink ?? undefined)
          : undefined,
      requiredChannels,
      participantsRule: 'button_click',
      createdAt: new Date(),
      mediaType: d.mediaType,
      mediaToken: d.mediaToken,
      mediaUrl: d.mediaUrl,
      additionalFiles: d.additionalFiles ?? [],
      buttonText: d.buttonText ?? 'Участвовать',
    };

    await GetGiveawaysCollection().insertOne(giveaway);

    res.status(201).json({
      ok: true,
      eventId: giveawayId.toHexString(),
      title: giveaway.title,
      type: giveaway.type,
      createdVia: d.createdVia,
    });
  };

  /**
   * Возвращаем список своих розыгрышей, подключённых каналов и данные подписки.
   * Подписка встроена в ответ, чтобы не делать отдельный запрос при каждом overview.
   */
  private _handleOverview = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.uid;

    const [createdGiveaways, channels, user] = await Promise.all([
      GetGiveawaysCollection()
        .find({ creatorId: userId })
        .sort({ createdAt: -1 })
        .limit(100)
        .toArray(),
      GetChannelConnectionsCollection()
        .find({ ownerId: userId, status: 'connected' })
        .sort({ connectedAt: -1 })
        .limit(100)
        .toArray(),
      GetUsersCollection().findOne({ uid: userId }),
    ]);

    res.json({
      giveaways: createdGiveaways.map((g) => ({
        eventId: String(g._id),
        title: g.title,
        type: g.type,
        audience: (g as GiveawayDoc).audience ?? 'all',
        status: g.status,
        endsAt: g.endsAt,
        winnersCount: g.winnersCount,
        channelId: g.channelId,
        channelIds: Array.isArray(g.channelIds) ? g.channelIds : [g.channelId],
        requiredInvites: g.requiredInvites ?? null,
        createdAt: g.createdAt ?? null,
        launchedAt: (g as GiveawayDoc).launchedAt ?? null,
      })),
      channels: channels.map((ch) => ({
        channelId: ch.channelId,
        channelTitle: ch.channelTitle ?? null,
        channelType: ch.channelType ?? null,
        channelJoinLink: ch.channelJoinLink ?? null,
        botIsAdmin: ch.botIsAdmin ?? false,
        isPublic: ch.isPublic ?? false,
        connectedAt: ch.connectedAt ?? null,
      })),
      subscription: {
        plan: user?.subscriptionPlan ?? 'free',
        status: user?.subscriptionStatus ?? 'active',
        validUntil: user?.subscriptionValidUntil ?? null,
      },
    });
  };

  /**
   * Отдельный эндпоинт для подписки и всех данных по ней.
   * Используется когда нужны только данные подписки (например, экран «Премиум»).
   */
  private _handleGetSubscription = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.uid;
    const user = await GetUsersCollection().findOne({ uid: userId });
    res.json({
      plan: user?.subscriptionPlan ?? 'free',
      status: user?.subscriptionStatus ?? 'active',
      validUntil: user?.subscriptionValidUntil ?? null,
    });
  };

  /**
   * Возвращаем детали конкретного розыгрыша (только создатель).
   */
  private _handleGetGiveaway = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.uid;
    if (!ObjectId.isValid(req.params.eventId)) {
      res.status(400).json({ error: 'bad_event_id' });
      return;
    }
    const giveawayId = new ObjectId(req.params.eventId);
    const giveaway = await GetGiveawaysCollection().findOne({ _id: giveawayId, creatorId: userId });
    if (!giveaway) {
      res.status(404).json({ error: 'not_found', message: 'розыгрыш не найден' });
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
      status: giveaway.status,
      endsAt: giveaway.endsAt,
      winnersCount: giveaway.winnersCount,
      participantsCount,
      channelId: giveaway.channelId,
      channelIds: Array.isArray(giveaway.channelIds) ? giveaway.channelIds : [giveaway.channelId],
      requiredInvites: giveaway.requiredInvites ?? null,
      requiredChannels: giveaway.requiredChannels ?? [],
      mediaType: g.mediaType ?? null,
      mediaToken: g.mediaToken ?? null,
      mediaUrl: g.mediaUrl ?? null,
      additionalFiles: g.additionalFiles ?? [],
      buttonText: g.buttonText ?? 'Участвовать',
      referralFriendsPerTicket: g.invitesPerTicket ?? g.requiredInvites ?? null,
      createdAt: giveaway.createdAt ?? null,
      launchedAt: g.launchedAt ?? null,
      announcementMessageId: g.announcementMessageId ?? null,
      announcementMessageIds: g.announcementMessageIds ?? null,
    });
  };

  /**
   * Частичное обновление черновика (только status: not_started).
   * Обновляются только переданные поля.
   */
  private _handleUpdateGiveaway = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.uid;
    if (!ObjectId.isValid(req.params.eventId)) {
      res.status(400).json({ error: 'bad_event_id' });
      return;
    }
    const giveawayId = new ObjectId(req.params.eventId);
    const giveaway = await GetGiveawaysCollection().findOne({
      _id: giveawayId,
      creatorId: userId,
    });
    if (!giveaway) {
      res.status(404).json({ error: 'not_found', message: 'розыгрыш не найден' });
      return;
    }
    if (giveaway.status !== 'not_started') {
      res.status(400).json({
        error: 'invalid_status',
        message: 'Редактировать можно только черновики (не запущенные конкурсы)',
      });
      return;
    }
    const parsed = giveawayDraftUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const d = parsed.data;
    const setFields: Record<string, unknown> = {};
    if (d.title !== undefined) setFields.title = d.title;
    if (d.description !== undefined) setFields.description = d.description;
    if (d.mediaType !== undefined) setFields.mediaType = d.mediaType;
    if (d.mediaToken !== undefined) setFields.mediaToken = d.mediaToken;
    if (d.mediaUrl !== undefined) setFields.mediaUrl = d.mediaUrl;
    if (d.additionalFiles !== undefined) setFields.additionalFiles = d.additionalFiles;
    if (d.buttonText !== undefined) setFields.buttonText = d.buttonText;
    if (d.winnersCount !== undefined) setFields.winnersCount = d.winnersCount;
    if (d.endsAt !== undefined) setFields.endsAt = new Date(d.endsAt);
    if (d.audience !== undefined) setFields.audience = d.audience;
    if (d.referralEnabled !== undefined) setFields.type = d.referralEnabled ? 'referral' : 'regular';
    if (d.referralFriendsPerTicket !== undefined) {
      setFields.invitesPerTicket = d.referralFriendsPerTicket;
      setFields.requiredInvites = d.referralFriendsPerTicket;
    }
    if (d.participantChannelIds !== undefined || d.publishChannelIds !== undefined) {
      const channelConnectionsCollection = GetChannelConnectionsCollection();
      const g = giveaway as GiveawayDoc;
      const publishIds =
        d.publishChannelIds ?? (Array.isArray(giveaway.channelIds) ? giveaway.channelIds : [giveaway.channelId]);
      const requiredIds =
        d.participantChannelIds ?? (g.requiredChannels ?? []).map((c) => c.channelId);
      const allIds = [...new Set([...publishIds, ...requiredIds])];
      const channels = await channelConnectionsCollection
        .find({ ownerId: userId, status: 'connected', channelId: { $in: allIds } })
        .toArray();
      const channelMap = new Map(channels.map((ch) => [ch.channelId, ch]));
      const missed = allIds.filter((id) => !channelMap.has(id));
      if (missed.length) {
        res.status(400).json({
          error: 'channels_not_connected',
          message: `Каналы не подключены: ${missed.join(', ')}`,
        });
        return;
      }
      setFields.channelId = publishIds[0];
      setFields.channelIds = publishIds;
      setFields.requiredChannels = requiredIds.map((channelId) => {
        const ch = channelMap.get(channelId)!;
        return {
          channelId,
          channelTitle: ch.channelTitle ?? null,
          channelJoinLink: ch.channelJoinLink ?? null,
        };
      });
    }
    if (Object.keys(setFields).length === 0) {
      res.json({ ok: true, eventId: req.params.eventId });
      return;
    }
    const result = await GetGiveawaysCollection().updateOne(
      { _id: giveawayId, creatorId: userId },
      { $set: setFields },
    );
    if (!result.matchedCount) {
      res.status(404).json({ error: 'not_found', message: 'розыгрыш не найден' });
      return;
    }
    res.json({ ok: true, eventId: req.params.eventId });
  };

  /**
   * Удаляем черновик (только status: not_started).
   */
  private _handleDeleteGiveaway = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.uid;
    const eventId = req.params.eventId;
    if (!ObjectId.isValid(eventId)) {
      res.status(400).json({ error: 'bad_event_id' });
      return;
    }
    const giveawayId = new ObjectId(eventId);
    const giveaway = await GetGiveawaysCollection().findOne({ _id: giveawayId, creatorId: userId });
    if (!giveaway) {
      res.status(404).json({ error: 'not_found', message: 'розыгрыш не найден' });
      return;
    }
    if (giveaway.status !== 'not_started') {
      res.status(400).json({
        error: 'invalid_status',
        message: 'Удалять можно только черновики (не запущенные конкурсы)',
      });
      return;
    }

    await GetGiveawaysCollection().deleteOne({ _id: giveawayId, creatorId: userId });

    res.json({ ok: true, eventId, deleted: true });
  };

  /**
   * Результат проверки ликвидности черновика перед запуском.
   */
  private async _validateGiveawayBeforeLaunch(
    giveaway: GiveawayDoc
  ): Promise<{ valid: boolean; errors: LaunchValidationError[] }> {
    const errors: LaunchValidationError[] = [];
    const publishChannelIds =
      Array.isArray(giveaway.channelIds) && giveaway.channelIds.length
        ? giveaway.channelIds
        : [giveaway.channelId];
    const requiredChannels = giveaway.requiredChannels ?? [];
    const allChannelIds = [
      ...new Set([...publishChannelIds, ...requiredChannels.map((c) => c.channelId)]),
    ];
    const channelMap = new Map(
      requiredChannels.map((c) => [c.channelId, { channelTitle: c.channelTitle ?? null }])
    );
    if (channelMap.size < allChannelIds.length) {
      const connections = await GetChannelConnectionsCollection()
        .find({
          ownerId: giveaway.creatorId,
          status: 'connected',
          channelId: { $in: allChannelIds },
        })
        .toArray();
      for (const ch of connections) {
        if (!channelMap.has(ch.channelId)) {
          channelMap.set(ch.channelId, { channelTitle: ch.channelTitle ?? null });
        }
      }
    }
    for (const channelId of allChannelIds) {
      const isAdmin = await this._checkBotIsAdminInChannel(channelId);
      if (!isAdmin) {
        const info = channelMap.get(channelId);
        errors.push({
          code: 'channel_bot_not_admin',
          channelId,
          channelTitle: info?.channelTitle ?? null,
        });
      }
    }
    const endsAt =
      typeof giveaway.endsAt === 'string'
        ? new Date(giveaway.endsAt).getTime()
        : giveaway.endsAt.getTime();
    if (endsAt <= Date.now()) {
      const endsAtIso =
        typeof giveaway.endsAt === 'string'
          ? giveaway.endsAt
          : giveaway.endsAt.toISOString();
      errors.push({ code: 'date_past', endsAt: endsAtIso });
    }

    // Кнопки поста, ведущие на каналы, должны иметь валидные ссылки на вступление
    for (const ch of requiredChannels) {
      if (!_isValidJoinLink(ch.channelJoinLink)) {
        errors.push({
          code: 'channel_invalid_join_link',
          channelId: ch.channelId,
          channelTitle: ch.channelTitle ?? channelMap.get(ch.channelId)?.channelTitle ?? null,
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * GET /giveaways/:eventId/launch-readiness — проверка готовности к запуску.
   */
  private _handleLaunchReadiness = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.uid;
    const eventId = req.params.eventId;
    if (!ObjectId.isValid(eventId)) {
      res.status(400).json({ error: 'bad_event_id' });
      return;
    }
    const giveawayId = new ObjectId(eventId);
    const giveaway = await GetGiveawaysCollection().findOne({
      _id: giveawayId,
      creatorId: userId,
    });
    if (!giveaway) {
      res.status(404).json({ error: 'not_found', message: 'розыгрыш не найден' });
      return;
    }
    if (giveaway.status !== 'not_started') {
      res.status(400).json({
        error: 'invalid_status',
        message: 'Проверять готовность можно только для черновика',
      });
      return;
    }
    const { valid, errors } = await this._validateGiveawayBeforeLaunch(giveaway);
    res.json({ ready: valid, errors: errors });
  };

  /**
   * Запускаем черновик: публикуем анонс во все каналы и меняем status на active.
   */
  private _handleLaunchGiveaway = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.uid;
    const eventId = req.params.eventId;
    if (!ObjectId.isValid(eventId)) {
      res.status(400).json({ error: 'bad_event_id' });
      return;
    }
    const giveawayId = new ObjectId(eventId);
    const giveaway = await GetGiveawaysCollection().findOne({ _id: giveawayId, creatorId: userId });
    if (!giveaway) {
      res.status(404).json({ error: 'not_found', message: 'розыгрыш не найден' });
      return;
    }
    if (giveaway.status !== 'not_started') {
      res.status(400).json({
        error: 'invalid_status',
        message: 'Запускать можно только черновик (status: not_started)',
      });
      return;
    }

    const { valid, errors } = await this._validateGiveawayBeforeLaunch(giveaway);
    if (!valid) {
      res.status(400).json({
        error: 'launch_validation_failed',
        errors,
      });
      return;
    }

    const now = new Date();
    await GetGiveawaysCollection().updateOne(
      { _id: giveawayId, creatorId: userId },
      {
        $set: {
          status: 'pending_start',
          createdAt: giveaway.createdAt ?? now,
        },
      },
    );

    res.json({
      ok: true,
      eventId,
      title: giveaway.title,
      sentCount: 0,
    });

    // Эмуляция очереди: через 10 секунд публикуем анонс и помечаем конкурс как active.
    setTimeout(async () => {
      try {
        const fresh = await GetGiveawaysCollection().findOne({
          _id: giveawayId,
          creatorId: userId,
        });
        if (!fresh || fresh.status !== 'pending_start') return;

        // Перед публикацией проверяем, что у всех каналов в кнопках есть валидные ссылки
        const requiredChannels = (fresh as GiveawayDoc).requiredChannels ?? [];
        const invalidLinkChannels = requiredChannels.filter((ch) => !_isValidJoinLink(ch.channelJoinLink));
        if (invalidLinkChannels.length > 0) {
          await GetGiveawaysCollection().updateOne(
            { _id: giveawayId, creatorId: userId, status: 'pending_start' },
            { $set: { status: 'not_started' } },
          );
          await this.bot.api.sendMessageToUser(
            userId,
            [
              `Не удалось запустить конкурс «${fresh.title}».`,
              '',
              'У одного или нескольких каналов для участия отсутствует или недействительна ссылка на вступление. Обновите ссылки в разделе «Мои каналы» и запустите конкурс снова.',
            ].join('\n'),
          );
          return;
        }

        const publishChannelIds =
          Array.isArray(fresh.channelIds) && fresh.channelIds.length
            ? fresh.channelIds
            : [fresh.channelId];

        const participantCount = 0;
        const postText = _buildChannelPostText(
          fresh as GiveawayDoc,
          this.publicApiUrl,
          participantCount,
        );
        const postAttachments = _buildChannelPostAttachments(
          fresh as GiveawayDoc,
          this.botPublicName,
        );

        const sent: Array<{ channelId: number; messageId: string }> = [];
        for (const channelId of publishChannelIds) {
          const message = await this.bot.api.sendMessageToChat(channelId, postText, {
            attachments: postAttachments as never,
            format: 'markdown',
          });
          sent.push({ channelId, messageId: message.body.mid });
        }

        const launchedAt = new Date();
        await GetGiveawaysCollection().updateOne(
          { _id: giveawayId, creatorId: userId, status: 'pending_start' },
          {
            $set: {
              status: 'active',
              launchedAt,
              announcementMessageId: sent[0]?.messageId,
              announcementMessageIds: sent,
            },
          },
        );

        // Уведомление организатора о запуске конкурса.
        await this.bot.api.sendMessageToUser(userId, [
          `Конкурс «${fresh.title}» запущен.`,
          '',
          `Анонс опубликован в ${sent.length} канал(ах).`,
        ].join('\n'));
      } catch (err) {
        console.error('[manage.routes] failed to process delayed launch', err);
      }
    }, 10_000);
  };

  /**
   * Останавливаем конкурс: status active → pending_stop → stopped (через задержку).
   */
  private _handleStopGiveaway = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.uid;
    const eventId = req.params.eventId;
    if (!ObjectId.isValid(eventId)) {
      res.status(400).json({ error: 'bad_event_id' });
      return;
    }
    const giveawayId = new ObjectId(eventId);
    const result = await GetGiveawaysCollection().updateOne(
      { _id: giveawayId, creatorId: userId, status: 'active' },
      { $set: { status: 'pending_stop' } },
    );
    if (!result.matchedCount) {
      res.status(404).json({
        error: 'not_found',
        message: 'розыгрыш не найден или уже не активен',
      });
      return;
    }
    res.json({ ok: true, eventId, status: 'pending_stop' });

    // Эмуляция очереди: через 10 секунд помечаем конкурс как окончательно остановленный.
    setTimeout(async () => {
      try {
        const fresh = await GetGiveawaysCollection().findOne({
          _id: giveawayId,
          creatorId: userId,
        });
        if (!fresh || fresh.status !== 'pending_stop') return;

        await GetGiveawaysCollection().updateOne(
          { _id: giveawayId, creatorId: userId, status: 'pending_stop' },
          { $set: { status: 'stopped' } },
        );

        await this.bot.api.sendMessageToUser(
          userId,
          [
            `Конкурс «${fresh.title}» досрочно остановлен.`,
            '',
            'Он перемещён в раздел «Завершенные».',
          ].join('\n'),
        );
      } catch (err) {
        console.error('[manage.routes] failed to process delayed stop', err);
      }
    }, 10_000);
  };

  /**
   * Досрочное завершение конкурса: status active → pending_finish → finished с выбором победителей.
   */
  private _handleFinishEarlyGiveaway = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.uid;
    const eventId = req.params.eventId;
    if (!ObjectId.isValid(eventId)) {
      res.status(400).json({ error: 'bad_event_id' });
      return;
    }
    const giveawayId = new ObjectId(eventId);
    const giveaway = await GetGiveawaysCollection().findOne({
      _id: giveawayId,
      creatorId: userId,
    });
    if (!giveaway) {
      res.status(404).json({ error: 'not_found', message: 'розыгрыш не найден' });
      return;
    }
    if (giveaway.status !== 'active') {
      res.status(400).json({
        error: 'invalid_status',
        message: 'Досрочно завершать можно только активный конкурс',
      });
      return;
    }

    await GetGiveawaysCollection().updateOne(
      { _id: giveawayId, creatorId: userId },
      { $set: { status: 'pending_finish' } },
    );

    res.json({
      ok: true,
      eventId,
      title: giveaway.title,
      status: 'pending_finish',
    });

    // Эмуляция очереди: через 10 секунд выбираем победителей и помечаем конкурс как завершённый.
    setTimeout(async () => {
      try {
        const fresh = await GetGiveawaysCollection().findOne({
          _id: giveawayId,
          creatorId: userId,
        });
        if (!fresh || fresh.status !== 'pending_finish') return;

        const ticketsCollection = GetTicketsCollection();
        const tickets = await ticketsCollection.find({ giveawayId }).toArray();

        const winnerUserIds: number[] = [];
        const participantsCount = tickets.length;
        const winnersCount = Math.min(fresh.winnersCount, tickets.length);

        if (winnersCount > 0) {
          const shuffled = [...tickets].sort(() => Math.random() - 0.5);
          const seen = new Set<number>();
          for (const t of shuffled) {
            if (seen.has(t.userId)) continue;
            seen.add(t.userId);
            winnerUserIds.push(t.userId);
            if (winnerUserIds.length >= winnersCount) break;
          }
        }

        await GetGiveawaysCollection().updateOne(
          { _id: giveawayId, creatorId: userId, status: 'pending_finish' },
          { $set: { status: 'finished', winnerUserIds } },
        );
        const startDate = fresh.createdAt
          ? new Date(fresh.createdAt)
          : new Date(fresh.endsAt ?? new Date());
        const endDate = new Date();
        const formatDateTime = (d: Date) =>
          d.toLocaleString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });

        // Готовим список победителей с конца.
        let winnersBlock = '';
        if (winnerUserIds.length > 0) {
          const usersCollection = GetUsersCollection();
          const users = await usersCollection
            .find({ uid: { $in: winnerUserIds } })
            .toArray();
          const byId = new Map<number, (typeof users)[number]>();
          for (const u of users) byId.set(u.uid, u);

          const lines: string[] = [];
          // Нумерация мест с конца: последнее место → первое.
          for (let i = 0; i < winnerUserIds.length; i++) {
            const place = fresh.winnersCount - i;
            if (place <= 0) break;
            const uid = winnerUserIds[i];
            const user = byId.get(uid);
            const firstName = (user?.firstName ?? '').trim();
            const lastName = (user?.lastName ?? '').trim();
            const username = (user?.username ?? '').trim();
            const displayName =
              (firstName || lastName ? `${firstName} ${lastName}`.trim() : '') ||
              (username ? `@${username}` : `ID ${uid}`);
            const link = username ? `https://t.me/${username}` : null;
            const line = link
              ? `${place}-е место — [${displayName}](${link})`
              : `${place}-е место — ${displayName}`;
            lines.push(line);
          }
          if (lines.length > 0) {
            winnersBlock = ['Вот список победителей (с последнего места):', '', ...lines].join(
              '\n',
            );
          }
        }

        const headerLines = [
          `**Конкурс «${fresh.title}» завершён**`,
          '',
          `Конкурс длился с ${formatDateTime(startDate)} по ${formatDateTime(endDate)}.`,
          `Всего участвовало: ${participantsCount} участник(ов).`,
          '',
        ];

        const footerLines =
          winnerUserIds.length > 0
            ? [
                '',
                'Мы отправили уведомления победителям, однако рекомендуем дополнительно связаться с ними вручную.',
                'Вы можете переразыграть призовые места и выгрузить подробный отчёт по конкурсу в разделе «Завершенные конкурсы».',
              ]
            : [
                '',
                'Билетов не было, поэтому победители не были выбраны.',
                'Вы можете переразыграть призовые места и выгрузить подробный отчёт по конкурсу в разделе «Завершенные конкурсы».',
              ];

        const fullText = [...headerLines, winnersBlock, ...footerLines]
          .filter((x) => x !== '')
          .join('\n');

        await this.bot.api.sendMessageToUser(
          userId,
          fullText,
          {
            format: 'markdown',
            attachments: [
              Keyboard.inlineKeyboard([
                [
                  // Должно совпадать со значением MAIN_MENU_ACTION_BACK в боте.
                  Keyboard.button.callback('🏠 В меню', 'menu_back_to_main'),
                ],
              ]),
            ],
          } as never,
        );
      } catch (err) {
        console.error('[manage.routes] failed to process delayed finish', err);
      }
    }, 10_000);
  };

  /**
   * Перезапуск конкурса: создаём новый черновик на основе завершённого/остановленного конкурса.
   * Новый документ получает status: not_started и новый _id.
   */
  private _handleRestartGiveaway = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.uid;
    const eventId = req.params.eventId;
    if (!ObjectId.isValid(eventId)) {
      res.status(400).json({ error: 'bad_event_id' });
      return;
    }
    const giveawayId = new ObjectId(eventId);
    const giveawaysCollection = GetGiveawaysCollection();
    const giveaway = await giveawaysCollection.findOne({
      _id: giveawayId,
      creatorId: userId,
    });
    if (!giveaway) {
      res.status(404).json({ error: 'not_found', message: 'розыгрыш не найден' });
      return;
    }

    if (giveaway.status !== 'finished' && giveaway.status !== 'stopped') {
      res.status(400).json({
        error: 'invalid_status',
        message: 'Перезапускать можно только завершённый или остановленный конкурс',
      });
      return;
    }

    const g = giveaway as GiveawayDoc;
    const now = new Date();

    const clone: Omit<GiveawayDoc, '_id'> = {
      creatorId: g.creatorId,
      createdVia: g.createdVia,
      title: g.title,
      description: g.description,
      type: g.type,
      audience: g.audience,
      status: 'not_started',
      endsAt: g.endsAt,
      winnersCount: g.winnersCount,
      channelId: g.channelId,
      channelIds: g.channelIds,
      requiredInvites: g.requiredInvites,
      invitesPerTicket: g.invitesPerTicket,
      requiredChannels: g.requiredChannels,
      channelJoinLink: g.channelJoinLink,
      participantsRule: g.participantsRule,
      createdAt: now,
      mediaType: g.mediaType,
      mediaToken: g.mediaToken,
      mediaUrl: g.mediaUrl,
      additionalFiles: g.additionalFiles,
      buttonText: g.buttonText,
    };

    const insertResult = await giveawaysCollection.insertOne(clone as GiveawayDoc);
    const newId = insertResult.insertedId;

    res.json({
      ok: true,
      eventId: newId.toHexString(),
      title: g.title,
      status: 'not_started',
    });
  };

  /**
   * Подводим итоги: выбираем победителей из билетов, status → finished.
   */
  private _handleFinishGiveaway = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.uid;
    const eventId = req.params.eventId;
    if (!ObjectId.isValid(eventId)) {
      res.status(400).json({ error: 'bad_event_id' });
      return;
    }
    const giveawayId = new ObjectId(eventId);
    const giveaway = await GetGiveawaysCollection().findOne({
      _id: giveawayId,
      creatorId: userId,
    });
    if (!giveaway) {
      res.status(404).json({ error: 'not_found', message: 'розыгрыш не найден' });
      return;
    }
    if (giveaway.status === 'finished') {
      res.status(400).json({
        error: 'invalid_status',
        message: 'Конкурс уже завершён',
      });
      return;
    }

    const ticketsCollection = GetTicketsCollection();
    const tickets = await ticketsCollection
      .find({ giveawayId })
      .toArray();

    const winnerUserIds: number[] = [];
    const winnersCount = Math.min(giveaway.winnersCount, tickets.length);

    if (winnersCount > 0) {
      const shuffled = [...tickets].sort(() => Math.random() - 0.5);
      const seen = new Set<number>();
      for (const t of shuffled) {
        if (seen.has(t.userId)) continue;
        seen.add(t.userId);
        winnerUserIds.push(t.userId);
        if (winnerUserIds.length >= winnersCount) break;
      }
    }

    await GetGiveawaysCollection().updateOne(
      { _id: giveawayId, creatorId: userId },
      { $set: { status: 'finished', winnerUserIds } },
    );

    res.json({
      ok: true,
      eventId,
      title: giveaway.title,
      winnersCount: winnerUserIds.length,
      winnerUserIds,
    });
  };

  /**
   * Обновляем ссылки на каналы: getChat для каждого requiredChannel, обновляем в БД.
   */
  private _handleRefreshChannelLinks = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.uid;
    const eventId = req.params.eventId;
    if (!ObjectId.isValid(eventId)) {
      res.status(400).json({ error: 'bad_event_id' });
      return;
    }
    const giveawayId = new ObjectId(eventId);
    const giveaway = await GetGiveawaysCollection().findOne({
      _id: giveawayId,
      creatorId: userId,
    });
    if (!giveaway) {
      res.status(404).json({ error: 'not_found', message: 'розыгрыш не найден' });
      return;
    }

    const requiredChannels = giveaway.requiredChannels ?? [];
    const channelConnectionsCollection = GetChannelConnectionsCollection();
    const updated: Array<{ channelId: number; channelTitle: string | null; channelJoinLink: string | null }> = [];

    for (const ch of requiredChannels) {
      const channelId = Number(ch.channelId);
      if (!Number.isInteger(channelId)) continue;

      const conn = await channelConnectionsCollection.findOne({
        ownerId: userId,
        channelId,
        status: 'connected',
      });
      if (!conn) continue;

      let channelTitle = conn.channelTitle ?? null;
      let channelJoinLink = conn.channelJoinLink ?? null;
      try {
        const chat = await this.bot.api.getChat(channelId);
        channelTitle = chat?.title ?? null;
        const rawLink = (chat as { link?: string | null })?.link;
        if (typeof rawLink === 'string' && rawLink.startsWith('http')) {
          channelJoinLink = rawLink;
        }
      } catch {
        // getChat может упасть — оставляем старые значения
      }

      await channelConnectionsCollection.updateOne(
        { ownerId: userId, channelId },
        { $set: { channelTitle, channelJoinLink } },
      );
      updated.push({ channelId, channelTitle, channelJoinLink });
    }

    const newRequiredChannels = requiredChannels.map((ch) => {
      const u = updated.find((x) => x.channelId === Number(ch.channelId));
      if (u) {
        return { channelId: ch.channelId, channelTitle: u.channelTitle, channelJoinLink: u.channelJoinLink };
      }
      return ch;
    });

    await GetGiveawaysCollection().updateOne(
      { _id: giveawayId, creatorId: userId },
      { $set: { requiredChannels: newRequiredChannels } },
    );

    res.json({ ok: true, eventId, updatedCount: updated.length });
  };

  /**
   * Повторно публикуем анонс розыгрыша во все каналы (репаблиш).
   * Сначала удаляем старые посты, затем публикуем новые.
   */
  private _handleRepublish = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.uid;
    if (!ObjectId.isValid(req.params.eventId)) {
      res.status(400).json({ error: 'bad_event_id' });
      return;
    }
    const giveawayId = new ObjectId(req.params.eventId);
    const giveaway = await GetGiveawaysCollection().findOne({ _id: giveawayId, creatorId: userId });
    if (!giveaway) {
      res.status(404).json({ error: 'not_found', message: 'розыгрыш не найден' });
      return;
    }

    const g = giveaway as GiveawayDoc;
    const oldMessageIds = g.announcementMessageIds ?? [];

    await Promise.all(
      oldMessageIds.map(async ({ messageId }) => {
        try {
          await this.bot.api.deleteMessage(messageId);
        } catch (err) {
          console.warn(`[republish] Не удалось удалить сообщение ${messageId}:`, err);
        }
      }),
    );

    const publishChannelIds =
      Array.isArray(giveaway.channelIds) && giveaway.channelIds.length
        ? giveaway.channelIds
        : [giveaway.channelId];

    const participantCount = await GetTicketsCollection().countDocuments({ giveawayId });
    const postText = _buildChannelPostText(giveaway, this.publicApiUrl, participantCount);
    const postAttachments = _buildChannelPostAttachments(giveaway, this.botPublicName);

    const sent: Array<{ channelId: number; messageId: string }> = [];
    for (const channelId of publishChannelIds) {
      const message = await this.bot.api.sendMessageToChat(channelId, postText, {
        attachments: postAttachments as never,
        format: 'markdown',
      });
      sent.push({ channelId, messageId: message.body.mid });
    }

    const updateFields: Record<string, unknown> = { announcementMessageIds: sent };
    if (sent[0]?.messageId) updateFields.announcementMessageId = sent[0].messageId;

    await GetGiveawaysCollection().updateOne(
      { _id: giveawayId, creatorId: userId },
      { $set: updateFields },
    );

    res.json({ ok: true, sentCount: sent.length, messages: sent });
  };

  /**
   * Подключить канал к аккаунту пользователя (вызывается ботом при событии bot_added в канал).
   * Вся обработка на backend: getChat (название, тип), проверка прав, сохранение.
   * Бот после вызова шлёт уведомление пользователю (только бот может отправлять сообщения).
   */
  private _handleConnectChannel = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.uid;
    const parsed = channelConnectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }

    const { channelId } = parsed.data;

    let channelTitle: string | null = null;
    let channelType: string | null = null;
    let channelJoinLink: string | null = null;
    let isPublic = false;
    try {
      const chat = await this.bot.api.getChat(channelId);
      channelTitle = chat?.title ?? null;
      channelType = chat?.type ?? null;
      const rawLink = (chat as { link?: string | null })?.link;
      if (typeof rawLink === 'string' && rawLink.startsWith('http')) {
        channelJoinLink = rawLink;
      }
      isPublic = !!(chat as { username?: string })?.username;
    } catch {
      // getChat может упасть — сохраняем без названия и ссылки
    }

    const botIsAdmin = await this._checkBotIsAdminInChannel(channelId);

    const channelConnectionsCollection = GetChannelConnectionsCollection();

    await channelConnectionsCollection.updateOne(
      { ownerId: userId, channelId },
      {
        $set: {
          ownerId: userId,
          channelId,
          status: 'connected',
          channelTitle: channelTitle ?? null,
          channelType: channelType ?? null,
          channelJoinLink: channelJoinLink ?? null,
          connectedAt: new Date(),
          botIsAdmin,
          isPublic,
        },
      },
      { upsert: true }
    );

    res.status(200).json({
      ok: true,
      channelId,
      channelTitle: channelTitle ?? null,
      channelType: channelType ?? null,
      channelJoinLink: channelJoinLink ?? null,
      botIsAdmin,
      isPublic,
    });
  };

  /**
   * Проверить права бота в канале и обновить в БД. Доступно боту и мини-аппу.
   * При 403 (бот не админ) — возвращаем botIsAdmin: false.
   * Если бот админ — пробуем получить ссылку на вступление через getChat (chat.link).
   */
  private _handleCheckChannelAdmin = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.uid;
    const channelId = Number(req.params.channelId);
    if (!Number.isInteger(channelId)) {
      res.status(400).json({ error: 'bad_channel_id' });
      return;
    }

    const channel = await GetChannelConnectionsCollection().findOne({
      ownerId: userId,
      channelId,
      status: 'connected',
    });
    if (!channel) {
      res.status(404).json({ error: 'not_found', message: 'канал не найден' });
      return;
    }

    const botIsAdmin = await this._checkBotIsAdminInChannel(channelId);

    let channelJoinLink: string | null = channel.channelJoinLink ?? null;
    let isPublic = channel.isPublic ?? false;
    if (botIsAdmin) {
      try {
        const chat = await this.bot.api.getChat(channelId);
        const rawLink = (chat as { link?: string | null })?.link;
        if (typeof rawLink === 'string' && rawLink.startsWith('http')) {
          channelJoinLink = rawLink;
        }
        isPublic = !!(chat as { username?: string })?.username;
      } catch {
        // getChat или link недоступны — оставляем текущую ссылку
      }
    }

    const updateSet: Record<string, unknown> = { botIsAdmin, isPublic };
    if (channelJoinLink !== null) {
      updateSet.channelJoinLink = channelJoinLink;
      updateSet.joinLinkUpdatedAt = new Date();
    }

    await GetChannelConnectionsCollection().updateOne(
      { ownerId: userId, channelId, status: 'connected' },
      { $set: updateSet }
    );

    res.json({
      ok: true,
      channelId,
      botIsAdmin,
      channelJoinLink: channelJoinLink ?? undefined,
    });
  };

  /**
   * Возвращаем детали подключённого канала (только владелец).
   */
  private _handleGetChannel = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.uid;
    const channelId = Number(req.params.channelId);
    if (!Number.isInteger(channelId)) {
      res.status(400).json({ error: 'bad_channel_id' });
      return;
    }
    const channel = await GetChannelConnectionsCollection().findOne({
      ownerId: userId,
      channelId,
      status: 'connected',
    });
    if (!channel) {
      res.status(404).json({ error: 'not_found', message: 'канал не найден' });
      return;
    }
    res.json({
      channelId: channel.channelId,
      channelTitle: channel.channelTitle ?? null,
      channelType: channel.channelType ?? null,
      channelJoinLink: channel.channelJoinLink ?? null,
      connectedAt: channel.connectedAt ?? null,
      joinLinkUpdatedAt: channel.joinLinkUpdatedAt ?? null,
      botIsAdmin: channel.botIsAdmin ?? false,
      isPublic: channel.isPublic ?? false,
    });
  };

  /**
   * Обновляем канал: ссылка на вступление и/или botIsAdmin (только владелец).
   */
  private _handleUpdateChannel = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.uid;
    const channelId = Number(req.params.channelId);
    if (!Number.isInteger(channelId)) {
      res.status(400).json({ error: 'bad_channel_id' });
      return;
    }
    const parsed = channelUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const set: Record<string, unknown> = {};
    if (parsed.data.channelJoinLink !== undefined) {
      set.channelJoinLink = parsed.data.channelJoinLink;
      set.joinLinkUpdatedAt = new Date();
    }
    if (parsed.data.botIsAdmin !== undefined) {
      set.botIsAdmin = parsed.data.botIsAdmin;
    }
    const result = await GetChannelConnectionsCollection().updateOne(
      { ownerId: userId, channelId, status: 'connected' },
      { $set: set },
    );
    if (!result.matchedCount) {
      res.status(404).json({ error: 'not_found', message: 'канал не найден' });
      return;
    }
    res.json({
      ok: true,
      channelId,
      ...(parsed.data.channelJoinLink !== undefined && {
        channelJoinLink: parsed.data.channelJoinLink,
      }),
      ...(parsed.data.botIsAdmin !== undefined && { botIsAdmin: parsed.data.botIsAdmin }),
    });
  };

  /**
   * Удалить канал: проверяем владельца, выходим ботом из канала, помечаем в БД, отправляем пользователю уведомление.
   * Вызывается из бота и из мини-аппа.
   */
  private _handleDeleteChannel = async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.uid;
    const channelId = Number(req.params.channelId);
    if (!Number.isInteger(channelId)) {
      res.status(400).json({ error: 'bad_channel_id' });
      return;
    }

    const channel = await GetChannelConnectionsCollection().findOne({
      ownerId: userId,
      channelId,
      status: 'connected',
    });
    if (!channel) {
      res.status(404).json({ error: 'not_found', message: 'канал не найден' });
      return;
    }

    const channelTitle = channel.channelTitle ?? `Канал ${channelId}`;

    try {
      const leaveChat = (this.bot.api as { leaveChat?: (chatId: number) => Promise<unknown> })
        .leaveChat;
      if (typeof leaveChat === 'function') {
        await leaveChat(channelId);
      }
    } catch (err) {
      console.warn('[manage] leaveChat failed (channel may already be left):', err);
      // Продолжаем: удаляем запись и уведомляем пользователя в любом случае.
    }

    await GetChannelConnectionsCollection().updateOne(
      { ownerId: userId, channelId, status: 'connected' },
      { $set: { status: 'disconnected' } },
    );

    try {
      await (this.bot.api as { sendMessageToUser?: (userId: number, text: string) => Promise<unknown> })
        .sendMessageToUser?.(userId, `Канал «${channelTitle}» успешно удалён.`);
    } catch (err) {
      console.warn('[manage] sendMessageToUser after delete failed:', err);
    }

    res.json({ ok: true, channelId });
  };
}
