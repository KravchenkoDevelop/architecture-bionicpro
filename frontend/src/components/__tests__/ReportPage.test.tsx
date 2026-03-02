/**
 * ReportPage.test.tsx — Unit tests for the ReportPage component.
 *
 * Covered requirements:
 *  [1] Authenticated user sees "Получить мой отчёт" button
 *  [2] Unauthenticated user sees login screen only (no report button)
 *  [3] Report button calls GET /reports with Bearer token from Keycloak
 *  [4] 401/403 response → auth error message is displayed
 *  [5] 404 response → "report not ready yet" message is displayed
 *  [6] 200 response → report data rendered correctly (name, stats, alerts)
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// jest.mock is hoisted by Babel — the factory must NOT reference variables
// declared outside it. Use jest.fn() in the factory, then grab the typed
// reference after the import.
jest.mock('@react-keycloak/web', () => ({
  useKeycloak: jest.fn(),
}));

import ReportPage from '../ReportPage';
import { useKeycloak } from '@react-keycloak/web';

const mockUseKeycloak = useKeycloak as jest.Mock;
const mockLogin       = jest.fn();
const mockLogout      = jest.fn();

// ---------------------------------------------------------------------------
// Shared test fixture
// ---------------------------------------------------------------------------

const MOCK_REPORT = {
  user_id:                  'prothetic1',
  first_name:               'Прохор',
  last_name:                'Иванов',
  email:                    'prothetic1@example.com',
  prosthesis_model:         'BionicPRO X1',
  prosthesis_serial_number: 'SN-001234',
  period_start:             '2024-01-01',
  period_end:               '2024-01-31',
  stats: {
    total_steps:        150_000,
    total_distance_km:  112.5,
    avg_daily_steps:    5_000.0,
    avg_battery_level:  73.5,
    total_usage_hours:  465.0,
    fall_events:        2,
    maintenance_alerts: 1,
  },
  generated_at: '2024-02-01T02:30:00',
};

const TOKEN = 'test-access-token-xyz';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupUnauthenticated() {
  mockUseKeycloak.mockReturnValue({
    keycloak: { authenticated: false, login: mockLogin, logout: mockLogout, token: undefined },
    initialized: true,
  });
}

function setupAuthenticated(token = TOKEN) {
  mockUseKeycloak.mockReturnValue({
    keycloak: { authenticated: true, login: mockLogin, logout: mockLogout, token },
    initialized: true,
  });
}

function mockFetch(status: number, body?: unknown) {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok:   status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => String(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReportPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------

  describe('Initialization', () => {
    it('shows loading indicator while Keycloak is not yet initialized', () => {
      mockUseKeycloak.mockReturnValue({
        keycloak: { authenticated: false, login: mockLogin, logout: mockLogout },
        initialized: false,
      });

      render(<ReportPage />);
      expect(screen.getByText('Инициализация...')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // [2] Unauthenticated state
  // -------------------------------------------------------------------------

  describe('[2] Unauthenticated', () => {
    beforeEach(setupUnauthenticated);

    it('shows login button', () => {
      render(<ReportPage />);
      expect(screen.getByText('Войти')).toBeInTheDocument();
    });

    it('does NOT show the report fetch button', () => {
      render(<ReportPage />);
      expect(screen.queryByText(/Получить мой отчёт/)).not.toBeInTheDocument();
    });

    it('calls keycloak.login() when login button is clicked', () => {
      render(<ReportPage />);
      fireEvent.click(screen.getByText('Войти'));
      expect(mockLogin).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // [1] Authenticated state — button present
  // -------------------------------------------------------------------------

  describe('[1] Authenticated — initial render', () => {
    beforeEach(setupAuthenticated);

    it('shows "Получить мой отчёт" button', () => {
      render(<ReportPage />);
      expect(screen.getByText('Получить мой отчёт')).toBeInTheDocument();
    });

    it('shows logout button', () => {
      render(<ReportPage />);
      expect(screen.getByText('Выйти')).toBeInTheDocument();
    });

    it('calls keycloak.logout() when logout button is clicked', () => {
      render(<ReportPage />);
      fireEvent.click(screen.getByText('Выйти'));
      expect(mockLogout).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // [3] Bearer token in request
  // -------------------------------------------------------------------------

  describe('[3] Bearer token usage', () => {
    beforeEach(setupAuthenticated);

    it('sends Authorization: Bearer <token> header when fetching report', async () => {
      mockFetch(200, MOCK_REPORT);

      render(<ReportPage />);
      fireEvent.click(screen.getByText('Получить мой отчёт'));

      await waitFor(() => expect(global.fetch).toHaveBeenCalled());

      const [, options] = (global.fetch as jest.Mock).mock.calls[0];
      expect(options.headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    });

    it('calls the /reports endpoint', async () => {
      mockFetch(200, MOCK_REPORT);

      render(<ReportPage />);
      fireEvent.click(screen.getByText('Получить мой отчёт'));

      await waitFor(() => expect(global.fetch).toHaveBeenCalled());

      const [url] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toContain('/reports');
    });

    it('shows loading state while request is in flight', async () => {
      (global.fetch as jest.Mock).mockReturnValue(new Promise(() => {}));

      render(<ReportPage />);
      fireEvent.click(screen.getByText('Получить мой отчёт'));

      expect(await screen.findByText('Загрузка отчёта...')).toBeInTheDocument();
    });

    it('shows error when token is missing', async () => {
      mockUseKeycloak.mockReturnValue({
        keycloak: { authenticated: true, token: undefined, login: mockLogin, logout: mockLogout },
        initialized: true,
      });

      render(<ReportPage />);
      fireEvent.click(screen.getByText('Получить мой отчёт'));

      expect(await screen.findByText('Not authenticated')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // [4] Auth errors
  // -------------------------------------------------------------------------

  describe('[4] Authorization errors (401 / 403)', () => {
    beforeEach(setupAuthenticated);

    it('shows auth error message on HTTP 401', async () => {
      mockFetch(401);
      render(<ReportPage />);
      fireEvent.click(screen.getByText('Получить мой отчёт'));
      expect(await screen.findByText(/ошибка авторизации/i)).toBeInTheDocument();
    });

    it('shows auth error message on HTTP 403', async () => {
      mockFetch(403);
      render(<ReportPage />);
      fireEvent.click(screen.getByText('Получить мой отчёт'));
      expect(await screen.findByText(/ошибка авторизации/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // [5] 404 — Airflow has not run yet
  // -------------------------------------------------------------------------

  describe('[5] Report not ready (HTTP 404)', () => {
    beforeEach(setupAuthenticated);

    it('shows "report not ready" message on HTTP 404', async () => {
      mockFetch(404);
      render(<ReportPage />);
      fireEvent.click(screen.getByText('Получить мой отчёт'));
      expect(await screen.findByText(/ещё не готов/i)).toBeInTheDocument();
    });

    it('mentions the ETL schedule (02:00) in the 404 message', async () => {
      mockFetch(404);
      render(<ReportPage />);
      fireEvent.click(screen.getByText('Получить мой отчёт'));
      expect(await screen.findByText(/02:00/)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // [6] Successful report render
  // -------------------------------------------------------------------------

  describe('[6] Report data displayed correctly', () => {
    beforeEach(setupAuthenticated);

    async function fetchAndRender() {
      mockFetch(200, MOCK_REPORT);
      render(<ReportPage />);
      fireEvent.click(screen.getByText('Получить мой отчёт'));
      await screen.findByText('Прохор Иванов');
    }

    it('displays user full name', async () => {
      await fetchAndRender();
      expect(screen.getByText('Прохор Иванов')).toBeInTheDocument();
    });

    it('displays email', async () => {
      await fetchAndRender();
      expect(screen.getByText('prothetic1@example.com')).toBeInTheDocument();
    });

    it('displays prosthesis model', async () => {
      await fetchAndRender();
      expect(screen.getByText('BionicPRO X1')).toBeInTheDocument();
    });

    it('displays average battery level with % sign', async () => {
      await fetchAndRender();
      expect(screen.getByText('73.5%')).toBeInTheDocument();
    });

    it('shows maintenance alert when maintenance_alerts > 0', async () => {
      await fetchAndRender();
      expect(
        screen.getByText(/Предупреждений о техобслуживании: 1/)
      ).toBeInTheDocument();
    });

    it('does NOT show maintenance alert when maintenance_alerts === 0', async () => {
      const noAlerts = {
        ...MOCK_REPORT,
        stats: { ...MOCK_REPORT.stats, maintenance_alerts: 0 },
      };
      mockFetch(200, noAlerts);
      render(<ReportPage />);
      fireEvent.click(screen.getByText('Получить мой отчёт'));
      await screen.findByText('Прохор Иванов');

      expect(
        screen.queryByText(/Предупреждений о техобслуживании/)
      ).not.toBeInTheDocument();
    });

    it('shows server error message on HTTP 500', async () => {
      mockFetch(500);
      render(<ReportPage />);
      fireEvent.click(screen.getByText('Получить мой отчёт'));
      expect(await screen.findByText(/ошибка сервера/i)).toBeInTheDocument();
    });
  });
});
