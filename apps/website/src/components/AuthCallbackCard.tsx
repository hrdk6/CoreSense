import React, { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, KeyRound, ShieldAlert, X } from 'lucide-react';

type CallbackKind = 'confirmed' | 'recovery' | 'error';
type CallbackSource = 'desktop' | 'android' | 'web' | null;

interface ParsedAuthCallback {
  kind: CallbackKind;
  source: CallbackSource;
  accessToken?: string;
  errorMessage?: string;
}

const API_BASE = 'https://coresense-api.onrender.com';
const PWA_URL = 'https://coresense-mobile-pwa.onrender.com';

function parseSupabaseAuthCallback(): ParsedAuthCallback | null {
  if (typeof window === 'undefined') return null;

  const query = new URLSearchParams(window.location.search);
  const rawHash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  // Ignore plain anchor hashes like #download, #diagnostics, #architecture, #top
  const isParamHash = rawHash.includes('=');
  const hash = isParamHash ? new URLSearchParams(rawHash) : new URLSearchParams();

  const sourceParam = (query.get('source') || '').toLowerCase();
  const source: CallbackSource =
    sourceParam === 'desktop' ? 'desktop' : sourceParam === 'android' ? 'android' : sourceParam === 'web' ? 'web' : null;

  const errorCode = hash.get('error') || query.get('error');
  const errorDesc = hash.get('error_description') || query.get('error_description');
  if (errorCode || errorDesc) {
    return {
      kind: 'error',
      source,
      errorMessage: errorDesc || errorCode || 'This verification link is invalid or has expired.',
    };
  }

  const type = (hash.get('type') || query.get('type') || '').toLowerCase();
  const authParam = (query.get('auth') || '').toLowerCase();
  const accessToken = hash.get('access_token') || undefined;
  const hasCode = Boolean(query.get('code'));

  if (type === 'recovery' || authParam === 'recovery') {
    return {
      kind: 'recovery',
      source,
      accessToken,
    };
  }

  if (
    type === 'signup' ||
    type === 'email' ||
    type === 'magiclink' ||
    type === 'email_change' ||
    authParam === 'confirmed' ||
    Boolean(accessToken) ||
    hasCode
  ) {
    return {
      kind: 'confirmed',
      source,
      accessToken,
    };
  }

  return null;
}

