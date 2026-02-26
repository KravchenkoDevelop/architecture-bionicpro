import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PKCEPair {
  codeVerifier: string;
  codeChallenge: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token: string;
  expires_in: number;
  refresh_expires_in: number;
  token_type: string;
}

// ---------------------------------------------------------------------------
// KeycloakService
//
// BFF-компонент для управления PKCE Authorization Code Flow с Keycloak.
// Токены access_token и refresh_token хранятся ТОЛЬКО на сервере (в сессии);
// фронтенд получает исключительно httpOnly session cookie.
// ---------------------------------------------------------------------------

export class KeycloakService {
  private readonly keycloakUrl: string;
  private readonly realm: string;
  private readonly clientId: string;
  private readonly redirectUri: string;

  constructor() {
    this.keycloakUrl = process.env.KEYCLOAK_URL ?? 'http://keycloak:8080';
    this.realm = process.env.KEYCLOAK_REALM ?? 'reports-realm';
    this.clientId = process.env.KEYCLOAK_BFF_CLIENT_ID ?? 'reports-bff';
    this.redirectUri = process.env.BFF_REDIRECT_URI ?? 'http://localhost:3001/auth/callback';
  }

  // -------------------------------------------------------------------------
  // PKCE helpers
  // -------------------------------------------------------------------------

  /**
   * Генерирует пару (code_verifier, code_challenge) по алгоритму S256 (RFC 7636).
   * code_verifier хранится в серверной сессии и НЕ передаётся клиенту.
   * code_challenge (SHA-256 хеш verifier в base64url) отправляется в Keycloak.
   */
  generatePKCE(): PKCEPair {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    return { codeVerifier, codeChallenge };
  }

  // -------------------------------------------------------------------------
  // Authorization URL
  // -------------------------------------------------------------------------

  /**
   * Формирует URL для редиректа браузера на страницу авторизации Keycloak.
   * @param codeChallenge  SHA-256(code_verifier) в base64url
   * @param state          Случайная строка для защиты от CSRF
   */
  buildAuthorizationUrl(codeChallenge: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid profile email',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    });

    return `${this.keycloakUrl}/realms/${this.realm}/protocol/openid-connect/auth?${params.toString()}`;
  }

  // -------------------------------------------------------------------------
  // Token exchange
  // -------------------------------------------------------------------------

  /**
   * Обменивает authorization code на токены.
   * Вызывается на сервере (BFF), результат сохраняется в серверной сессии.
   * Фронтенд токены не видит.
   *
   * @param code          Authorization code из callback-редиректа Keycloak
   * @param codeVerifier  code_verifier из серверной сессии (не от клиента!)
   */
  async exchangeCode(code: string, codeVerifier: string): Promise<TokenResponse> {
    const tokenEndpoint = this.tokenEndpointUrl();

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      code,
      code_verifier: codeVerifier,
    });

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Keycloak token exchange failed [${response.status}]: ${detail}`);
    }

    return response.json() as Promise<TokenResponse>;
  }

  // -------------------------------------------------------------------------
  // Token refresh
  // -------------------------------------------------------------------------

  /**
   * Обновляет access token при помощи refresh token.
   * refresh token хранится в серверной сессии — фронтенд его не получает.
   */
  async refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
    const tokenEndpoint = this.tokenEndpointUrl();

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      refresh_token: refreshToken,
    });

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Keycloak token refresh failed [${response.status}]: ${detail}`);
    }

    return response.json() as Promise<TokenResponse>;
  }

  // -------------------------------------------------------------------------
  // Logout
  // -------------------------------------------------------------------------

  /**
   * Строит URL для выхода (end_session_endpoint) в Keycloak.
   */
  buildLogoutUrl(idToken: string, postLogoutRedirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      id_token_hint: idToken,
      post_logout_redirect_uri: postLogoutRedirectUri,
    });
    return `${this.keycloakUrl}/realms/${this.realm}/protocol/openid-connect/logout?${params.toString()}`;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private tokenEndpointUrl(): string {
    return `${this.keycloakUrl}/realms/${this.realm}/protocol/openid-connect/token`;
  }
}

export const keycloakService = new KeycloakService();
