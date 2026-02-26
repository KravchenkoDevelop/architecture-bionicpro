"""
BionicPRO Reports Service API
==============================
FastAPI-сервис для получения предрассчитанных отчётов о работе протезов.

Эндпоинт:
    GET /reports          — отчёт аутентифицированного пользователя (последний)
    GET /reports?date=... — отчёт на конкретную дату (YYYY-MM-DD)
    GET /health           — проверка работоспособности

Контроль доступа (Задача 4):
    Пользователь может просматривать только свой отчёт.
    Идентификация происходит по claim 'preferred_username' (или 'sub') из JWT.
    Бэкенд не принимает user_id как параметр запроса — он извлекается из токена.

Аутентификация:
    JWT выдаётся Keycloak. Подпись проверяется через JWKS-endpoint Keycloak.
    Библиотека: PyJWT + httpx для получения публичных ключей.
"""

from __future__ import annotations

import logging
import os
from datetime import date, datetime
from typing import Optional

import httpx
import jwt
import psycopg2
import psycopg2.extras
from fastapi import Depends, FastAPI, HTTPException, Security, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

log = logging.getLogger("uvicorn.error")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

KEYCLOAK_URL   = os.getenv("KEYCLOAK_URL",   "http://keycloak:8080")
KEYCLOAK_REALM = os.getenv("KEYCLOAK_REALM", "reports-realm")
JWKS_URL       = f"{KEYCLOAK_URL}/realms/{KEYCLOAK_REALM}/protocol/openid-connect/certs"

DB_HOST = os.getenv("DB_HOST", "reports_postgres")
DB_PORT = int(os.getenv("DB_PORT", "5432"))
DB_NAME = os.getenv("DB_NAME", "reports_db")
DB_USER = os.getenv("DB_USER", "reports_user")
DB_PASS = os.getenv("DB_PASS", "reports_password")

# ---------------------------------------------------------------------------
# Database helper
# ---------------------------------------------------------------------------

def _get_db():
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT,
        dbname=DB_NAME, user=DB_USER, password=DB_PASS,
        cursor_factory=psycopg2.extras.RealDictCursor,
    )

# ---------------------------------------------------------------------------
# JWKS / JWT validation
# ---------------------------------------------------------------------------

_jwks_cache: Optional[dict] = None


async def _fetch_jwks() -> dict:
    global _jwks_cache
    if _jwks_cache is None:
        async with httpx.AsyncClient() as client:
            resp = await client.get(JWKS_URL, timeout=10)
            resp.raise_for_status()
            _jwks_cache = resp.json()
    return _jwks_cache


security = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Security(security),
) -> str:
    """
    Валидирует JWT-токен и возвращает идентификатор пользователя.

    Используется preferred_username (= username в Keycloak),
    который совпадает с keycloak_id в crm_clients/user_reports_mart.
    В продакшене следует использовать 'sub' (UUID) и хранить его в CRM.

    Задача 4 — контроль доступа: пользователь идентифицируется исключительно
    по токену; запросить чужой отчёт невозможно, т.к. user_id не принимается
    как параметр запроса.
    """
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header with Bearer token is required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = credentials.credentials
    try:
        jwks = await _fetch_jwks()
        # Находим подходящий публичный ключ по kid
        header = jwt.get_unverified_header(token)
        key = next(
            (k for k in jwks["keys"] if k.get("kid") == header.get("kid")),
            None,
        )
        if key is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Public key not found in JWKS",
            )
        public_key = jwt.algorithms.RSAAlgorithm.from_jwk(key)
        payload = jwt.decode(
            token,
            public_key,
            algorithms=["RS256"],
            options={"verify_aud": False},  # Keycloak-токены могут не содержать aud
        )
        # Используем preferred_username как идентификатор пользователя в CRM
        user_id = payload.get("preferred_username") or payload.get("sub")
        if not user_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Cannot identify user from token",
            )
        return user_id
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired")
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc))

# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------

class ReportStats(BaseModel):
    total_steps: int
    total_distance_km: float
    avg_daily_steps: float
    avg_battery_level: float
    total_usage_hours: float
    fall_events: int
    maintenance_alerts: int


class ReportResponse(BaseModel):
    user_id: str
    first_name: str
    last_name: str
    email: Optional[str]
    prosthesis_model: Optional[str]
    prosthesis_serial_number: Optional[str]
    period_start: Optional[date]
    period_end: Optional[date]
    stats: ReportStats
    generated_at: datetime

# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="BionicPRO Reports API",
    description="Сервис отчётов по использованию протезов. Данные из OLAP-витрины.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "reports-api"}


@app.get("/reports", response_model=ReportResponse)
async def get_report(
    report_date: Optional[date] = None,
    user_id: str = Depends(get_current_user),
):
    """
    Возвращает предрассчитанный отчёт из OLAP-витрины user_reports_mart.

    - Пользователь аутентифицируется по Bearer JWT (Keycloak).
    - user_id извлекается из токена — просмотр чужого отчёта невозможен.
    - Если date не указана — возвращается последний доступный отчёт.
    - Сложных вычислений нет — только SELECT из готовой витрины.
    """
    target_date = report_date or date.today()

    conn = _get_db()
    try:
        with conn.cursor() as cur:
            if report_date:
                # Конкретная дата
                cur.execute(
                    """
                    SELECT * FROM user_reports_mart
                    WHERE keycloak_id = %s AND report_date = %s
                    """,
                    (user_id, target_date),
                )
            else:
                # Последний доступный отчёт по пользователю
                cur.execute(
                    """
                    SELECT * FROM user_reports_mart
                    WHERE keycloak_id = %s
                    ORDER BY report_date DESC
                    LIMIT 1
                    """,
                    (user_id,),
                )
            row = cur.fetchone()
    finally:
        conn.close()

    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Report not found for user '{user_id}'. "
                   "The ETL pipeline may not have run yet.",
        )

    return ReportResponse(
        user_id=user_id,
        first_name=row["first_name"] or "",
        last_name=row["last_name"] or "",
        email=row["email"],
        prosthesis_model=row["prosthesis_model"],
        prosthesis_serial_number=row["prosthesis_serial_number"],
        period_start=row["period_start"],
        period_end=row["period_end"],
        stats=ReportStats(
            total_steps=int(row["total_steps"] or 0),
            total_distance_km=float(row["total_distance_km"] or 0),
            avg_daily_steps=float(row["avg_daily_steps"] or 0),
            avg_battery_level=float(row["avg_battery_level"] or 0),
            total_usage_hours=float(row["total_usage_hours"] or 0),
            fall_events=int(row["fall_events"] or 0),
            maintenance_alerts=int(row["maintenance_alerts"] or 0),
        ),
        generated_at=row["generated_at"],
    )