export const AuthCallbackCard: React.FC = () => {
  const [callback, setCallback] = useState<ParsedAuthCallback | null>(() => parseSupabaseAuthCallback());
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  useEffect(() => {
    if (!callback) return;
    // Immediately scrub sensitive access_token/code parameters from the address bar
    try {
      const cleanUrl = `${window.location.origin}${window.location.pathname}`;
      window.history.replaceState({}, document.title, cleanUrl);
    } catch {
      // Ignore history API restrictions
    }
  }, [callback]);

  if (!callback) return null;

  const handlePasswordUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetError(null);
    if (newPassword.length < 8) {
      setResetError('Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setResetError('Passwords do not match.');
      return;
    }
    if (!callback.accessToken) {
      setResetError('Recovery token missing or expired. Request a new password reset link inside CoreSense.');
      return;
    }

    setSaving(true);
    try {
      const cfgRes = await fetch(`${API_BASE}/api/v1/auth/config`);
      if (!cfgRes.ok) throw new Error('Unable to contact CoreSense auth configuration.');
      const cfg = (await cfgRes.json()) as {
        supabaseEnabled?: boolean;
        supabaseUrl?: string;
        supabaseAnonKey?: string;
      };
      if (!cfg.supabaseEnabled || !cfg.supabaseUrl || !cfg.supabaseAnonKey) {
        throw new Error('Cloud authentication is currently unavailable.');
      }

      const updRes = await fetch(`${cfg.supabaseUrl.replace(/\/$/, '')}/auth/v1/user`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          apikey: cfg.supabaseAnonKey,
          Authorization: `Bearer ${callback.accessToken}`,
        },
        body: JSON.stringify({ password: newPassword }),
      });

      if (!updRes.ok) {
        const errBody = (await updRes.json().catch(() => ({}))) as { msg?: string; error_description?: string };
        throw new Error(errBody.error_description || errBody.msg || 'Could not update password. Request a fresh link.');
      }

      setResetDone(true);
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setResetError(err instanceof Error ? err.message : 'Unable to update password.');
    } finally {
      setSaving(false);
    }
  };

  const targetAppText =
    callback.source === 'desktop'
      ? 'Return to the CoreSense Desktop app and sign in with your email and password.'
      : callback.source === 'android'
        ? 'Return to the CoreSense Android app and sign in with your email and password.'
        : 'Return to the CoreSense Desktop or Android app and sign in with your email and password.';

  return (
    <section
      aria-live="polite"
      className="border-b border-[var(--cs-border)] bg-[var(--cs-well)]"
    >
      <div className="mx-auto max-w-6xl px-5 py-6">
        {callback.kind === 'confirmed' && (
          <div className="cs-panel border-[var(--cs-ok-border)] bg-[var(--cs-ok-soft)]/50 p-5 sm:p-6 flex flex-col sm:flex-row items-start justify-between gap-4">
            <div className="flex items-start gap-3.5 min-w-0">
              <CheckCircle2 className="h-5 w-5 text-[var(--cs-ok)] shrink-0 mt-0.5" />
              <div className="space-y-1.5">
                <h2 className="cs-heading text-lg font-bold text-[var(--cs-ink)]">
                  Your CoreSense email is confirmed
                </h2>
                <p className="text-sm text-[var(--cs-ink-2)] leading-relaxed max-w-[64ch]">
                  Your account is active and synced across all platforms. {targetAppText}
                </p>
                <div className="pt-2 flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => setCallback(null)}
                    className="cs-btn-primary px-4 py-2 text-xs cursor-pointer"
                  >
                    Continue to website
                  </button>
                  <a
                    href={PWA_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="cs-btn-secondary px-3.5 py-2 text-xs inline-flex items-center gap-1.5"
                  >
                    <span>Open Mobile Web instead</span>
                    <ExternalLink className="h-3.5 w-3.5 text-[var(--cs-ink-muted)]" />
                  </a>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setCallback(null)}
              aria-label="Dismiss confirmation notice"
              className="text-[var(--cs-ink-muted)] hover:text-[var(--cs-ink)] cursor-pointer shrink-0"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {callback.kind === 'recovery' && (
          <div className="cs-panel p-5 sm:p-6 max-w-lg space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <KeyRound className="h-5 w-5 text-[var(--cs-accent)] shrink-0" />
                <h2 className="cs-heading text-lg font-bold text-[var(--cs-ink)]">
                  {resetDone ? 'Password updated' : 'Set a new CoreSense password'}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setCallback(null)}
                aria-label="Dismiss password recovery panel"
                className="text-[var(--cs-ink-muted)] hover:text-[var(--cs-ink)] cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {resetDone ? (
              <div className="space-y-3">
                <p className="text-sm text-[var(--cs-ink-2)]">
                  Your password has been changed. {targetAppText}
                </p>
                <button
                  type="button"
                  onClick={() => setCallback(null)}
                  className="cs-btn-primary px-4 py-2 text-xs cursor-pointer"
                >
                  Done
                </button>
              </div>
            ) : (
              <form onSubmit={handlePasswordUpdate} className="space-y-3">
                <p className="text-xs text-[var(--cs-ink-muted)]">
                  Choose a new password (at least 8 characters). Once saved, sign back into your CoreSense Desktop or
                  Android app.
                </p>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="New password"
                  className="w-full rounded-lg border border-[var(--cs-border)] bg-[var(--cs-canvas)] px-3.5 py-2.5 text-sm text-[var(--cs-ink)]"
                />
                <input
                  type="password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                  className="w-full rounded-lg border border-[var(--cs-border)] bg-[var(--cs-canvas)] px-3.5 py-2.5 text-sm text-[var(--cs-ink)]"
                />
                {resetError && (
                  <div className="rounded-md border border-[var(--cs-danger-border)] bg-[var(--cs-danger-soft)] px-3 py-2 text-xs text-[var(--cs-danger-ink)]">
                    {resetError}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={saving}
                  className="cs-btn-primary px-4 py-2.5 text-xs cursor-pointer disabled:opacity-60"
                >
                  {saving ? 'Updating password...' : 'Update password'}
                </button>
              </form>
            )}
          </div>
        )}

        {callback.kind === 'error' && (
          <div className="cs-panel border-[var(--cs-danger-border)] bg-[var(--cs-danger-soft)]/50 p-5 sm:p-6 flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <ShieldAlert className="h-5 w-5 text-[var(--cs-danger)] shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h2 className="cs-heading text-base font-bold text-[var(--cs-ink)]">
                  Verification link expired or already used
                </h2>
                <p className="text-xs sm:text-sm text-[var(--cs-ink-2)] max-w-[64ch]">
                  {callback.errorMessage} If you already confirmed your account, simply sign in inside CoreSense.
                  Otherwise, tap Resend confirmation email on the sign-in screen.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setCallback(null)}
              aria-label="Dismiss error notice"
              className="text-[var(--cs-ink-muted)] hover:text-[var(--cs-ink)] cursor-pointer shrink-0"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </section>
  );
};
