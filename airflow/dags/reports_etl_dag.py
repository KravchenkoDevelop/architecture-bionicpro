"""
BionicPRO Reports ETL DAG
--------------------------
Ежедневно извлекает данные из CRM (клиенты) и Sensor DB (телеметрия),
объединяет их и записывает в OLAP-витрину user_reports_mart.

Расписание: каждый день в 02:00 UTC (cron: '0 2 * * *')

Граф задач:
  create_tables
      |
  [extract_crm, extract_telemetry]  (параллельно)
      |
  merge_to_mart
      |
  cleanup_staging
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, date

import psycopg2
from psycopg2.extras import execute_values

from airflow import DAG
from airflow.operators.python import PythonOperator

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Connection factory
# ---------------------------------------------------------------------------

DB_HOST = os.getenv("REPORTS_DB_HOST", "reports_postgres")
DB_PORT = int(os.getenv("REPORTS_DB_PORT", "5432"))
DB_NAME = os.getenv("REPORTS_DB_NAME", "reports_db")
DB_USER = os.getenv("REPORTS_DB_USER", "reports_user")
DB_PASS = os.getenv("REPORTS_DB_PASS", "reports_password")


def _get_conn() -> psycopg2.extensions.connection:
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT,
        dbname=DB_NAME, user=DB_USER, password=DB_PASS,
    )


# ---------------------------------------------------------------------------
# DDL helpers
# ---------------------------------------------------------------------------

CREATE_TABLES_SQL = """
-- Staging: CRM snapshot
CREATE TABLE IF NOT EXISTS stg_crm_clients (
    keycloak_id        VARCHAR(255) PRIMARY KEY,
    first_name         VARCHAR(255),
    last_name          VARCHAR(255),
    email              VARCHAR(255),
    prosthesis_model   VARCHAR(255),
    prosthesis_serial  VARCHAR(255),
    installation_date  DATE,
    extracted_at       TIMESTAMP DEFAULT NOW()
);

-- Staging: Telemetry aggregated per user per day
CREATE TABLE IF NOT EXISTS stg_telemetry_daily (
    keycloak_id        VARCHAR(255)  NOT NULL,
    event_date         DATE          NOT NULL,
    steps_count        BIGINT        DEFAULT 0,
    distance_meters    FLOAT         DEFAULT 0,
    battery_level_avg  FLOAT         DEFAULT 0,
    usage_hours        FLOAT         DEFAULT 0,
    fall_events        INT           DEFAULT 0,
    maintenance_alerts INT           DEFAULT 0,
    extracted_at       TIMESTAMP     DEFAULT NOW(),
    PRIMARY KEY (keycloak_id, event_date)
);

-- OLAP Data Mart: pre-computed reports per user per day
-- Структура спроектирована для быстрого доступа по keycloak_id:
--   PRIMARY KEY (keycloak_id, report_date) — точечный SELECT по пользователю
--   INDEX на keycloak_id — для запросов последнего отчёта
CREATE TABLE IF NOT EXISTS user_reports_mart (
    keycloak_id            VARCHAR(255)  NOT NULL,
    report_date            DATE          NOT NULL DEFAULT CURRENT_DATE,
    first_name             VARCHAR(255),
    last_name              VARCHAR(255),
    email                  VARCHAR(255),
    prosthesis_model       VARCHAR(255),
    prosthesis_serial_number VARCHAR(255),
    period_start           DATE,
    period_end             DATE,
    total_steps            BIGINT        DEFAULT 0,
    total_distance_km      FLOAT         DEFAULT 0,
    avg_daily_steps        FLOAT         DEFAULT 0,
    avg_battery_level      FLOAT         DEFAULT 0,
    total_usage_hours      FLOAT         DEFAULT 0,
    fall_events            INT           DEFAULT 0,
    maintenance_alerts     INT           DEFAULT 0,
    generated_at           TIMESTAMP     DEFAULT NOW(),
    PRIMARY KEY (keycloak_id, report_date)
);

CREATE INDEX IF NOT EXISTS idx_mart_keycloak_id
    ON user_reports_mart (keycloak_id);
