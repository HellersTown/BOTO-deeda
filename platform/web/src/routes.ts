/**
 * Every route, as data. App.tsx renders it; routes.test.ts checks it. Search
 * and lots are public (the catalogue is world-readable, 0003); hunts, bids,
 * alerts, the profile and "Before you set out" are the user's own and need a
 * session. `shell` routes sit inside the app shell (top navigation and tabs).
 */
import type { ComponentType } from 'react';
import { AlertsPage } from './pages/AlertsPage';
import { AuthCallbackPage } from './pages/AuthCallbackPage';
import { BidsPage } from './pages/BidsPage';
import { HuntDetailPage } from './pages/HuntDetailPage';
import { HuntsPage } from './pages/HuntsPage';
import { LotPage } from './pages/LotPage';
import { NewHuntPage } from './pages/NewHuntPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { PickupPage } from './pages/PickupPage';
import { ProfilePage } from './pages/ProfilePage';
import { SearchPage } from './pages/SearchPage';
import { SignInPage } from './pages/SignInPage';

export interface AppRoute {
  readonly path: string;
  readonly Page: ComponentType;
  readonly access: 'public' | 'account';
  readonly shell: boolean;
}

export const APP_ROUTES: readonly AppRoute[] = [
  { path: '/signin', Page: SignInPage, access: 'public', shell: false },
  { path: '/auth/callback', Page: AuthCallbackPage, access: 'public', shell: false },
  { path: '/welcome', Page: OnboardingPage, access: 'account', shell: false },
  { path: '/', Page: SearchPage, access: 'public', shell: true },
  { path: '/lot/:id', Page: LotPage, access: 'public', shell: true },
  { path: '/hunts', Page: HuntsPage, access: 'account', shell: true },
  { path: '/hunts/new', Page: NewHuntPage, access: 'account', shell: true },
  { path: '/hunts/:id', Page: HuntDetailPage, access: 'account', shell: true },
  { path: '/bids', Page: BidsPage, access: 'account', shell: true },
  { path: '/bids/pickup', Page: PickupPage, access: 'account', shell: true },
  { path: '/alerts', Page: AlertsPage, access: 'account', shell: true },
  { path: '/profile', Page: ProfilePage, access: 'account', shell: true },
];

/** Anything else, inside the shell. */
export const NOT_FOUND: ComponentType = NotFoundPage;
