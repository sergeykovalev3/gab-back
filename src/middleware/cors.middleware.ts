import cors from 'cors';
import { Config } from '../config/index.js';

/**
 * Создаём CORS middleware на основе конфига.
 *
 * Разрешаем запросы от:
 * - запросов без Origin (server-to-server, Postman и т.п.)
 * - поддоменов *.ru.tuna.am и *.tuna.am (тестовые тоннели в dev-режиме)
 * - явно указанных origins из CORS_ORIGIN в .env
 *
 * @param config — конфиг приложения с полем corsOrigins
 * @returns cors middleware для Express
 */
export function CorsMiddleware(config: Config) {
  return cors({
    origin: (origin, callback) => {
      // Пропускаем запросы без заголовка Origin (server-to-server, same-origin)
      if (!origin) {
        callback(null, true);
        return;
      }

      // Разрешаем dev-тоннели Tuna (*.ru.tuna.am и *.tuna.am)
      if (origin.endsWith('.ru.tuna.am') || origin.endsWith('.tuna.am')) {
        callback(null, true);
        return;
      }

      // Проверяем, есть ли origin в белом списке из .env
      if (config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`CORS заблокирован для origin: ${origin}`));
    },
    credentials: true,
  });
}
