import React, { useEffect, useState } from 'react';
import {
  Activity,
  BookOpen,
  BrainCircuit,
  ClipboardList,
  Download,
  Laptop,
  LogOut,
  MessageSquare,
  Moon,
  Settings,
  Sun,
  X,
} from 'lucide-react';
import {
  apiRequest,
  getAuthToken,
  loadOfflineCache,
  reportClientCrash,
  reportDesktopActivation,
  saveOfflineCache,
  setAuthToken,
} from './api';
import {
  type AvailableUpdateInfo,
  checkForDesktopUpdate,
  installDesktopUpdate,
} from './updater';
import { initSupabaseAuthSync, signOutSupabase } from './supabase';
import { AiMlLabView } from './components/AiMlLabView';
import { AuthView } from './components/AuthView';
import { BrandLogo } from './components/BrandLogo';
import { CopilotView } from './components/CopilotView';
import { DiagnosticsView } from './components/DiagnosticsView';
import { type DeviceRecord, DevicesView } from './components/DevicesView';
import { KnowledgeBaseView } from './components/KnowledgeBaseView';
import { RepairCasesView } from './components/RepairCasesView';
import { type AccountSnapshot, SettingsView } from './components/SettingsView';

type TabId = 'copilot' | 'diagnostics' | 'ailab' | 'devices' | 'knowledge' | 'cases' | 'settings';

const THEME_STORAGE_KEY = 'coresense_desktop_theme';

