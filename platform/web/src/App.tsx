import type { ReactNode } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { RequireAuth } from './components/RequireAuth';
import { AboutPage } from './pages/AboutPage';
import { AlertsPage } from './pages/AlertsPage';
import { AuthCallbackPage } from './pages/AuthCallbackPage';
import { BidsPage } from './pages/BidsPage';
import { HuntDetailPage } from './pages/HuntDetailPage';
import { HuntsPage } from './pages/HuntsPage';
import { LotPage } from './pages/LotPage';
import { NewHuntPage } from './pages/NewHuntPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProfilePage } from './pages/ProfilePage';
import { SearchPage } from './pages/SearchPage';
import { SignInPage } from './pages/SignInPage';
import { AlertsProvider } from './providers/AlertsProvider';
import { AuthProvider } from './providers/AuthProvider';
import { HomeProvider } from './providers/HomeProvider';

const priv = (page: ReactNode) => <RequireAuth>{page}</RequireAuth>;

/**
 * Routes. Search, lots and About are public (the catalogue is world-readable,
 * 0003); hunts, bids, alerts and the profile are the user's own data and need
 * a session.
 */
export function App() {
  return (
    <AuthProvider>
      <HomeProvider>
        <AlertsProvider>
          <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <Routes>
              <Route path="/signin" element={<SignInPage />} />
              <Route path="/auth/callback" element={<AuthCallbackPage />} />
              <Route element={<AppShell />}>
                <Route index element={<SearchPage />} />
                <Route path="lot/:id" element={<LotPage />} />
                <Route path="hunts" element={priv(<HuntsPage />)} />
                <Route path="hunts/new" element={priv(<NewHuntPage />)} />
                <Route path="hunts/:id" element={priv(<HuntDetailPage />)} />
                <Route path="bids" element={priv(<BidsPage />)} />
                <Route path="alerts" element={priv(<AlertsPage />)} />
                <Route path="profile" element={priv(<ProfilePage />)} />
                <Route path="about" element={<AboutPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </AlertsProvider>
      </HomeProvider>
    </AuthProvider>
  );
}
