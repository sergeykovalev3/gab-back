import { Collection } from 'mongodb';
import {
  GiveawayDoc,
  ParticipantDoc,
  TicketDoc,
  ChannelConnectionDoc,
  UserDoc,
} from '../types/index.js';
import { GetDatabase } from './mongodb.js';

/**
 * Возвращаем типизированную коллекцию розыгрышей.
 */
export function GetGiveawaysCollection(): Collection<GiveawayDoc> {
  return GetDatabase().collection<GiveawayDoc>('giveaways');
}

/**
 * Возвращаем типизированную коллекцию участников розыгрышей.
 */
export function GetParticipantsCollection(): Collection<ParticipantDoc> {
  return GetDatabase().collection<ParticipantDoc>('giveaway_participants');
}

/**
 * Возвращаем типизированную коллекцию билетов участников.
 */
export function GetTicketsCollection(): Collection<TicketDoc> {
  return GetDatabase().collection<TicketDoc>('giveaway_tickets');
}

/**
 * Возвращаем типизированную коллекцию подключённых каналов.
 */
export function GetChannelConnectionsCollection(): Collection<ChannelConnectionDoc> {
  return GetDatabase().collection<ChannelConnectionDoc>('channel_connections');
}

/**
 * Возвращаем типизированную коллекцию пользователей сервиса.
 */
export function GetUsersCollection(): Collection<UserDoc> {
  return GetDatabase().collection<UserDoc>('users');
}