export const App: React.FC = () => {
  const [tokenReady, setTokenReady] = useState(Boolean(getAuthToken()));
  const [account, setAccount] = useState<AccountSnapshot | null>(() => loadOfflineCache<AccountSnapshot>('account'));
  const [devices, setDevices] = useState<DeviceRecord[]>(() => loadOfflineCache<DeviceRecord[]>('devices') || []);
  const [activeTab, setActiveTab] = useState<TabId>('copilot');
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === 'light' ? 'light' : 'dark';
  });
  const [offlineBanner, setOfflineBanner] = useState(false);
  const [passwordRecoveryPending, setPasswordRecoveryPending] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdateInfo | null>(null);
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const toggleTheme = () => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_STORAGE_KEY, next);
      document.documentElement.classList.add('cs-theme-switching');
      document.documentElement.classList.toggle('dark', next === 'dark');
      document.documentElement.classList.toggle('light', next === 'light');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document.documentElement.classList.remove('cs-theme-switching');
        });
      });
      return next;
    });
  };

  const loadWorkspace = async () => {
    try {
      const [meRes, devRes] = await Promise.all([
        apiRequest<AccountSnapshot>('/api/v1/account/me'),
        apiRequest<{ devices: DeviceRecord[] }>('/api/v1/devices'),
      ]);
      setAccount(meRes);
      setDevices(devRes.devices);
      saveOfflineCache('account', meRes);
      saveOfflineCache('devices', devRes.devices);
      setOfflineBanner(false);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401) {
        setAuthToken(null);
        setTokenReady(false);
        setAccount(null);
      } else {
        setOfflineBanner(true);
      }
    }
  };

  useEffect(() => {
    reportDesktopActivation();
    const onErr = (ev: ErrorEvent) => reportClientCrash('desktop_window', ev.error || ev.message);
    window.addEventListener('error', onErr);
    let unsubSupabase: () => void = () => {};
    initSupabaseAuthSync({
      onSession: (session) => {
        if (session?.access_token) {
          setTokenReady(true);
        } else {
          setTokenReady(false);
          setAccount(null);
        }
      },
      onPasswordRecovery: () => {
        setPasswordRecoveryPending(true);
        setTokenReady(false);
      },
    })
      .then((unsub) => {
        unsubSupabase = unsub;
      })
      .catch(() => {});
    return () => {
      window.removeEventListener('error', onErr);
      unsubSupabase();
    };
  }, []);

  useEffect(() => {
    if (tokenReady) loadWorkspace();
  }, [tokenReady]);

  // Automatic silent background update check shortly after launch
  useEffect(() => {
    const timer = setTimeout(() => {
      checkForDesktopUpdate()
        .then((res) => {
          if (res.status === 'update_available' && res.update) {
            setAvailableUpdate(res.update);
          }
        })
        .catch(() => {});
    }, 2500);
    return () => clearTimeout(timer);
  }, []);

  const handleInstallUpdate = async (target?: AvailableUpdateInfo) => {
    const upd = target ?? availableUpdate;
    if (!upd || installingUpdate) return;
    setInstallingUpdate(true);
    setUpdateError(null);
    setUpdateProgress(0);
    try {
      await installDesktopUpdate(upd, (pct) => setUpdateProgress(pct));
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : 'Unable to install update automatically.');
    } finally {
      setInstallingUpdate(false);
    }
  };

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.classList.toggle('light', theme === 'light');
  }, [theme]);

  if (!tokenReady || passwordRecoveryPending) {
    return (
      <AuthView
        theme={theme}
        onToggleTheme={toggleTheme}
        passwordRecoveryPending={passwordRecoveryPending}
        onPasswordRecoveryComplete={() => setPasswordRecoveryPending(false)}
        onAuthenticated={() => {
          setPasswordRecoveryPending(false);
          setTokenReady(true);
        }}
      />
    );
  }

  if (!account) {
    return (
      <div className="min-h-screen bg-[var(--cs-canvas)] flex flex-col items-center justify-center gap-4 text-[var(--cs-ink-muted)] text-sm">
        <BrandLogo compact />
        <div className="flex items-center gap-2.5">
          <div className="flex items-end gap-0.5 h-3.5">
            {[0, 120, 240, 360].map((delay) => (
              <span
                key={delay}
                className="w-1 h-full rounded-sm bg-[var(--cs-accent)] cs-animate-eq"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </div>
          <span>Opening your CoreSense workspace...</span>
        </div>
      </div>
    );
  }

  const navItems: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
    { id: 'copilot', label: 'Copilot', icon: <MessageSquare className="h-3.5 w-3.5" /> },
    { id: 'diagnostics', label: 'Diagnostics', icon: <Activity className="h-3.5 w-3.5" /> },
    { id: 'ailab', label: 'AI / ML Lab', icon: <BrainCircuit className="h-3.5 w-3.5" /> },
    { id: 'devices', label: 'Devices', icon: <Laptop className="h-3.5 w-3.5" /> },
    { id: 'knowledge', label: 'Manuals', icon: <BookOpen className="h-3.5 w-3.5" /> },
    { id: 'cases', label: 'Repair cases', icon: <ClipboardList className="h-3.5 w-3.5" /> },
    { id: 'settings', label: 'Account', icon: <Settings className="h-3.5 w-3.5" /> },
  ];

  const handleLogout = () => {
    void signOutSupabase();
    setAuthToken(null);
    try {
      localStorage.removeItem('coresense_offline_cache');
    } catch {}
    setTokenReady(false);
    setAccount(null);
    setDevices([]);
  };

  const initials = account.user.displayName
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const shortRuntimeLabel = (() => {
    const raw = account.aiRuntime.activeMode || '';
    const lower = raw.toLowerCase();
    if (lower.includes('gemini')) return 'Gemini cloud';
    if (lower.includes('openai')) return 'OpenAI cloud';
    if (lower.includes('ollama')) return 'Ollama local';
    if (lower.includes('local')) return 'Local engine';
    return raw.slice(0, 22);
  })();

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-[var(--cs-canvas)] text-[var(--cs-ink)]">
      {/* Top Precision Instrument Bar */}
      <header className="h-14 shrink-0 border-b border-[var(--cs-border)] bg-[var(--cs-chassis)] px-4 lg:px-5 flex items-center justify-between gap-4 z-30">
        <div className="flex items-center gap-6 min-w-0">
          <button
            type="button"
            onClick={() => setActiveTab('copilot')}
            className="shrink-0 cursor-pointer text-left"
          >
            <BrandLogo size="sm" />
          </button>

          {/* Horizontal Instrument Navigation */}
          <nav className="flex items-center gap-0.5 overflow-x-auto no-scrollbar" aria-label="Workspace sections">
            {navItems.map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`relative h-14 px-3 flex items-center gap-1.5 text-[13px] font-medium whitespace-nowrap transition-colors cursor-pointer ${
                    active
                      ? 'text-[var(--cs-ink)] font-semibold'
                      : 'text-[var(--cs-ink-muted)] hover:text-[var(--cs-ink)]'
                  }`}
                >
                  <span className={active ? 'text-[var(--cs-accent)]' : ''}>{item.icon}</span>
                  <span>{item.label}</span>
                  <span
                    className={`absolute left-2.5 right-2.5 bottom-0 h-[2.5px] bg-[var(--cs-accent)] transition-transform duration-200 origin-center ${
                      active ? 'scale-x-100' : 'scale-x-0'
                    }`}
                  />
                </button>
              );
            })}
          </nav>
        </div>

        {/* Right Telemetry Status & Controls */}
        <div className="flex items-center gap-2 shrink-0">
          <div
            className="hidden xl:flex items-center gap-2 px-2.5 py-1 rounded-md bg-[var(--cs-surface)] border border-[var(--cs-border)] text-xs"
            title={account.aiRuntime.activeMode}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--cs-ok)] cs-animate-led" />
            <span className="text-[var(--cs-ink-2)] whitespace-nowrap font-medium">{shortRuntimeLabel}</span>
          </div>

          <button
            type="button"
            onClick={() => setActiveTab('settings')}
            className="hidden md:flex items-center gap-2 px-2.5 py-1 rounded-md bg-[var(--cs-surface)] border border-[var(--cs-border)] hover:border-[var(--cs-border-strong)] transition-colors cursor-pointer"
            title="Account & preferences"
          >
            <span className="h-5 w-5 rounded bg-[var(--cs-action)] text-[var(--cs-action-ink)] text-[10px] font-semibold flex items-center justify-center">
              {initials || 'CS'}
            </span>
            <span className="text-xs font-medium text-[var(--cs-ink)] max-w-[140px] truncate">
              {account.user.displayName}
            </span>
          </button>

          <button
            type="button"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to OLED black'}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to OLED black theme'}
            className="h-8 w-8 rounded-md bg-[var(--cs-surface)] border border-[var(--cs-border)] hover:border-[var(--cs-border-strong)] flex items-center justify-center text-[var(--cs-ink-2)] hover:text-[var(--cs-ink)] transition-colors cursor-pointer"
          >
            {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </button>

          <button
            type="button"
            onClick={handleLogout}
            title="Sign out"
            aria-label="Sign out"
            className="h-8 w-8 rounded-md bg-[var(--cs-surface)] border border-[var(--cs-border)] hover:border-[var(--cs-danger-border)] hover:text-[var(--cs-danger)] flex items-center justify-center text-[var(--cs-ink-muted)] transition-colors cursor-pointer"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {/* Signed Auto-Update Notification Strip */}
      {availableUpdate && !updateBannerDismissed && (
        <div className="shrink-0 border-b border-[var(--cs-accent-border)] bg-[var(--cs-accent-soft)] px-5 py-2 text-xs text-[var(--cs-ink)] flex flex-wrap items-center justify-between gap-3 cs-animate-view">
          <div className="flex items-center gap-2 min-w-0">
            <Download className="h-3.5 w-3.5 text-[var(--cs-accent)] shrink-0" />
            <span className="truncate">
              <strong>CoreSense v{availableUpdate.latestVersion}</strong> is available
              {updateError ? ` — ${updateError}` : ''}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={installingUpdate}
              onClick={() => handleInstallUpdate(availableUpdate)}
              className="cs-btn-accent px-3 py-1 text-[11px] font-semibold cursor-pointer disabled:opacity-60"
            >
              {installingUpdate
                ? updateProgress != null
                  ? `Downloading ${updateProgress}%...`
                  : 'Installing...'
                : availableUpdate.canAutoInstall
                  ? 'Update & Restart'
                  : 'Download update'}
            </button>
            {!installingUpdate && (
              <button
                type="button"
                onClick={() => setUpdateBannerDismissed(true)}
                aria-label="Dismiss update banner"
                className="p-1 text-[var(--cs-ink-muted)] hover:text-[var(--cs-ink)] cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Offline Status Strip */}
      {offlineBanner && (
        <div className="shrink-0 border-b border-[var(--cs-warn-border)] bg-[var(--cs-warn-soft)] px-5 py-2 text-xs text-[var(--cs-warn-ink)] flex items-center justify-between cs-animate-view">
          <span>
            Offline mode active. Showing locally cached workspace records until the API connection returns.
          </span>
          <button
            type="button"
            onClick={loadWorkspace}
            className="font-semibold underline cursor-pointer ml-4 shrink-0"
          >
            Retry connection
          </button>
        </div>
      )}

      {/* Main Workspace Canvas */}
      <main
        key={activeTab}
        className={`flex-1 min-h-0 min-w-0 cs-animate-view ${
          activeTab === 'copilot' ? 'flex flex-col overflow-hidden' : 'overflow-y-auto p-5 lg:p-7'
        }`}
      >
        {activeTab === 'copilot' && <CopilotView devices={devices} />}
        {activeTab === 'diagnostics' && <DiagnosticsView devices={devices} />}
        {activeTab === 'ailab' && <AiMlLabView />}
        {activeTab === 'devices' && <DevicesView devices={devices} onRefresh={loadWorkspace} />}
        {activeTab === 'knowledge' && <KnowledgeBaseView />}
        {activeTab === 'cases' && <RepairCasesView devices={devices} />}
        {activeTab === 'settings' && (
          <SettingsView
            account={account}
            theme={theme}
            onToggleTheme={toggleTheme}
            onRefreshAccount={loadWorkspace}
            onLoggedOut={handleLogout}
            availableUpdate={availableUpdate}
            onUpdateDetected={(upd) => {
              setAvailableUpdate(upd);
              setUpdateBannerDismissed(false);
            }}
            onInstallUpdate={handleInstallUpdate}
            installingUpdate={installingUpdate}
            updateProgress={updateProgress}
          />
        )}
      </main>
    </div>
  );
};
