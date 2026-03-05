import { Router } from "express";
import jwt from "jsonwebtoken";
import { Collection, ObjectId } from "mongodb";

export type ParticipantDoc = {
  giveawayId: ObjectId;
  userId: number;
  joinedAt?: Date | string;
  ticket?: string | null;
};

export type GiveawayTicketDoc = {
  giveawayId: ObjectId;
  userId: number;
  ticket: string;
  sequence: number;
  createdAt: Date | string;
};

export type GiveawayDoc = {
  _id: ObjectId;
  title: string;
  type: "regular" | "referral";
  status: "active" | "finished";
  endsAt: Date | string;
  winnersCount: number;
  requiredChannels?: Array<{
    channelId: number;
    channelTitle?: string | null;
    channelJoinLink?: string | null;
  }>;
  winnerUserIds?: number[];
  winnerTickets?: string[];
};

type CreateProfileRouterInput = {
  jwtSecret: string;
  participantsCollection: Collection<ParticipantDoc>;
  giveawaysCollection: Collection<GiveawayDoc>;
  ticketsCollection: Collection<GiveawayTicketDoc>;
};

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

export function createProfileRouter(input: CreateProfileRouterInput) {
  const router = Router();

  router.get("/participations", async (req, res) => {
    const userId = getUserIdFromAuthHeader(req.headers.authorization, input.jwtSecret);
    if (!userId) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const participations = await input.participantsCollection
      .find({ userId })
      .sort({ joinedAt: -1 })
      .limit(100)
      .toArray();

    const giveawayIds = participations.map((item) => item.giveawayId);
    const giveaways = giveawayIds.length
      ? await input.giveawaysCollection.find({ _id: { $in: giveawayIds } }).toArray()
      : [];
    const giveawayMap = new Map(giveaways.map((giveaway) => [String(giveaway._id), giveaway]));
    const tickets = giveawayIds.length
      ? await input.ticketsCollection
          .find({ giveawayId: { $in: giveawayIds }, userId })
          .sort({ sequence: -1 })
          .toArray()
      : [];
    const latestTicketByGiveaway = new Map<string, string>();
    for (const row of tickets) {
      const key = String(row.giveawayId);
      if (!latestTicketByGiveaway.has(key)) {
        latestTicketByGiveaway.set(key, row.ticket);
      }
    }

    const items = participations
      .map((item) => {
        const giveaway = giveawayMap.get(String(item.giveawayId));
        if (!giveaway) {
          return null;
        }
        const winnerUserIds = Array.isArray(giveaway.winnerUserIds) ? giveaway.winnerUserIds : [];
        const won = giveaway.status === "finished" ? winnerUserIds.includes(userId) : null;
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

    return res.json({ items });
  });

  router.get("/participations/:eventId", async (req, res) => {
    const userId = getUserIdFromAuthHeader(req.headers.authorization, input.jwtSecret);
    if (!userId) {
      return res.status(401).json({ error: "unauthorized" });
    }

    if (!ObjectId.isValid(req.params.eventId)) {
      return res.status(400).json({ error: "bad_event_id" });
    }
    const giveawayId = new ObjectId(req.params.eventId);

    const participation = await input.participantsCollection.findOne({ giveawayId, userId });
    if (!participation) {
      return res.status(404).json({ error: "not_found", message: "participation not found" });
    }

    const giveaway = await input.giveawaysCollection.findOne({ _id: giveawayId });
    if (!giveaway) {
      return res.status(404).json({ error: "not_found", message: "giveaway not found" });
    }

    const winnerUserIds = Array.isArray(giveaway.winnerUserIds) ? giveaway.winnerUserIds : [];
    const winnerTickets = Array.isArray(giveaway.winnerTickets) ? giveaway.winnerTickets : [];
    const latestTicket = await input.ticketsCollection.findOne(
      { giveawayId, userId },
      { sort: { sequence: -1 } },
    );
    const winners = winnerUserIds.map((winnerUserId, index) => ({
      userId: winnerUserId,
      ticket: winnerTickets[index] ?? null,
    }));

    return res.json({
      eventId: String(giveaway._id),
      title: giveaway.title,
      type: giveaway.type,
      status: giveaway.status,
      endsAt: giveaway.endsAt,
      winnersCount: giveaway.winnersCount,
      joinedAt: participation.joinedAt ?? null,
      ticket: latestTicket?.ticket ?? null,
      won: giveaway.status === "finished" ? winnerUserIds.includes(userId) : null,
      requiredChannels: Array.isArray(giveaway.requiredChannels) ? giveaway.requiredChannels : [],
      winners,
    });
  });

  return router;
}

