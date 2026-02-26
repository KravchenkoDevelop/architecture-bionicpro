-- =============================================================================
-- BionicPRO Reports DB — initial schema
-- =============================================================================
-- Этот файл выполняется при первом запуске контейнера reports_postgres.
-- Создаёт исходные таблицы (CRM, Telemetry) и OLAP-витрину.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Source table: CRM client data
-- Источник: CRM-система. В реальной архитектуре — отдельная БД.
-- Airflow считывает отсюда данные о клиентах.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_clients (
    keycloak_id              VARCHAR(255)  PRIMARY KEY,   -- sub из JWT-токена Keycloak
    first_name               VARCHAR(255)  NOT NULL,
    last_name                VARCHAR(255)  NOT NULL,
    email                    VARCHAR(255),
    prosthesis_model         VARCHAR(255),
    prosthesis_serial_number VARCHAR(255),
    installation_date        DATE,
    created_at               TIMESTAMP     DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Source table: Daily telemetry from prosthesis sensors
-- Источник: Sensor DB. Airflow агрегирует данные за период.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telemetry_events (
    id                  SERIAL        PRIMARY KEY,
    keycloak_id         VARCHAR(255)  NOT NULL,
    event_date          DATE          NOT NULL,
    steps_count         INT           DEFAULT 0,
    distance_meters     FLOAT         DEFAULT 0,
    battery_level_avg   FLOAT         DEFAULT 0,   -- средний уровень заряда, %
    usage_hours         FLOAT         DEFAULT 0,
    fall_events         INT           DEFAULT 0,
    maintenance_alerts  INT           DEFAULT 0,
    recorded_at         TIMESTAMP     DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_user_date
    ON telemetry_events (keycloak_id, event_date);

-- ---------------------------------------------------------------------------
-- OLAP Data Mart: pre-computed user reports
-- Заполняется Airflow DAG (reports_etl, ежедневно в 02:00).
-- Reports API читает ТОЛЬКО отсюда — без сложных вычислений в реальном времени.
--
-- Структура для быстрого доступа:
--   PRIMARY KEY (keycloak_id, report_date) — точечная выборка
--   INDEX на keycloak_id — для запроса "последнего отчёта по пользователю"
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_reports_mart (
    keycloak_id              VARCHAR(255)  NOT NULL,
    report_date              DATE          NOT NULL DEFAULT CURRENT_DATE,
    first_name               VARCHAR(255),
    last_name                VARCHAR(255),
    email                    VARCHAR(255),
    prosthesis_model         VARCHAR(255),
    prosthesis_serial_number VARCHAR(255),
    period_start             DATE,
    period_end               DATE,
    total_steps              BIGINT        DEFAULT 0,
    total_distance_km        FLOAT         DEFAULT 0,
    avg_daily_steps          FLOAT         DEFAULT 0,
    avg_battery_level        FLOAT         DEFAULT 0,
    total_usage_hours        FLOAT         DEFAULT 0,
    fall_events              INT           DEFAULT 0,
    maintenance_alerts       INT           DEFAULT 0,
    generated_at             TIMESTAMP     DEFAULT NOW(),
    PRIMARY KEY (keycloak_id, report_date)
);

CREATE INDEX IF NOT EXISTS idx_mart_keycloak_id
    ON user_reports_mart (keycloak_id);

-- ---------------------------------------------------------------------------
-- Staging tables (used by Airflow during ETL)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stg_crm_clients (LIKE crm_clients INCLUDING ALL);
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

-- ---------------------------------------------------------------------------
-- Sample data for development / testing
-- keycloak_id — значения нужно заменить на реальные Keycloak sub после
-- первого входа пользователей в систему. Здесь — плейсхолдеры по username.
-- ---------------------------------------------------------------------------
INSERT INTO crm_clients
    (keycloak_id, first_name, last_name, email, prosthesis_model, prosthesis_serial_number, installation_date)
VALUES
    ('prothetic1', 'Прохор',  'Иванов',  'prothetic1@example.com', 'BionicPRO X1', 'SN-001234', '2023-06-15'),
    ('prothetic2', 'Мария',   'Смирнова', 'prothetic2@example.com', 'BionicPRO X2', 'SN-002345', '2023-08-20'),
    ('prothetic3', 'Алексей', 'Петров',  'prothetic3@example.com', 'BionicPRO X1', 'SN-003456', '2023-11-10')
ON CONFLICT DO NOTHING;

-- Генерируем 30 дней телеметрии для каждого тестового пользователя
INSERT INTO telemetry_events
    (keycloak_id, event_date, steps_count, distance_meters, battery_level_avg, usage_hours, fall_events, maintenance_alerts)
SELECT
    client.keycloak_id,
    (CURRENT_DATE - series.i)                              AS event_date,
    (4000 + RANDOM() * 6000)::INT                          AS steps_count,
    ((4000 + RANDOM() * 6000) * 0.75)                     AS distance_meters,
    (60  + RANDOM() * 35)                                  AS battery_level_avg,
    (6   + RANDOM() * 10)                                  AS usage_hours,
    CASE WHEN RANDOM() < 0.05 THEN 1 ELSE 0 END           AS fall_events,
    CASE WHEN RANDOM() < 0.03 THEN 1 ELSE 0 END           AS maintenance_alerts
FROM crm_clients client
CROSS JOIN generate_series(0, 29) AS series(i);

-- Заполняем витрину начальными данными (без Airflow)
-- Это нужно для тестирования API до первого запуска DAG
INSERT INTO user_reports_mart (
    keycloak_id, report_date,
    first_name, last_name, email,
    prosthesis_model, prosthesis_serial_number,
    period_start, period_end,
    total_steps, total_distance_km, avg_daily_steps,
    avg_battery_level, total_usage_hours, fall_events, maintenance_alerts
)
SELECT
    c.keycloak_id,
    CURRENT_DATE,
    c.first_name,
    c.last_name,
    c.email,
    c.prosthesis_model,
    c.prosthesis_serial_number,
    CURRENT_DATE - INTERVAL '30 days',
    CURRENT_DATE,
    COALESCE(SUM(t.steps_count), 0),
    COALESCE(ROUND(SUM(t.distance_meters)::NUMERIC / 1000, 2), 0),
    COALESCE(ROUND(AVG(t.steps_count)::NUMERIC, 0), 0),
    COALESCE(ROUND(AVG(t.battery_level_avg)::NUMERIC, 1), 0),
    COALESCE(ROUND(SUM(t.usage_hours)::NUMERIC, 1), 0),
    COALESCE(SUM(t.fall_events), 0),
    COALESCE(SUM(t.maintenance_alerts), 0)
FROM crm_clients c
LEFT JOIN telemetry_events t USING (keycloak_id)
GROUP BY c.keycloak_id, c.first_name, c.last_name, c.email,
         c.prosthesis_model, c.prosthesis_serial_number
ON CONFLICT DO NOTHING;
