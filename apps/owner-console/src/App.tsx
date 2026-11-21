import React, { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Cpu,
  Download,
  Lock,
  LogOut,
  Menu,
  MessageSquare,
  Moon,
  RefreshCw,
  ServerCrash,
  Settings,
  ShieldCheck,
  Sun,
  Users,
  X,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getOwnerToken, ownerApi, setOwnerToken } from './ownerApi';

type SectionId =
  | 'overview'
  | 'downloads'
  | 'users'
  | 'engagement'
  | 'ai'
  | 'reliability'
  | 'feedback'
  | 'config';

const OC_THEME_KEY = 'coresense_owner_theme';
const RANGES = ['24h', '7d', '30d', '90d', 'all'] as const;

export const App: React.FC = () => {
  const [authed, setAuthed] = useState(Boolean(getOwnerToken()));
  const [email, setEmail] = useState('owner@coresense.app');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [mfaPrompt, setMfaPrompt] = useState(false);
  const [loginErr, setLoginErr] = useState<string | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    localStorage.getItem(OC_THEME_KEY) === 'light' ? 'light' : 'dark',
  );

  const [section, setSection] = useState<SectionId>('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [range, setRange] = useState<'24h' | '7d' | '30d' | '90d' | 'all'>('30d');
  const [loading, setLoading] = useState(false);

  const [ownerInfo, setOwnerInfo] = useState<{ email: string; displayName: string; totpEnabled: boolean } | null>(null);
  const [overview, setOverview] = useState<any>(null);
  const [downloads, setDownloads] = useState<any>(null);
  const [users, setUsers] = useState<any>(null);
  const [engagement, setEngagement] = useState<any>(null);
  const [aiCosts, setAiCosts] = useState<any>(null);
  const [reliability, setReliability] = useState<any>(null);
  const [feedback, setFeedback] = useState<any>(null);
  const [configData, setConfigData] = useState<{
    alerts: Array<{ id: string; metric_key: string; label: string; threshold_value: number; unit: string; enabled: number }>;
    productConfig: Record<string, unknown>;
  } | null>(null);

  const [mfaSecret, setMfaSecret] = useState<string | null>(null);
  const [mfaVerifyInput, setMfaVerifyInput] = useState('');
  const [configNotice, setConfigNotice] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const toggleTheme = () => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem(OC_THEME_KEY, next);
      document.documentElement.classList.add('oc-theme-switching');
      document.documentElement.classList.toggle('light', next === 'light');
      document.documentElement.classList.toggle('dark', next === 'dark');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document.documentElement.classList.remove('oc-theme-switching');
        });
      });
      return next;
    });
  };

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const fetchAll = async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const results = await Promise.allSettled([
        ownerApi<{ owner: typeof ownerInfo }>('/owner-api/v1/auth/me'),
        ownerApi(`/owner-api/v1/overview?range=${range}`),
        ownerApi(`/owner-api/v1/downloads?range=${range}`),
        ownerApi(`/owner-api/v1/users?range=${range}`),
        ownerApi(`/owner-api/v1/engagement?range=${range}`),
        ownerApi(`/owner-api/v1/ai-costs?range=${range}`),
        ownerApi(`/owner-api/v1/reliability?range=${range}`),
        ownerApi('/owner-api/v1/feedback'),
        ownerApi<typeof configData>('/owner-api/v1/config'),
      ]);

      const authFailed = results.some(
        (r) =>
          r.status === 'rejected' &&
          ((r.reason as { status?: number })?.status === 401 ||
            (r.reason as { status?: number })?.status === 403),
      );
      if (authFailed) {
        setOwnerToken(null);
        setAuthed(false);
        return;
      }

      if (results[0].status === 'fulfilled') setOwnerInfo(results[0].value.owner);
      if (results[1].status === 'fulfilled') setOverview(results[1].value);
      if (results[2].status === 'fulfilled') setDownloads(results[2].value);
      if (results[3].status === 'fulfilled') setUsers(results[3].value);
      if (results[4].status === 'fulfilled') setEngagement(results[4].value);
      if (results[5].status === 'fulfilled') setAiCosts(results[5].value);
      if (results[6].status === 'fulfilled') setReliability(results[6].value);
      if (results[7].status === 'fulfilled') setFeedback(results[7].value);
      if (results[8].status === 'fulfilled') setConfigData(results[8].value);

      const failedCount = results.filter((r) => r.status === 'rejected').length;
      if (failedCount > 0) {
        setFetchError(`${failedCount} telemetry feed(s) returned an error. Showing available metrics.`);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (authed) fetchAll();
  }, [authed, range]);

  const handleOwnerLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginErr(null);
    try {
      const res = await ownerApi<{ accessToken: string }>('/owner-api/v1/auth/login', {
        method: 'POST',
        skipAuth: true,
        body: { email, password, totpCode: totpCode || undefined },
      });
      setOwnerToken(res.accessToken);
      setAuthed(true);
    } catch (err) {
      const e2 = err as Error & { mfaRequired?: boolean };
      if (e2.mfaRequired) setMfaPrompt(true);
      setLoginErr(e2.message);
    }
  };

  const handleUpdateFeedbackStatus = async (id: string, status: string) => {
    await ownerApi(`/owner-api/v1/feedback/${id}`, { method: 'PATCH', body: { status } });
    await fetchAll();
  };

  const handleUpdateAlertThreshold = async (id: string, thresholdValue: number) => {
    await ownerApi(`/owner-api/v1/config/alerts/${id}`, { method: 'PATCH', body: { thresholdValue } });
    setConfigNotice('Updated operational alert threshold.');
    await fetchAll();
  };

  const handleSetupMfa = async () => {
    const res = await ownerApi<{ secret: string }>('/owner-api/v1/auth/mfa/setup', { method: 'POST', body: {} });
    setMfaSecret(res.secret);
  };

  const handleEnableMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    await ownerApi('/owner-api/v1/auth/mfa/enable', { method: 'POST', body: { code: mfaVerifyInput } });
    setMfaSecret(null);
    setMfaVerifyInput('');
    setConfigNotice('Owner TOTP multi-factor authentication enabled.');
    await fetchAll();
  };

  if (!authed) {
    return (
      <div className="min-h-screen oc-grid-bg bg-[var(--oc-chassis)] flex items-center justify-center p-6">
        <div className="w-full max-w-md oc-panel p-8 space-y-6 border-t-[3px] border-t-[var(--oc-brand)] oc-animate-view">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-[var(--oc-brand-soft)] border border-[var(--oc-brand-border)] flex items-center justify-center">
                <Lock className="h-5 w-5 text-[var(--oc-brand)]" />
              </div>
              <div>
                <h1 className="oc-heading text-xl font-bold text-[var(--oc-ink)]">CoreSense Owner Console</h1>
                <p className="text-xs text-[var(--oc-ink-muted)]">Private telemetry & product operations</p>
              </div>
            </div>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle theme"
              className="oc-btn-secondary h-8 w-8 flex items-center justify-center cursor-pointer"
            >
              {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </button>
          </div>

          <div className="rounded-lg bg-[var(--oc-ok-soft)] border border-[var(--oc-ok-border)] p-3 flex gap-2.5 text-xs text-[var(--oc-ok-ink)] leading-relaxed">
            <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5 text-[var(--oc-ok)]" />
            <span>
              Separate owner authentication. Physically isolated from customer repair workspaces, conversations, photographs, and manuals.
            </span>
          </div>

          <form onSubmit={handleOwnerLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-[var(--oc-ink-2)] mb-1.5">
                Owner admin email
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="oc-input w-full px-3.5 py-2.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--oc-ink-2)] mb-1.5">
                Owner password
              </label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter owner console password"
                className="oc-input w-full px-3.5 py-2.5 text-sm"
              />
            </div>
            {mfaPrompt && (
              <div className="oc-animate-view">
                <label className="block text-xs font-medium text-[var(--oc-ink-2)] mb-1.5">
                  6-digit TOTP MFA code
                </label>
                <input
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  placeholder="000000"
                  className="oc-input w-full px-3.5 py-2.5 text-sm font-mono oc-tabular"
                />
              </div>
            )}
            {loginErr && (
              <div className="rounded-lg bg-[var(--oc-danger-soft)] border border-[var(--oc-danger-border)] px-3 py-2 text-xs text-[var(--oc-danger-ink)]">
                {loginErr}
              </div>
            )}
            <button type="submit" className="oc-btn-primary w-full py-2.5 text-sm cursor-pointer">
              Sign in to owner console
            </button>
          </form>
        </div>
      </div>
    );
  }

  const nav: Array<{ id: SectionId; label: string; icon: React.ReactNode }> = [
    { id: 'overview', label: 'Executive overview', icon: <BarChart3 className="h-4 w-4" /> },
    { id: 'downloads', label: 'Downloads & installs', icon: <Download className="h-4 w-4" /> },
    { id: 'users', label: 'Users & retention', icon: <Users className="h-4 w-4" /> },
    { id: 'engagement', label: 'Engagement & funnel', icon: <Activity className="h-4 w-4" /> },
    { id: 'ai', label: 'AI usage & costs', icon: <Cpu className="h-4 w-4" /> },
    { id: 'reliability', label: 'Reliability & crashes', icon: <ServerCrash className="h-4 w-4" /> },
    { id: 'feedback', label: 'Feedback & support', icon: <MessageSquare className="h-4 w-4" /> },
    { id: 'config', label: 'Product config & MFA', icon: <Settings className="h-4 w-4" /> },
  ];

  const k = overview?.kpis;
  const rangeIndex = RANGES.indexOf(range);

  const renderNavButtons = () => (
    <nav className="p-2.5 space-y-0.5" aria-label="Owner console sections">
      {nav.map((item) => {
        const active = section === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              setSection(item.id);
              setMobileNavOpen(false);
            }}
            className={`relative w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
              active
                ? 'bg-[var(--oc-surface)] text-[var(--oc-ink)] font-semibold border border-[var(--oc-border)]'
                : 'text-[var(--oc-ink-muted)] hover:text-[var(--oc-ink)] hover:bg-[var(--oc-surface)]/50 border border-transparent'
            }`}
          >
            {active && (
              <span
                aria-hidden="true"
                className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r bg-[var(--oc-brand)]"
              />
            )}
            <span className={active ? 'text-[var(--oc-brand)]' : ''}>{item.icon}</span>
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-[var(--oc-canvas)] text-[var(--oc-ink)]">
      {/* Compact Top Bar on Narrow Screens (< lg) */}
      <div className="lg:hidden shrink-0 px-4 py-3 border-b border-[var(--oc-border)] bg-[var(--oc-chassis)] flex items-center justify-between gap-2 sticky top-0 z-30">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setMobileNavOpen((o) => !o)}
            aria-label="Toggle operations menu"
            className="oc-btn-secondary h-8 w-8 flex items-center justify-center cursor-pointer"
          >
            {mobileNavOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
          <div className="oc-heading text-sm font-bold text-[var(--oc-ink)]">CoreSense Owner</div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={toggleTheme}
            aria-label="Toggle theme"
            className="oc-btn-secondary h-8 w-8 flex items-center justify-center cursor-pointer"
          >
            {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* Collapsible Mobile Drawer */}
      {mobileNavOpen && (
        <div className="lg:hidden border-b border-[var(--oc-border)] bg-[var(--oc-chassis)] oc-animate-view">
          {renderNavButtons()}
        </div>
      )}

      {/* Left Operations Navigation Rail (Desktop >= lg) */}
      <aside className="hidden lg:flex w-64 shrink-0 border-r border-[var(--oc-border)] bg-[var(--oc-chassis)] flex-col justify-between">
        <div>
          <div className="px-4 py-4 border-b border-[var(--oc-border)] flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-[var(--oc-brand-soft)] border border-[var(--oc-brand-border)] flex items-center justify-center shrink-0">
              <Lock className="h-4 w-4 text-[var(--oc-brand)]" />
            </div>
            <div className="min-w-0">
              <div className="oc-heading text-sm font-bold text-[var(--oc-ink)] truncate">CoreSense Owner</div>
              <div className="text-[11px] text-[var(--oc-brand-ink)]">Private operations</div>
            </div>
          </div>

          {renderNavButtons()}
        </div>

        <div className="p-3.5 space-y-2.5 border-t border-[var(--oc-border)]">
          <div className="rounded-lg bg-[var(--oc-ok-soft)] border border-[var(--oc-ok-border)] p-3 text-[11px] text-[var(--oc-ok-ink)] leading-relaxed">
            <div className="font-semibold flex items-center gap-1.5 mb-0.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--oc-ok)] oc-animate-led" />
              <span>Privacy isolation active</span>
            </div>
            Zero access to customer chats, photos, manuals, or personal repair records.
          </div>
          <button
            type="button"
            onClick={() => {
              setOwnerToken(null);
              setAuthed(false);
            }}
            className="oc-btn-secondary w-full flex items-center justify-center gap-1.5 py-2 text-xs text-[var(--oc-ink-muted)] hover:text-[var(--oc-danger)] cursor-pointer"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className="truncate">Sign out{ownerInfo?.email ? ` (${ownerInfo.email})` : ''}</span>
          </button>
        </div>
      </aside>

      {/* Main Analytics Content */}
      <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 space-y-6 overflow-y-auto">
        {/* Top Control Header */}
        <header className="flex flex-wrap items-end justify-between gap-4 pb-4 border-b border-[var(--oc-border)]">
          <div className="space-y-1">
            <h1 className="oc-heading text-xl sm:text-2xl font-bold text-[var(--oc-ink)]">
              {nav.find((n) => n.id === section)?.label}
            </h1>
            <p className="text-xs text-[var(--oc-ink-muted)]">
              Aggregate product telemetry from{' '}
              <code className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-[var(--oc-well)] border border-[var(--oc-border)] text-[var(--oc-blue-ink)]">
                coresense_owner.db
              </code>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Sliding Range Selector */}
            <div className="relative grid grid-cols-5 p-0.5 rounded-lg bg-[var(--oc-well)] border border-[var(--oc-border)] shrink-0">
              <div
                aria-hidden="true"
                className="absolute top-0.5 bottom-0.5 left-0.5 w-[calc(20%-0.8px)] rounded-md bg-[var(--oc-surface)] border border-[var(--oc-border)] transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
                style={{ transform: `translateX(${rangeIndex * 100}%)` }}
              />
              {RANGES.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRange(r)}
                  className={`relative z-10 px-2.5 sm:px-3 py-1.5 text-xs font-mono cursor-pointer transition-colors ${
                    range === r ? 'text-[var(--oc-brand-ink)] font-semibold' : 'text-[var(--oc-ink-muted)] hover:text-[var(--oc-ink)]'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={fetchAll}
              className="oc-btn-secondary flex items-center gap-1.5 px-3 py-2 text-xs cursor-pointer"
            >
              <RefreshCw className={`h-3.5 w-3.5 text-[var(--oc-brand)] ${loading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>

            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle theme"
              className="hidden lg:flex oc-btn-secondary h-8 w-8 items-center justify-center cursor-pointer"
            >
              {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </button>
          </div>
        </header>

        {fetchError && (
          <div className="rounded-lg border border-[var(--oc-brand-border)] bg-[var(--oc-brand-soft)] px-4 py-2.5 text-xs text-[var(--oc-brand-ink)]">
            {fetchError}
          </div>
        )}

        {overview?.alerts?.some((a: any) => a.triggered) && (
          <div className="rounded-lg border border-[var(--oc-danger-border)] border-l-[4px] border-l-[var(--oc-danger)] bg-[var(--oc-danger-soft)] p-3.5 flex items-center gap-3 text-xs text-[var(--oc-danger-ink)]">
            <AlertTriangle className="h-5 w-5 text-[var(--oc-danger)] shrink-0" />
            <div>
              <strong>Operational alert triggered: </strong>
              {overview.alerts
                .filter((a: any) => a.triggered)
                .map((a: any) => `${a.label} (${a.currentValue}${a.unit} > ${a.thresholdValue}${a.unit})`)
                .join(' / ')}
            </div>
          </div>
        )}

        <div key={section} className="oc-animate-view">
          {/* SECTION: EXECUTIVE OVERVIEW */}
          {section === 'overview' && k && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 lg:grid-cols-4 border border-[var(--oc-border)] rounded-lg bg-[var(--oc-surface)] overflow-hidden">
                {[
                  { label: 'Installer downloads', val: k.installerDownloads, sub: 'Tracked distribution events', tone: 'text-[var(--oc-blue-ink)]' },
                  { label: 'First-launch activations', val: k.firstActivations, sub: `${k.activeInstallations30d} active installs (30d)`, tone: 'text-[var(--oc-ink)]' },
                  { label: 'Registered accounts', val: k.totalRegisteredUsers, sub: `+${k.newRegistrations} new, ${k.accountDeletions} deleted`, tone: 'text-[var(--oc-ink)]' },
                  { label: 'DAU / WAU / MAU', val: `${k.dau} / ${k.wau} / ${k.mau}`, sub: 'Unique anonymized active users', tone: 'text-[var(--oc-ok-ink)]' },
                  { label: 'Diagnostic scans', val: k.totalScans ?? 0, sub: `${k.totalInvestigations ?? 0} investigations started`, tone: 'text-[var(--oc-ok)]' },
                  { label: 'AI operating spend', val: `$${k.aiTotalCostUsd.toFixed(4)}`, sub: `${k.aiTotalRequests} reqs, $${k.aiCostPerActiveUserUsd}/MAU`, tone: 'text-[var(--oc-brand-ink)]' },
                  { label: 'API latency', val: `${k.apiAvgLatencyMs} ms`, sub: `${k.apiTotalCalls} calls, ${k.apiErrorRatePercent}% 5xx`, tone: 'text-[var(--oc-blue-ink)]' },
                  { label: 'Crash-free sessions', val: `${k.crashFreeSessionsPercent}%`, sub: `${k.crashCount} scrubbed crash report(s)`, tone: 'text-[var(--oc-ok-ink)]' },
                ].map((card) => (
                  <div
                    key={card.label}
                    className="p-4 border-b border-r border-[var(--oc-border)] space-y-1"
                  >
                    <div className="text-xs text-[var(--oc-ink-muted)] font-medium">{card.label}</div>
                    <div className={`font-mono text-2xl font-bold oc-tabular ${card.tone}`}>{card.val}</div>
                    <div className="text-[11px] text-[var(--oc-ink-muted)]">{card.sub}</div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                <div className="oc-panel p-5 space-y-3">
                  <h2 className="oc-heading text-sm font-bold text-[var(--oc-ink)]">Diagnostic workflow funnel</h2>
                  <div className="h-60">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={engagement?.funnel || []} layout="vertical" margin={{ left: 16 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--oc-border)" horizontal={false} />
                        <XAxis type="number" tick={{ fill: 'var(--oc-ink-muted)', fontSize: 11 }} axisLine={false} tickLine={false} />
                        <YAxis dataKey="stage" type="category" width={155} tick={{ fill: 'var(--oc-ink-2)', fontSize: 11 }} axisLine={false} tickLine={false} />
                        <Tooltip
                          cursor={{ fill: 'var(--oc-well)' }}
                          contentStyle={{
                            backgroundColor: 'var(--oc-surface)',
                            borderColor: 'var(--oc-border-strong)',
                            color: 'var(--oc-ink)',
                            borderRadius: '8px',
                            fontSize: 12,
                          }}
                        />
                        <Bar dataKey="count" fill="var(--oc-blue)" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="oc-panel p-5 space-y-3">
                  <h2 className="oc-heading text-sm font-bold text-[var(--oc-ink)]">Operational guardrail thresholds</h2>
                  <div className="divide-y divide-[var(--oc-border)] border-t border-[var(--oc-border)]">
                    {(overview?.alerts || []).map((a: any) => (
                      <div key={a.id} className="py-3 flex items-center justify-between gap-3">
                        <div>
                          <div className="text-xs font-semibold text-[var(--oc-ink)]">{a.label}</div>
                          <div className="text-[11px] font-mono text-[var(--oc-ink-muted)] oc-tabular">
                            Threshold: {a.thresholdValue} {a.unit}
                          </div>
                        </div>
                        <span
                          className={`font-mono text-xs px-2.5 py-1 rounded border oc-tabular ${
                            a.triggered
                              ? 'bg-[var(--oc-danger-soft)] border-[var(--oc-danger-border)] text-[var(--oc-danger-ink)]'
                              : 'bg-[var(--oc-ok-soft)] border-[var(--oc-ok-border)] text-[var(--oc-ok-ink)]'
                          }`}
                        >
                          {a.currentValue} {a.unit} {a.triggered ? 'Alert' : 'OK'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* SECTION A: DOWNLOADS & INSTALLATIONS */}
          {section === 'downloads' && downloads && (
            <div className="space-y-4">
              <div className="oc-panel p-3.5 border-l-[3px] border-l-[var(--oc-blue)] text-xs text-[var(--oc-ink-2)]">
                {downloads.separationNote}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="oc-panel p-5 space-y-3">
                  <h2 className="oc-heading text-sm font-bold text-[var(--oc-ink)]">Installer downloads by platform</h2>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[var(--oc-ink-muted)] border-b border-[var(--oc-border)]">
                        <th className="py-2 font-medium">Platform</th>
                        <th className="py-2 font-medium">Channel</th>
                        <th className="py-2 font-medium">Version</th>
                        <th className="py-2 text-right font-medium">Downloads</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--oc-border)] font-mono oc-tabular">
                      {downloads.downloadsByPlatform.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="py-6 text-center text-[var(--oc-ink-muted)] font-sans">
                            No installer downloads tracked in this period.
                          </td>
                        </tr>
                      ) : (
                        downloads.downloadsByPlatform.map((r: any, i: number) => (
                          <tr key={i}>
                            <td className="py-2 capitalize">{r.platform}</td>
                            <td className="py-2">{r.channel}</td>
                            <td className="py-2">{r.app_version}</td>
                            <td className="py-2 text-right text-[var(--oc-blue-ink)]">{r.count}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="oc-panel p-5 space-y-3">
                  <h2 className="oc-heading text-sm font-bold text-[var(--oc-ink)]">First-launch activations & versions</h2>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[var(--oc-ink-muted)] border-b border-[var(--oc-border)]">
                        <th className="py-2 font-medium">Platform</th>
                        <th className="py-2 font-medium">Version</th>
                        <th className="py-2 text-right font-medium">Active installs</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--oc-border)] font-mono oc-tabular">
                      {downloads.activeByVersion.map((r: any, i: number) => (
                        <tr key={i}>
                          <td className="py-2 capitalize">{r.platform}</td>
                          <td className="py-2">{r.app_version}</td>
                          <td className="py-2 text-right text-[var(--oc-brand-ink)]">{r.installs}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* SECTION B: USERS & RETENTION */}
          {section === 'users' && users && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 md:grid-cols-4 border border-[var(--oc-border)] rounded-lg bg-[var(--oc-surface)] divide-y md:divide-y-0 md:divide-x divide-[var(--oc-border)]">
                <div className="p-4">
                  <div className="text-xs text-[var(--oc-ink-muted)]">Active accounts</div>
                  <div className="font-mono text-2xl font-bold text-[var(--oc-ink)] oc-tabular mt-0.5">
                    {users.summary.activeAccounts}
                  </div>
                </div>
                <div className="p-4">
                  <div className="text-xs text-[var(--oc-ink-muted)]">Returning users</div>
                  <div className="font-mono text-2xl font-bold text-[var(--oc-blue-ink)] oc-tabular mt-0.5">
                    {users.summary.returningUsers}
                  </div>
                </div>
                <div className="p-4">
                  <div className="text-xs text-[var(--oc-ink-muted)]">Multi-day retention</div>
                  <div className="font-mono text-2xl font-bold text-[var(--oc-ok)] oc-tabular mt-0.5">
                    {users.summary.retentionRatePercent}%
                  </div>
                </div>
                <div className="p-4">
                  <div className="text-xs text-[var(--oc-ink-muted)]">Account deletions / churn</div>
                  <div className="font-mono text-2xl font-bold text-[var(--oc-brand-ink)] oc-tabular mt-0.5">
                    {users.summary.accountDeletions} ({users.summary.churnRatePercent}%)
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                <div className="oc-panel p-5 space-y-3">
                  <h2 className="oc-heading text-sm font-bold text-[var(--oc-ink)]">Daily active users trend</h2>
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={users.dailyActive}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--oc-border)" vertical={false} />
                        <XAxis dataKey="day" tick={{ fill: 'var(--oc-ink-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fill: 'var(--oc-ink-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: 'var(--oc-surface)',
                            borderColor: 'var(--oc-border-strong)',
                            color: 'var(--oc-ink)',
                            borderRadius: '8px',
                            fontSize: 12,
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="active_users"
                          stroke="var(--oc-brand)"
                          strokeWidth={2}
                          fill="var(--oc-brand-soft)"
                          fillOpacity={0.7}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="oc-panel p-5 space-y-3">
                  <h2 className="oc-heading text-sm font-bold text-[var(--oc-ink)]">Platform adoption</h2>
                  <div className="space-y-2 text-xs">
                    {users.platformAdoption.map((p: any) => (
                      <div key={p.platform} className="flex justify-between rounded-md bg-[var(--oc-well)] border border-[var(--oc-border)] px-3 py-2">
                        <span className="capitalize text-[var(--oc-ink)]">{p.platform}</span>
                        <span className="font-mono text-[var(--oc-blue-ink)] oc-tabular">{p.users} account(s)</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* SECTION C: ENGAGEMENT */}
          {section === 'engagement' && engagement && (
            <div className="oc-panel p-5 space-y-3">
              <h2 className="oc-heading text-sm font-bold text-[var(--oc-ink)]">Aggregate feature adoption events</h2>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[var(--oc-ink-muted)] border-b border-[var(--oc-border)]">
                    <th className="py-2 font-medium">Event name</th>
                    <th className="py-2 text-right font-medium">Total events</th>
                    <th className="py-2 text-right font-medium">Unique users</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--oc-border)] font-mono oc-tabular">
                  {engagement.featureCounts.map((f: any) => (
                    <tr key={f.event_name}>
                      <td className="py-2.5 text-[var(--oc-blue-ink)]">{f.event_name}</td>
                      <td className="py-2.5 text-right text-[var(--oc-ink)]">{f.count}</td>
                      <td className="py-2.5 text-right text-[var(--oc-brand-ink)]">{f.unique_users}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* SECTION D: AI USAGE & OPERATING COSTS */}
          {section === 'ai' && aiCosts && (
            <div className="space-y-4">
              <div className="oc-panel p-3.5 border-l-[3px] border-l-[var(--oc-ok)] text-xs text-[var(--oc-ok-ink)]">
                {aiCosts.privacyNotice}
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                <div className="oc-panel p-5 space-y-3">
                  <h2 className="oc-heading text-sm font-bold text-[var(--oc-ink)]">Usage & cost by provider / model</h2>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[var(--oc-ink-muted)] border-b border-[var(--oc-border)]">
                        <th className="py-2 font-medium">Provider / model</th>
                        <th className="py-2 text-right font-medium">Reqs</th>
                        <th className="py-2 text-right font-medium">In / out tokens</th>
                        <th className="py-2 text-right font-medium">Avg ms</th>
                        <th className="py-2 text-right font-medium">Est. USD</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--oc-border)] font-mono oc-tabular">
                      {aiCosts.byProviderModel.map((m: any, i: number) => (
                        <tr key={i}>
                          <td className="py-2.5 text-[var(--oc-blue-ink)]">{m.provider} / {m.model}</td>
                          <td className="py-2.5 text-right">{m.requests}</td>
                          <td className="py-2.5 text-right text-[var(--oc-ink-2)]">{m.input_tokens} / {m.output_tokens}</td>
                          <td className="py-2.5 text-right">{Math.round(m.avg_latency_ms)}</td>
                          <td className="py-2.5 text-right text-[var(--oc-brand-ink)]">${Number(m.cost_usd).toFixed(5)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="oc-panel p-5 space-y-3">
                  <h2 className="oc-heading text-sm font-bold text-[var(--oc-ink)]">Usage by feature & modality</h2>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[var(--oc-ink-muted)] border-b border-[var(--oc-border)]">
                        <th className="py-2 font-medium">Feature</th>
                        <th className="py-2 font-medium">Modality</th>
                        <th className="py-2 text-right font-medium">Requests</th>
                        <th className="py-2 text-right font-medium">Est. USD</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--oc-border)] font-mono oc-tabular">
                      {aiCosts.byFeature.map((f: any, i: number) => (
                        <tr key={i}>
                          <td className="py-2.5 text-[var(--oc-ink)]">{f.feature}</td>
                          <td className="py-2.5 text-[var(--oc-ink-2)]">{f.modality}</td>
                          <td className="py-2.5 text-right">{f.requests}</td>
                          <td className="py-2.5 text-right text-[var(--oc-brand-ink)]">${Number(f.cost_usd).toFixed(5)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* SECTION F: RELIABILITY & CRASHES */}
          {section === 'reliability' && reliability && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 md:grid-cols-4 border border-[var(--oc-border)] rounded-lg bg-[var(--oc-surface)] divide-y md:divide-y-0 md:divide-x divide-[var(--oc-border)]">
                <div className="p-4">
                  <div className="text-xs text-[var(--oc-ink-muted)]">API status</div>
                  <div className="font-mono text-lg font-bold text-[var(--oc-ok)] capitalize mt-0.5">
                    {reliability.serviceHealth.apiStatus}
                  </div>
                </div>
                <div className="p-4">
                  <div className="text-xs text-[var(--oc-ink-muted)]">Owner DB size</div>
                  <div className="font-mono text-lg font-bold text-[var(--oc-ink)] oc-tabular mt-0.5">
                    {reliability.serviceHealth.ownerDbSizeKb} KB
                  </div>
                </div>
                <div className="p-4">
                  <div className="text-xs text-[var(--oc-ink-muted)]">API uptime</div>
                  <div className="font-mono text-lg font-bold text-[var(--oc-blue-ink)] oc-tabular mt-0.5">
                    {reliability.serviceHealth.uptimeSeconds} s
                  </div>
                </div>
                <div className="p-4">
                  <div className="text-xs text-[var(--oc-ink-muted)]">Recent crashes</div>
                  <div className="font-mono text-lg font-bold text-[var(--oc-brand-ink)] oc-tabular mt-0.5">
                    {reliability.recentCrashes.length}
                  </div>
                </div>
              </div>

              <div className="oc-panel p-5 space-y-3">
                <h2 className="oc-heading text-sm font-bold text-[var(--oc-ink)]">Endpoint performance & error rates</h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[var(--oc-ink-muted)] border-b border-[var(--oc-border)]">
                        <th className="py-2 font-medium">Method & route</th>
                        <th className="py-2 text-right font-medium">Calls</th>
                        <th className="py-2 text-right font-medium">Avg ms</th>
                        <th className="py-2 text-right font-medium">Max ms</th>
                        <th className="py-2 text-right font-medium">4xx</th>
                        <th className="py-2 text-right font-medium">5xx</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--oc-border)] font-mono oc-tabular">
                      {reliability.routeStats.map((r: any, i: number) => (
                        <tr key={i}>
                          <td className="py-2.5 text-[var(--oc-blue-ink)]">{r.method} {r.route_pattern}</td>
                          <td className="py-2.5 text-right">{r.calls}</td>
                          <td className="py-2.5 text-right">{r.avg_latency_ms}</td>
                          <td className="py-2.5 text-right">{r.max_latency_ms}</td>
                          <td className="py-2.5 text-right text-[var(--oc-brand-ink)]">{r.errors_4xx}</td>
                          <td className="py-2.5 text-right text-[var(--oc-danger-ink)]">{r.errors_5xx}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* SECTION G: VOLUNTARY FEEDBACK & SUPPORT */}
          {section === 'feedback' && feedback && (
            <div className="space-y-4">
              <div className="oc-panel p-4 flex items-center justify-between">
                <div>
                  <h2 className="oc-heading text-sm font-bold text-[var(--oc-ink)]">
                    Voluntary user feedback & bug reports
                  </h2>
                  <p className="text-xs text-[var(--oc-ink-muted)] mt-0.5">
                    Average rating:{' '}
                    <strong className="font-mono text-[var(--oc-brand-ink)] oc-tabular">
                      {feedback.averageRating ?? 'N/A'} / 5
                    </strong>{' '}
                    ({feedback.ratingCount} ratings)
                  </p>
                </div>
              </div>

              <div className="space-y-2.5">
                {feedback.feedback.length === 0 ? (
                  <div className="oc-panel p-8 text-center text-xs text-[var(--oc-ink-muted)]">
                    No voluntary feedback submitted yet.
                  </div>
                ) : (
                  feedback.feedback.map((f: any) => (
                    <div key={f.id} className="oc-panel p-4 flex flex-wrap items-start justify-between gap-4">
                      <div className="space-y-1.5 max-w-2xl">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="rounded bg-[var(--oc-blue-soft)] text-[var(--oc-blue-ink)] px-2 py-0.5 font-medium capitalize text-[11px]">
                            {String(f.category).replace(/_/g, ' ')}
                          </span>
                          {f.rating && (
                            <span className="font-mono text-[var(--oc-brand-ink)] oc-tabular">{f.rating}/5 ★</span>
                          )}
                          <span className="font-mono text-[11px] text-[var(--oc-ink-muted)]">
                            {f.platform} v{f.app_version}
                          </span>
                        </div>
                        <div className="text-sm font-semibold text-[var(--oc-ink)]">{f.title}</div>
                        <p className="text-xs text-[var(--oc-ink-2)] leading-relaxed">{f.message}</p>
                      </div>
                      <select
                        value={f.status}
                        onChange={(e) => handleUpdateFeedbackStatus(f.id, e.target.value)}
                        className="oc-input px-3 py-1.5 text-xs font-medium"
                      >
                        <option value="new">New</option>
                        <option value="reviewed">Reviewed</option>
                        <option value="planned">Planned</option>
                        <option value="resolved">Resolved</option>
                        <option value="dismissed">Dismissed</option>
                      </select>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* SECTION G: PRODUCT CONFIG & MFA */}
          {section === 'config' && configData && (
            <div className="space-y-5">
              {configNotice && (
                <div className="rounded-lg bg-[var(--oc-ok-soft)] border border-[var(--oc-ok-border)] px-4 py-2.5 text-xs text-[var(--oc-ok-ink)] oc-animate-view">
                  {configNotice}
                </div>
              )}

              <div className="oc-panel p-5 space-y-4">
                <h2 className="oc-heading text-sm font-bold text-[var(--oc-ink)]">Operational alert thresholds</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {configData.alerts.map((a) => (
                    <div
                      key={a.id}
                      className="rounded-lg bg-[var(--oc-well)] border border-[var(--oc-border)] px-3.5 py-2.5 flex items-center justify-between gap-3"
                    >
                      <span className="text-xs font-medium text-[var(--oc-ink)]">
                        {a.label} ({a.unit})
                      </span>
                      <input
                        type="number"
                        step="0.5"
                        defaultValue={a.threshold_value}
                        onBlur={(e) => handleUpdateAlertThreshold(a.id, Number(e.target.value))}
                        className="oc-input w-24 px-2.5 py-1 text-xs font-mono text-[var(--oc-brand-ink)] oc-tabular"
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="oc-panel p-5 space-y-3">
                <h2 className="oc-heading text-sm font-bold text-[var(--oc-ink)]">
                  Owner TOTP multi-factor authentication
                </h2>
                <div className="text-xs text-[var(--oc-ink-muted)]">
                  Status:{' '}
                  <strong className={ownerInfo?.totpEnabled ? 'text-[var(--oc-ok)]' : 'text-[var(--oc-brand-ink)]'}>
                    {ownerInfo?.totpEnabled ? 'Enabled' : 'Not enabled'}
                  </strong>
                </div>
                {!mfaSecret ? (
                  <button
                    type="button"
                    onClick={handleSetupMfa}
                    className="oc-btn-secondary px-4 py-2 text-xs font-semibold cursor-pointer"
                  >
                    Generate TOTP authenticator secret
                  </button>
                ) : (
                  <form onSubmit={handleEnableMfa} className="space-y-2.5 max-w-md oc-animate-view">
                    <div className="rounded-lg bg-[var(--oc-well)] border border-[var(--oc-border)] p-3 font-mono text-xs text-[var(--oc-blue-ink)] break-all">
                      Secret key: {mfaSecret}
                    </div>
                    <div className="flex gap-2">
                      <input
                        required
                        value={mfaVerifyInput}
                        onChange={(e) => setMfaVerifyInput(e.target.value)}
                        placeholder="Enter 6-digit code to enable"
                        className="oc-input flex-1 px-3 py-2 text-xs font-mono oc-tabular"
                      />
                      <button type="submit" className="oc-btn-primary px-4 text-xs cursor-pointer">
                        Enable MFA
                      </button>
                    </div>
                  </form>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};
