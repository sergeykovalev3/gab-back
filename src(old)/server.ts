import cors from "cors";
import express from "express";
import { Bot } from "@maxhub/max-bot-api";
import { createHash, randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import { MongoClient, ObjectId } from "mongodb";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { validateMaxInitData } from "./maxAuth.js";
import { createManageRouter, type ChannelConnectionDoc, type GiveawayDoc as ManageGiveawayDoc } from "./routes/manage.js";
import {
  createProfileRouter,
  type GiveawayTicketDoc as ProfileTicketDoc,
  type GiveawayDoc as ProfileGiveawayDoc,
  type ParticipantDoc as ProfileParticipantDoc,
} from "./routes/profile.js";

type CheckParticipantDoc = ProfileParticipantDoc & {
  referredByUserId?: number;
  subscribedToChannel?: boolean;
  qualificationStatus?: "pending_subscription" | "pending_referrals" | "qualified";
};

type CheckGiveawayDoc = ManageGiveawayDoc;
type CheckTicketDoc = ProfileTicketDoc & {
  source?: "regular_join" | "referral_progress" | "backend_check";
  sourceUserId?: number;
};

const config = loadConfig();
const app = express();
const bot = new Bot(config.botToken);
const mongoClient = new MongoClient(config.mongoUri);
const db = mongoClient.db(config.mongoDbName);
const giveawaysCollection = db.collection<CheckGiveawayDoc>("giveaways");
const manageGiveawaysCollection = db.collection<ManageGiveawayDoc>("giveaways");
const profileGiveawaysCollection = db.collection<ProfileGiveawayDoc>("giveaways");
const participantsCollection = db.collection<CheckParticipantDoc>("giveaway_participants");
const profileParticipantsCollection = db.collection<ProfileParticipantDoc>("giveaway_participants");
const ticketsCollection = db.collection<CheckTicketDoc>("giveaway_tickets");
const profileTicketsCollection = db.collection<ProfileTicketDoc>("giveaway_tickets");
const channelConnectionsCollection = db.collection<ChannelConnectionDoc>("channel_connections");

app.use(express.json({ limit: "256kb" }));
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow server-to-server or same-origin requests without Origin header.
      if (!origin) {
        callback(null, true);
        return;
      }
      // Tuna generates random subdomains; allow them in development flow.
      if (origin.endsWith(".ru.tuna.am")) {
        callback(null, true);
        return;
      }
      if (config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  }),
);

const authBodySchema = z.object({
  initData: z.string().min(1),
});
const checkBodySchema = z.object({
  eventId: z.string().min(1),
  inviterId: z.number().int().positive().optional(),
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/max", (req, res) => {
  const parsed = authBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "bad_request",
      details: parsed.error.flatten(),
    });
  }

  try {
    const validated = validateMaxInitData(
      parsed.data.initData,
      config.botToken,
      config.authMaxAgeSeconds,
    );

    if (!validated.user?.id) {
      return res.status(400).json({
        error: "user_missing",
        message: "initData has no user object",
      });
    }

    const token = jwt.sign(
      {
        uid: validated.user.id,
        first_name: validated.user.first_name ?? "",
        last_name: validated.user.last_name ?? "",
        username: validated.user.username ?? "",
      },
      config.jwtSecret,
      { expiresIn: "7d" },
    );

    return res.json({
      token,
      user: validated.user,
      chat: validated.chat ?? null,
      startParam: validated.startParam ?? null,
      authDate: validated.authDate,
    });
  } catch (error) {
    return res.status(401).json({
      error: "unauthorized",
      message: error instanceof Error ? error.message : "Validation failed",
    });
  }
});

app.get("/api/auth/me", (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;

  if (!token) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    return res.json({ ok: true, payload });
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
});

app.use(
  "/api/manage",
  createManageRouter({
    bot,
    jwtSecret: config.jwtSecret,
    giveawaysCollection: manageGiveawaysCollection,
    channelConnectionsCollection,
  }),
);

app.use(
  "/api/profile",
  createProfileRouter({
    jwtSecret: config.jwtSecret,
    participantsCollection: profileParticipantsCollection,
    giveawaysCollection: profileGiveawaysCollection,
    ticketsCollection: profileTicketsCollection,
  }),
);

