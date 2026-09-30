/**
 * Where the user bids from: home ZIP and driving radius.
 *
 * Signed in, these are profiles.home_postal_code and radius_miles (0009 lets the
 * user write both). Signed out, they live in this device's localStorage, so
 * search works before signup. A ZIP set on the device before signing in is
 * carried into an empty profile once.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ProfileRow, ProfileUpdate } from '../data/database.types';
import { lookupPostalCode, type PostalPlace } from '../data/postal';
import { getMyProfile, updateMyProfile } from '../data/profile';
import { readStored, writeStored } from '../lib/storage';
import { useAuth } from './AuthProvider';

export const DEFAULT_RADIUS_MILES = 50;

interface DeviceHome {
  readonly zip: string | null;
  readonly radiusMiles: number;
}

function isDeviceHome(v: unknown): v is DeviceHome {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (o.zip === null || (typeof o.zip === 'string' && /^\d{5}$/.test(o.zip))) && typeof o.radiusMiles === 'number';
}

export interface HomeState {
  readonly zip: string | null;
  readonly radiusMiles: number;
  /** City, state and centroid of the home ZIP, when the gazetteer knows it. */
  readonly place: PostalPlace | null;
  readonly profile: ProfileRow | null;
  readonly profileLoading: boolean;
  readonly profileError: unknown;
  readonly setHome: (zip: string | null, radiusMiles: number) => Promise<void>;
  readonly updateProfile: (patch: ProfileUpdate) => Promise<ProfileRow>;
  readonly reloadProfile: () => void;
}

const HomeContext = createContext<HomeState | null>(null);

export function HomeProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [device, setDevice] = useState<DeviceHome>(
    () => readStored('home', isDeviceHome) ?? { zip: null, radiusMiles: DEFAULT_RADIUS_MILES },
  );
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const [place, setPlace] = useState<PostalPlace | null>(null);

  const userId = user?.id ?? null;

  useEffect(() => {
    if (authLoading) return;
    if (!userId) {
      setProfile(null);
      return;
    }
    let active = true;
    setProfileLoading(true);
    setProfileError(null);
    getMyProfile(userId)
      .then(async (p) => {
        if (!active) return;
        // Carry a ZIP chosen before sign-in into a profile that has none.
        if (p && !p.home_postal_code && device.zip) {
          try {
            p = await updateMyProfile(userId, { home_postal_code: device.zip, radius_miles: device.radiusMiles });
          } catch (err) {
            console.warn(err);
          }
        }
        if (active) setProfile(p);
      })
      .catch((err: unknown) => {
        if (active) setProfileError(err);
      })
      .finally(() => {
        if (active) setProfileLoading(false);
      });
    return () => {
      active = false;
    };
    // device is read once per sign-in on purpose.
  }, [userId, authLoading, nonce]);

  const zip = (userId ? profile?.home_postal_code : null) ?? device.zip;
  const radiusMiles = (userId ? profile?.radius_miles : null) ?? device.radiusMiles ?? DEFAULT_RADIUS_MILES;

  useEffect(() => {
    if (!zip) {
      setPlace(null);
      return;
    }
    let active = true;
    lookupPostalCode(zip)
      .then((p) => {
        if (active) setPlace(p);
      })
      .catch(() => {
        if (active) setPlace(null);
      });
    return () => {
      active = false;
    };
  }, [zip]);

  const setHome = useCallback(
    async (nextZip: string | null, nextRadius: number) => {
      const next = { zip: nextZip, radiusMiles: nextRadius };
      writeStored('home', next);
      setDevice(next);
      if (userId) {
        const p = await updateMyProfile(userId, { home_postal_code: nextZip, radius_miles: nextRadius });
        setProfile(p);
      }
    },
    [userId],
  );

  const updateProfile = useCallback(
    async (patch: ProfileUpdate) => {
      if (!userId) throw new Error('Sign in to change your profile.');
      const p = await updateMyProfile(userId, patch);
      setProfile(p);
      if (patch.home_postal_code !== undefined || patch.radius_miles !== undefined) {
        const next = { zip: p.home_postal_code, radiusMiles: p.radius_miles ?? DEFAULT_RADIUS_MILES };
        writeStored('home', next);
        setDevice(next);
      }
      return p;
    },
    [userId],
  );

  const reloadProfile = useCallback(() => setNonce((n) => n + 1), []);

  const value = useMemo<HomeState>(
    () => ({ zip, radiusMiles, place, profile, profileLoading, profileError, setHome, updateProfile, reloadProfile }),
    [zip, radiusMiles, place, profile, profileLoading, profileError, setHome, updateProfile, reloadProfile],
  );
  return <HomeContext.Provider value={value}>{children}</HomeContext.Provider>;
}

export function useHome(): HomeState {
  const ctx = useContext(HomeContext);
  if (!ctx) throw new Error('useHome must be used inside HomeProvider');
  return ctx;
}
