/**
 * session.test.ts — Unit tests for the BFF session store.
 *
 * Covered:
 *  - createSession: stores tokens, generates unique IDs, sets correct expiries
 *  - getSession: retrieves by ID, returns undefined for unknown IDs
 *  - updateSession: patches tokens; preserves idToken; returns undefined for ghost IDs
 *  - deleteSession: removes from store; is safe to call on missing ID
 *  - isAccessTokenExpired: respects the 30-second early-refresh buffer
 *  - isRefreshTokenExpired: strict boundary check
 */

import {
  createSession,
  getSession,
  updateSession,
  deleteSession,
  isAccessTokenExpired,
  isRefreshTokenExpired,
  BFFSession,
} from '../../src/utils/session';

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe('createSession', () => {
  it('returns a session with the provided tokens', () => {
    const s = createSession('at', 'rt', 'it', 300, 1800);
    expect(s.accessToken).toBe('at');
    expect(s.refreshToken).toBe('rt');
    expect(s.idToken).toBe('it');
  });

  it('generates a non-empty sessionId', () => {
    const s = createSession('a', 'r', 'i', 300, 1800);
    expect(s.sessionId).toBeTruthy();
    expect(typeof s.sessionId).toBe('string');
  });

  it('generates different sessionIds on consecutive calls', () => {
    const s1 = createSession('a', 'r', 'i', 300, 1800);
    const s2 = createSession('a', 'r', 'i', 300, 1800);
    expect(s1.sessionId).not.toBe(s2.sessionId);
  });

  it('sets accessTokenExpiresAt to now + expiresIn seconds', () => {
    const before = Date.now();
    const s = createSession('a', 'r', 'i', 300, 1800);
    const after = Date.now();

    expect(s.accessTokenExpiresAt).toBeGreaterThanOrEqual(before + 300_000);
    expect(s.accessTokenExpiresAt).toBeLessThanOrEqual(after + 300_000);
  });

  it('sets refreshTokenExpiresAt to now + refreshExpiresIn seconds', () => {
    const before = Date.now();
    const s = createSession('a', 'r', 'i', 300, 1800);
    const after = Date.now();

    expect(s.refreshTokenExpiresAt).toBeGreaterThanOrEqual(before + 1_800_000);
    expect(s.refreshTokenExpiresAt).toBeLessThanOrEqual(after + 1_800_000);
  });
});

// ---------------------------------------------------------------------------
// getSession
// ---------------------------------------------------------------------------

describe('getSession', () => {
  it('retrieves a session by sessionId', () => {
    const created = createSession('acc', 'ref', 'idtok', 300, 1800);
    const found = getSession(created.sessionId);
    expect(found).toEqual(created);
  });

  it('returns undefined for an unknown sessionId', () => {
    expect(getSession('does-not-exist')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// updateSession
// ---------------------------------------------------------------------------

describe('updateSession', () => {
  it('updates accessToken and refreshToken', () => {
    const s = createSession('old-at', 'old-rt', 'id', 300, 1800);
    const updated = updateSession(s.sessionId, {
      accessToken:           'new-at',
      refreshToken:          'new-rt',
      accessTokenExpiresAt:  Date.now() + 600_000,
      refreshTokenExpiresAt: Date.now() + 3_600_000,
    });

    expect(updated?.accessToken).toBe('new-at');
    expect(updated?.refreshToken).toBe('new-rt');
  });

  it('preserves idToken after update', () => {
    const s = createSession('a', 'r', 'preserved-id-token', 300, 1800);
    const updated = updateSession(s.sessionId, {
      accessToken:           'new',
      refreshToken:          'new',
      accessTokenExpiresAt:  Date.now() + 600_000,
      refreshTokenExpiresAt: Date.now() + 3_600_000,
    });

    expect(updated?.idToken).toBe('preserved-id-token');
  });

  it('persists the update so getSession returns new values', () => {
    const s = createSession('old', 'old', 'id', 300, 1800);
    updateSession(s.sessionId, {
      accessToken:           'persisted',
      refreshToken:          'persisted-rt',
      accessTokenExpiresAt:  Date.now() + 600_000,
      refreshTokenExpiresAt: Date.now() + 3_600_000,
    });

    expect(getSession(s.sessionId)?.accessToken).toBe('persisted');
  });

  it('returns undefined for an unknown sessionId', () => {
    const result = updateSession('ghost', {
      accessToken:           'x',
      refreshToken:          'x',
      accessTokenExpiresAt:  0,
      refreshTokenExpiresAt: 0,
    });
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------

describe('deleteSession', () => {
  it('removes the session from the store', () => {
    const s = createSession('a', 'r', 'i', 300, 1800);
    deleteSession(s.sessionId);
    expect(getSession(s.sessionId)).toBeUndefined();
  });

  it('does not throw when called with an unknown sessionId', () => {
    expect(() => deleteSession('ghost-id')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// isAccessTokenExpired
// ---------------------------------------------------------------------------

describe('isAccessTokenExpired', () => {
  function makeSession(expiresAt: number): BFFSession {
    return {
      sessionId:             'test',
      accessToken:           'at',
      refreshToken:          'rt',
      idToken:               'it',
      accessTokenExpiresAt:  expiresAt,
      refreshTokenExpiresAt: Date.now() + 3_600_000,
    };
  }

  it('returns false for a token with plenty of time left (>30 s)', () => {
    expect(isAccessTokenExpired(makeSession(Date.now() + 60_000))).toBe(false);
  });

  it('returns true when token expires within the 30-second buffer', () => {
    // Expires in 20 seconds — inside the 30s early-refresh window
    expect(isAccessTokenExpired(makeSession(Date.now() + 20_000))).toBe(true);
  });

  it('returns true for an already-expired token', () => {
    expect(isAccessTokenExpired(makeSession(Date.now() - 1_000))).toBe(true);
  });

  it('returns false when exactly 31 seconds remain (just outside the buffer)', () => {
    expect(isAccessTokenExpired(makeSession(Date.now() + 31_000))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isRefreshTokenExpired
// ---------------------------------------------------------------------------

describe('isRefreshTokenExpired', () => {
  function makeSession(refreshExpiresAt: number): BFFSession {
    return {
      sessionId:             'test',
      accessToken:           'at',
      refreshToken:          'rt',
      idToken:               'it',
      accessTokenExpiresAt:  Date.now() + 300_000,
      refreshTokenExpiresAt: refreshExpiresAt,
    };
  }

  it('returns false for a freshly created refresh token', () => {
    expect(isRefreshTokenExpired(makeSession(Date.now() + 1_800_000))).toBe(false);
  });

  it('returns true for an already-expired refresh token', () => {
    expect(isRefreshTokenExpired(makeSession(Date.now() - 1_000))).toBe(true);
  });

  it('returns true when refresh token expires at exactly now', () => {
    // Date.now() >= expiresAt when they are equal → expired
    expect(isRefreshTokenExpired(makeSession(Date.now()))).toBe(true);
  });
});
