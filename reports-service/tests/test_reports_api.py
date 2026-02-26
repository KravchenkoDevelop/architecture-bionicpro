"""
test_reports_api.py — Integration tests for BionicPRO Reports Service API.

Covered requirements
---------------------
[1] UI can call GET /reports to obtain a report (endpoint is accessible).
[2] Unauthenticated requests are rejected with HTTP 401.
[3] Authenticated users can access ONLY their own report (user_id from JWT).
[4] Reports are fetched from the OLAP DB without real-time aggregation.
[5] HTTP 404 is returned when Airflow has not yet produced the report.

Run from reports-service/:
    pip install -r requirements.txt -r tests/requirements-test.txt
    pytest -v
"""

from __future__ import annotations

from datetime import date, datetime
from unittest.mock import MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from main import app, get_current_user

# ---------------------------------------------------------------------------
# Shared test data
# ---------------------------------------------------------------------------

MOCK_USER_ID    = "prothetic1"
OTHER_USER_ID   = "prothetic2"

MOCK_REPORT_ROW = {
    "keycloak_id":              MOCK_USER_ID,
    "report_date":              date.today(),
    "first_name":               "Прохор",
    "last_name":                "Иванов",
    "email":                    "prothetic1@example.com",
    "prosthesis_model":         "BionicPRO X1",
    "prosthesis_serial_number": "SN-001234",
    "period_start":             date(2024, 1, 1),
    "period_end":               date(2024, 1, 31),
    "total_steps":              150_000,
    "total_distance_km":        112.5,
    "avg_daily_steps":          5_000.0,
    "avg_battery_level":        73.5,
    "total_usage_hours":        465.0,
    "fall_events":              2,
    "maintenance_alerts":       1,
    "generated_at":             datetime(2024, 2, 1, 2, 30, 0),
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_db_mock(row: dict | None) -> tuple[MagicMock, MagicMock]:
    """
    Build a mock psycopg2 connection whose cursor.fetchone() returns `row`.
    Handles the  `with conn.cursor() as cur:` context-manager protocol.
    """
    conn   = MagicMock()
    cursor = conn.cursor.return_value.__enter__.return_value
    cursor.fetchone.return_value = row
    return conn, cursor


async def _get(client: AsyncClient, path: str = "/reports", **kwargs):
    return await client.get(path, **kwargs)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def clear_dependency_overrides():
    """Ensure dependency overrides are reset between tests."""
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def auth_client_fixture():
    """Override get_current_user to return MOCK_USER_ID (authenticated)."""
    app.dependency_overrides[get_current_user] = lambda: MOCK_USER_ID


# ---------------------------------------------------------------------------
# [2] Unauthenticated access
# ---------------------------------------------------------------------------

async def test_no_auth_header_returns_401():
    """
    Requirement [2]: No Authorization header → HTTP 401.
    Confirms that unauthenticated users cannot generate / view any report.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await _get(c)

    assert resp.status_code == 401, (
        f"Expected 401, got {resp.status_code}. "
        "Unauthenticated access must be rejected."
    )


async def test_malformed_bearer_token_returns_401():
    """
    Requirement [2]: Malformed / expired token → HTTP 401.
    A syntactically valid header with an invalid JWT must be rejected.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await _get(c, headers={"Authorization": "Bearer not.a.jwt"})

    assert resp.status_code == 401


async def test_missing_bearer_prefix_returns_401():
    """
    Requirement [2]: Authorization header without 'Bearer' scheme → 401.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await _get(c, headers={"Authorization": "Basic dXNlcjpwYXNz"})

    # FastAPI HTTPBearer rejects non-Bearer schemes (returns 403 or 401 depending on version)
    assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# [1] Authenticated access — UI can call GET /reports
# ---------------------------------------------------------------------------

async def test_authenticated_user_gets_report(auth_client_fixture):
    """
    Requirement [1]: Authenticated user calls GET /reports and receives a report.
    Simulates what the React UI does: sends Bearer token, expects 200 + JSON body.
    """
    conn, _ = _make_db_mock(MOCK_REPORT_ROW)
    with patch("main._get_db", return_value=conn):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await _get(c)

    assert resp.status_code == 200
    body = resp.json()
    assert body["user_id"]              == MOCK_USER_ID
    assert body["first_name"]           == "Прохор"
    assert body["stats"]["total_steps"] == 150_000
    assert body["stats"]["fall_events"] == 2


async def test_health_endpoint_is_accessible():
    """
    Requirement [1]: Health endpoint is accessible without authentication.
    Used by load balancer / Docker health checks to confirm the service is up.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await _get(c, "/health")

    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


# ---------------------------------------------------------------------------
# [3] Access control — user can only see own report
# ---------------------------------------------------------------------------

async def test_user_id_comes_from_token_not_from_query_param(auth_client_fixture):
    """
    Requirement [3]: user_id is extracted from the JWT, not from request params.
    Passing an arbitrary user_id via query string must have no effect —
    the API always returns data for the authenticated user.
    """
    conn, cursor = _make_db_mock(MOCK_REPORT_ROW)
    with patch("main._get_db", return_value=conn):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            # Attempt to inject a different user_id — must be silently ignored
            resp = await _get(c, params={"user_id": OTHER_USER_ID})

    assert resp.status_code == 200
    # The response must belong to MOCK_USER_ID (from token), not OTHER_USER_ID
    assert resp.json()["user_id"] == MOCK_USER_ID


async def test_db_query_uses_user_id_from_token(auth_client_fixture):
    """
    Requirement [3][4]: The SQL query sent to the OLAP DB uses the user_id
    extracted from the JWT token (not from any external parameter).
    """
    conn, cursor = _make_db_mock(MOCK_REPORT_ROW)
    with patch("main._get_db", return_value=conn):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            await _get(c)

    # cursor.execute must have been called
    assert cursor.execute.called, "cursor.execute was not called — DB was not queried"

    # The SQL parameters must include MOCK_USER_ID (from JWT), not OTHER_USER_ID
    call_args = str(cursor.execute.call_args)
    assert MOCK_USER_ID in call_args, (
        f"Expected SQL params to contain '{MOCK_USER_ID}' (from JWT). "
        f"Actual call: {call_args}"
    )
    assert OTHER_USER_ID not in call_args, (
        "SQL params must not contain OTHER_USER_ID — only token user is allowed."
    )


# ---------------------------------------------------------------------------
# [4] OLAP query — no real-time aggregation
# ---------------------------------------------------------------------------

async def test_report_is_read_from_olap_without_aggregation(auth_client_fixture):
    """
    Requirement [4]: The endpoint performs a simple SELECT from user_reports_mart;
    it does NOT execute GROUP BY / aggregation queries (those run in Airflow).
    Verified by confirming the DB is queried exactly once per request.
    """
    conn, cursor = _make_db_mock(MOCK_REPORT_ROW)
    with patch("main._get_db", return_value=conn):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await _get(c)

    assert resp.status_code == 200
    # Exactly one execute() call — a simple SELECT, not a complex aggregation pipeline
    assert cursor.execute.call_count == 1, (
        f"Expected 1 DB call (simple SELECT), got {cursor.execute.call_count}."
    )
    # Confirm query targets the mart table
    sql_executed = cursor.execute.call_args[0][0].lower()
    assert "user_reports_mart" in sql_executed, (
        "Query must read from user_reports_mart (the OLAP pre-computed mart)."
    )
    # No GROUP BY in the executed query (aggregation is Airflow's job)
    assert "group by" not in sql_executed, (
        "Real-time GROUP BY found — aggregation should be done by Airflow, not the API."
    )


async def test_report_stats_values_match_olap_row(auth_client_fixture):
    """
    Requirement [4]: API maps the OLAP row 1-to-1 without modifying values.
    """
    conn, _ = _make_db_mock(MOCK_REPORT_ROW)
    with patch("main._get_db", return_value=conn):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await _get(c)

    stats = resp.json()["stats"]
    assert stats["total_steps"]       == MOCK_REPORT_ROW["total_steps"]
    assert stats["total_distance_km"] == MOCK_REPORT_ROW["total_distance_km"]
    assert stats["avg_battery_level"] == MOCK_REPORT_ROW["avg_battery_level"]
    assert stats["fall_events"]       == MOCK_REPORT_ROW["fall_events"]


# ---------------------------------------------------------------------------
# [5] Airflow not yet run — data missing in OLAP
# ---------------------------------------------------------------------------

async def test_no_data_in_olap_returns_404(auth_client_fixture):
    """
    Requirement [5]: When Airflow has not yet processed data for a user,
    the OLAP mart is empty → API must return HTTP 404 with a clear message.
    """
    conn, _ = _make_db_mock(None)   # fetchone() → None (no rows)
    with patch("main._get_db", return_value=conn):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await _get(c)

    assert resp.status_code == 404
    detail = resp.json()["detail"].lower()
    # Message should hint that the report was not found (not a server error)
    assert "not found" in detail or "not yet" in detail or "pipeline" in detail


async def test_future_date_with_no_data_returns_404(auth_client_fixture):
    """
    Requirement [5]: Requesting a date in the future (Airflow hasn't run yet)
    returns 404 — not a 500 or empty response.
    """
    conn, _ = _make_db_mock(None)
    with patch("main._get_db", return_value=conn):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await _get(c, params={"report_date": "2099-12-31"})

    assert resp.status_code == 404


async def test_specific_processed_date_returns_200(auth_client_fixture):
    """
    Requirement [5]: Requesting a date that exists in the OLAP mart (Airflow ran)
    returns 200 with the pre-computed report.
    """
    conn, _ = _make_db_mock(MOCK_REPORT_ROW)
    with patch("main._get_db", return_value=conn):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await _get(c, params={"report_date": "2024-01-31"})

    assert resp.status_code == 200
    assert resp.json()["stats"]["total_steps"] == 150_000
