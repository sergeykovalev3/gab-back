import { Bot, Keyboard } from "@maxhub/max-bot-api";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { Collection, ObjectId } from "mongodb";
import { z } from "zod";

export type ChannelConnectionDoc = {
  channelId: number;
  ownerId: number;
  status: string;
  channelTitle?: string | null;
  channelType?: string | null;
  channelJoinLink?: string | null;
  connectedAt?: Date;
  joinLinkUpdatedAt?: Date;
};

export type GiveawayDoc = {
  _id: ObjectId;
  creatorId: number;
  title: string;
  type: "regular" | "referral";
  status: "active" | "finished";
  endsAt: Date | string;
  winnersCount: number;
  channelId: number;
  channelIds?: number[];
  requiredInvites?: number;
  invitesPerTicket?: number;
  requiredChannels?: Array<{
    channelId: number;
    channelTitle?: string | null;
    channelJoinLink?: string | null;
  }>;
  channelJoinLink?: string;
  participantsRule?: string;
  createdAt?: Date;
  announcementMessageId?: string;
  announcementMessageIds?: Array<{ channelId: number; messageId: string }>;
};

type CreateManageRouterInput = {
  bot: Bot;
  jwtSecret: string;
  giveawaysCollection: Collection<GiveawayDoc>;
  channelConnectionsCollection: Collection<ChannelConnectionDoc>;
};

const channelUpdateSchema = z.object({
  channelJoinLink: z.string().trim().url().max(500),
});

const giveawayUpdateSchema = z.object({
  title: z.string().trim().min(1).max(160),
});

const giveawayCreateSchema = z
  .object({
    type: z.enum(["regular", "referral"]),
    title: z.string().trim().min(1).max(160),
    endsAt: z.string().datetime(),
    winnersCount: z.number().int().min(1).max(3),
    channelIds: z.array(z.number().int()).min(1).max(10),
    requiredChannelIds: z.array(z.number().int()).min(1).max(10).optional(),
    requiredInvites: z.number().int().min(1).max(100).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === "regular") {
      if (!value.requiredChannelIds?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "requiredChannelIds is required for regular giveaway",
          path: ["requiredChannelIds"],
        });
      }
      return;
    }
    if (typeof value.requiredInvites !== "number") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "requiredInvites is required for referral giveaway",
        path: ["requiredInvites"],
      });
    }
  });

function getUserIdFromAuthHeader(authorizationHeader: string | undefined, jwtSecret: string) {
  const token =
    authorizationHeader?.startsWith("Bearer ")
      ? authorizationHeader.slice("Bearer ".length)
      : null;
  if (!token) {
    return null;
  }
  try {
    const decoded = jwt.verify(token, jwtSecret) as jwt.JwtPayload | string;
    if (typeof decoded === "string") {
      return null;
    }
    return typeof decoded.uid === "number" ? decoded.uid : null;
  } catch {
    return null;
  }
}

function buildRepublishText(giveaway: GiveawayDoc) {
  const finishText =
    giveaway.endsAt instanceof Date
      ? giveaway.endsAt.toLocaleString("ru-RU")
      : String(giveaway.endsAt);
  const lines = [
    "Новый конкурс!",
    `Тип: ${giveaway.type === "referral" ? "реферальный" : "обычный"}`,
    `Название: ${giveaway.title}`,
    `Завершение: ${finishText}`,
    `Победителей: ${giveaway.winnersCount}`,
    "",
    giveaway.type === "referral"
      ? `Билет за каждые ${giveaway.invitesPerTicket ?? giveaway.requiredInvites ?? 1} приглашенных`
      : "",
    "Нажмите кнопку «Участвовать», чтобы открыть мини-апп и пройти условия.",
  ];
  return lines.filter(Boolean).join("\n");
}

function buildMiniAppStartAppLink(giveawayIdHex: string) {
  const botPublicName = process.env.BOT_PUBLIC_NAME ?? "id231002619995_bot";
  return `https://max.ru/${botPublicName}?startapp=eventId_${giveawayIdHex}`;
}

