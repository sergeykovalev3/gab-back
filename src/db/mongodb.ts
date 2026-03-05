import { MongoClient, Db } from 'mongodb';

// Единственный экземпляр клиента на всё приложение (singleton)
let client: MongoClient | null = null;
let database: Db | null = null;

/**
 * Подключаемся к MongoDB и сохраняем экземпляры клиента и базы.
 * Повторный вызов безопасен — если соединение уже есть, ничего не делаем.
 *
 * @param uri — строка подключения (mongodb://...)
 * @param dbName — имя базы данных
 */
export async function ConnectMongoDB(uri: string, dbName: string): Promise<void> {
  if (client) return;

  client = new MongoClient(uri);
  await client.connect();
  database = client.db(dbName);

  console.log(`[db] подключились к MongoDB: ${dbName}`);
}

/**
 * Закрываем соединение с MongoDB (при graceful shutdown).
 */
export async function CloseMongoDB(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    database = null;
    console.log('[db] соединение закрыто');
  }
}

/**
 * Возвращаем экземпляр базы данных.
 * Бросаем ошибку если ConnectMongoDB не был вызван раньше —
 * это защита от случайного использования до инициализации.
 *
 * @returns Db — объект базы данных MongoDB
 */
export function GetDatabase(): Db {
  if (!database) {
    throw new Error('[db] база данных не инициализирована — вызови ConnectMongoDB сначала');
  }
  return database;
}
