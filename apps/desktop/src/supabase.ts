import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { getApiBaseUrl, setAuthToken } from './api';

let cachedClient: SupabaseClient | null | undefined;
let cachedApiBase = '';

interface AuthConfigResponse {
  supabaseEnabled: boolean;
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
}

export async function getSupabaseClient(): Promise<SupabaseClient | null> {
  const apiBase = getApiBaseUrl();
  if (cachedClient !== undefined && cachedApiBase === apiBase) {
    return cachedClient;
  }

  let url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() || '';
  let anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() || '';

  if (!url || !anonKey) {
    try {
      const res = await fetch(`${apiBase}/api/v1/auth/config`);
      if (res.ok) {
        const cfg = (await res.json()) as AuthConfigResponse;
        if (cfg.supabaseEnabled && cfg.supabaseUrl && cfg.supabaseAnonKey) {
          url = cfg.supabaseUrl;
          anonKey = cfg.supabaseAnonKey;
        }
      }
    } catch {
      // Backend unreachable; fall back cleanly
    }
  }

  cachedApiBase = apiBase;
  if (!url || !anonKey) {
    cachedClient = null;
    return null;
  }

  cachedClient = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  return cachedClient;
}

export function resetSupabaseClientCache(): void {
  cachedClient = undefined;
  cachedApiBase = '';
}

export async function initSupabaseAuthSync(handlers: {
  onSession: (session: Session | null) => void;
  onPasswordRecovery?: () => void;
}): Promise<() => void> {
  const sb = await getSupabaseClient();
  if (!sb) return () => {};

  const { data } = await sb.auth.getSession();
  if (data.session?.access_token) {
    setAuthToken(data.session.access_token);
    handlers.onSession(data.session);
  }

  const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      handlers.onPasswordRecovery?.();
      return;
    }
    if (session?.access_token) {
      setAuthToken(session.access_token);
      handlers.onSession(session);
    } else if (event === 'SIGNED_OUT') {
      setAuthToken(null);
      handlers.onSession(null);
    }
  });

  return () => {
    sub.subscription.unsubscribe();
  };
}

export async function signOutSupabase(): Promise<void> {
  const sb = await getSupabaseClient();
  if (sb) {
    await sb.auth.signOut().catch(() => {});
  }
}