function buildRepublishKeyboard(giveaway: GiveawayDoc) {
  const mainRow = [
    Keyboard.button.link("Участвовать", buildMiniAppStartAppLink(giveaway._id.toHexString())),
  ];
  const rows: Parameters<typeof Keyboard.inlineKeyboard>[0] = [mainRow];
  for (const channel of giveaway.requiredChannels ?? []) {
    if (!channel.channelJoinLink) {
      continue;
    }
    rows.push([
      Keyboard.button.link(
        channel.channelTitle ?? `Канал ${channel.channelId}`,
        channel.channelJoinLink,
      ),
    ]);
  }
  return Keyboard.inlineKeyboard(rows);
}

function buildAnnouncementText(giveaway: GiveawayDoc) {
  const endsAtText =
    giveaway.endsAt instanceof Date
      ? giveaway.endsAt.toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })
      : String(giveaway.endsAt);
  const lines = [
    "Новый конкурс!",
    `Тип: ${giveaway.type === "referral" ? "реферальный" : "обычный"}`,
    `Название: ${giveaway.title}`,
    `Завершение: ${endsAtText}`,
    `Победителей: ${giveaway.winnersCount}`,
  ];
  if (giveaway.type === "referral" && giveaway.requiredInvites) {
    lines.push(
      `Билет за каждые ${giveaway.invitesPerTicket ?? giveaway.requiredInvites ?? 1} приглашенных`,
    );
  }
  if (giveaway.requiredChannels?.length) {
    lines.push("", "Подписка обязательна на каналы:");
    for (const [index, channel] of giveaway.requiredChannels.entries()) {
      const title = channel.channelTitle ?? `Канал ${channel.channelId}`;
      const link = channel.channelJoinLink ? ` — ${channel.channelJoinLink}` : "";
      lines.push(`${index + 1}) ${title}${link}`);
    }
  }
  lines.push("", "Нажмите кнопку «Участвовать», чтобы открыть мини-апп и пройти условия.");
  return lines.join("\n");
}

