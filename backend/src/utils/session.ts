import { randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Session store
//
// Серверное хранилище сессий для BFF-паттерна.
// Токены (access_token, refresh_token) хранятся ТОЛЬКО здесь.
// Клиент получает лишь идентификатор сессии через httpOnly cookie.
//
// В продакшене замените Map на Redis (ioredis / connect-redis).
// ---------------------------------------------------------------------------

export interface BFFSession {
  sessionId: string;
  /** Токен для запросов к Backend API — хранится только на сервере */
  accessToken: string;
  /** Токен для обновления access_token — хранится только на сервере */
  refreshToken: string;
  /** ID-токен для logout (id_token_hint) */
  idToken: string;
  /** Unix-timestamp (мс) истечения access_token */
  accessTokenExpiresAt: number;
  /** Unix-timestamp (мс) истечения refresh_token */
  refreshTokenExpiresAt: number;
}

// In-memory store (замените на Redis в продакшене)
const store = new Map<string, BFFSession>();

export function createSession(
  accessToken: string,
  refreshToken: string,
  idToken: string,
  expiresIn: number,
  refreshExpiresIn: number,
): BFFSession {
  const sessionId = randomBytes(32).toString('hex');
  const now = Date.now();

  const session: BFFSession = {
    sessionId,
    accessToken,
    refreshToken,
    idToken,
    accessTokenExpiresAt: now + expiresIn * 1000,
    refreshTokenExpiresAt: now + refreshExpiresIn * 1000,
  };

  store.set(sessionId, session);
  return session;
}

export function getSession(sessionId: string): BFFSession | undefined {
  return store.get(sessionId);
}

export function updateSession(
  sessionId: string,
  updates: Pick<BFFSession, 'accessToken' | 'refreshToken' | 'accessTokenExpiresAt' | 'refreshTokenExpiresAt'>,
): BFFSession | undefined {
  const session = store.get(sessionId);
  if (!session) return undefined;
  const updated = { ...session, ...updates };
  store.set(sessionId, updated);
  return updated;
}

export function deleteSession(sessionId: string): void {
  store.delete(sessionId);
}

export function isAccessTokenExpired(session: BFFSession): boolean {
  // Обновляем за 30 секунд до истечения
  return Date.now() >= session.accessTokenExpiresAt - 30_000;
}

export function isRefreshTokenExpired(session: BFFSession): boolean {
  return Date.now() >= session.refreshTokenExpiresAt;
}
