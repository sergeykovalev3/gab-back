import 'dotenv/config';

/**
 * Описание всех конфигурационных параметров приложения.
 * Значения берутся из переменных окружения (.env файла).
 */
export type Config = {
  port: number;
  botToken: string;
  botPublicName: string;
  jwtSecret: string;
  authMaxAgeSeconds: number;
  corsOrigins: string[];
  mongoUri: string;
  mongoDbName: string;
  /** Базовый URL API для ссылок на файлы (прокси /api/files/download) */
  publicApiUrl?: string;
};

/**
 * Загружаем и валидируем конфиг из переменных окружения.
 * Если обязательная переменная отсутствует — бросаем ошибку на старте,
 * чтобы не получить падение в рантайме в неожиданном месте.
 *
 * @returns Config — объект с готовыми параметрами приложения.
 */
export function loadConfig(): Config {
  const port = Number(process.env.PORT ?? 4000);
  const botToken = process.env.BOT_TOKEN;
  const botPublicName = process.env.BOT_PUBLIC_NAME ?? 'id231002619995_bot';
  const jwtSecret = process.env.JWT_SECRET;

  // Срок жизни initData (в секундах), по умолчанию 24 часа
  const authMaxAgeSeconds = Number(process.env.AUTH_MAX_AGE_SECONDS ?? 86400);

  // Список разрешённых origins для CORS, разделённых запятой
  const corsOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173,https://localhost:5173')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const mongoUri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
  const mongoDbName = process.env.MONGODB_DB ?? 'max_events_bot';

  const rawPublicUrl =
    process.env.PUBLIC_API_URL ?? process.env.BACKEND_API_URL ?? 'http://localhost:4000';
  const publicApiUrl = rawPublicUrl.replace(/\/+$/, '');

  if (!botToken) {
    throw new Error('BOT_TOKEN отсутствует в .env файле бэкенда');
  }
  if (!jwtSecret) {
    throw new Error('JWT_SECRET отсутствует в .env файле бэкенда');
  }

  return {
    port,
    botToken,
    botPublicName,
    jwtSecret,
    authMaxAgeSeconds,
    corsOrigins,
    mongoUri,
    mongoDbName,
    publicApiUrl,
  };
}
