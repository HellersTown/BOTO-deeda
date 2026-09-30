import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { RequireAuth } from './components/RequireAuth';
import { AlertsProvider } from './providers/AlertsProvider';
import { AuthProvider } from './providers/AuthProvider';
import { HomeProvider } from './providers/HomeProvider';
import { APP_ROUTES, NOT_FOUND, type AppRoute } from './routes';

function page({ Page, access }: AppRoute) {
  return access === 'account' ? (
    <RequireAuth>
      <Page />
    </RequireAuth>
  ) : (
    <Page />
  );
}

/** The routes in routes.ts: the full-screen ones, then the rest inside the app shell. */
export function App() {
  const NotFound = NOT_FOUND;
  return (
    <AuthProvider>
      <HomeProvider>
        <AlertsProvider>
          <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <Routes>
              {APP_ROUTES.filter((r) => !r.shell).map((r) => (
                <Route key={r.path} path={r.path} element={page(r)} />
              ))}
              <Route element={<AppShell />}>
                {APP_ROUTES.filter((r) => r.shell).map((r) => (
                  <Route key={r.path} path={r.path} element={page(r)} />
                ))}
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </AlertsProvider>
      </HomeProvider>
    </AuthProvider>
  );
}
