import { Router, type Request, type Response } from 'express';
import { EnsureUserExists } from '../../services/users.service.js';

/**
 * Роуты, связанные с профилем пользователя в контексте сервиса (не Max).
 *
 * Все эндпоинты предполагают, что AuthMiddleware уже выполнился и в req.user
 * находится uid и базовые поля профиля.
 */
export class UserRoutes {
  public Router: Router;

  constructor() {
    this.Router = Router();
    this._initRoutes();
  }

  private _initRoutes(): void {
    /**
     * POST /api/profile/users/ensure
     *
     * Гарантирует наличие записи пользователя в коллекции users и обновляет
     * поля профиля (имя, фамилия, username) и lastSeenAt.
     *
     * Вызывается ботом и мини‑аппом при старте работы пользователя.
     */
    this.Router.post('/users/ensure', this._handleEnsureUser.bind(this));
  }

  private async _handleEnsureUser(req: Request, res: Response): Promise<void> {
    const user = req.user;
    if (!user || typeof user.uid !== 'number') {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    await EnsureUserExists({
      uid: user.uid,
      first_name: user.first_name,
      last_name: user.last_name,
      username: user.username,
    });

    res.json({ ok: true });
  }
}
