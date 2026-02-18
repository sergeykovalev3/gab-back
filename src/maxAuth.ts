import { createHmac, timingSafeEqual } from "node:crypto";

type MaxUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string | null;
};

type MaxChat = {
  id: number;
  type: string;
};

export type MaxInitData = {
  authDate: number;
  queryId?: string;
  hash: string;
  startParam?: string;
  user?: MaxUser;
  chat?: MaxChat;
  raw: string;
};

export function validateMaxInitData(
  rawInitData: string,
  botToken: string,
  maxAgeSeconds: number,
): MaxInitData {
  if (!rawInitData) {
    throw new Error("initData is empty");
  }

  // In practice clients may send encoded or already-decoded data.
  const decoded = safeDecode(rawInitData);
  const params = new URLSearchParams(decoded);
  const hash = params.get("hash");
  if (!hash) {
    throw new Error("hash is missing in initData");
  }

  const entries: string[] = [];
  params.forEach((value, key) => {
    if (key !== "hash") {
      entries.push(`${key}=${value}`);
    }
  });
  entries.sort((a, b) => a.localeCompare(b));
  const dataCheckString = entries.join("\n");

  const secret = createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const calculated = createHmac("sha256", secret)
    .update(dataCheckString)
    .digest("hex");

  const providedBuffer = Buffer.from(hash, "hex");
  const calculatedBuffer = Buffer.from(calculated, "hex");
  if (
    providedBuffer.length !== calculatedBuffer.length ||
    !timingSafeEqual(providedBuffer, calculatedBuffer)
  ) {
    throw new Error("invalid initData signature");
  }

  const authDateRaw = params.get("auth_date");
  if (!authDateRaw) {
    throw new Error("auth_date is missing");
  }
  const authDateNum = Number(authDateRaw);
  if (!Number.isFinite(authDateNum)) {
    throw new Error("auth_date is invalid");
  }
  const authDateSeconds =
    authDateNum > 1_000_000_000_000
      ? Math.floor(authDateNum / 1000)
      : Math.floor(authDateNum);

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - authDateSeconds > maxAgeSeconds) {
    throw new Error("initData expired");
  }

  return {
    authDate: authDateSeconds,
    queryId: params.get("query_id") ?? undefined,
    hash,
    startParam: params.get("start_param") ?? undefined,
    user: parseJson<MaxUser>(params.get("user")),
    chat: parseJson<MaxChat>(params.get("chat")),
    raw: rawInitData,
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

