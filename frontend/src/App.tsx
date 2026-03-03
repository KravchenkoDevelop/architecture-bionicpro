import React from 'react';
import { ReactKeycloakProvider } from '@react-keycloak/web';
import Keycloak, { KeycloakConfig, KeycloakInitOptions } from 'keycloak-js';
import ReportPage from './components/ReportPage';

const keycloakConfig: KeycloakConfig = {
  url: process.env.REACT_APP_KEYCLOAK_URL,
  realm: process.env.REACT_APP_KEYCLOAK_REALM || '',
  clientId: process.env.REACT_APP_KEYCLOAK_CLIENT_ID || '',
};

const keycloak = new Keycloak(keycloakConfig);

// PKCE (Proof Key for Code Exchange) — защита от перехвата authorization code.
// code_verifier генерируется keycloak-js в браузере; на сервер Keycloak передаётся
// только его SHA-256 хеш (code_challenge). Без code_verifier украденный code бесполезен.
// pkceMethod: 'S256' нужно указывать явно — keycloak-js не включает PKCE автоматически.
const keycloakInitOptions: KeycloakInitOptions = {
  onLoad: 'check-sso',
  silentCheckSsoRedirectUri: window.location.origin + '/silent-check-sso.html',
  // Отключает fallback при блокировке third-party cookies браузером (Chrome 120+, Яндекс.Браузер).
  // Без этого keycloak-js зависает на 3p-cookies/step1.html при инициализации.
  silentCheckSsoFallback: false,
  pkceMethod: 'S256',
};

const App: React.FC = () => {
  return (
    <ReactKeycloakProvider authClient={keycloak} initOptions={keycloakInitOptions}>
      <div className="App">
        <ReportPage />
      </div>
    </ReactKeycloakProvider>
  );
};

export default App;