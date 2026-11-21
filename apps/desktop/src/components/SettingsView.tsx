import React, { useEffect, useState } from 'react';
import {
  Cloud,
  CreditCard,
  Download,
  KeyRound,
  MessageSquarePlus,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import type { ExpertiseMode, PlanConfig } from '@coresense/shared';
import { apiRequest, detectClientPlatform, getSyncSeq, setAuthToken, setSyncSeq } from '../api';

export interface AccountSnapshot {
  user: {
    id: string;
    email: string;
    displayName: string;
    expertiseMode: ExpertiseMode;
    telemetryOptIn: boolean;
    geoOptIn: boolean;
    cloudSyncEnabled: boolean;
    externalAiConsent: boolean;
    planTier: 'free' | 'pro' | 'premium';
    billingCycle: 'monthly' | 'annual';
    byokConfigured: boolean;
    byokProvider?: string | null;
    byokModel?: string | null;
  };
  plan: PlanConfig;
  usage: {
    periodYm: string;
    aiMessages: number;
    imageAnalyses: number;
    voiceInteractions: number;
    devices: number;
    documents: number;
    investigations: number;
    cases: number;
  };
  aiRuntime: {
    activeMode: string;
    externalDataTransmissionEnabled: boolean;
  };
}

const QuotaMeter: React.FC<{ label: string; used: number; limit: number }> = ({ label, used, limit }) => {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-[var(--cs-ink-2)]">{label}</span>
        <span className="font-mono text-[11px] text-[var(--cs-ink)] cs-tabular">
          {used} / {limit}
        </span>
      </div>
      <div className="h-1.5 w-full rounded-sm bg-[var(--cs-well)] overflow-hidden">
        <div
          className="h-full cs-meter-fill"
          style={{
            width: `${pct}%`,
            backgroundColor: pct >= 90 ? 'var(--cs-danger)' : pct >= 75 ? 'var(--cs-warn)' : 'var(--cs-accent)',
          }}
        />
      </div>
    </div>
  );
};

