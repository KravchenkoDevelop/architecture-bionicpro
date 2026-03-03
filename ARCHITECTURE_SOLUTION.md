# Архитектурное решение: управление учётными данными в BionicPRO

## Задача 1 — Управление учётными данными

### 1. Проблемы исходной архитектуры

| Проблема | Описание |
|---|---|
| Токены IdP на фронтенде | `keycloak-js` получает `access_token` и `refresh_token` напрямую от Keycloak и хранит их в памяти браузера (JS-доступ, XSS-уязвимость) |
| Authorization Code Grant без PKCE | Перехваченный `code` можно обменять на токены без дополнительного секрета |
| Нет поддержки внешних IdP | Единственный источник пользователей — локальная база Keycloak |
| Нет унификации доступа | Нет интеграции с корпоративным LDAP как единым источником истины |

---

### 2. Предлагаемое решение

#### 2.1 BFF (Backend for Frontend) — безопасная работа с токенами

Ключевой принцип: **фронтенд никогда не видит токены, полученные от Keycloak**.

```
Браузер → BFF → Keycloak → (LDAP / External IdP)
              ↓
         Session Store (Redis)
              ↓
         Backend API (Bearer-token инъекция)
```

**Поток аутентификации (PKCE + BFF):**

1. Пользователь нажимает «Войти» → фронтенд делает `GET /auth/login` к BFF.
2. BFF генерирует `code_verifier` (случайные 32 байта) и `code_challenge = SHA-256(code_verifier)`, сохраняет `code_verifier` в серверной сессии.
3. BFF перенаправляет браузер в Keycloak с параметрами `code_challenge` и `code_challenge_method=S256`.
4. Keycloak аутентифицирует пользователя (через LDAP или внешний IdP).
5. Keycloak перенаправляет браузер обратно на `BFF /auth/callback?code=…&state=…`.
6. BFF извлекает `code_verifier` из серверной сессии и обменивает `code` на токены у Keycloak, передав `code_verifier`.
7. BFF сохраняет `access_token` и `refresh_token` в **Redis/Session Store** (сервер), привязывая к `sessionId`.
8. BFF возвращает браузеру **только** httpOnly cookie `sessionId`. Токены фронтенд не получает.
9. При API-запросах фронтенд отправляет cookie → BFF находит сессию → инжектирует `Bearer access_token` в запрос к Backend API.
10. BFF автоматически обновляет `access_token` через `refresh_token` до истечения сессии.

**Результат:** Даже при XSS-атаке злоумышленник не получит токены IdP — в JS-контексте браузера их нет.

#### 2.2 Унификация доступа через внешний LDAP

Все учётные записи сотрудников и пользователей BionicPRO хранятся в **корпоративном LDAP/AD**, расположенном в стране представительства компании.

Интеграция реализуется через механизм **User Federation** в Keycloak:
- Keycloak обращается к LDAP по протоколу LDAPS (зашифрованное соединение).
- Атрибуты пользователя (имя, email, группы) синхронизируются из LDAP в Keycloak.
- Медицинские и персональные данные **остаются в локальной базе данных** (PostgreSQL) на инфраструктуре BionicPRO — принцип локального хранения не нарушается.
- LDAP используется только для аутентификации (проверка пароля) и получения базовых атрибутов.

#### 2.3 Поддержка внешних IdP для разных стран

Keycloak реализует **Identity Provider Brokering** (брокирование):
- Для каждой страны присутствия настраивается отдельный external IdP (SAML 2.0 или OIDC).
- Примеры: Госуслуги (Россия), NHS Login (Великобритания), BundID (Германия).
- Пользователь выбирает страну → Keycloak перенаправляет на нужный IdP.
- После успешной аутентификации Keycloak создаёт или обновляет локальную запись пользователя и выдаёт внутренний токен BFF.
- BFF не знает о том, какой именно IdP использовался — для него процесс унифицирован.

Это обеспечивает **единую точку входа** для всех стран, не нарушая принципа локального хранения данных.

---

### 3. C4-диаграмма

Файл: [architecture-c4-diagram.xml](./architecture-c4-diagram.xml) (открыть в [draw.io](https://app.diagrams.net/))

**Компоненты:**

| Компонент | Тип | Назначение |
|---|---|---|
| Frontend (React SPA) | Container | UI, взаимодействует только с BFF через session cookie |
| BFF (Node.js/Express) | Container | PKCE flow, хранение токенов, проксирование API |
| Backend API | Container | Бизнес-логика, локальное хранение медицинских данных |
| Keycloak | Container | OAuth2/OIDC IdP, Identity Brokering, User Federation |
| Session Store (Redis) | Container | Серверное хранилище токенов — токены фронтенд не видит |
| PostgreSQL | Container | Данные Keycloak + бизнес-данные (локально) |
| Корпоративный LDAP/AD | External | Единый каталог пользователей в стране представительства |
| External IdP (Страна A/B) | External | Национальные IdP по странам присутствия |

---

## Задача 2 — Замена Authorization Code Grant на PKCE

### Что изменено

#### 1. Frontend — [frontend/src/App.tsx](./frontend/src/App.tsx)

Добавлены `initOptions` с включённым PKCE:

```typescript
const keycloakInitOptions: KeycloakInitOptions = {
  onLoad: 'check-sso',
  silentCheckSsoRedirectUri: window.location.origin + '/silent-check-sso.html',
  pkceCodeChallengeMethod: 'S256',  // ← PKCE включён
};
```

`keycloak-js` теперь автоматически:
1. Генерирует криптографически стойкий `code_verifier` (random 32 bytes → base64url).
2. Вычисляет `code_challenge = BASE64URL(SHA256(code_verifier))`.
3. Добавляет `code_challenge` и `code_challenge_method=S256` в Authorization Request.
4. При получении `code` отправляет `code_verifier` в Token Request.

#### 2. Keycloak — [keycloak/realm-export.json](./keycloak/realm-export.json)

Клиент `reports-frontend` обновлён:

```json
{
  "clientId": "reports-frontend",
  "publicClient": true,
  "standardFlowEnabled": true,
  "directAccessGrantsEnabled": false,
  "attributes": {
    "pkce.code.challenge.method": "S256"
  }
}
```

- `pkce.code.challenge.method: S256` — Keycloak **отклоняет** запросы без PKCE.
- `directAccessGrantsEnabled: false` — отключён Resource Owner Password Credentials Grant (обходит PKCE).

#### 3. Silent SSO — [frontend/public/silent-check-sso.html](./frontend/public/silent-check-sso.html)

Страница для фонового обновления SSO-сессии в скрытом iframe без редиректа основного окна.

### Почему PKCE важен для публичных клиентов

| Атака | Без PKCE | С PKCE (S256) |
|---|---|---|
| Перехват authorization code | code можно обменять на токены | code бесполезен без `code_verifier` |
| Authorization Code Injection | Возможна подстановка code | Привязан к конкретному `code_verifier` в сессии |
| Replay attack | Частично возможен | `code_verifier` одноразовый |

### Ссылки

- [RFC 7636 — PKCE](https://www.rfc-editor.org/rfc/rfc7636)
- [Keycloak PKCE documentation](https://www.keycloak.org/docs/latest/server_admin/#_proof-key-for-code-exchange)
- [keycloak-js — initOptions](https://www.keycloak.org/docs/latest/securing_apps/#javascript-adapter-reference)
- [OAuth 2.0 Security BCP (RFC 9700)](https://www.rfc-editor.org/rfc/rfc9700) — рекомендует PKCE для всех клиентов
