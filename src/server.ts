import express from 'express';

import { loadConfig } from './config/index.js';
import { ConnectMongoDB, CloseMongoDB } from './db/mongodb.js';
import { CreateIndexes } from './db/indexes.js';
import { AuthMiddleware } from './middleware/auth.middleware.js';
import { CorsMiddleware } from './middleware/cors.middleware.js';
import { ErrorMiddleware } from './middleware/error.middleware.js';
import { AuthRoutes } from './api/auth/auth.routes.js';
import { GiveawayRoutes } from './api/giveaways/giveaway.routes.js';
import { FilesRoutes } from './api/files/files.routes.js';
import { ManageRoutes } from './api/manage/manage.routes.js';
import { ProfileRoutes } from './api/profile/profile.routes.js';
import { UserRoutes } from './api/profile/user.routes.js';

/**
 * Главный класс сервера - отвечает только за запуск и конфигурацию Express.
 * Вся бизнес-логика вынесена в сервисы и роуты.
 */
class Server {
  private app: express.Application;
  private config = loadConfig();

  constructor() {
    this.app = express();
    this.InitializeMiddlewares();
    this.InitializeRoutes();
    this.InitializeErrorHandling();
  }

  /**
   * Инициализируем базовые middleware.
   */
  private InitializeMiddlewares(): void {
    // Парсинг JSON с ограничением размера
    this.app.use(express.json({ limit: '256kb' }));

    // CORS конфигурация
    this.app.use(CorsMiddleware(this.config));

    // Проверка здоровья приложения
    this.app.get('/health', (_req, res) => {
      res.json({ ok: true });
    });
  }

  /**
   * Инициализируем роуты API.
   */

  private InitializeRoutes(): void {
    // Публичные роуты (без авторизации)
    this.app.use('/api/auth', new AuthRoutes().Router);
    this.app.use('/api/files', new FilesRoutes().Router);

    // Защищенные роуты (требуют авторизации)
    this.app.use('/api/giveaways', AuthMiddleware, new GiveawayRoutes().Router);
    this.app.use('/api/manage', AuthMiddleware, new ManageRoutes().Router);
    this.app.use('/api/profile', AuthMiddleware, new ProfileRoutes().Router);
    this.app.use('/api/profile', AuthMiddleware, new UserRoutes().Router);
  }

  /**
   * Инициализируем обработку ошибок.
   */
  private InitializeErrorHandling(): void {
    this.app.use(ErrorMiddleware);
  }

  /**
   * Запускаем сервер.
   */
  public async Start(): Promise<void> {
    try {
      // Подключаемся к MongoDB и создаём индексы
      await ConnectMongoDB(this.config.mongoUri, this.config.mongoDbName);
      await CreateIndexes();

      // Запускаем Express сервер
      const server = this.app.listen(this.config.port, () => {
        console.log(`[gab-backend] сервер запущен на http://localhost:${this.config.port}`);
      });

      // Graceful shutdown: закрываем MongoDB при SIGTERM/SIGINT
      const shutdown = async () => {
        server.close();
        await CloseMongoDB();
        process.exit(0);
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    } catch (error) {
      console.error('[gab-backend] ошибка запуска сервера:', error);
      process.exit(1);
    }
  }
}

/**
 * Точка входа в приложение.
 */
async function Bootstrap(): Promise<void> {
  const server = new Server();
  await server.Start();
}

// Запускаем приложение
Bootstrap().catch((error) => {
  console.error('[gab-backend] критическая ошибка:', error);
  process.exit(1);
});
