import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { loadConfig } from '../../config/index.js';
import { ValidateMaxInitData } from '../../utils/max-auth.js';

// Схема валидации тела запроса на авторизацию
const authBodySchema = z.object({
  initData: z.string().min(1),
});

/**
 * Роуты авторизации через платформу Max.
 *
 * POST /api/auth/max  — принимает initData, возвращает JWT-токен
 * GET  /api/auth/me   — проверяет токен и возвращает payload
 */
export class AuthRoutes {
  public Router: Router;

  constructor() {
    this.Router = Router();
    this._initRoutes();
  }

  private _initRoutes(): void {
    this.Router.post('/max', this._handleLogin.bind(this));
    this.Router.get('/me', this._handleMe.bind(this));
  }

  /**
   * Авторизация пользователя через initData платформы Max.
   * Проверяем подпись initData, извлекаем пользователя и выдаём JWT на 7 дней.
   */
  private _handleLogin = async (req: import('express').Request, res: import('express').Response): Promise<void> => {
    const config = loadConfig();

    // Валидируем тело запроса
    const parsed = authBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }

    try {
      // Проверяем подпись initData и извлекаем данные пользователя
      const validated = ValidateMaxInitData(
        parsed.data.initData,
        config.botToken,
        config.authMaxAgeSeconds,
      );

      if (!validated.user?.id) {
        res.status(400).json({ error: 'user_missing', message: 'initData не содержит объект user' });
        return;
      }

      // Выпускаем JWT-токен с данными пользователя
      const token = jwt.sign(
        {
          uid: validated.user.id,
          first_name: validated.user.first_name ?? '',
          last_name: validated.user.last_name ?? '',
          username: validated.user.username ?? '',
        },
        config.jwtSecret,
        { expiresIn: '7d' },
      );

      res.json({
        token,
        user: validated.user,
        chat: validated.chat ?? null,
        startParam: validated.startParam ?? null,
        authDate: validated.authDate,
      });
    } catch (error) {
      res.status(401).json({
        error: 'unauthorized',
        message: error instanceof Error ? error.message : 'Validation failed',
      });
    }
  };

  /**
   * Проверяем JWT-токен из заголовка Authorization и возвращаем его payload.
   * Используется клиентом для проверки валидности сессии.
   */
  private _handleMe = (req: import('express').Request, res: import('express').Response): void => {
    const config = loadConfig();

    // Извлекаем токен из заголовка Authorization: Bearer <token>
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : null;

    if (!token) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    try {
      const payload = jwt.verify(token, config.jwtSecret);
      res.json({ ok: true, payload });
    } catch {
      res.status(401).json({ error: 'invalid_token' });
    }
  };
}
