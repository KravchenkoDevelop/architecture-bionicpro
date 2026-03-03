/**
 * keycloak.service.test.ts — Unit tests for KeycloakService (BFF).
 *
 * Covered:
 *  - generatePKCE: randomness, length, correct SHA-256 challenge derivation
 *  - buildAuthorizationUrl: required OAuth params, S256 method, state param
 *  - exchangeCode: POSTs correct body, returns tokens, throws on error
 *  - refreshAccessToken: POSTs refresh_token grant, throws on error
 *  - buildLogoutUrl: id_token_hint, post_logout_redirect_uri, correct endpoint
 */

import * as crypto from 'crypto';
import { KeycloakService } from '../../src/services/keycloak.service';

// ---------------------------------------------------------------------------
// Setup: mock fetch globally
// ---------------------------------------------------------------------------

const mockFetch = jest.fn();
global.fetch = mockFetch;

function okResponse(body: object) {
  return Promise.resolve({
    ok:   true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function errorResponse(status: number, text = 'error') {
  return Promise.resolve({
    ok:   false,
    status,
    json: async () => ({}),
    text: async () => text,
  });
}

const TOKEN_RESPONSE = {
  access_token:      'at-value',
  refresh_token:     'rt-value',
  id_token:          'it-value',
  expires_in:        300,
  refresh_expires_in:1800,
  token_type:        'Bearer',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('KeycloakService', () => {
  let svc: KeycloakService;

  beforeEach(() => {
    svc = new KeycloakService();
  });

  // -------------------------------------------------------------------------
  // generatePKCE
  // -------------------------------------------------------------------------

  describe('generatePKCE', () => {
    it('returns non-empty codeVerifier and codeChallenge', () => {
      const { codeVerifier, codeChallenge } = svc.generatePKCE();
      expect(codeVerifier).toBeTruthy();
      expect(codeChallenge).toBeTruthy();
    });

    it('codeChallenge equals SHA-256(codeVerifier) encoded as base64url', () => {
      const { codeVerifier, codeChallenge } = svc.generatePKCE();
      const expected = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');
      expect(codeChallenge).toBe(expected);
    });

    it('generates unique pairs on each call (randomness)', () => {
      const p1 = svc.generatePKCE();
      const p2 = svc.generatePKCE();
      expect(p1.codeVerifier).not.toBe(p2.codeVerifier);
      expect(p1.codeChallenge).not.toBe(p2.codeChallenge);
    });

    it('codeVerifier is at least 32 characters long (RFC 7636 minimum)', () => {
      const { codeVerifier } = svc.generatePKCE();
      expect(codeVerifier.length).toBeGreaterThanOrEqual(32);
    });

    it('codeVerifier contains only base64url-safe characters', () => {
      const { codeVerifier } = svc.generatePKCE();
      expect(codeVerifier).toMatch(/^[A-Za-z0-9\-_]+$/);
    });
  });

  // -------------------------------------------------------------------------
  // buildAuthorizationUrl
  // -------------------------------------------------------------------------

  describe('buildAuthorizationUrl', () => {
    it('includes the code_challenge in the URL', () => {
      const url = svc.buildAuthorizationUrl('my-challenge', 'csrf-state');
      expect(url).toContain('code_challenge=my-challenge');
    });

    it('sets code_challenge_method=S256', () => {
      const url = svc.buildAuthorizationUrl('ch', 'st');
      expect(url).toContain('code_challenge_method=S256');
    });

    it('includes the state parameter (CSRF protection)', () => {
      const url = svc.buildAuthorizationUrl('ch', 'unique-state');
      expect(url).toContain('state=unique-state');
    });

    it('sets response_type=code (Authorization Code Flow)', () => {
      const url = svc.buildAuthorizationUrl('ch', 'st');
      expect(url).toContain('response_type=code');
    });

    it('requests openid, profile and email scopes', () => {
      const url = svc.buildAuthorizationUrl('ch', 'st');
      // URLSearchParams encodes spaces as '+', so decode '+' → ' ' before asserting
      const decoded = decodeURIComponent(url).replace(/\+/g, ' ');
      expect(decoded).toContain('openid profile email');
    });

    it('points to the Keycloak /auth endpoint of the correct realm', () => {
      const url = svc.buildAuthorizationUrl('ch', 'st');
      expect(url).toContain('/realms/reports-realm/protocol/openid-connect/auth');
    });

    it('includes the configured client_id', () => {
      const url = svc.buildAuthorizationUrl('ch', 'st');
      expect(url).toContain('client_id=reports-bff');
    });
  });

  // -------------------------------------------------------------------------
  // exchangeCode
  // -------------------------------------------------------------------------

  describe('exchangeCode', () => {
    it('POSTs to the token endpoint', async () => {
      mockFetch.mockReturnValueOnce(okResponse(TOKEN_RESPONSE));

      await svc.exchangeCode('auth-code', 'code-verifier');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/protocol/openid-connect/token');
    });

    it('sends grant_type=authorization_code', async () => {
      mockFetch.mockReturnValueOnce(okResponse(TOKEN_RESPONSE));

      await svc.exchangeCode('auth-code', 'code-verifier');

      const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as string);
      expect(body.get('grant_type')).toBe('authorization_code');
    });

    it('includes the authorization code in the request body', async () => {
      mockFetch.mockReturnValueOnce(okResponse(TOKEN_RESPONSE));

      await svc.exchangeCode('my-auth-code', 'verifier');

      const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as string);
      expect(body.get('code')).toBe('my-auth-code');
    });

    it('includes the code_verifier in the request body (PKCE)', async () => {
      mockFetch.mockReturnValueOnce(okResponse(TOKEN_RESPONSE));

      await svc.exchangeCode('code', 'my-verifier');

      const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as string);
      expect(body.get('code_verifier')).toBe('my-verifier');
    });

    it('returns the TokenResponse on success', async () => {
      mockFetch.mockReturnValueOnce(okResponse(TOKEN_RESPONSE));

      const result = await svc.exchangeCode('code', 'verifier');

      expect(result.access_token).toBe('at-value');
      expect(result.refresh_token).toBe('rt-value');
    });

    it('throws a descriptive error when Keycloak returns 400', async () => {
      mockFetch.mockReturnValueOnce(errorResponse(400, 'invalid_grant'));

      await expect(svc.exchangeCode('bad-code', 'verifier')).rejects.toThrow(
        /token exchange failed.*400/i
      );
    });
  });

  // -------------------------------------------------------------------------
  // refreshAccessToken
  // -------------------------------------------------------------------------

  describe('refreshAccessToken', () => {
    it('POSTs grant_type=refresh_token', async () => {
      mockFetch.mockReturnValueOnce(okResponse(TOKEN_RESPONSE));

      await svc.refreshAccessToken('old-rt');

      const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as string);
      expect(body.get('grant_type')).toBe('refresh_token');
    });

    it('sends the refresh token in the request body', async () => {
      mockFetch.mockReturnValueOnce(okResponse(TOKEN_RESPONSE));

      await svc.refreshAccessToken('my-refresh-token');

      const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as string);
      expect(body.get('refresh_token')).toBe('my-refresh-token');
    });

    it('returns new tokens on success', async () => {
      mockFetch.mockReturnValueOnce(okResponse(TOKEN_RESPONSE));

      const result = await svc.refreshAccessToken('rt');

      expect(result.access_token).toBe('at-value');
    });

    it('throws a descriptive error when refresh token is rejected (401)', async () => {
      mockFetch.mockReturnValueOnce(errorResponse(401, 'invalid_token'));

      await expect(svc.refreshAccessToken('expired-rt')).rejects.toThrow(
        /token refresh failed.*401/i
      );
    });
  });

  // -------------------------------------------------------------------------
  // buildLogoutUrl
  // -------------------------------------------------------------------------

  describe('buildLogoutUrl', () => {
    it('includes id_token_hint', () => {
      const url = svc.buildLogoutUrl('my-id-token', 'http://localhost:3000');
      expect(url).toContain('id_token_hint=my-id-token');
    });

    it('includes post_logout_redirect_uri', () => {
      const redirectUri = 'http://localhost:3000/bye';
      const url = svc.buildLogoutUrl('tok', redirectUri);
      expect(decodeURIComponent(url)).toContain(redirectUri);
    });

    it('points to the Keycloak /logout endpoint', () => {
      const url = svc.buildLogoutUrl('tok', 'http://localhost:3000');
      expect(url).toContain('/protocol/openid-connect/logout');
    });

    it('includes the realm in the URL', () => {
      const url = svc.buildLogoutUrl('tok', 'http://localhost:3000');
      expect(url).toContain('/realms/reports-realm/');
    });
  });
});
