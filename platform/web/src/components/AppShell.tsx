import { useEffect, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useOnline } from '../hooks/useOnline';
import { useAlerts } from '../providers/AlertsProvider';
import { BellIcon, CompassIcon, PaddleIcon, PersonIcon, PriceIcon, SearchIcon } from './Icons';
import { LocationButton } from './LocationDialog';
import { Wordmark } from './Logo';

const TABS = [
  { to: '/', label: 'Search', Icon: SearchIcon, end: true },
  { to: '/finds', label: 'Finds', Icon: PriceIcon, end: false },
  { to: '/hunts', label: 'Hunts', Icon: CompassIcon, end: false },
  { to: '/bids', label: 'Bids', Icon: PaddleIcon, end: false },
  { to: '/alerts', label: 'Alerts', Icon: BellIcon, end: false },
  { to: '/profile', label: 'Profile', Icon: PersonIcon, end: false },
] as const;

function unreadLabel(n: number): string {
  return n === 1 ? '1 unread alert' : `${n} unread alerts`;
}

/** Desktop search box in the top bar (the design's web header). Drives /?q=. */
function HeaderSearch() {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const current = location.pathname === '/' ? (params.get('q') ?? '') : '';
  const [text, setText] = useState(current);
  useEffect(() => setText(current), [current]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const q = text.trim();
    navigate(q ? `/?q=${encodeURIComponent(q)}` : '/');
  }

  return (
    <form role="search" className="header-search" onSubmit={submit}>
      <label htmlFor="header-q" className="visually-hidden">
        What do you need?
      </label>
      <input
        id="header-q"
        type="search"
        className="header-search__input"
        value={text}
        placeholder="e.g. generator under $800 within 60 miles"
        onChange={(e) => setText(e.target.value)}
        enterKeyHint="search"
      />
      <LocationButton variant="field" />
      <button type="submit" className="btn btn--primary header-search__submit">
        Search
      </button>
    </form>
  );
}

function TopNav() {
  const { unread } = useAlerts();
  return (
    <header className="topnav">
      <Link to="/" className="topnav__brand" aria-label="Skeuos, search">
        <Wordmark size={28} markSize={30} />
      </Link>
      <HeaderSearch />
      <nav aria-label="Primary" className="topnav__nav">
        {TABS.map(({ to, label, end }) => (
          <NavLink key={to} to={to} end={end} className="topnav__link">
            {label}
            {to === '/alerts' && unread > 0 ? (
              <span className="count-badge" aria-label={unreadLabel(unread)}>
                {unread > 99 ? '99+' : unread}
              </span>
            ) : null}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}

function BottomTabs() {
  const { unread } = useAlerts();
  return (
    <nav aria-label="Primary" className="tabbar">
      {TABS.map(({ to, label, Icon, end }) => (
        <NavLink key={to} to={to} end={end} className="tab">
          {({ isActive }) => (
            <>
              <span className="tab__icon">
                <Icon strokeWidth={isActive ? 2 : 1.8} />
                {to === '/alerts' && unread > 0 ? (
                  <span className="count-badge count-badge--tab" aria-hidden="true">
                    {unread > 99 ? '99+' : unread}
                  </span>
                ) : null}
              </span>
              <span>{label}</span>
              {to === '/alerts' && unread > 0 ? <span className="visually-hidden">, {unreadLabel(unread)}</span> : null}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

export function AppShell() {
  const online = useOnline();
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <TopNav />
      {!online ? (
        <div className="offline-banner" role="status">
          You are offline. Skeuos opens, but searching, hunts and alerts need a connection.
        </div>
      ) : null}
      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>
      <BottomTabs />
    </div>
  );
}