export const SettingsView: React.FC<{
  account: AccountSnapshot;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onRefreshAccount: () => Promise<void>;
  onLoggedOut: () => void;
}> = ({ account, theme, onToggleTheme, onRefreshAccount, onLoggedOut }) => {
  const [plans, setPlans] = useState<PlanConfig[]>([]);
  const [byokProvider, setByokProvider] = useState<'gemini' | 'openai' | 'ollama'>('gemini');
  const [byokKey, setByokKey] = useState('');
  const [byokModel, setByokModel] = useState('gemini-4-hydrogen');
  const [byokBaseUrl, setByokBaseUrl] = useState('');
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [fbCategory, setFbCategory] = useState<'feedback' | 'bug_report' | 'feature_request'>('feedback');
  const [fbRating, setFbRating] = useState(5);
  const [fbTitle, setFbTitle] = useState('');
  const [fbMsg, setFbMsg] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    apiRequest<{ plans: PlanConfig[] }>('/api/v1/billing/plans', { skipAuth: true })
      .then((res) => setPlans(res.plans))
      .catch(() => {});
  }, []);

  const updateSettings = async (patch: Record<string, unknown>, message?: string) => {
    await apiRequest('/api/v1/account/settings', { method: 'PATCH', body: patch });
    await onRefreshAccount();
    if (message) setNotice(message);
  };

  const handleSaveByok = async (e: React.FormEvent) => {
    e.preventDefault();
    await updateSettings(
      {
        byok: {
          provider: byokProvider,
          apiKey: byokKey,
          model: byokModel || undefined,
          baseUrl: byokBaseUrl || undefined,
        },
      },
      'AI provider key encrypted with AES-256-GCM and stored in your personal account.',
    );
    setByokKey('');
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      const seq = getSyncSeq();
      const res = await apiRequest<{ latestSeq: number; changes: unknown[] }>(
        `/api/v1/sync/pull?sinceSeq=${seq}`,
      );
      setSyncSeq(res.latestSeq);
      setSyncStatus(`Synced at cursor #${res.latestSeq} (${res.changes.length} delta change(s) pulled).`);
      await onRefreshAccount();
    } catch (err) {
      setSyncStatus(err instanceof Error ? err.message : 'Sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  const handleSelectPlan = async (tier: 'free' | 'pro' | 'premium') => {
    const res = await apiRequest<{ note: string }>('/api/v1/billing/subscribe', {
      method: 'POST',
      body: { planTier: tier, billingCycle: 'monthly', provider: 'sandbox' },
    });
    await onRefreshAccount();
    setNotice(res.note);
  };

  const handleExportAll = async () => {
    const data = await apiRequest<Record<string, unknown>>('/api/v1/account/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `coresense-personal-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setNotice('Complete personal workspace export downloaded.');
  };

  const handleSubmitFeedback = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiRequest('/api/v1/feedback', {
      method: 'POST',
      body: {
        category: fbCategory,
        rating: fbRating,
        title: fbTitle,
        message: fbMsg,
        platform: detectClientPlatform(),
      },
    });
    setFbTitle('');
    setFbMsg('');
    setNotice('Voluntary feedback submitted without sharing private workspace records.');
  };

  const handleDeleteAccount = async () => {
    if (!window.confirm('Permanently delete your CoreSense account and all devices, investigations, photos, and manuals? This cannot be undone.')) {
      return;
    }
    await apiRequest('/api/v1/account', { method: 'DELETE' });
    setAuthToken(null);
    onLoggedOut();
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="pb-4 border-b border-[var(--cs-border)] space-y-1">
        <h1 className="cs-heading text-2xl font-bold text-[var(--cs-ink)]">Account, sync & preferences</h1>
        <p className="text-xs text-[var(--cs-ink-muted)]">
          Manage explanation depth, appearance, encrypted AI provider keys, subscription limits, and data export.
        </p>
      </div>

      {notice && (
        <div className="rounded-lg border border-[var(--cs-ok-border)] bg-[var(--cs-ok-soft)] px-4 py-2.5 text-xs text-[var(--cs-ok-ink)] flex items-center justify-between gap-2 cs-animate-view">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="cursor-pointer">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Profile + Sync & Privacy */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="cs-panel p-5 space-y-4">
          <h2 className="cs-heading text-base font-bold text-[var(--cs-ink)]">Profile & interface</h2>
          <div className="text-xs text-[var(--cs-ink-muted)]">
            Signed in as <strong className="text-[var(--cs-ink)]">{account.user.displayName}</strong> ({account.user.email})
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--cs-ink-2)] mb-2">
              Technical explanation depth
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(['everyday', 'enthusiast', 'technician'] as ExpertiseMode[]).map((mode) => {
                const active = account.user.expertiseMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => updateSettings({ expertiseMode: mode }, `Switched to ${mode} explanation depth.`)}
                    className={`py-2 rounded-lg border text-xs font-semibold capitalize transition-colors cursor-pointer ${
                      active
                        ? 'border-[var(--cs-accent)] bg-[var(--cs-accent-soft)] text-[var(--cs-accent-ink)]'
                        : 'border-[var(--cs-border)] bg-[var(--cs-canvas)] text-[var(--cs-ink-muted)] hover:text-[var(--cs-ink)]'
                    }`}
                  >
                    {mode}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between pt-3 border-t border-[var(--cs-border)]">
            <div>
              <div className="text-xs font-medium text-[var(--cs-ink)]">Bench theme</div>
              <div className="text-[11px] text-[var(--cs-ink-muted)]">
                {theme === 'dark' ? 'Lab graphite dark' : 'Machined aluminum light'}
              </div>
            </div>
            <button
              type="button"
              onClick={onToggleTheme}
              className="cs-btn-secondary flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer"
            >
              {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
              <span>{theme === 'dark' ? 'Switch to light' : 'Switch to dark'}</span>
            </button>
          </div>
        </div>

        <div className="cs-panel p-5 space-y-3.5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="cs-heading text-base font-bold text-[var(--cs-ink)] flex items-center gap-2">
              <Cloud className="h-4 w-4 text-[var(--cs-accent)]" />
              <span>Cross-device sync & privacy</span>
            </h2>
            <button
              type="button"
              disabled={syncing}
              onClick={handleSyncNow}
              className="cs-btn-secondary flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
              <span>{syncing ? 'Syncing...' : 'Sync now'}</span>
            </button>
          </div>

          {syncStatus && (
            <div className="rounded-md bg-[var(--cs-ok-soft)] border border-[var(--cs-ok-border)] px-3 py-2 text-xs font-mono text-[var(--cs-ok-ink)] cs-animate-view">
              {syncStatus}
            </div>
          )}

          <div className="space-y-3 pt-1">
            <label className="flex items-start gap-2.5 text-xs text-[var(--cs-ink-2)] cursor-pointer">
              <input
                type="checkbox"
                checked={account.user.cloudSyncEnabled}
                onChange={(e) => updateSettings({ cloudSyncEnabled: e.target.checked })}
                className="mt-0.5 accent-[var(--cs-accent)]"
              />
              <span>Sync personal devices, investigations, cases, and manuals between desktop and mobile</span>
            </label>
            <label className="flex items-start gap-2.5 text-xs text-[var(--cs-ink-2)] cursor-pointer">
              <input
                type="checkbox"
                checked={account.user.externalAiConsent}
                onChange={(e) => updateSettings({ externalAiConsent: e.target.checked })}
                className="mt-0.5 accent-[var(--cs-accent)]"
              />
              <span>
                Allow sending diagnostic context to configured cloud AI providers. Active engine:{' '}
                <strong className="text-[var(--cs-ink)]">{account.aiRuntime.activeMode}</strong>
              </span>
            </label>
            <label className="flex items-start gap-2.5 text-xs text-[var(--cs-ink-2)] cursor-pointer">
              <input
                type="checkbox"
                checked={account.user.telemetryOptIn}
                onChange={(e) => updateSettings({ telemetryOptIn: e.target.checked })}
                className="mt-0.5 accent-[var(--cs-accent)]"
              />
              <span>Share anonymous aggregate feature and crash reliability counts (zero personal repair data)</span>
            </label>
          </div>
        </div>
      </div>

      {/* BYOK AI Provider */}
      <div className="cs-panel p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <h2 className="cs-heading text-base font-bold text-[var(--cs-ink)] flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-[var(--cs-accent)]" />
              <span>AI model provider (BYOK)</span>
            </h2>
            <p className="text-xs text-[var(--cs-ink-muted)]">
              Active runtime:{' '}
              <span className="font-mono text-[var(--cs-ink)]">{account.aiRuntime.activeMode}</span>. Keys
              are encrypted at rest with AES-256-GCM.
            </p>
          </div>
          {account.user.byokConfigured && (
            <button
              type="button"
              onClick={() => updateSettings({ byok: null }, 'Removed custom AI provider key.')}
              className="text-xs font-medium text-[var(--cs-danger)] hover:underline cursor-pointer"
            >
              Remove custom key
            </button>
          )}
        </div>

        <form onSubmit={handleSaveByok} className="grid grid-cols-1 md:grid-cols-4 gap-2.5">
          <select
            value={byokProvider}
            onChange={(e) => {
              const p = e.target.value as 'gemini' | 'openai' | 'ollama';
              setByokProvider(p);
              setByokModel(p === 'gemini' ? 'gemini-4-hydrogen' : p === 'openai' ? 'gpt-4o-mini' : 'llama3.2');
            }}
            className="cs-input px-3 py-2 text-xs"
          >
            <option value="gemini">Google Gemini (Interactions API)</option>
            <option value="openai">OpenAI compatible</option>
            <option value="ollama">Local Ollama server</option>
          </select>
          <input
            type="password"
            required={byokProvider !== 'ollama'}
            value={byokKey}
            onChange={(e) => setByokKey(e.target.value)}
            placeholder={byokProvider === 'ollama' ? 'Optional token' : 'Paste API key'}
            className="cs-input px-3 py-2 text-xs"
          />
          <input
            value={byokModel}
            onChange={(e) => setByokModel(e.target.value)}
            placeholder="Model ID"
            className="cs-input px-3 py-2 text-xs font-mono"
          />
          <button type="submit" className="cs-btn-primary text-xs py-2 cursor-pointer">
            Save encrypted key
          </button>
          {byokProvider !== 'gemini' && (
            <input
              value={byokBaseUrl}
              onChange={(e) => setByokBaseUrl(e.target.value)}
              placeholder="Base URL (e.g. http://127.0.0.1:11434/v1)"
              className="md:col-span-4 cs-input px-3 py-2 text-xs font-mono"
            />
          )}
        </form>
      </div>

      {/* Subscription & Quotas */}
      <div className="cs-panel p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="cs-heading text-base font-bold text-[var(--cs-ink)] flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-[var(--cs-ok)]" />
              <span>Subscription & monthly usage ({account.usage.periodYm})</span>
            </h2>
          </div>
          <span className="rounded-md bg-[var(--cs-ok-soft)] border border-[var(--cs-ok-border)] px-3 py-1 text-xs font-semibold text-[var(--cs-ok-ink)]">
            Active plan: {account.plan.displayName}
          </span>
        </div>

        {/* Visual Quota Meters */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pb-2">
          <QuotaMeter
            label="AI messages"
            used={account.usage.aiMessages}
            limit={account.plan.limits.aiMessagesPerMonth}
          />
          <QuotaMeter
            label="Vision inspections"
            used={account.usage.imageAnalyses}
            limit={account.plan.limits.imageAnalysesPerMonth}
          />
          <QuotaMeter
            label="Tracked devices"
            used={account.usage.devices}
            limit={account.plan.limits.maxDevices}
          />
          <QuotaMeter
            label="Indexed manuals"
            used={account.usage.documents}
            limit={account.plan.limits.documentUploadsMax}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
          {plans.map((p) => {
            const current = p.tier === account.user.planTier;
            return (
              <div
                key={p.tier}
                className={`rounded-lg p-4 border flex flex-col justify-between gap-4 ${
                  current
                    ? 'border-[var(--cs-accent)] bg-[var(--cs-accent-soft)]'
                    : 'border-[var(--cs-border)] bg-[var(--cs-canvas)]'
                }`}
              >
                <div className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <span className="cs-heading text-sm font-bold text-[var(--cs-ink)]">{p.displayName}</span>
                    <span className="font-mono text-sm font-bold text-[var(--cs-ink)] cs-tabular">
                      ${(p.monthlyPriceCents / 100).toFixed(2)}/mo
                    </span>
                  </div>
                  <p className="text-xs text-[var(--cs-ink-muted)] leading-relaxed">{p.description}</p>
                  <ul className="text-xs text-[var(--cs-ink-2)] space-y-1 pt-1 font-mono cs-tabular">
                    <li>{p.limits.aiMessagesPerMonth.toLocaleString()} AI turns / mo</li>
                    <li>{p.limits.imageAnalysesPerMonth} vision checks / mo</li>
                    <li>{p.limits.documentUploadsMax} indexed manuals</li>
                    <li>{p.limits.maxDevices} synced devices</li>
                  </ul>
                </div>
                <button
                  type="button"
                  disabled={current}
                  onClick={() => handleSelectPlan(p.tier)}
                  className={`w-full py-2 rounded-lg text-xs font-semibold ${
                    current
                      ? 'bg-[var(--cs-well)] text-[var(--cs-ink-muted)] cursor-default'
                      : 'cs-btn-primary cursor-pointer'
                  }`}
                >
                  {current ? 'Current plan' : `Switch to ${p.displayName}`}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Feedback + Data Ownership */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <form onSubmit={handleSubmitFeedback} className="cs-panel p-5 space-y-3">
          <h2 className="cs-heading text-base font-bold text-[var(--cs-ink)] flex items-center gap-2">
            <MessageSquarePlus className="h-4 w-4 text-[var(--cs-accent)]" />
            <span>Send feedback or report a bug</span>
          </h2>
          <div className="flex gap-2">
            <select
              value={fbCategory}
              onChange={(e) => setFbCategory(e.target.value as typeof fbCategory)}
              className="cs-input flex-1 px-3 py-2 text-xs"
            >
              <option value="feedback">General feedback</option>
              <option value="bug_report">Bug report</option>
              <option value="feature_request">Feature request</option>
            </select>
            <select
              value={fbRating}
              onChange={(e) => setFbRating(Number(e.target.value))}
              className="cs-input w-28 px-3 py-2 text-xs"
            >
              {[5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>
                  {n} / 5 stars
                </option>
              ))}
            </select>
          </div>
          <input
            required
            value={fbTitle}
            onChange={(e) => setFbTitle(e.target.value)}
            placeholder="Short summary"
            className="cs-input w-full px-3 py-2 text-xs"
          />
          <textarea
            required
            rows={2}
            value={fbMsg}
            onChange={(e) => setFbMsg(e.target.value)}
            placeholder="Describe what happened or what you'd like improved..."
            className="cs-input w-full px-3 py-2 text-xs"
          />
          <button type="submit" className="cs-btn-secondary px-4 py-2 text-xs font-semibold cursor-pointer">
            Send feedback
          </button>
        </form>

        <div className="cs-panel p-5 flex flex-col justify-between gap-4">
          <div className="space-y-2">
            <h2 className="cs-heading text-base font-bold text-[var(--cs-ink)] flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-[var(--cs-ok)]" />
              <span>Data export & account deletion</span>
            </h2>
            <p className="text-xs text-[var(--cs-ink-2)] leading-relaxed">
              Export every device, investigation, telemetry snapshot, indexed manual record, and
              repair case as open JSON at any time, or permanently erase your workspace.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleExportAll}
              className="cs-btn-secondary flex items-center gap-1.5 px-4 py-2 text-xs font-semibold cursor-pointer"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export workspace JSON</span>
            </button>
            <button
              type="button"
              onClick={handleDeleteAccount}
              className="flex items-center gap-1.5 rounded-lg border border-[var(--cs-danger-border)] bg-[var(--cs-danger-soft)] hover:opacity-90 px-4 py-2 text-xs font-semibold text-[var(--cs-danger-ink)] cursor-pointer"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Delete account</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
