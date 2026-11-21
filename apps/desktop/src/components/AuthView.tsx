import React, { useEffect, useState } from 'react';
import { KeyRound, Moon, ShieldCheck, Sun } from 'lucide-react';
import { apiRequest, detectClientPlatform, getInstallId, setAuthToken } from '../api';
import { getSupabaseClient } from '../supabase';
import { BrandLogo } from './BrandLogo';

interface AuthViewProps {
  onAuthenticated: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  passwordRecoveryPending?: boolean;
  onPasswordRecoveryComplete?: () => void;
}

type ScopeChannel = 'thermal' | 'storage' | 'power';

const SCOPE_CHANNELS: Record<
  ScopeChannel,
  {
    label: string;
    channelLabel: string;
    primaryReadout: string;
    secondaryReadout: string;
    statusLabel: string;
    tracePrimary: string;
    traceSecondary: string;
    probeX: number;
    probeY: number;
  }
> = {
  thermal: {
    label: 'Thermal',
    channelLabel: 'CH1 CPU Die · CH2 Fan RPM',
    primaryReadout: '64.2 °C',
    secondaryReadout: 'Fan nominal · 2,410 RPM',
    statusLabel: 'Within safe thermal window',
    tracePrimary: 'M 0 68 C 40 66, 65 54, 105 56 C 145 58, 175 44, 220 48 C 265 52, 300 40, 350 44 C 390 47, 420 43, 460 45',
    traceSecondary: 'M 0 88 C 55 86, 110 84, 180 82 C 250 80, 320 78, 460 76',
    probeX: 350,
    probeY: 44,
  },
  storage: {
    label: 'Storage SMART',
    channelLabel: 'CH1+2 NVMe I/O & SMART Wear',
    primaryReadout: '14% wear',
    secondaryReadout: '0 media errors · 38% load',
    statusLabel: 'SMART baseline verified',
    tracePrimary: 'M 0 74 L 38 74 L 52 38 L 70 64 L 112 64 L 128 28 L 146 58 L 210 58 L 226 36 L 244 62 L 310 62 L 328 24 L 348 56 L 410 56 L 428 42 L 460 42',
    traceSecondary: 'M 0 92 L 70 92 L 88 80 L 164 80 L 182 88 L 280 88 L 296 74 L 378 74 L 396 86 L 460 86',
    probeX: 328,
    probeY: 24,
  },
  power: {
    label: 'Power Rails',
    channelLabel: 'CH1 PPBUS_G3H · CH2 USB-C PD',
    primaryReadout: '12.56 V',
    secondaryReadout: '20.04 V @ 2.14 A · 42.9 W',
    statusLabel: 'Rail ripple < 18 mV p-p',
    tracePrimary: 'M 0 36 H 64 V 78 H 102 V 36 H 196 V 78 H 222 V 36 H 316 V 78 H 352 V 36 H 460',
    traceSecondary: 'M 0 88 H 48 V 68 H 128 V 88 H 176 V 68 H 264 V 88 H 308 V 68 H 404 V 88 H 460',
    probeX: 316,
    probeY: 36,
  },
};

