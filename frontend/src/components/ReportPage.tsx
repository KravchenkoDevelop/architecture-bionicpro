import React, { useState } from 'react';
import { useKeycloak } from '@react-keycloak/web';

// ---------------------------------------------------------------------------
// Types (должны соответствовать ReportResponse в reports-service/main.py)
// ---------------------------------------------------------------------------

interface ReportStats {
  total_steps: number;
  total_distance_km: number;
  avg_daily_steps: number;
  avg_battery_level: number;
  total_usage_hours: number;
  fall_events: number;
  maintenance_alerts: number;
}

interface Report {
  user_id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  prosthesis_model: string | null;
  prosthesis_serial_number: string | null;
  period_start: string | null;
  period_end: string | null;
  stats: ReportStats;
  generated_at: string;
}

// ---------------------------------------------------------------------------
// StatCard — вспомогательный компонент для отображения одной метрики
// ---------------------------------------------------------------------------

const StatCard: React.FC<{
  label: string;
  value: string;
  color: string;
}> = ({ label, value, color }) => (
  <div className={`${color} p-4 rounded-lg`}>
    <p className="text-sm text-gray-500">{label}</p>
    <p className="text-2xl font-bold mt-1">{value}</p>
  </div>
);

// ---------------------------------------------------------------------------
// ReportPage
// ---------------------------------------------------------------------------

const ReportPage: React.FC = () => {
  const { keycloak, initialized } = useKeycloak();
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [report, setReport]     = useState<Report | null>(null);

  const fetchReport = async () => {
    if (!keycloak?.token) {
      setError('Not authenticated');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`${process.env.REACT_APP_API_URL}/reports`, {
        headers: {
          'Authorization': `Bearer ${keycloak.token}`,
        },
      });

      if (response.status === 404) {
        setError('Отчёт ещё не готов. ETL-процесс запускается ежедневно в 02:00.');
        return;
      }

      if (response.status === 401 || response.status === 403) {
        setError('Ошибка авторизации. Попробуйте выйти и войти снова.');
        return;
      }

      if (!response.ok) {
        throw new Error(`Ошибка сервера: ${response.status}`);
      }

      const data: Report = await response.json();
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Произошла ошибка');
    } finally {
      setLoading(false);
    }
  };

  // -------------------------------------------------------------------------
  // Render: not initialized
  // -------------------------------------------------------------------------

  if (!initialized) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-100">
        <p className="text-gray-500">Инициализация...</p>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: not authenticated → login button
  // -------------------------------------------------------------------------

  if (!keycloak.authenticated) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100">
        <div className="p-8 bg-white rounded-lg shadow-md text-center">
          <h1 className="text-2xl font-bold mb-4">BionicPRO Reports</h1>
          <p className="text-gray-600 mb-6">Войдите, чтобы просмотреть отчёт о работе протеза.</p>
          <button
            onClick={() => keycloak.login()}
            className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Войти
          </button>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: authenticated
  // -------------------------------------------------------------------------

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100 px-4">
      <div className="p-8 bg-white rounded-lg shadow-md w-full max-w-2xl">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Usage Reports</h1>
          <button
            onClick={() => keycloak.logout()}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            Выйти
          </button>
        </div>

        {/* Кнопка получения отчёта (Задача 5) */}
        <button
          onClick={fetchReport}
          disabled={loading}
          className={`w-full px-4 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors ${
            loading ? 'opacity-50 cursor-not-allowed' : ''
          }`}
        >
          {loading ? 'Загрузка отчёта...' : 'Получить мой отчёт'}
        </button>

        {/* Ошибка */}
        {error && (
          <div className="mt-4 p-4 bg-red-100 text-red-700 rounded-lg">
            {error}
          </div>
        )}

        {/* Данные отчёта */}
        {report && (
          <div className="mt-6 space-y-5">

            {/* Профиль */}
            <div className="border-b pb-4">
              <h2 className="text-lg font-semibold">
                {report.first_name} {report.last_name}
              </h2>
              {report.email && (
                <p className="text-gray-500 text-sm">{report.email}</p>
              )}
              {report.prosthesis_model && (
                <p className="text-gray-500 text-sm mt-1">
                  Протез: <span className="font-medium">{report.prosthesis_model}</span>
                  {report.prosthesis_serial_number && ` · S/N: ${report.prosthesis_serial_number}`}
                </p>
              )}
              {report.period_start && report.period_end && (
                <p className="text-gray-400 text-xs mt-1">
                  Период: {report.period_start} — {report.period_end}
                </p>
              )}
            </div>

            {/* Статистика (6 метрик) */}
            <div className="grid grid-cols-2 gap-4">
              <StatCard
                label="Шагов всего"
                value={report.stats.total_steps.toLocaleString('ru-RU')}
                color="bg-blue-50"
              />
              <StatCard
                label="Дистанция (км)"
                value={report.stats.total_distance_km.toFixed(1)}
                color="bg-green-50"
              />
              <StatCard
                label="Шагов в день (ср.)"
                value={Math.round(report.stats.avg_daily_steps).toLocaleString('ru-RU')}
                color="bg-purple-50"
              />
              <StatCard
                label="Заряд батареи (ср.)"
                value={`${report.stats.avg_battery_level.toFixed(1)}%`}
                color="bg-yellow-50"
              />
              <StatCard
                label="Часов использования"
                value={`${report.stats.total_usage_hours.toFixed(0)} ч`}
                color="bg-indigo-50"
              />
              <StatCard
                label="Событий падения"
                value={String(report.stats.fall_events)}
                color={report.stats.fall_events > 0 ? 'bg-red-50' : 'bg-gray-50'}
              />
            </div>

            {report.stats.maintenance_alerts > 0 && (
              <div className="p-3 bg-orange-50 border border-orange-200 rounded-lg text-sm text-orange-800">
                ⚠ Предупреждений о техобслуживании: {report.stats.maintenance_alerts}
              </div>
            )}

            <p className="text-xs text-gray-400">
              Отчёт сформирован: {new Date(report.generated_at).toLocaleString('ru-RU')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default ReportPage;
