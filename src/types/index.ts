import { ObjectId } from 'mongodb';

// ─── Пользователь Max ────────────────────────────────────────────────────────

/**
 * Данные пользователя из initData (приходят от платформы Max).
 */
export type MaxUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string | null;
};

/**
 * Данные чата из initData.
 */
export type MaxChat = {
  id: number;
  type: string;
};

/**
 * Распарсенный и провалидированный initData от платформы Max.
 */
export type MaxInitData = {
  authDate: number;
  queryId?: string;
  hash: string;
  startParam?: string;
  user?: MaxUser;
  chat?: MaxChat;
  raw: string;
};

/**
 * Payload, который мы кладём в JWT-токен после успешной авторизации.
 */
export type JwtPayload = {
  uid: number;
  first_name: string;
  last_name: string;
  username: string;
};

// ─── MongoDB документы ───────────────────────────────────────────────────────

/**
 * Один обязательный канал для участия в розыгрыше.
 */
export type RequiredChannel = {
  channelId: number;
  channelTitle?: string | null;
  channelJoinLink?: string | null;
};

/**
 * Розыгрыш в коллекции MongoDB.
 */
export type GiveawayDoc = {
  _id: ObjectId;
  creatorId: number;
  /** Источник создания: бот или мини-апп. */
  createdVia?: 'bot' | 'miniapp';
  title: string;
  description?: string;
  type: 'regular' | 'referral';
  /**
   * Аудитория конкурса:
   * - 'all'  — для всех пользователей (старое поведение по умолчанию)
   * - 'new'  — только для новых пользователей
   *
   * Поле опционально, чтобы не ломать уже существующие документы.
   */
  audience?: 'all' | 'new';
  status:
    | 'not_started'
    | 'pending_start'
    | 'pending_stop'
    | 'pending_finish'
    | 'active'
    | 'stopped'
    | 'finished';
  endsAt: Date | string;
  winnersCount: number;
  channelId: number;
  channelIds?: number[];
  requiredInvites?: number;
  invitesPerTicket?: number;
  requiredChannels?: RequiredChannel[];
  channelJoinLink?: string;
  participantsRule?: string;
  createdAt?: Date;
  /** Дата запуска (публикации в каналы), при смене status на active. */
  launchedAt?: Date;
  announcementMessageId?: string;
  announcementMessageIds?: Array<{ channelId: number; messageId: string }>;
  winnerUserIds?: number[];
  winnerTickets?: string[];
  /** Медиа: image | video. */
  mediaType?: 'image' | 'video';
  /** Токен медиа для загрузки. */
  mediaToken?: string;
  /** Прямая ссылка на медиа. */
  mediaUrl?: string;
  /** Дополнительные файлы. */
  additionalFiles?: Array<{ name: string; token: string; url?: string; filename: string }>;
  /** Текст кнопки участия. */
  buttonText?: string;
};

/**
 * Участник розыгрыша в коллекции MongoDB.
 */
export type ParticipantDoc = {
  giveawayId: ObjectId;
  userId: number;
  joinedAt?: Date | string;
  ticket?: string | null;
  referredByUserId?: number;
  subscribedToChannel?: boolean;
  qualificationStatus?: 'pending_subscription' | 'pending_referrals' | 'qualified';
};

/**
 * Билет участника розыгрыша в коллекции MongoDB.
 */
export type TicketDoc = {
  giveawayId: ObjectId;
  userId: number;
  ticket: string;
  sequence: number;
  createdAt: Date | string;
  source?: 'regular_join' | 'referral_progress' | 'backend_check';
  sourceUserId?: number;
};

/**
 * Подключённый канал владельца в коллекции MongoDB.
 * botIsAdmin: бот в канале с правами администратора (может публиковать посты); при добавлении без прав — false.
 */
export type ChannelConnectionDoc = {
  channelId: number;
  ownerId: number;
  status: string;
  channelTitle?: string | null;
  channelType?: string | null;
  channelJoinLink?: string | null;
  connectedAt?: Date;
  joinLinkUpdatedAt?: Date;
  /** Бот является администратором канала с правом отправки сообщений (write). */
  botIsAdmin?: boolean;
  /** Публичный канал (есть username) — ссылку на вступление не показываем в UI. */
  isPublic?: boolean;
};

/**
 * Пользователь сервиса (организатор / участник конкурсов).
 * Одна запись на uid в коллекции users.
 */
export type UserDoc = {
  /** Идентификатор пользователя из платформы Max (user_id). */
  uid: number;
  /** Имя из профиля Max (если передано в initData / JWT). */
  firstName?: string;
  /** Фамилия из профиля Max (если передана). */
  lastName?: string;
  /** Username из профиля Max (если передан). */
  username?: string;
  /** Дата первой регистрации пользователя в сервисе. */
  createdAt: Date | string;
  /** Дата последней активности (любой успешный авторизованный запрос). */
  lastSeenAt?: Date | string;
  /** План подписки (free — по умолчанию, pro — платный тариф). */
  subscriptionPlan?: 'free' | 'pro';
  /** Статус подписки. */
  subscriptionStatus?: 'active' | 'expired' | 'trial';
  /** Дата окончания подписки (для trial / pro), null если бессрочно. */
  subscriptionValidUntil?: Date | string | null;
};