export const AuthView: React.FC<AuthViewProps> = ({
  onAuthenticated,
  theme,
  onToggleTheme,
  passwordRecoveryPending = false,
  onPasswordRecoveryComplete,
}) => {
  const [mode, setMode] = useState<'login' | 'register' | 'recover'>(
    passwordRecoveryPending ? 'recover' : 'login',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [scopeChannel, setScopeChannel] = useState<ScopeChannel>('thermal');
  const [telemetryOptIn, setTelemetryOptIn] = useState(true);
  const [externalAiConsent, setExternalAiConsent] = useState(true);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [recoverySent, setRecoverySent] = useState<string | null>(null);
  const [supabaseActive, setSupabaseActive] = useState(false);
  const [unconfirmedEmail, setUnconfirmedEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    getSupabaseClient()
      .then((sb) => setSupabaseActive(Boolean(sb)))
      .catch(() => setSupabaseActive(false));
  }, []);

  useEffect(() => {
    if (passwordRecoveryPending) setMode('recover');
  }, [passwordRecoveryPending]);

  const activeScope = SCOPE_CHANNELS[scopeChannel];
  const modeIndex = mode === 'login' ? 0 : mode === 'register' ? 1 : 2;

  const handleResendConfirmation = async () => {
    if (!unconfirmedEmail) return;
    setError(null);
    setLoading(true);
    try {
      const sb = await getSupabaseClient();
      if (sb) {
        const { error: resendErr } = await sb.auth.resend({
          type: 'signup',
          email: unconfirmedEmail,
        });
        if (resendErr) throw resendErr;
        setSuccessMsg(`Confirmation email resent to ${unconfirmedEmail}. Check your inbox (and spam folder).`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to resend confirmation email.');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setUnconfirmedEmail(null);
    setLoading(true);
    try {
      const sb = await getSupabaseClient();

      if (sb) {
        if (mode === 'login') {
          const { data, error: signInErr } = await sb.auth.signInWithPassword({
            email: email.trim(),
            password,
          });
          if (signInErr) {
            if (/email not confirmed/i.test(signInErr.message)) {
              setUnconfirmedEmail(email.trim());
            }
            throw signInErr;
          }
          if (!data.session?.access_token) {
            throw new Error('Sign-in did not return an active session. Please check your email confirmation.');
          }
          setAuthToken(data.session.access_token);
          onAuthenticated();
        } else if (mode === 'register') {
          const cleanName = (displayName || email.split('@')[0]).trim();
          const { data, error: signUpErr } = await sb.auth.signUp({
            email: email.trim(),
            password,
            options: {
              emailRedirectTo: window.location.origin,
              data: { display_name: cleanName },
            },
          });
          if (signUpErr) throw signUpErr;

          if (data.session?.access_token) {
            setAuthToken(data.session.access_token);
            await apiRequest('/api/v1/account/settings', {
              method: 'PATCH',
              body: { telemetryOptIn, externalAiConsent, displayName: cleanName },
            }).catch(() => {});
            onAuthenticated();
          } else {
            setUnconfirmedEmail(email.trim());
            setSuccessMsg(
              `Account created! Check ${email.trim()} and click the verification link to activate your workspace, then sign in.`,
            );
            setMode('login');
          }
        } else if (mode === 'recover') {
          if (passwordRecoveryPending) {
            const { error: updErr } = await sb.auth.updateUser({ password: newPassword });
            if (updErr) throw updErr;
            setSuccessMsg('Password updated. You can now sign in with your new password.');
            setNewPassword('');
            onPasswordRecoveryComplete?.();
            setMode('login');
          } else {
            const { error: resetErr } = await sb.auth.resetPasswordForEmail(email.trim(), {
              redirectTo: window.location.origin,
            });
            if (resetErr) throw resetErr;
            setSuccessMsg(
              `If an account matches ${email.trim()}, a password reset link has been sent to your inbox.`,
            );
          }
        }
        return;
      }

      // Local / Offline API Auth Fallback
      if (mode === 'login') {
        const res = await apiRequest<{ accessToken: string }>('/api/v1/auth/login', {
          method: 'POST',
          skipAuth: true,
          body: {
            email,
            password,
            platform: detectClientPlatform(),
            installId: getInstallId(),
          },
        });
        setAuthToken(res.accessToken);
        onAuthenticated();
      } else if (mode === 'register') {
        const res = await apiRequest<{ accessToken: string }>('/api/v1/auth/register', {
          method: 'POST',
          skipAuth: true,
          body: {
            email,
            password,
            displayName: displayName || email.split('@')[0],
            telemetryOptIn,
            externalAiConsent,
            platform: detectClientPlatform(),
            installId: getInstallId(),
          },
        });
        setAuthToken(res.accessToken);
        onAuthenticated();
      } else if (mode === 'recover') {
        if (!recoverySent) {
          const res = await apiRequest<{ message: string; devRecoveryCode?: string }>(
            '/api/v1/auth/recover/request',
            { method: 'POST', skipAuth: true, body: { email } },
          );
          setRecoverySent(res.devRecoveryCode || 'sent');
          setSuccessMsg(
            res.devRecoveryCode
              ? `${res.message} Local recovery code: ${res.devRecoveryCode}`
              : res.message,
          );
        } else {
          await apiRequest('/api/v1/auth/recover/confirm', {
            method: 'POST',
            skipAuth: true,
            body: { email, code: recoveryCode, newPassword },
          });
          setSuccessMsg('Password reset complete. Sign in with your new password.');
          setRecoverySent(null);
          setMode('login');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to complete sign-in. Check your credentials and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-12 bg-[var(--cs-chassis)] text-[var(--cs-ink)]">
      {/* Left 7 Columns: Precision Diagnostic Bench Showcase */}
      <section className="lg:col-span-7 cs-bench-grid flex flex-col justify-between p-7 sm:p-10 lg:p-12 border-b lg:border-b-0 lg:border-r border-[var(--cs-border)]">
        {/* Top Brand & Theme Switch */}
        <div className="flex items-center justify-between cs-animate-hero" style={{ animationDelay: '0ms' }}>
          <BrandLogo subtitle />
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to OLED black theme'}
            className="cs-btn-secondary flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer"
          >
            {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            <span>{theme === 'dark' ? 'Light mode' : 'OLED black'}</span>
          </button>
        </div>

        {/* Center Hero Headline + Interactive Live Oscilloscope Bench */}
        <div className="my-10 space-y-8 max-w-2xl">
          <div className="space-y-3 cs-animate-hero" style={{ animationDelay: '70ms' }}>
            <h1 className="cs-heading text-3xl sm:text-4xl lg:text-[42px] font-bold leading-[1.08] text-[var(--cs-ink)]">
              Find the real fault before opening the case.
            </h1>
            <p className="text-[15px] text-[var(--cs-ink-2)] leading-relaxed max-w-[56ch]">
              Investigate slow laptops, failing SSDs, Wi-Fi drops, thermal shutdowns, and board
              damage with real OS telemetry, indexed service manuals, and evidence-backed reasoning.
            </p>
          </div>

          {/* Interactive Instrument Oscilloscope Monitor (True OLED Black Viewport) */}
          <div
            className="rounded-xl bg-[#000000] border border-[#22262c] overflow-hidden cs-animate-hero"
            style={{ animationDelay: '140ms' }}
          >
            {/* Scope Header Strip */}
            <div className="px-4 py-2.5 border-b border-[#1b1e23] bg-[#060708] flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2.5">
                <span className="relative flex h-2 w-2">
                  <span className="cs-animate-probe-ring absolute inline-flex h-full w-full rounded-full bg-[#5EC6A8]" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-[#5EC6A8]" />
                </span>
                <span className="font-mono text-[11px] text-[#c2cac6]">{activeScope.channelLabel}</span>
              </div>
              <span className="font-mono text-[11px] text-[#9de2ce]">{activeScope.statusLabel}</span>
            </div>

            {/* Scope Waveform Canvas */}
            <div className="relative px-4 pt-4 pb-3 bg-[#000000]">
              <svg
                viewBox="0 0 460 112"
                className="w-full h-28 overflow-visible"
                role="img"
                aria-label={`Diagnostic waveform preview for ${activeScope.label}`}
              >
                {/* Calibrated horizontal & vertical graticule lines */}
                {[22, 44, 66, 88].map((y) => (
                  <line key={y} x1="0" y1={y} x2="460" y2={y} stroke="#16191d" strokeWidth="1" />
                ))}
                {[92, 184, 276, 368].map((x) => (
                  <line key={x} x1={x} y1="0" x2={x} y2="112" stroke="#16191d" strokeWidth="1" strokeDasharray="3 4" />
                ))}

                {/* Static persistence reference under-trace */}
                <path
                  d={activeScope.tracePrimary}
                  fill="none"
                  stroke="#7BA7F7"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity="0.22"
                />

                {/* Secondary reference rail */}
                <path
                  key={`sec-${scopeChannel}`}
                  d={activeScope.traceSecondary}
                  fill="none"
                  stroke="#5EC6A8"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity="0.78"
                  className="cs-animate-trace"
                />

                {/* Primary diagnostic channel trace */}
                <path
                  key={`pri-${scopeChannel}`}
                  d={activeScope.tracePrimary}
                  fill="none"
                  stroke="#7BA7F7"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="cs-animate-trace"
                />

                {/* Measurement crosshair marker */}
                <line
                  x1={activeScope.probeX}
                  y1="4"
                  x2={activeScope.probeX}
                  y2="108"
                  stroke="#363c45"
                  strokeWidth="1"
                  strokeDasharray="2 3"
                />
                <circle
                  cx={activeScope.probeX}
                  cy={activeScope.probeY}
                  r="4.5"
                  fill="#000000"
                  stroke="#b5cffd"
                  strokeWidth="2.2"
                />
              </svg>

              {/* Live Numeric Readout Strip */}
              <div className="mt-2 pt-2.5 border-t border-[#181b1f] flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-xl font-semibold text-[#e8ecea] cs-tabular">
                    {activeScope.primaryReadout}
                  </span>
                  <span className="font-mono text-xs text-[#8f9995] cs-tabular">
                    {activeScope.secondaryReadout}
                  </span>
                </div>
                <span className="text-[11px] text-[#707b77]">Interactive signal preview</span>
              </div>
            </div>

            {/* Tactile Scope Channel Selector */}
            <div className="grid grid-cols-3 border-t border-[#1b1e23] bg-[#060708]">
              {(['thermal', 'storage', 'power'] as ScopeChannel[]).map((channel) => {
                const selected = scopeChannel === channel;
                return (
                  <button
                    key={channel}
                    type="button"
                    onClick={() => setScopeChannel(channel)}
                    className={`px-3 py-2.5 text-left transition-colors cursor-pointer border-r last:border-r-0 border-[#1b1e23] ${
                      selected
                        ? 'bg-[#0b1424] text-[#e8ecea]'
                        : 'text-[#96a19c] hover:text-[#e8ecea] hover:bg-[#0e1013]'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-xs font-semibold">
                      <span
                        className={`h-1.5 w-1.5 rounded-full transition-colors ${
                          selected ? 'bg-[#7BA7F7]' : 'bg-[#3c434c]'
                        }`}
                      />
                      <span>{SCOPE_CHANNELS[channel].label}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Bottom Architectural Specification Row */}
        <div
          className="grid sm:grid-cols-3 gap-6 pt-6 border-t border-[var(--cs-border)] cs-animate-hero"
          style={{ animationDelay: '210ms' }}
        >
          <div className="space-y-1">
            <div className="text-xs font-semibold text-[var(--cs-ink)]">Read-only local tools</div>
            <p className="text-xs text-[var(--cs-ink-muted)] leading-relaxed">
              Validated diagnostic collectors only. State changes require explicit confirmation.
            </p>
          </div>
          <div className="space-y-1">
            <div className="text-xs font-semibold text-[var(--cs-ink)]">Isolated personal data</div>
            <p className="text-xs text-[var(--cs-ink-muted)] leading-relaxed">
              Chats, board photos, and uploaded manuals remain strictly inside your workspace.
            </p>
          </div>
          <div className="space-y-1">
            <div className="text-xs font-semibold text-[var(--cs-ink)]">Desktop and mobile sync</div>
            <p className="text-xs text-[var(--cs-ink-muted)] leading-relaxed">
              Continue investigations between your workbench PC and CoreSense Mobile.
            </p>
          </div>
        </div>
      </section>

      {/* Right 5 Columns: Workspace Authentication Panel */}
      <section className="lg:col-span-5 bg-[var(--cs-surface)] flex flex-col justify-center p-7 sm:p-10 lg:p-14">
        <div className="w-full max-w-md mx-auto space-y-7 cs-animate-hero" style={{ animationDelay: '180ms' }}>
          <div className="space-y-1.5">
            <h2 className="cs-heading text-2xl font-bold text-[var(--cs-ink)]">
              {mode === 'login'
                ? 'Open your workspace'
                : mode === 'register'
                  ? 'Create a personal workspace'
                  : 'Recover your account'}
            </h2>
            <p className="text-sm text-[var(--cs-ink-muted)]">
              {mode === 'login'
                ? 'Sign in to access your devices, telemetry snapshots, and repair cases.'
                : mode === 'register'
                  ? 'Create a free personal workspace with full diagnostics, manuals, and cross-device sync.'
                  : passwordRecoveryPending
                    ? 'Choose a new password for your CoreSense account.'
                    : supabaseActive
                      ? 'Enter your email address to receive a password reset link.'
                      : 'Request a 6-digit recovery code for your registered email address.'}
            </p>
          </div>

          {/* Sliding Segmented Mode Control */}
          <div className="relative grid grid-cols-3 p-1 rounded-lg bg-[var(--cs-well)] border border-[var(--cs-border)]">
            <div
              aria-hidden="true"
              className="absolute top-1 bottom-1 left-1 w-[calc(33.333%-2.67px)] rounded-md bg-[var(--cs-surface)] border border-[var(--cs-border)] transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
              style={{ transform: `translateX(${modeIndex * 100}%)` }}
            />
            {[
              { id: 'login', label: 'Sign in' },
              { id: 'register', label: 'Create account' },
              { id: 'recover', label: 'Recover' },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setMode(tab.id as 'login' | 'register' | 'recover');
                  setError(null);
                  setSuccessMsg(null);
                }}
                className={`relative z-10 py-2 text-xs font-semibold transition-colors cursor-pointer ${
                  mode === tab.id ? 'text-[var(--cs-ink)]' : 'text-[var(--cs-ink-muted)] hover:text-[var(--cs-ink)]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'register' && (
              <div>
                <label className="block text-xs font-medium text-[var(--cs-ink-2)] mb-1.5">
                  Display name
                </label>
                <input
                  type="text"
                  required
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Alex Rivera"
                  className="cs-input w-full px-3.5 py-2.5 text-sm"
                />
              </div>
            )}

            {!(mode === 'recover' && passwordRecoveryPending) && (
              <div>
                <label className="block text-xs font-medium text-[var(--cs-ink-2)] mb-1.5">
                  Email address
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="cs-input w-full px-3.5 py-2.5 text-sm"
                />
              </div>
            )}

            {mode !== 'recover' && (
              <div>
                <label className="block text-xs font-medium text-[var(--cs-ink-2)] mb-1.5">
                  Password
                </label>
                <input
                  type="password"
                  required
                  minLength={mode === 'register' ? 8 : 1}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === 'register' ? 'At least 8 characters' : 'Enter your password'}
                  className="cs-input w-full px-3.5 py-2.5 text-sm"
                />
              </div>
            )}

            {mode === 'recover' && (passwordRecoveryPending || recoverySent) && (
              <div className="space-y-4 cs-animate-view">
                {!passwordRecoveryPending && (
                  <div>
                    <label className="block text-xs font-medium text-[var(--cs-ink-2)] mb-1.5">
                      6-digit recovery code
                    </label>
                    <input
                      type="text"
                      required
                      value={recoveryCode}
                      onChange={(e) => setRecoveryCode(e.target.value)}
                      placeholder="123456"
                      className="cs-input w-full px-3.5 py-2.5 text-sm font-mono cs-tabular"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-[var(--cs-ink-2)] mb-1.5">
                    New password
                  </label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    className="cs-input w-full px-3.5 py-2.5 text-sm"
                  />
                </div>
              </div>
            )}

            {mode === 'register' && (
              <div className="space-y-4 pt-1 cs-animate-view">
                <div className="space-y-2.5 rounded-lg bg-[var(--cs-canvas)] border border-[var(--cs-border)] p-3.5 text-xs text-[var(--cs-ink-2)]">
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={externalAiConsent}
                      onChange={(e) => setExternalAiConsent(e.target.checked)}
                      className="mt-0.5 accent-[var(--cs-accent)]"
                    />
                    <span>
                      Allow cloud AI diagnostic requests when keys are configured. Leave unchecked to stay on the local diagnostic engine.
                    </span>
                  </label>
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={telemetryOptIn}
                      onChange={(e) => setTelemetryOptIn(e.target.checked)}
                      className="mt-0.5 accent-[var(--cs-accent)]"
                    />
                    <span>
                      Share anonymous feature and crash counts. Never includes chats, photos, manuals, or personal device details.
                    </span>
                  </label>
                </div>
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-[var(--cs-danger-border)] bg-[var(--cs-danger-soft)] px-3.5 py-2.5 text-xs text-[var(--cs-danger-ink)] space-y-2 cs-animate-view">
                <div>{error}</div>
                {unconfirmedEmail && (
                  <button
                    type="button"
                    onClick={handleResendConfirmation}
                    className="underline font-semibold cursor-pointer"
                  >
                    Resend confirmation email
                  </button>
                )}
              </div>
            )}

            {successMsg && (
              <div className="rounded-lg border border-[var(--cs-ok-border)] bg-[var(--cs-ok-soft)] px-3.5 py-2.5 text-xs text-[var(--cs-ok-ink)] space-y-2 cs-animate-view">
                <div>{successMsg}</div>
                {unconfirmedEmail && (
                  <button
                    type="button"
                    onClick={handleResendConfirmation}
                    className="underline font-semibold cursor-pointer"
                  >
                    Didn't receive it? Resend confirmation email
                  </button>
                )}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="cs-btn-primary w-full flex items-center justify-center gap-2 py-2.5 px-4 text-sm disabled:opacity-50 cursor-pointer"
            >
              {mode === 'recover' && <KeyRound className="h-4 w-4" />}
              <span>
                {loading
                  ? 'Working...'
                  : mode === 'login'
                    ? 'Sign in'
                    : mode === 'register'
                      ? 'Create workspace'
                      : passwordRecoveryPending || recoverySent
                        ? 'Update password'
                        : supabaseActive
                          ? 'Send reset link'
                          : 'Send recovery code'}
              </span>
            </button>
          </form>

          <div className="pt-4 border-t border-[var(--cs-border)] flex items-start gap-2.5 text-xs text-[var(--cs-ink-muted)]">
            <ShieldCheck className="h-4 w-4 text-[var(--cs-ok)] shrink-0 mt-0.5" />
            <span>
              Your diagnostic records, board photos, and uploaded manuals stay isolated inside your private database.
            </span>
          </div>
        </div>
      </section>
    </div>
  );
};