"""


# ---------------------------------------------------------------------------
# Task functions
# ---------------------------------------------------------------------------

def create_tables(**context) -> None:
    """Создаёт staging-таблицы и витрину, если не существуют."""
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(CREATE_TABLES_SQL)
        conn.commit()
        log.info("Tables created / verified.")
    finally:
        conn.close()


def extract_crm(**context) -> None:
    """
    Извлекает актуальные данные из CRM в staging-таблицу stg_crm_clients.
    В продакшене CRM — отдельная БД; здесь используем crm_clients в той же БД.
    """
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            # Очищаем staging перед загрузкой свежих данных
            cur.execute("TRUNCATE TABLE stg_crm_clients;")

            # Извлекаем данные из CRM-таблицы
            cur.execute("""
                INSERT INTO stg_crm_clients
                    (keycloak_id, first_name, last_name, email,
                     prosthesis_model, prosthesis_serial, installation_date)
                SELECT
                    keycloak_id, first_name, last_name, email,
                    prosthesis_model, prosthesis_serial_number, installation_date
                FROM crm_clients;
            """)
            count = cur.rowcount
        conn.commit()
        log.info("CRM extract done: %d rows.", count)
    finally:
        conn.close()


def extract_telemetry(**context) -> None:
    """
    Агрегирует телеметрию по (keycloak_id, event_date) в staging.
    Период: последние 30 дней.
    """
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("TRUNCATE TABLE stg_telemetry_daily;")

            cur.execute("""
                INSERT INTO stg_telemetry_daily
                    (keycloak_id, event_date, steps_count, distance_meters,
                     battery_level_avg, usage_hours, fall_events, maintenance_alerts)
                SELECT
                    keycloak_id,
                    event_date,
                    SUM(steps_count)            AS steps_count,
                    SUM(distance_meters)        AS distance_meters,
                    AVG(battery_level_avg)      AS battery_level_avg,
                    SUM(usage_hours)            AS usage_hours,
                    SUM(fall_events)            AS fall_events,
                    SUM(maintenance_alerts)     AS maintenance_alerts
                FROM telemetry_events
                WHERE event_date >= CURRENT_DATE - INTERVAL '30 days'
                GROUP BY keycloak_id, event_date;
            """)
            count = cur.rowcount
        conn.commit()
        log.info("Telemetry extract done: %d user-day rows.", count)
    finally:
        conn.close()


def merge_to_mart(**context) -> None:
    """
    Объединяет CRM и телеметрию, вычисляет агрегаты за 30 дней
    и загружает готовую витрину в user_reports_mart.
    Использует UPSERT (INSERT … ON CONFLICT DO UPDATE) для идемпотентности.
    """
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO user_reports_mart (
                    keycloak_id, report_date,
                    first_name, last_name, email,
                    prosthesis_model, prosthesis_serial_number,
                    period_start, period_end,
                    total_steps, total_distance_km,
                    avg_daily_steps, avg_battery_level,
                    total_usage_hours, fall_events, maintenance_alerts,
                    generated_at
                )
                SELECT
                    c.keycloak_id,
                    CURRENT_DATE                                    AS report_date,
                    c.first_name,
                    c.last_name,
                    c.email,
                    c.prosthesis_model,
                    c.prosthesis_serial                             AS prosthesis_serial_number,
                    MIN(t.event_date)                               AS period_start,
                    MAX(t.event_date)                               AS period_end,
                    COALESCE(SUM(t.steps_count), 0)                 AS total_steps,
                    COALESCE(SUM(t.distance_meters) / 1000.0, 0)   AS total_distance_km,
                    COALESCE(AVG(t.steps_count), 0)                 AS avg_daily_steps,
                    COALESCE(AVG(t.battery_level_avg), 0)           AS avg_battery_level,
                    COALESCE(SUM(t.usage_hours), 0)                 AS total_usage_hours,
                    COALESCE(SUM(t.fall_events), 0)                 AS fall_events,
                    COALESCE(SUM(t.maintenance_alerts), 0)          AS maintenance_alerts,
                    NOW()                                           AS generated_at
                FROM stg_crm_clients c
                LEFT JOIN stg_telemetry_daily t USING (keycloak_id)
                GROUP BY c.keycloak_id, c.first_name, c.last_name, c.email,
                         c.prosthesis_model, c.prosthesis_serial
                ON CONFLICT (keycloak_id, report_date) DO UPDATE SET
                    first_name             = EXCLUDED.first_name,
                    last_name              = EXCLUDED.last_name,
                    email                  = EXCLUDED.email,
                    prosthesis_model       = EXCLUDED.prosthesis_model,
                    prosthesis_serial_number = EXCLUDED.prosthesis_serial_number,
                    period_start           = EXCLUDED.period_start,
                    period_end             = EXCLUDED.period_end,
                    total_steps            = EXCLUDED.total_steps,
                    total_distance_km      = EXCLUDED.total_distance_km,
                    avg_daily_steps        = EXCLUDED.avg_daily_steps,
                    avg_battery_level      = EXCLUDED.avg_battery_level,
                    total_usage_hours      = EXCLUDED.total_usage_hours,
                    fall_events            = EXCLUDED.fall_events,
                    maintenance_alerts     = EXCLUDED.maintenance_alerts,
                    generated_at           = EXCLUDED.generated_at;
            """)
            count = cur.rowcount
        conn.commit()
        log.info("Mart merge done: %d rows upserted.", count)
    finally:
        conn.close()


def cleanup_staging(**context) -> None:
    """Очищает staging-таблицы после успешной загрузки в mart."""
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("TRUNCATE TABLE stg_crm_clients, stg_telemetry_daily;")
        conn.commit()
        log.info("Staging tables cleaned up.")
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# DAG definition
# ---------------------------------------------------------------------------

default_args = {
    "owner": "bionic-pro",
    "depends_on_past": False,
    "start_date": datetime(2024, 1, 1),
    "email_on_failure": False,
    "email_on_retry": False,
    "retries": 2,
    "retry_delay": timedelta(minutes=5),
}

with DAG(
    dag_id="reports_etl",
    description="ETL: CRM + Telemetry → OLAP user_reports_mart (daily)",
    default_args=default_args,
    schedule_interval="0 2 * * *",   # Каждый день в 02:00 UTC
    catchup=False,
    tags=["reports", "etl", "bionic-pro"],
    doc_md=__doc__,
) as dag:

    t_create = PythonOperator(
        task_id="create_tables",
        python_callable=create_tables,
    )

    t_crm = PythonOperator(
        task_id="extract_crm",
        python_callable=extract_crm,
    )

    t_telemetry = PythonOperator(
        task_id="extract_telemetry",
        python_callable=extract_telemetry,
    )

    t_merge = PythonOperator(
        task_id="merge_to_mart",
        python_callable=merge_to_mart,
    )

    t_cleanup = PythonOperator(
        task_id="cleanup_staging",
        python_callable=cleanup_staging,
    )

    # Граф зависимостей:
    # create_tables → [extract_crm, extract_telemetry] → merge_to_mart → cleanup
    t_create >> [t_crm, t_telemetry] >> t_merge >> t_cleanup
