/**
 * Supabase Auth: magic link, email + password, sign-out. A profiles row is made
 * for every new user by the on_auth_user_created trigger (0003), so sign-up
 * never inserts one (0009 revokes that insert anyway).
 */
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { toDataError } from './errors';
import { db } from './supabase';

/** Where magic links and confirmation emails return to. */
export function callbackUrl(origin: string = window.location.origin): string {
  return `${origin}/auth/callback`;
}

export async function sendMagicLink(email: string): Promise<void> {
  const { error } = await db().auth.signInWithOtp({
    email,
    options: { emailRedirectTo: callbackUrl(), shouldCreateUser: true },
  });
  if (error) throw toDataError(error, 'magic link');
}

export async function signInWithPassword(email: string, password: string): Promise<Session> {
  const { data, error } = await db().auth.signInWithPassword({ email, password });
  if (error) throw toDataError(error, 'sign in');
  return data.session;
}

/** Returns the session, or null when the project requires the emailed confirmation first. */
export async function signUpWithPassword(email: string, password: string): Promise<Session | null> {
  const { data, error } = await db().auth.signUp({
    email,
    password,
    options: { emailRedirectTo: callbackUrl() },
  });
  if (error) throw toDataError(error, 'sign up');
  return data.session;
}

export async function signOut(): Promise<void> {
  const { error } = await db().auth.signOut();
  if (error) throw toDataError(error, 'sign out');
}

export async function getSession(): Promise<Session | null> {
  const { data, error } = await db().auth.getSession();
  if (error) throw toDataError(error, 'session');
  return data.session;
}

/**
 * PKCE callback: exchange ?code= for a session. (Implicit-flow links carry the
 * tokens in the URL hash and are picked up by the client on load, because it
 * runs with detectSessionInUrl.)
 */
export async function exchangeCode(code: string): Promise<Session | null> {
  const { data, error } = await db().auth.exchangeCodeForSession(code);
  if (error) throw toDataError(error, 'sign-in link');
  return data.session;
}

export function onAuthStateChange(listener: (event: AuthChangeEvent, session: Session | null) => void): () => void {
  const { data } = db().auth.onAuthStateChange(listener);
  return () => data.subscription.unsubscribe();
}
