import React, { useState } from 'react';
import { KeyRound, Moon, ShieldCheck, Sun } from 'lucide-react';
import type { ExpertiseMode } from '@coresense/shared';
import { apiRequest, detectClientPlatform, getInstallId, setAuthToken } from '../api';
import { BrandLogo } from './BrandLogo';

interface AuthViewProps {
  onAuthenticated: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

const SCOPE_PROFILES: Record<
  ExpertiseMode,
  {
    label: string;
    shortDesc: string;
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
  everyday: {
    label: 'Everyday owner',
    shortDesc: 'Plain-language findings and safe guided checks.',
    channelLabel: 'CH1 Thermal stability',
    primaryReadout: '64.2 °C',
    secondaryReadout: 'Fan nominal · 2,410 RPM',
    statusLabel: 'Within safe thermal window',
    tracePrimary: 'M 0 68 C 40 66, 65 54, 105 56 C 145 58, 175 44, 220 48 C 265 52, 300 40, 350 44 C 390 47, 420 43, 460 45',
    traceSecondary: 'M 0 88 C 55 86, 110 84, 180 82 C 250 80, 320 78, 460 76',
    probeX: 350,
    probeY: 44,
  },
  enthusiast: {
    label: 'Repair enthusiast',
    shortDesc: 'Live OS telemetry, SMART health, and manual lookup.',
    channelLabel: 'CH1+2 NVMe I/O & CPU load',
    primaryReadout: '14% wear',
    secondaryReadout: '0 media errors · 38% load',
    statusLabel: 'SMART baseline verified',
    tracePrimary: 'M 0 74 L 38 74 L 52 38 L 70 64 L 112 64 L 128 28 L 146 58 L 210 58 L 226 36 L 244 62 L 310 62 L 328 24 L 348 56 L 410 56 L 428 42 L 460 42',
    traceSecondary: 'M 0 92 L 70 92 L 88 80 L 164 80 L 182 88 L 280 88 L 296 74 L 378 74 L 396 86 L 460 86',
    probeX: 328,
    probeY: 24,
  },
  technician: {
    label: 'Technician',
    shortDesc: 'Power rails, error codes, schematics, and bench logs.',
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

export const AuthView: React.FC<AuthViewProps> = ({ onAuthenticated, theme, onToggleTheme }) => {
  const [mode, setMode] = useState<'login' | 'register' | 'recover'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [expertiseMode, setExpertiseMode] = useState<ExpertiseMode>('everyday');
  const [telemetryOptIn, setTelemetryOptIn] = useState(true);
  const [externalAiConsent, setExternalAiConsent] = useState(true);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [recoverySent, setRecoverySent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const activeScope = SCOPE_PROFILES[expertiseMode];
  const modeIndex = mode === 'login' ? 0 : mode === 'register' ? 1 : 2;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setLoading(true);
    try {
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
            expertiseMode,
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
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            className="cs-btn-secondary flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer"
          >
            {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            <span>{theme === 'dark' ? 'Light chassis' : 'Dark graphite'}</span>
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

          {/* Interactive Instrument Oscilloscope Monitor */}
          <div
            className="rounded-xl bg-[#111824] border border-[#2a3444] overflow-hidden cs-animate-hero"
            style={{ animationDelay: '140ms' }}
          >
            {/* Scope Header Strip */}
            <div className="px-4 py-2.5 border-b border-[#232d3d] flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2.5">
                <span className="relative flex h-2 w-2">
                  <span className="cs-animate-probe-ring absolute inline-flex h-full w-full rounded-full bg-[#14B8A6]" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-[#14B8A6]" />
                </span>
                <span className="font-mono text-[11px] text-[#cbd5e1]">{activeScope.channelLabel}</span>
              </div>
              <span className="font-mono text-[11px] text-[#5eead4]">{activeScope.statusLabel}</span>
            </div>

            {/* Scope Waveform Canvas */}
            <div className="relative px-4 pt-4 pb-3 bg-[#0d131d]">
              <svg
                viewBox="0 0 460 112"
                className="w-full h-28 overflow-visible"
                role="img"
                aria-label={`Diagnostic waveform preview for ${activeScope.label}`}
              >
                {/* Calibrated horizontal & vertical graticule lines */}
                {[22, 44, 66, 88].map((y) => (
                  <line key={y} x1="0" y1={y} x2="460" y2={y} stroke="#1e293b" strokeWidth="1" />
                ))}
                {[92, 184, 276, 368].map((x) => (
                  <line key={x} x1={x} y1="0" x2={x} y2="112" stroke="#1e293b" strokeWidth="1" strokeDasharray="3 4" />
                ))}

                {/* Static persistence reference under-trace */}
                <path
                  d={activeScope.tracePrimary}
                  fill="none"
                  stroke="#3B82F6"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity="0.22"
                />

                {/* Secondary reference rail */}
                <path
                  key={`sec-${expertiseMode}`}
                  d={activeScope.traceSecondary}
                  fill="none"
                  stroke="#14B8A6"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity="0.75"
                  className="cs-animate-trace"
                />

                {/* Primary diagnostic channel trace */}
                <path
                  key={`pri-${expertiseMode}`}
                  d={activeScope.tracePrimary}
                  fill="none"
                  stroke="#3B82F6"
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
                  stroke="#475569"
                  strokeWidth="1"
                  strokeDasharray="2 3"
                />
                <circle
                  cx={activeScope.probeX}
                  cy={activeScope.probeY}
                  r="4.5"
                  fill="#0d131d"
                  stroke="#93c5fd"
                  strokeWidth="2.2"
                />
              </svg>

              {/* Live Numeric Readout Strip */}
              <div className="mt-2 pt-2.5 border-t border-[#1e2736] flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-xl font-semibold text-[#f8fafc] cs-tabular">
                    {activeScope.primaryReadout}
                  </span>
                  <span className="font-mono text-xs text-[#94a3b8] cs-tabular">
                    {activeScope.secondaryReadout}
                  </span>
                </div>
                <span className="text-[11px] text-[#94a3b8]">Interactive depth preview</span>
              </div>
            </div>

            {/* Tactile Scope Mode Selector */}
            <div className="grid grid-cols-3 border-t border-[#232d3d] bg-[#141c29]">
              {(['everyday', 'enthusiast', 'technician'] as ExpertiseMode[]).map((depth) => {
                const selected = expertiseMode === depth;
                return (
                  <button
                    key={depth}
                    type="button"
                    onClick={() => setExpertiseMode(depth)}
                    className={`px-3 py-2.5 text-left transition-colors cursor-pointer border-r last:border-r-0 border-[#232d3d] ${
                      selected
                        ? 'bg-[#1b2942] text-[#f8fafc]'
                        : 'text-[#8b9bb0] hover:text-[#e2e8f0] hover:bg-[#192232]'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-xs font-semibold">
                      <span
                        className={`h-1.5 w-1.5 rounded-full transition-colors ${
                          selected ? 'bg-[#3B82F6]' : 'bg-[#475569]'
                        }`}
                      />
                      <span>{SCOPE_PROFILES[depth].label}</span>
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
                  ? 'Set your technical depth and privacy preferences below. You can change them anytime.'
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

            {mode === 'recover' && recoverySent && (
              <div className="space-y-4 cs-animate-view">
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
                <div>
                  <label className="block text-xs font-medium text-[var(--cs-ink-2)] mb-2">
                    Technical explanation depth
                  </label>
                  <div className="grid grid-cols-1 gap-2">
                    {(['everyday', 'enthusiast', 'technician'] as ExpertiseMode[]).map((depth) => {
                      const active = expertiseMode === depth;
                      const profile = SCOPE_PROFILES[depth];
                      return (
                        <button
                          key={depth}
                          type="button"
                          onClick={() => setExpertiseMode(depth)}
                          className={`text-left px-3.5 py-2.5 rounded-lg border transition-colors cursor-pointer flex items-center justify-between gap-3 ${
                            active
                              ? 'border-[var(--cs-accent)] bg-[var(--cs-accent-soft)]'
                              : 'border-[var(--cs-border)] bg-[var(--cs-canvas)] hover:border-[var(--cs-border-strong)]'
                          }`}
                        >
                          <div>
                            <div className="text-xs font-semibold text-[var(--cs-ink)]">{profile.label}</div>
                            <div className="text-[11px] text-[var(--cs-ink-muted)] mt-0.5">{profile.shortDesc}</div>
                          </div>
                          <span
                            className={`h-4 w-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
                              active ? 'border-[var(--cs-accent)]' : 'border-[var(--cs-border-strong)]'
                            }`}
                          >
                            {active && <span className="h-2 w-2 rounded-full bg-[var(--cs-accent)]" />}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

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
              <div className="rounded-lg border border-[var(--cs-danger-border)] bg-[var(--cs-danger-soft)] px-3.5 py-2.5 text-xs text-[var(--cs-danger-ink)] cs-animate-view">
                {error}
              </div>
            )}

            {successMsg && (
              <div className="rounded-lg border border-[var(--cs-ok-border)] bg-[var(--cs-ok-soft)] px-3.5 py-2.5 text-xs text-[var(--cs-ok-ink)] cs-animate-view">
                {successMsg}
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
                      : recoverySent
                        ? 'Reset password'
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