export function createManageRouter(input: CreateManageRouterInput) {
  const router = Router();

  router.post("/giveaways", async (req, res) => {
    const userId = getUserIdFromAuthHeader(req.headers.authorization, input.jwtSecret);
    if (!userId) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const parsed = giveawayCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "bad_request", details: parsed.error.flatten() });
    }

    const publishChannelIds = [...new Set(parsed.data.channelIds)];
    const requiredChannelIds = [...new Set(parsed.data.requiredChannelIds ?? parsed.data.channelIds)];

    const channels = await input.channelConnectionsCollection
      .find({
        ownerId: userId,
        status: "connected",
        channelId: { $in: [...new Set([...publishChannelIds, ...requiredChannelIds])] },
      })
      .toArray();

    const channelMap = new Map(channels.map((channel) => [channel.channelId, channel]));
    const missed = [...new Set([...publishChannelIds, ...requiredChannelIds])].filter(
      (channelId) => !channelMap.has(channelId),
    );
    if (missed.length) {
      return res.status(400).json({
        error: "channels_not_connected",
        message: `Some channels are not connected: ${missed.join(", ")}`,
      });
    }

    const giveawayId = new ObjectId();
    const requiredChannels = requiredChannelIds.map((channelId) => {
      const channel = channelMap.get(channelId)!;
      return {
        channelId,
        channelTitle: channel.channelTitle ?? null,
        channelJoinLink: channel.channelJoinLink ?? null,
      };
    });

    const giveaway: GiveawayDoc = {
      _id: giveawayId,
      creatorId: userId,
      title: parsed.data.title,
      type: parsed.data.type,
      status: "active",
      endsAt: new Date(parsed.data.endsAt),
      winnersCount: parsed.data.winnersCount,
      channelId: publishChannelIds[0],
      channelIds: publishChannelIds,
      requiredInvites:
        parsed.data.type === "referral" ? Number(parsed.data.requiredInvites ?? 1) : undefined,
      invitesPerTicket:
        parsed.data.type === "referral" ? Number(parsed.data.requiredInvites ?? 1) : undefined,
      channelJoinLink:
        parsed.data.type === "referral"
          ? (requiredChannels.find((channel) => typeof channel.channelJoinLink === "string")
              ?.channelJoinLink ?? undefined)
          : undefined,
      requiredChannels,
      participantsRule: "button_click",
      createdAt: new Date(),
    };

    const joinKeyboardRows: Parameters<typeof Keyboard.inlineKeyboard>[0] = [[
      Keyboard.button.link("Участвовать", buildMiniAppStartAppLink(giveawayId.toHexString())),
    ]];
    for (const channel of requiredChannels) {
      if (channel.channelJoinLink) {
        joinKeyboardRows.push([
          Keyboard.button.link(
            channel.channelTitle ?? `Канал ${channel.channelId}`,
            channel.channelJoinLink,
          ),
        ]);
      }
    }

    const sent: Array<{ channelId: number; messageId: string }> = [];
    for (const channelId of publishChannelIds) {
      const message = await input.bot.api.sendMessageToChat(channelId, buildAnnouncementText(giveaway), {
        attachments: [Keyboard.inlineKeyboard(joinKeyboardRows)],
      });
      sent.push({ channelId, messageId: message.body.mid });
    }

    giveaway.announcementMessageId = sent[0]?.messageId;
    giveaway.announcementMessageIds = sent;

    await input.giveawaysCollection.insertOne(giveaway);

    return res.status(201).json({
      ok: true,
      eventId: giveawayId.toHexString(),
      title: giveaway.title,
      type: giveaway.type,
      sentCount: sent.length,
    });
  });

  router.get("/overview", async (req, res) => {
    const userId = getUserIdFromAuthHeader(req.headers.authorization, input.jwtSecret);
    if (!userId) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const createdGiveaways = await input.giveawaysCollection
      .find({ creatorId: userId })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    const channels = await input.channelConnectionsCollection
      .find({ ownerId: userId, status: "connected" })
      .sort({ connectedAt: -1 })
      .limit(100)
      .toArray();

    return res.json({
      giveaways: createdGiveaways.map((giveaway) => ({
        eventId: String(giveaway._id),
        title: giveaway.title,
        type: giveaway.type,
        status: giveaway.status,
        endsAt: giveaway.endsAt,
        winnersCount: giveaway.winnersCount,
        channelId: giveaway.channelId,
        channelIds: Array.isArray(giveaway.channelIds)
          ? giveaway.channelIds
          : [giveaway.channelId],
        requiredInvites: giveaway.requiredInvites ?? null,
      })),
      channels: channels.map((channel) => ({
        channelId: channel.channelId,
        channelTitle: channel.channelTitle ?? null,
        channelType: channel.channelType ?? null,
        channelJoinLink: channel.channelJoinLink ?? null,
      })),
    });
  });

  router.get("/channels/:channelId", async (req, res) => {
    const userId = getUserIdFromAuthHeader(req.headers.authorization, input.jwtSecret);
    if (!userId) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const channelId = Number(req.params.channelId);
    if (!Number.isInteger(channelId)) {
      return res.status(400).json({ error: "bad_channel_id" });
    }

    const channel = await input.channelConnectionsCollection.findOne({
      ownerId: userId,
      channelId,
      status: "connected",
    });
    if (!channel) {
      return res.status(404).json({ error: "not_found", message: "channel not found" });
    }

    return res.json({
      channelId: channel.channelId,
      channelTitle: channel.channelTitle ?? null,
      channelType: channel.channelType ?? null,
      channelJoinLink: channel.channelJoinLink ?? null,
      connectedAt: channel.connectedAt ?? null,
      joinLinkUpdatedAt: channel.joinLinkUpdatedAt ?? null,
    });
  });

  router.patch("/channels/:channelId", async (req, res) => {
    const userId = getUserIdFromAuthHeader(req.headers.authorization, input.jwtSecret);
    if (!userId) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const channelId = Number(req.params.channelId);
    if (!Number.isInteger(channelId)) {
      return res.status(400).json({ error: "bad_channel_id" });
    }

    const parsed = channelUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "bad_request", details: parsed.error.flatten() });
    }

    const updateResult = await input.channelConnectionsCollection.updateOne(
      { ownerId: userId, channelId, status: "connected" },
      {
        $set: {
          channelJoinLink: parsed.data.channelJoinLink,
          joinLinkUpdatedAt: new Date(),
        },
      },
    );
    if (!updateResult.matchedCount) {
      return res.status(404).json({ error: "not_found", message: "channel not found" });
    }

    return res.json({
      ok: true,
      channelId,
      channelJoinLink: parsed.data.channelJoinLink,
    });
  });

  router.get("/giveaways/:eventId", async (req, res) => {
    const userId = getUserIdFromAuthHeader(req.headers.authorization, input.jwtSecret);
    if (!userId) {
      return res.status(401).json({ error: "unauthorized" });
    }

    if (!ObjectId.isValid(req.params.eventId)) {
      return res.status(400).json({ error: "bad_event_id" });
    }
    const giveawayId = new ObjectId(req.params.eventId);

    const giveaway = await input.giveawaysCollection.findOne({
      _id: giveawayId,
      creatorId: userId,
    });
    if (!giveaway) {
      return res.status(404).json({ error: "not_found", message: "giveaway not found" });
    }

    return res.json({
      eventId: giveaway._id.toHexString(),
      title: giveaway.title,
      type: giveaway.type,
      status: giveaway.status,
      endsAt: giveaway.endsAt,
      winnersCount: giveaway.winnersCount,
      channelId: giveaway.channelId,
      channelIds: Array.isArray(giveaway.channelIds)
        ? giveaway.channelIds
        : [giveaway.channelId],
      requiredInvites: giveaway.requiredInvites ?? null,
      requiredChannels: giveaway.requiredChannels ?? [],
    });
  });

  router.patch("/giveaways/:eventId", async (req, res) => {
    const userId = getUserIdFromAuthHeader(req.headers.authorization, input.jwtSecret);
    if (!userId) {
      return res.status(401).json({ error: "unauthorized" });
    }

    if (!ObjectId.isValid(req.params.eventId)) {
      return res.status(400).json({ error: "bad_event_id" });
    }
    const giveawayId = new ObjectId(req.params.eventId);

    const parsed = giveawayUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "bad_request", details: parsed.error.flatten() });
    }

    const updateResult = await input.giveawaysCollection.updateOne(
      { _id: giveawayId, creatorId: userId },
      { $set: { title: parsed.data.title } },
    );
    if (!updateResult.matchedCount) {
      return res.status(404).json({ error: "not_found", message: "giveaway not found" });
    }

    return res.json({ ok: true, eventId: req.params.eventId, title: parsed.data.title });
  });

  router.post("/giveaways/:eventId/republish", async (req, res) => {
    const userId = getUserIdFromAuthHeader(req.headers.authorization, input.jwtSecret);
    if (!userId) {
      return res.status(401).json({ error: "unauthorized" });
    }

    if (!ObjectId.isValid(req.params.eventId)) {
      return res.status(400).json({ error: "bad_event_id" });
    }
    const giveawayId = new ObjectId(req.params.eventId);

    const giveaway = await input.giveawaysCollection.findOne({
      _id: giveawayId,
      creatorId: userId,
    });
    if (!giveaway) {
      return res.status(404).json({ error: "not_found", message: "giveaway not found" });
    }

    const publishChannelIds =
      Array.isArray(giveaway.channelIds) && giveaway.channelIds.length
        ? giveaway.channelIds
        : [giveaway.channelId];

    const sent: Array<{ channelId: number; messageId: string }> = [];
    for (const channelId of publishChannelIds) {
      const message = await input.bot.api.sendMessageToChat(
        channelId,
        buildRepublishText(giveaway),
        { attachments: [buildRepublishKeyboard(giveaway)] },
      );
      sent.push({
        channelId,
        messageId: message.body.mid,
      });
    }

    await input.giveawaysCollection.updateOne(
      { _id: giveawayId, creatorId: userId },
      { $set: { announcementMessageIds: sent } },
    );

    return res.json({ ok: true, sentCount: sent.length, messages: sent });
  });

  return router;
}

