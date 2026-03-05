import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { loadConfig } from '../config/index.js';
import { JwtPayload } from '../types/index.js';

// Расширяем стандартный тип Request — добавляем поле user после успешной авторизации
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/**
 * Middleware проверки авторизации.
 *
 * Поддерживает два варианта:
 * 1) Mini-app / фронтенд: Authorization: Bearer <JWT>
 * 2) Бот (server-to-server): Authorization: Bot <BOT_TOKEN> + заголовок X-User-Id: <uid>
 *
 * В обоих случаях по итогу заполняем req.user.uid, чтобы роуты работали одинаково.
 */
export function AuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const config = loadConfig();

  const authHeader = req.headers.authorization ?? '';

  // Вариант 1: авторизация через JWT (Bearer)
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length);

    try {
      const decoded = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;

      if (typeof decoded.uid !== 'number') {
        res.status(401).json({ error: 'invalid_token' });
        return;
      }

      req.user = {
        uid: decoded.uid,
        first_name: decoded.first_name ?? '',
        last_name: decoded.last_name ?? '',
        username: decoded.username ?? '',
      };

      next();
      return;
    } catch {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
  }

  // Вариант 2: авторизация бота: Authorization: Bot <BOT_TOKEN> + X-User-Id
  if (authHeader.startsWith('Bot ')) {
    const apiKey = authHeader.slice('Bot '.length).trim();

    // Используем BOT_TOKEN как shared secret между ботом и backend
    if (!apiKey || apiKey !== config.botToken) {
      res.status(401).json({ error: 'unauthorized_bot' });
      return;
    }

    const rawUserId = req.header('x-user-id');
    const uid = Number(rawUserId);

    if (!rawUserId || !Number.isInteger(uid) || uid <= 0) {
      res.status(401).json({ error: 'bad_user_id', message: 'X-User-Id обязателен и должен быть целым числом' });
      return;
    }

    req.user = {
      uid,
      first_name: '',
      last_name: '',
      username: '',
    };

    next();
    return;
  }

  // Если не подошёл ни один вариант — считаем запрос неавторизованным
  res.status(401).json({ error: 'unauthorized' });
}

