import { Request, Response, NextFunction } from 'express';

/**
 * Централизованный обработчик ошибок Express.
 *
 * Подключается последним через app.use() — перехватывает любую ошибку,
 * которую роут передал через next(error) или бросил в async-обработчике.
 *
 * Формат ответа всегда одинаковый: { error, message? }
 */
export function ErrorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  // Логируем ошибку на сервере для отладки
  console.error('[error]', err);

  // Если это стандартная ошибка JS — передаём её message клиенту
  if (err instanceof Error) {
    res.status(500).json({
      error: 'internal_server_error',
      message: err.message,
    });
    return;
  }

  // Для неизвестных типов ошибок — общий ответ
  res.status(500).json({ error: 'internal_server_error' });
}