async function issueBackendTickets(input: {
  giveawayId: ObjectId;
  userId: number;
  desiredCount: number;
  sourceUserId?: number;
}) {
  const safeDesired = Math.max(0, Math.floor(input.desiredCount));
  const currentCount = await ticketsCollection.countDocuments({
    giveawayId: input.giveawayId,
    userId: input.userId,
  });
  const toIssue = Math.max(0, safeDesired - currentCount);
  if (toIssue > 0) {
    const now = new Date();
    const docs: CheckTicketDoc[] = Array.from({ length: toIssue }, (_, index) => ({
      giveawayId: input.giveawayId,
      userId: input.userId,
      ticket: createHash("sha256")
        .update(`${input.giveawayId.toHexString()}:${input.userId}:${Date.now()}:${randomUUID()}`)
        .digest("hex")
        .slice(0, 12)
        .toUpperCase(),
      sequence: currentCount + index + 1,
      createdAt: now,
      source: "backend_check",
      ...(typeof input.sourceUserId === "number" ? { sourceUserId: input.sourceUserId } : {}),
    }));
    await ticketsCollection.insertMany(docs, { ordered: true });
  }
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

app.post("/api/giveaways/check", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;
  if (!token) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const parsedBody = checkBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: "bad_request",
      details: parsedBody.error.flatten(),
    });
  }

  let userId: number | null = null;
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload | string;
    if (typeof decoded === "string") {
      return res.status(401).json({ error: "invalid_token" });
    }
    const uid = decoded.uid;
    if (typeof uid !== "number") {
      return res.status(401).json({ error: "invalid_token" });
    }
    userId = uid;
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }

  if (!ObjectId.isValid(parsedBody.data.eventId)) {
    return res.status(400).json({
      error: "bad_event_id",
      message: "eventId is invalid",
    });
  }
  const giveawayId = new ObjectId(parsedBody.data.eventId);
  const inviterIdFromPayload = parsedBody.data.inviterId;

  const giveaway = await giveawaysCollection.findOne({ _id: giveawayId });
  if (!giveaway) {
    return res.status(404).json({
      error: "not_found",
      message: "giveaway not found",
    });
  }

  const requiredChannels =
    Array.isArray(giveaway.requiredChannels) && giveaway.requiredChannels.length > 0
      ? giveaway.requiredChannels
      : [{ channelId: giveaway.channelId }];

  const channelChecks: Array<{
    channelId: number;
    channelTitle: string | null;
    channelJoinLink: string | null;
    subscribed: boolean;
  }> = [];

  for (const channel of requiredChannels) {
    const channelId = Number(channel.channelId);
    if (!Number.isInteger(channelId)) {
      continue;
    }
    try {
      const members = await bot.api.getChatMembers(channelId, {
        user_ids: [userId],
        count: 1,
      });
      const subscribed = members.members.some((member) => member.user_id === userId);
      channelChecks.push({
        channelId,
        channelTitle:
          typeof channel.channelTitle === "string" ? channel.channelTitle : null,
        channelJoinLink:
          typeof channel.channelJoinLink === "string" ? channel.channelJoinLink : null,
        subscribed,
      });
    } catch (err) {
      console.error("giveaway_check_membership_error:", {
        eventId: parsedBody.data.eventId,
        userId,
        channelId,
        error: err,
      });
      return res.status(502).json({
        error: "membership_check_failed",
        message: `Failed to verify membership for channel ${channelId}`,
      });
    }
  }

  const missingChannels = channelChecks.filter((item) => !item.subscribed);
  const allChannelsSubscribed = missingChannels.length === 0;
  let participant = await participantsCollection.findOne({ giveawayId, userId });
  const effectiveInviterId =
    typeof participant?.referredByUserId === "number"
      ? participant.referredByUserId
      : typeof inviterIdFromPayload === "number" && inviterIdFromPayload !== userId
        ? inviterIdFromPayload
        : undefined;
  const baseQualificationStatus =
    giveaway.type === "referral"
      ? allChannelsSubscribed
        ? "pending_referrals"
        : "pending_subscription"
      : allChannelsSubscribed
        ? "qualified"
        : "pending_subscription";

  const participantUpdate = await participantsCollection.findOneAndUpdate(
    { giveawayId, userId },
    {
      $setOnInsert: {
        giveawayId,
        userId,
        joinedAt: new Date(),
      },
      $set: {
        subscribedToChannel: allChannelsSubscribed,
        qualificationStatus: baseQualificationStatus,
        ...(typeof effectiveInviterId === "number" ? { referredByUserId: effectiveInviterId } : {}),
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  participant = participantUpdate ?? participant;
  const referralRequired = Math.max(
    1,
    Number(giveaway.invitesPerTicket ?? giveaway.requiredInvites ?? 1),
  );
  const referralCompletedCount =
    referralRequired > 0
      ? await participantsCollection.countDocuments({
          giveawayId,
          referredByUserId: userId,
          subscribedToChannel: true,
        })
      : 0;
  const referralMet = giveaway.type === "referral"
    ? referralCompletedCount >= referralRequired
    : true;

  const allConditionsMet = allChannelsSubscribed && referralMet;
  const desiredTicketCount =
    giveaway.type === "referral"
      ? Math.floor(referralCompletedCount / referralRequired)
      : allConditionsMet
        ? 1
        : 0;
  const participantTicketCountBefore = await ticketsCollection.countDocuments({
    giveawayId,
    userId,
  });
  const shouldIssueOrUpdateTicket =
    allConditionsMet &&
    giveaway.status === "active" &&
    desiredTicketCount > 0 &&
    participantTicketCountBefore < desiredTicketCount;

  if (shouldIssueOrUpdateTicket) {
    await issueBackendTickets({
      giveawayId,
      userId,
      desiredCount: desiredTicketCount,
    });
    await participantsCollection.updateOne(
      { giveawayId, userId },
      {
        $set: {
          subscribedToChannel: allChannelsSubscribed,
          ...(giveaway.type === "referral" ? { qualificationStatus: "qualified" } : {}),
        },
      },
      { upsert: true },
    );
    participant = await participantsCollection.findOne({ giveawayId, userId });
  }

  if (giveaway.type === "referral" && typeof effectiveInviterId === "number") {
    const inviterCompletedCount = await participantsCollection.countDocuments({
      giveawayId,
      referredByUserId: effectiveInviterId,
      subscribedToChannel: true,
    });
    const inviterDesiredTicketCount = Math.floor(inviterCompletedCount / referralRequired);
    const inviter = await participantsCollection.findOne({ giveawayId, userId: effectiveInviterId });
    const inviterCanReceiveTicket = Boolean(inviter?.subscribedToChannel);
    if (inviterCanReceiveTicket && inviterDesiredTicketCount > 0) {
      await issueBackendTickets({
        giveawayId,
        userId: effectiveInviterId,
        desiredCount: inviterDesiredTicketCount,
        sourceUserId: userId,
      });
      await participantsCollection.updateOne(
        { giveawayId, userId: effectiveInviterId },
        {
          $set: {
            qualificationStatus: "qualified",
          },
        },
      );
    }
  }

  const latestParticipantTicket = await ticketsCollection.findOne(
    { giveawayId, userId },
    { sort: { sequence: -1 } },
  );
  const participantTicketCount = await ticketsCollection.countDocuments({ giveawayId, userId });

  if (giveaway.type === "referral" && allChannelsSubscribed && participantTicketCount === 0) {
    await participantsCollection.updateOne(
      { giveawayId, userId },
      { $set: { qualificationStatus: "pending_referrals" } },
    );
    participant = await participantsCollection.findOne({ giveawayId, userId });
  }

  const botPublicName = process.env.BOT_PUBLIC_NAME ?? "id231002619995_bot";
  const referralInviteLink =
    giveaway.type === "referral" && allChannelsSubscribed
      ? `https://max.ru/${botPublicName}?startapp=invite_${giveawayId.toHexString()}_${userId}`
      : null;

  return res.json({
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
      giveaway.type === "referral"
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
});

async function bootstrap() {
  await mongoClient.connect();
  app.listen(config.port, () => {
    console.log(`[max-backend] listening on http://localhost:${config.port}`);
  });
}

bootstrap().catch((err) => {
  console.error("[max-backend] failed to start:", err);
  process.exit(1);
});

