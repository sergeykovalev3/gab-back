import "dotenv/config";

export type Config = {
  port: number;
  botToken: string;
  jwtSecret: string;
  authMaxAgeSeconds: number;
  corsOrigins: string[];
  mongoUri: string;
  mongoDbName: string;
};

export function loadConfig(): Config {
  const port = Number(process.env.PORT ?? 4000);
  const botToken = process.env.BOT_TOKEN;
  const jwtSecret = process.env.JWT_SECRET;
  const authMaxAgeSeconds = Number(process.env.AUTH_MAX_AGE_SECONDS ?? 86400);
  const corsOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5173,https://localhost:5173")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const mongoUri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017";
  const mongoDbName = process.env.MONGODB_DB ?? "max_events_bot";

  if (!botToken) {
    throw new Error("BOT_TOKEN is missing in backend .env");
  }
  if (!jwtSecret) {
    throw new Error("JWT_SECRET is missing in backend .env");
  }

  return {
    port,
    botToken,
    jwtSecret,
    authMaxAgeSeconds,
    corsOrigins,
    mongoUri,
    mongoDbName,
  };
}

