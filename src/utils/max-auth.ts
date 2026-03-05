import { createHmac, timingSafeEqual } from 'node:crypto';
import { MaxInitData } from '../types/index.js';

/**
 * Безопасно декодируем URL-encoded строку.
 * Если строка уже decoded — возвращаем как есть.
 */
function _safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Парсим JSON-строку в объект нужного типа.
 * Если строка пустая или невалидный JSON — возвращаем undefined.
 */
function _parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/**
 * Проверяем подлинность initData от платформы Max (Mini App).
 *
 * Алгоритм проверки:
 * 1. Декодируем строку и разбираем как URLSearchParams
 * 2. Извлекаем hash и убираем его из параметров
 * 3. Сортируем оставшиеся параметры и собираем строку для проверки
 * 4. Вычисляем HMAC-SHA256: secret = HMAC(botToken, "WebAppData"), подпись = HMAC(dataCheckString, secret)
 * 5. Сравниваем вычисленную подпись с присланной (timingSafeEqual защищает от timing-атак)
 * 6. Проверяем, что данные не устарели (auth_date + maxAgeSeconds > now)
 *
 * @param rawInitData — сырая строка initData от клиента
 * @param botToken — токен бота для вычисления секрета
 * @param maxAgeSeconds — максимальный допустимый возраст данных в секундах
 * @returns MaxInitData — распарсенные и провалидированные данные
 * @throws Error если подпись невалидна или данные устарели
 */
export function ValidateMaxInitData(
  rawInitData: string,
  botToken: string,
  maxAgeSeconds: number,
): MaxInitData {
  if (!rawInitData) {
    throw new Error('initData пустой');
  }

  // Декодируем и разбираем параметры
  const decoded = _safeDecode(rawInitData);
  const params = new URLSearchParams(decoded);

  const hash = params.get('hash');
  if (!hash) {
    throw new Error('hash отсутствует в initData');
  }

  // Собираем строку для проверки подписи: все параметры кроме hash, отсортированные
  const entries: string[] = [];
  params.forEach((value, key) => {
    if (key !== 'hash') entries.push(`${key}=${value}`);
  });
  entries.sort((a, b) => a.localeCompare(b));
  const dataCheckString = entries.join('\n');

  // Вычисляем ожидаемую подпись
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculated = createHmac('sha256', secret).update(dataCheckString).digest('hex');

  // Сравниваем подписи безопасным способом (защита от timing-атак)
  const providedBuffer = Buffer.from(hash, 'hex');
  const calculatedBuffer = Buffer.from(calculated, 'hex');
  if (
    providedBuffer.length !== calculatedBuffer.length ||
    !timingSafeEqual(providedBuffer, calculatedBuffer)
  ) {
    throw new Error('невалидная подпись initData');
  }

  // Проверяем актуальность данных по auth_date
  const authDateRaw = params.get('auth_date');
  if (!authDateRaw) throw new Error('auth_date отсутствует в initData');

  const authDateNum = Number(authDateRaw);
  if (!Number.isFinite(authDateNum)) throw new Error('auth_date невалидный');

  // Поддерживаем как секунды, так и миллисекунды
  const authDateSeconds =
    authDateNum > 1_000_000_000_000
      ? Math.floor(authDateNum / 1000)
      : Math.floor(authDateNum);

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - authDateSeconds > maxAgeSeconds) {
    throw new Error('initData устарел');
  }

  return {
    authDate: authDateSeconds,
    queryId: params.get('query_id') ?? undefined,
    hash,
    startParam: params.get('start_param') ?? undefined,
    user: _parseJson(params.get('user')),
    chat: _parseJson(params.get('chat')),
    raw: rawInitData,
  };
}
