import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  BookOpen,
  Camera,
  Cloud,
  Download,
  Globe,
  Laptop,
  LogOut,
  MessageSquare,
  Mic,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Send,
  Smartphone,
  Sun,
  User,
  Wrench,
  X,
} from 'lucide-react';
import { CORESENSE_VERSION, type StructuredPcbInspection } from '@coresense/shared';
import {
  type MobileReleaseInfo,
  detectMobilePlatform,
  fetchLatestMobileRelease,
  getApiBaseUrl,
  getInstallId,
  getMobileSyncSeq,
  getMobileToken,
  isNativeMobileApp,
  isNewerMobileSemver,
  mobileApiRequest,
  mobileStreamSsePost,
  reportMobileActivation,
  setMobileApiBaseUrl,
  setMobileSyncSeq,
  setMobileToken,
  trackAndroidApkDownload,
} from './mobileApi';
import {
  getMobileSupabaseClient,
  initMobileSupabaseSync,
  signOutMobileSupabase,
} from './supabase';
import { PhoneDiagnosticsTab } from './components/PhoneDiagnosticsTab';

type MobileTab = 'copilot' | 'phone' | 'devices' | 'manuals' | 'account';
const MOBILE_THEME_KEY = 'coresense_mobile_theme';

const MobileMark: React.FC<{ small?: boolean }> = ({ small = false }) => (
  <div
    className={`flex shrink-0 items-center justify-center bg-[#000000] border border-[#262b31] ${
      small ? 'h-8 w-8 rounded-lg' : 'h-11 w-11 rounded-[10px]'
    }`}
  >
    <svg viewBox="0 0 128 128" className={small ? 'h-5 w-5' : 'h-7 w-7'} fill="none" aria-hidden="true">
      <path
        d="M16 68 H42 L53 34 L67 96 L78 52 L87 68 H112"
        stroke="#7BA7F7"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="112" cy="68" r="6" fill="#5EC6A8" />
    </svg>
  </div>
);

function renderMobileMarkdown(text: string): React.ReactNode {
  return text.split('\n').map((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return <div key={i} className="h-1" />;
    const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g).map((p, idx) => {
      if (p.startsWith('**') && p.endsWith('**')) {
        return (
          <strong key={idx} className="text-[var(--cs-ink)] font-semibold">
            {p.slice(2, -2)}
          </strong>
        );
      }
      if (p.startsWith('`') && p.endsWith('`')) {
        return (
          <code
            key={idx}
            className="bg-[var(--cs-well)] border border-[var(--cs-border)] px-1 rounded font-mono text-[11px] text-[var(--cs-accent-ink)]"
          >
            {p.slice(1, -1)}
          </code>
        );
      }
      if (p.startsWith('_') && p.endsWith('_') && p.length > 2) {
        return (
          <em key={idx} className="text-[var(--cs-ink-muted)] italic">
            {p.slice(1, -1)}
          </em>
        );
      }
      return <React.Fragment key={idx}>{p}</React.Fragment>;
    });
    if (trimmed.startsWith('### ')) {
      return (
        <div key={i} className="cs-heading font-bold text-[var(--cs-ink)] pt-1.5">
          {trimmed.slice(4)}
        </div>
      );
    }
    return <div key={i}>{parts}</div>;
  });
}

export const App: React.FC = () => {
  const [authed, setAuthed] = useState(Boolean(getMobileToken()));
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [authErr, setAuthErr] = useState<string | null>(null);
  const [authInfo, setAuthInfo] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    localStorage.getItem(MOBILE_THEME_KEY) === 'light' ? 'light' : 'dark',
  );

  const [tab, setTab] = useState<MobileTab>('copilot');
  const [profile, setProfile] = useState<{
    displayName: string;
    email: string;
  } | null>(null);
  const [devices, setDevices] = useState<Array<{ id: string; name: string; category: string; model: string }>>([]);
  const [cases, setCases] = useState<Array<{ id: string; title: string; status: string; totalExpense: number }>>([]);
  const [docs, setDocs] = useState<Array<{ id: string; title: string; pageCount: number; chunkCount: number }>>([]);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Mobile Copilot state
  const [invId, setInvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<
    Array<{
      id: string;
      role: string;
      content: string;
      aiProvider?: string;
      structuredInspection?: StructuredPcbInspection | null;
    }>
  >([]);
  const [hypotheses, setHypotheses] = useState<Array<{ id: string; title: string; discriminatingTest: string }>>([]);
  const [prompt, setPrompt] = useState('');
  const [photo, setPhoto] = useState<{ base64: string; mimeType: string; filename: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [mobileStreamText, setMobileStreamText] = useState<{ userText: string; text: string } | null>(null);

  // Quick Add Device / Case / Manual / Mobile standalone forms
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [newDevName, setNewDevName] = useState('');
  const [newCaseTitle, setNewCaseTitle] = useState('');
  const [expandedCaseId, setExpandedCaseId] = useState<string | null>(null);
  const [caseEntryText, setCaseEntryText] = useState('');
  const [caseExpenseItem, setCaseExpenseItem] = useState('');
  const [caseExpenseAmt, setCaseExpenseAmt] = useState('');
  const [manualQuery, setManualQuery] = useState('');
  const [manualHits, setManualHits] = useState<Array<{ documentTitle: string; pageNumber: number; sectionHeading: string; excerpt: string }>>([]);
  const [showAddManual, setShowAddManual] = useState(false);
  const [newManualTitle, setNewManualTitle] = useState('');
  const [newManualText, setNewManualText] = useState('');
  const [mobileServerUrl, setMobileServerUrl] = useState(() => getApiBaseUrl());
  const [mobileRelease, setMobileRelease] = useState<MobileReleaseInfo | null>(null);
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateCheckMsg, setUpdateCheckMsg] = useState<string | null>(null);
  const nativeApp = isNativeMobileApp();
  const hasNewerApk = Boolean(
    mobileRelease && isNewerMobileSemver(mobileRelease.version, CORESENSE_VERSION),
  );

  const handleCheckMobileUpdate = async () => {
    setCheckingUpdate(true);
    setUpdateCheckMsg(null);
    try {
      const rel = await fetchLatestMobileRelease();
      setMobileRelease(rel);
      if (isNewerMobileSemver(rel.version, CORESENSE_VERSION)) {
        setUpdateBannerDismissed(false);
        setUpdateCheckMsg(`Update available: CoreSense v${rel.version} signed APK.`);
      } else {
        setUpdateCheckMsg(`CoreSense v${CORESENSE_VERSION} is up to date.`);
      }
    } catch {
      setUpdateCheckMsg('Unable to check for updates right now.');
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleDownloadApk = (release?: MobileReleaseInfo | null) => {
    const target = release ?? mobileRelease;
    const version = target?.version || CORESENSE_VERSION;
    const url =
      target?.apkDownloadUrl ||
      `https://github.com/hrdk6/CoreSense/releases/latest/download/CoreSense_${version}_android.apk`;
    trackAndroidApkDownload(version);
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const camRef = useRef<HTMLInputElement | null>(null);

  const toggleTheme = () => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem(MOBILE_THEME_KEY, next);
      document.documentElement.classList.add('cs-theme-switching');
      document.documentElement.classList.toggle('dark', next === 'dark');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document.documentElement.classList.remove('cs-theme-switching');
        });
      });
      return next;
    });
  };

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const loadAll = async () => {
    try {
      const [me, devRes, caseRes, docRes, invRes] = await Promise.all([
        mobileApiRequest<{ user: typeof profile }>('/api/v1/account/me'),
        mobileApiRequest<{ devices: typeof devices }>('/api/v1/devices'),
        mobileApiRequest<{ cases: typeof cases }>('/api/v1/cases'),
        mobileApiRequest<{ documents: typeof docs }>('/api/v1/documents'),
        mobileApiRequest<{ investigations: Array<{ id: string }> }>('/api/v1/investigations'),
      ]);
      setProfile(me.user);
      setDevices(devRes.devices);
      setCases(caseRes.cases);
      setDocs(docRes.documents);
      if (!invId && invRes.investigations.length > 0) {
        const latestId = invRes.investigations[0].id;
        setInvId(latestId);
        const det = await mobileApiRequest<{
          investigation: { hypotheses: typeof hypotheses };
          messages: typeof messages;
        }>(`/api/v1/investigations/${latestId}`);
        setMessages(det.messages);
        setHypotheses(det.investigation.hypotheses);
      }
    } catch {
      setMobileToken(null);
      setAuthed(false);
    }
  };

  useEffect(() => {
    reportMobileActivation();
    fetchLatestMobileRelease()
      .then((rel) => setMobileRelease(rel))
      .catch(() => {});
    let unsub: () => void = () => {};
    initMobileSupabaseSync({
      onSession: (session) => {
        if (session?.access_token) {
          setAuthed(true);
        } else {
          setAuthed(false);
        }
      },
    })
      .then((fn) => {
        unsub = fn;
      })
      .catch(() => {});
    return () => unsub();
  }, []);

  useEffect(() => {
    if (authed) loadAll();
  }, [authed]);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthErr(null);
    setAuthInfo(null);
    try {
      const sb = await getMobileSupabaseClient();
      if (sb) {
        if (authMode === 'login') {
          const { data, error } = await sb.auth.signInWithPassword({
            email: email.trim(),
            password,
          });
          if (error) throw error;
          if (!data.session?.access_token) {
            throw new Error('Please confirm your email address first, then sign in.');
          }
          setMobileToken(data.session.access_token);
          setAuthed(true);
        } else {
          const cleanName = (displayName || email.split('@')[0]).trim();
          const { data, error } = await sb.auth.signUp({
            email: email.trim(),
            password,
            options: {
              emailRedirectTo: window.location.origin,
              data: { display_name: cleanName },
            },
          });
          if (error) throw error;
          if (data.session?.access_token) {
            setMobileToken(data.session.access_token);
            setAuthed(true);
          } else {
            setAuthInfo(`Account created! Check ${email.trim()} to verify your email, then sign in.`);
            setAuthMode('login');
          }
        }
        return;
      }

      const plat = (await detectMobilePlatform()).platform;
      const endpoint = authMode === 'login' ? '/api/v1/auth/login' : '/api/v1/auth/register';
      const res = await mobileApiRequest<{ accessToken: string }>(endpoint, {
        method: 'POST',
        skipAuth: true,
        body:
          authMode === 'login'
            ? { email, password, platform: plat, installId: getInstallId() }
            : {
                email,
                password,
                displayName: displayName || email.split('@')[0],
                platform: plat,
                installId: getInstallId(),
              },
      });
      setMobileToken(res.accessToken);
      setAuthed(true);
    } catch (err) {
      setAuthErr(err instanceof Error ? err.message : 'Unable to sign in. Check your credentials.');
    }
  };

  const handleVoiceDictate = () => {
    const SpeechRec =
      (window as unknown as { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => any }).webkitSpeechRecognition;
    if (!SpeechRec) return;
    const rec = new SpeechRec();
    rec.lang = 'en-US';
    rec.onresult = (ev: any) => {
      const txt = ev.results?.[0]?.[0]?.transcript || '';
      setPrompt((p) => (p ? `${p} ${txt}` : txt));
    };
    rec.start();
  };

  const handleSendCopilot = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = prompt.trim();
    if (!text || sending) return;
    const attached = photo;
    setSending(true);
    setPrompt('');
    setPhoto(null);
    setMobileStreamText({ userText: text, text: '' });

    let targetId = invId;
    try {
      const endpoint = targetId
        ? `/api/v1/investigations/${targetId}/messages/stream`
        : '/api/v1/investigations/stream';
      const body = targetId
        ? {
            message: text,
            inputModality: attached ? 'image' : 'text',
            imageBase64: attached?.base64,
            imageMimeType: attached?.mimeType,
            imageFilename: attached?.filename,
          }
        : {
            initialSymptom: text,
            deviceId: selectedDeviceId || undefined,
            inputModality: attached ? 'image' : 'text',
            imageBase64: attached?.base64,
            imageMimeType: attached?.mimeType,
            imageFilename: attached?.filename,
          };

      await mobileStreamSsePost(endpoint, body, {
        onMeta: (meta) => {
          const inv = meta.investigation as { id?: string } | undefined;
          if (inv?.id) targetId = inv.id;
        },
        onDelta: (chunk) => {
          setMobileStreamText((prev) => (prev ? { ...prev, text: prev.text + chunk } : prev));
        },
        onDone: (done) => {
          const inv = done.investigation as { id?: string } | undefined;
          if (inv?.id) targetId = inv.id;
        },
      });
    } catch {
      // Fallback to classic JSON request if SSE stream drops
      if (!targetId) {
        const res = await mobileApiRequest<{ investigation: { id: string } }>('/api/v1/investigations', {
          method: 'POST',
          body: {
            initialSymptom: text,
            deviceId: selectedDeviceId || undefined,
            inputModality: attached ? 'image' : 'text',
            imageBase64: attached?.base64,
            imageMimeType: attached?.mimeType,
            imageFilename: attached?.filename,
          },
        });
        targetId = res.investigation.id;
      } else {
        await mobileApiRequest(`/api/v1/investigations/${targetId}/messages`, {
          method: 'POST',
          body: {
            message: text,
            inputModality: attached ? 'image' : 'text',
            imageBase64: attached?.base64,
            imageMimeType: attached?.mimeType,
            imageFilename: attached?.filename,
          },
        });
      }
    } finally {
      setMobileStreamText(null);
      if (targetId) {
        setInvId(targetId);
        const det = await mobileApiRequest<{
          investigation: { hypotheses: typeof hypotheses };
          messages: typeof messages;
        }>(`/api/v1/investigations/${targetId}`);
        setMessages(det.messages);
        setHypotheses(det.investigation.hypotheses);
      }
      setSending(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const seq = getMobileSyncSeq();
      const res = await mobileApiRequest<{ latestSeq: number; changes: unknown[] }>(
        `/api/v1/sync/pull?sinceSeq=${seq}`,
      );
      setMobileSyncSeq(res.latestSeq);
      setSyncMsg(`Synced with desktop at cursor #${res.latestSeq} (${res.changes.length} updates).`);
      await loadAll();
    } finally {
      setSyncing(false);
    }
  };

  const handleQuickAddDevice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDevName.trim()) return;
    await mobileApiRequest('/api/v1/devices', {
      method: 'POST',
      body: { name: newDevName, category: 'smartphone', manufacturer: 'Mobile', model: 'Personal Phone' },
    });
    setNewDevName('');
    await loadAll();
  };

  const handleQuickAddCase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCaseTitle.trim()) return;
    await mobileApiRequest('/api/v1/cases', {
      method: 'POST',
      body: { title: newCaseTitle, symptomSummary: 'Created from CoreSense Mobile companion' },
    });
    setNewCaseTitle('');
    await loadAll();
  };

  const handleAddCaseNote = async (caseId: string) => {
    if (!caseEntryText.trim()) return;
    await mobileApiRequest(`/api/v1/cases/${caseId}/entries`, {
      method: 'POST',
      body: { entryType: 'note', title: 'Mobile Bench Note', body: caseEntryText },
    });
    setCaseEntryText('');
    setSyncMsg('Repair note saved & synced.');
    await loadAll();
  };

  const handleAddCaseExpense = async (caseId: string) => {
    if (!caseExpenseItem.trim() || !caseExpenseAmt) return;
    await mobileApiRequest(`/api/v1/cases/${caseId}/expenses`, {
      method: 'POST',
      body: { itemName: caseExpenseItem, amount: Number(caseExpenseAmt), category: 'part' },
    });
    setCaseExpenseItem('');
    setCaseExpenseAmt('');
    setSyncMsg('Repair part expense logged & synced.');
    await loadAll();
  };

  const handleMobileManualSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (manualQuery.trim().length < 2) return;
    const res = await mobileApiRequest<{ results: typeof manualHits }>(
      `/api/v1/documents/search?q=${encodeURIComponent(manualQuery)}`,
    );
    setManualHits(res.results);
  };

  const handleMobileAddManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newManualTitle.trim() || !newManualText.trim()) return;
    await mobileApiRequest('/api/v1/documents', {
      method: 'POST',
      body: {
        title: newManualTitle,
        filename: `${newManualTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`,
        mimeType: 'text/markdown',
        contentText: newManualText,
      },
    });
    setNewManualTitle('');
    setNewManualText('');
    setShowAddManual(false);
    setSyncMsg('Service manual indexed and synced.');
    await loadAll();
  };

  const handleMobileExport = async () => {
    const data = await mobileApiRequest<Record<string, unknown>>('/api/v1/account/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `coresense-mobile-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!authed) {
    return (
      <div className="min-h-screen bg-[var(--cs-chassis)] flex items-center justify-center p-5">
        <div className="w-full max-w-sm cs-panel p-6 space-y-5 cs-animate-view">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <MobileMark />
              <div>
                <h1 className="cs-heading text-lg font-bold text-[var(--cs-ink)]">CoreSense Mobile</h1>
                <p className="text-xs text-[var(--cs-ink-muted)]">Portable repair companion</p>
              </div>
            </div>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle theme"
              className="cs-btn-secondary h-8 w-8 flex items-center justify-center cursor-pointer"
            >
              {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </button>
          </div>

          <div className="relative grid grid-cols-2 p-1 rounded-lg bg-[var(--cs-well)] border border-[var(--cs-border)]">
            <div
              aria-hidden="true"
              className="absolute top-1 bottom-1 left-1 w-[calc(50%-4px)] rounded-md bg-[var(--cs-surface)] border border-[var(--cs-border)] transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
              style={{ transform: `translateX(${authMode === 'login' ? 0 : 100}%)` }}
            />
            <button
              type="button"
              onClick={() => setAuthMode('login')}
              className={`relative z-10 py-2 text-xs font-semibold cursor-pointer ${
                authMode === 'login' ? 'text-[var(--cs-ink)]' : 'text-[var(--cs-ink-muted)]'
              }`}
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => setAuthMode('register')}
              className={`relative z-10 py-2 text-xs font-semibold cursor-pointer ${
                authMode === 'register' ? 'text-[var(--cs-ink)]' : 'text-[var(--cs-ink-muted)]'
              }`}
            >
              Create account
            </button>
          </div>

          <form onSubmit={handleAuth} className="space-y-3">
            {authMode === 'register' && (
              <input
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Display name"
                className="cs-input w-full px-3.5 py-2.5 text-sm"
              />
            )}
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email (same account as desktop)"
              className="cs-input w-full px-3.5 py-2.5 text-sm"
            />
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="cs-input w-full px-3.5 py-2.5 text-sm"
            />
            {authErr && (
              <div className="rounded-md bg-[var(--cs-danger-soft)] border border-[var(--cs-danger-border)] px-3 py-2 text-xs text-[var(--cs-danger-ink)]">
                {authErr}
              </div>
            )}
            {authInfo && (
              <div className="rounded-md bg-[var(--cs-ok-soft)] border border-[var(--cs-ok-border)] px-3 py-2 text-xs text-[var(--cs-ok-ink)]">
                {authInfo}
              </div>
            )}
            <button type="submit" className="cs-btn-primary w-full py-2.5 text-sm cursor-pointer">
              {authMode === 'login' ? 'Sign in' : 'Create mobile account'}
            </button>
          </form>

          {!nativeApp && (
            <div className="pt-3 border-t border-[var(--cs-border)] space-y-2">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-semibold text-[var(--cs-ink)] flex items-center gap-1.5">
                  <Smartphone className="h-3.5 w-3.5 text-[var(--cs-accent)]" />
                  <span>Native Android App</span>
                </span>
                <span className="font-mono text-[10px] text-[var(--cs-ink-muted)]">
                  v{mobileRelease?.version || CORESENSE_VERSION} · Signed APK
                </span>
              </div>
              <button
                type="button"
                onClick={() => handleDownloadApk(mobileRelease)}
                className="cs-btn-secondary w-full py-2 text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer"
              >
                <Download className="h-3.5 w-3.5 text-[var(--cs-accent)]" />
                <span>Download CoreSense Android (.apk)</span>
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-dvh overflow-hidden bg-[var(--cs-chassis)] flex justify-center">
      <div className="w-full max-w-md h-full bg-[var(--cs-canvas)] border-x border-[var(--cs-border)] flex flex-col overflow-hidden">
        {/* Top App Bar */}
        <header className="shrink-0 px-4 py-3 border-b border-[var(--cs-border)] bg-[var(--cs-surface)] flex items-center justify-between z-20">
          <div className="flex items-center gap-2.5">
            <MobileMark small />
            <div>
              <div className="cs-heading text-sm font-bold text-[var(--cs-ink)] leading-none">
                CoreSense
              </div>
              <div className="text-[11px] text-[var(--cs-ink-muted)] mt-0.5">Portable companion</div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleSync}
              className="cs-btn-secondary flex items-center gap-1 px-2.5 py-1.5 text-xs cursor-pointer"
            >
              <RefreshCw className={`h-3 w-3 text-[var(--cs-accent)] ${syncing ? 'animate-spin' : ''}`} />
              <span>Sync</span>
            </button>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle theme"
              className="cs-btn-secondary h-8 w-8 flex items-center justify-center cursor-pointer"
            >
              {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </button>
          </div>
        </header>

        {hasNewerApk && !updateBannerDismissed && mobileRelease && (
          <div className="shrink-0 px-4 py-2 bg-[var(--cs-accent-soft)] border-b border-[var(--cs-accent-border)] flex items-center justify-between gap-2 text-xs">
            <div className="min-w-0">
              <span className="font-semibold text-[var(--cs-ink)]">
                Update available: v{mobileRelease.version}
              </span>
              <span className="text-[var(--cs-ink-muted)] ml-1.5 text-[11px]">Signed Android APK</span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => handleDownloadApk(mobileRelease)}
                className="cs-btn-primary px-2.5 py-1 text-[11px] flex items-center gap-1 cursor-pointer"
              >
                <Download className="h-3 w-3" />
                <span>Download</span>
              </button>
              <button
                type="button"
                onClick={() => setUpdateBannerDismissed(true)}
                aria-label="Dismiss update banner"
                className="text-[var(--cs-ink-muted)] hover:text-[var(--cs-ink)] cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Main Viewport Body */}
        <main
          key={tab}
          className={`flex-1 min-h-0 cs-animate-view ${
            tab === 'copilot' ? 'flex flex-col overflow-hidden' : 'overflow-y-auto px-4 pt-4 pb-6'
          }`}
        >
          {syncMsg && (
            <div className={`${tab === 'copilot' ? 'mx-4 mt-3' : 'mb-3'} rounded-lg bg-[var(--cs-ok-soft)] border border-[var(--cs-ok-border)] px-3 py-2 text-xs text-[var(--cs-ok-ink)] flex justify-between gap-2 cs-animate-view shrink-0`}>
              <span>{syncMsg}</span>
              <button type="button" onClick={() => setSyncMsg(null)} className="cursor-pointer">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {tab === 'copilot' && (
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              <div className="shrink-0 px-4 pt-3 pb-2.5 flex items-center justify-between gap-2 border-b border-[var(--cs-border)] bg-[var(--cs-canvas)]">
                <h1 className="cs-heading text-base font-bold text-[var(--cs-ink)] shrink-0">Repair copilot</h1>
                <div className="flex items-center gap-2 min-w-0">
                  {!invId && devices.length > 0 && (
                    <select
                      value={selectedDeviceId}
                      onChange={(e) => setSelectedDeviceId(e.target.value)}
                      className="cs-input px-2 py-1 text-[11px] max-w-[120px] truncate"
                    >
                      <option value="">Any device</option>
                      {devices.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setInvId(null);
                      setMessages([]);
                      setHypotheses([]);
                    }}
                    className="text-xs text-[var(--cs-accent)] font-semibold shrink-0 cursor-pointer"
                  >
                    + New
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
                {hypotheses.length > 0 && (
                  <div className="rounded-lg bg-[var(--cs-surface)] border border-[var(--cs-border)] border-l-[3px] border-l-[var(--cs-accent)] p-3 space-y-1">
                    <div className="text-[11px] font-semibold text-[var(--cs-accent-ink)]">
                      Leading hypothesis
                    </div>
                    <div className="text-xs font-semibold text-[var(--cs-ink)]">{hypotheses[0].title}</div>
                    <div className="text-xs text-[var(--cs-ink-2)]">{hypotheses[0].discriminatingTest}</div>
                  </div>
                )}

                <div className="space-y-2.5">
                  {messages.length === 0 && !mobileStreamText ? (
                    <div className="cs-panel p-5 space-y-3">
                      <div className="h-9 w-9 rounded-lg bg-[var(--cs-chassis)] border border-[var(--cs-border)] flex items-center justify-center">
                        <Wrench className="h-4 w-4 text-[var(--cs-accent)]" />
                      </div>
                      <div className="space-y-1">
                        <div className="cs-heading text-sm font-bold text-[var(--cs-ink)]">
                          Camera, voice, or text diagnosis
                        </div>
                        <p className="text-xs text-[var(--cs-ink-muted)] leading-relaxed">
                          Photograph a board or port, dictate a fault, or continue an investigation synced from desktop.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setPrompt("My phone's Wi-Fi stopped working.")}
                        className="cs-btn-secondary w-full text-left py-2.5 px-3 text-xs cursor-pointer"
                      >
                        Try: "My phone's Wi-Fi stopped working."
                      </button>
                    </div>
                  ) : (
                    messages.map((m) => (
                      <div
                        key={m.id}
                        className={`rounded-lg p-3 text-xs leading-relaxed whitespace-pre-wrap ${
                          m.role === 'user'
                            ? 'bg-[var(--cs-well)] border border-[var(--cs-border)] ml-6 text-[var(--cs-ink)]'
                            : 'bg-[var(--cs-surface)] border border-[var(--cs-border)] border-l-[3px] border-l-[var(--cs-accent)] mr-3 text-[var(--cs-ink-2)]'
                        }`}
                      >
                        {m.role === 'assistant' ? (
                          <div className="space-y-1">{renderMobileMarkdown(m.content)}</div>
                        ) : (
                          m.content
                        )}
                        {m.role === 'assistant' && m.structuredInspection && (
                          <div className="mt-2.5 rounded-md bg-[var(--cs-canvas)] border border-[var(--cs-border)] p-2.5 space-y-2 whitespace-normal">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-[11px] text-[var(--cs-ink)]">
                                PCB Vision: {m.structuredInspection.boardOrDeviceType}
                              </span>
                              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[var(--cs-well)] border border-[var(--cs-border)] text-[var(--cs-accent-ink)]">
                                {m.structuredInspection.imageClarity.replace(/_/g, ' ')}
                              </span>
                            </div>
                            {m.structuredInspection.identifiedComponents.length > 0 && (
                              <div className="space-y-1">
                                {m.structuredInspection.identifiedComponents.slice(0, 6).map((c, idx) => (
                                  <div
                                    key={idx}
                                    className="rounded bg-[var(--cs-surface)] border border-[var(--cs-border)] px-2 py-1.5 text-[11px] space-y-0.5"
                                  >
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="font-mono font-semibold text-[var(--cs-ink)]">
                                        {c.designator} · {c.componentType}
                                      </span>
                                      <span
                                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                                          c.visualCondition === 'normal'
                                            ? 'bg-[var(--cs-ok-soft)] border-[var(--cs-ok-border)] text-[var(--cs-ok-ink)]'
                                            : c.visualCondition === 'unreadable'
                                              ? 'bg-[var(--cs-well)] border-[var(--cs-border)] text-[var(--cs-ink-muted)]'
                                              : 'bg-[var(--cs-danger-soft)] border-[var(--cs-danger-border)] text-[var(--cs-danger-ink)]'
                                        }`}
                                      >
                                        {c.visualCondition.replace(/_/g, ' ')}
                                      </span>
                                    </div>
                                    <div className="text-[var(--cs-ink-2)]">{c.visualEvidence}</div>
                                  </div>
                                ))}
                              </div>
                            )}
                            {m.structuredInspection.electricalTestsRequired.length > 0 && (
                              <div className="text-[11px] text-[var(--cs-ink-2)] pt-1 border-t border-[var(--cs-border)]">
                                <span className="font-semibold text-[var(--cs-ink)]">Confirm electrically: </span>
                                {m.structuredInspection.electricalTestsRequired[0].target} —{' '}
                                {m.structuredInspection.electricalTestsRequired[0].testMethod}
                              </div>
                            )}
                            <div className="text-[10px] text-[var(--cs-ink-muted)] italic">
                              {m.structuredInspection.disclaimer}
                            </div>
                          </div>
                        )}
                        {m.aiProvider && (
                          <div className="mt-2 pt-1.5 border-t border-[var(--cs-border)] text-[10px] font-mono text-[var(--cs-ink-muted)]">
                            Engine: {m.aiProvider}
                          </div>
                        )}
                      </div>
                    ))
                  )}

                  {mobileStreamText && (
                    <div className="space-y-2">
                      <div className="rounded-lg p-3 text-xs leading-relaxed whitespace-pre-wrap bg-[var(--cs-well)] border border-[var(--cs-border)] ml-6 text-[var(--cs-ink)]">
                        {mobileStreamText.userText}
                      </div>
                      <div className="rounded-lg p-3 text-xs leading-relaxed bg-[var(--cs-surface)] border border-[var(--cs-border)] border-l-[3px] border-l-[var(--cs-accent)] mr-3 text-[var(--cs-ink-2)]">
                        {mobileStreamText.text ? (
                          <div className="space-y-1">
                            {renderMobileMarkdown(mobileStreamText.text)}
                            <span className="inline-block w-1.5 h-3 bg-[var(--cs-accent)] animate-pulse align-middle" />
                          </div>
                        ) : (
                          <span className="text-[var(--cs-ink-muted)]">Streaming live diagnosis...</span>
                        )}
                      </div>
                    </div>
                  )}

                  {sending && !mobileStreamText && (
                    <div className="flex items-center gap-2.5 rounded-lg bg-[var(--cs-surface)] border border-[var(--cs-border)] p-3 text-xs text-[var(--cs-ink-muted)]">
                      <div className="flex items-end gap-0.5 h-3">
                        {[0, 90, 180, 270].map((d) => (
                          <span
                            key={d}
                            className="w-1 h-full bg-[var(--cs-accent)] cs-animate-eq"
                            style={{ animationDelay: `${d}ms` }}
                          />
                        ))}
                      </div>
                      <span>Analyzing fault...</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Pinned Mobile Composer */}
              <form
                onSubmit={handleSendCopilot}
                className="shrink-0 px-3.5 py-2.5 border-t border-[var(--cs-border)] bg-[var(--cs-surface)] space-y-2"
              >
                {photo && (
                  <div className="flex items-center justify-between rounded-lg bg-[var(--cs-canvas)] border border-[var(--cs-accent-border)] px-3 py-1.5 text-xs">
                    <span className="truncate text-[var(--cs-ink)] font-medium">{photo.filename}</span>
                    <button type="button" onClick={() => setPhoto(null)} className="cursor-pointer">
                      <X className="h-4 w-4 text-[var(--cs-ink-muted)]" />
                    </button>
                  </div>
                )}
                <div className="flex items-center gap-1.5">
                  <input
                    ref={camRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      const r = new FileReader();
                      r.onload = () => setPhoto({ base64: String(r.result || ''), mimeType: f.type, filename: f.name });
                      r.readAsDataURL(f);
                    }}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => camRef.current?.click()}
                    className="cs-btn-secondary h-10 w-10 shrink-0 flex items-center justify-center cursor-pointer"
                    title="Camera capture"
                    aria-label="Camera capture"
                  >
                    <Camera className="h-4 w-4 text-[var(--cs-accent)]" />
                  </button>
                  <button
                    type="button"
                    onClick={handleVoiceDictate}
                    className="cs-btn-secondary h-10 w-10 shrink-0 flex items-center justify-center cursor-pointer"
                    title="Voice input"
                    aria-label="Voice input"
                  >
                    <Mic className="h-4 w-4 text-[var(--cs-ink-2)]" />
                  </button>
                  <input
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="Describe fault or component..."
                    className="cs-input flex-1 min-w-0 h-10 px-3 text-xs"
                  />
                  <button
                    type="submit"
                    disabled={sending || !prompt.trim()}
                    className="cs-btn-primary h-10 w-10 shrink-0 flex items-center justify-center cursor-pointer disabled:opacity-40"
                    aria-label="Send message"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </div>
              </form>
            </div>
          )}

          {tab === 'phone' && (
            <PhoneDiagnosticsTab
              onSendPhotoToCopilot={(captured) => {
                setPhoto(captured);
                setPrompt('What is this component and is there visible damage?');
                setTab('copilot');
              }}
            />
          )}

          {tab === 'devices' && (
            <div className="space-y-5">
              <div className="space-y-2.5">
                <h1 className="cs-heading text-base font-bold text-[var(--cs-ink)]">
                  Synced devices ({devices.length})
                </h1>
                <form onSubmit={handleQuickAddDevice} className="flex gap-2">
                  <input
                    value={newDevName}
                    onChange={(e) => setNewDevName(e.target.value)}
                    placeholder="Add phone, laptop, or console..."
                    className="cs-input flex-1 px-3 py-2 text-xs"
                  />
                  <button type="submit" className="cs-btn-primary px-3 text-xs cursor-pointer">
                    <Plus className="h-4 w-4" />
                  </button>
                </form>
                <div className="space-y-2">
                  {devices.map((d) => (
                    <div key={d.id} className="cs-panel p-3 flex justify-between items-center">
                      <div>
                        <div className="text-xs font-semibold text-[var(--cs-ink)]">{d.name}</div>
                        <div className="text-[11px] text-[var(--cs-ink-muted)]">{d.model || d.category}</div>
                      </div>
                      <span className="text-[11px] rounded bg-[var(--cs-well)] px-2 py-0.5 text-[var(--cs-ink-2)] capitalize">
                        {d.category.replace('_', ' ')}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-2.5 pt-3 border-t border-[var(--cs-border)]">
                <h2 className="cs-heading text-base font-bold text-[var(--cs-ink)]">
                  Repair cases ({cases.length})
                </h2>
                <form onSubmit={handleQuickAddCase} className="flex gap-2">
                  <input
                    value={newCaseTitle}
                    onChange={(e) => setNewCaseTitle(e.target.value)}
                    placeholder="New repair case title..."
                    className="cs-input flex-1 px-3 py-2 text-xs"
                  />
                  <button type="submit" className="cs-btn-accent px-3 text-xs cursor-pointer">
                    <Plus className="h-4 w-4" />
                  </button>
                </form>
                <div className="space-y-2">
                  {cases.map((c) => {
                    const expanded = expandedCaseId === c.id;
                    return (
                      <div key={c.id} className="cs-panel p-3 space-y-2.5">
                        <button
                          type="button"
                          onClick={() => setExpandedCaseId(expanded ? null : c.id)}
                          className="w-full flex justify-between items-center text-xs text-left cursor-pointer"
                        >
                          <span className="font-semibold text-[var(--cs-ink)]">{c.title}</span>
                          <span className="font-mono text-[var(--cs-ok-ink)] cs-tabular">
                            ${Number(c.totalExpense || 0).toFixed(2)}
                          </span>
                        </button>
                        {expanded && (
                          <div className="pt-2 border-t border-[var(--cs-border)] space-y-2">
                            <div className="flex gap-1.5">
                              <input
                                value={caseEntryText}
                                onChange={(e) => setCaseEntryText(e.target.value)}
                                placeholder="Log note or multimeter reading..."
                                className="cs-input flex-1 px-2.5 py-1.5 text-xs"
                              />
                              <button
                                type="button"
                                onClick={() => handleAddCaseNote(c.id)}
                                className="cs-btn-secondary px-2.5 py-1.5 text-[11px] font-semibold cursor-pointer"
                              >
                                Save
                              </button>
                            </div>
                            <div className="flex gap-1.5">
                              <input
                                value={caseExpenseItem}
                                onChange={(e) => setCaseExpenseItem(e.target.value)}
                                placeholder="Part name"
                                className="cs-input flex-1 px-2.5 py-1.5 text-xs"
                              />
                              <input
                                type="number"
                                min={0}
                                step="0.01"
                                value={caseExpenseAmt}
                                onChange={(e) => setCaseExpenseAmt(e.target.value)}
                                placeholder="$"
                                className="cs-input w-16 px-2 py-1.5 text-xs font-mono"
                              />
                              <button
                                type="button"
                                onClick={() => handleAddCaseExpense(c.id)}
                                className="cs-btn-accent px-2.5 py-1.5 text-[11px] cursor-pointer"
                              >
                                +Cost
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {tab === 'manuals' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h1 className="cs-heading text-base font-bold text-[var(--cs-ink)]">
                  Service manuals ({docs.length})
                </h1>
                <button
                  type="button"
                  onClick={() => setShowAddManual((v) => !v)}
                  className="text-xs font-semibold text-[var(--cs-accent)] cursor-pointer"
                >
                  {showAddManual ? 'Close' : '+ Index notes'}
                </button>
              </div>

              {showAddManual && (
                <form onSubmit={handleMobileAddManual} className="cs-panel p-3 space-y-2">
                  <input
                    required
                    value={newManualTitle}
                    onChange={(e) => setNewManualTitle(e.target.value)}
                    placeholder="Manual title (e.g. Pixel 8 Board Pinout)"
                    className="cs-input w-full px-3 py-2 text-xs"
                  />
                  <textarea
                    required
                    rows={3}
                    value={newManualText}
                    onChange={(e) => setNewManualText(e.target.value)}
                    placeholder="Paste repair specs, error codes, or schematic notes..."
                    className="cs-input w-full px-3 py-2 text-xs font-mono"
                  />
                  <button type="submit" className="cs-btn-primary w-full py-2 text-xs cursor-pointer">
                    Index & sync manual
                  </button>
                </form>
              )}

              <form onSubmit={handleMobileManualSearch} className="flex gap-1.5">
                <input
                  value={manualQuery}
                  onChange={(e) => setManualQuery(e.target.value)}
                  placeholder="Search manuals for error codes or specs..."
                  className="cs-input flex-1 px-3 py-2 text-xs"
                />
                <button type="submit" className="cs-btn-secondary px-3 cursor-pointer" aria-label="Search manuals">
                  <Search className="h-3.5 w-3.5" />
                </button>
              </form>

              {manualHits.length > 0 && (
                <div className="space-y-2">
                  {manualHits.map((h, i) => (
                    <div key={i} className="cs-panel p-3 border-l-[3px] border-l-[var(--cs-accent)] space-y-1">
                      <div className="text-[11px] font-semibold text-[var(--cs-accent-ink)]">
                        {h.documentTitle} · p.{h.pageNumber}
                      </div>
                      <p className="text-xs text-[var(--cs-ink-2)] line-clamp-3">{h.excerpt}</p>
                    </div>
                  ))}
                </div>
              )}

              {docs.length === 0 ? (
                <div className="cs-panel p-6 text-center text-xs text-[var(--cs-ink-muted)]">
                  No manuals indexed yet. Add notes above or upload PDFs on desktop.
                </div>
              ) : (
                docs.map((doc) => (
                  <div key={doc.id} className="cs-panel p-3.5 space-y-1">
                    <div className="text-xs font-semibold text-[var(--cs-ink)]">{doc.title}</div>
                    <div className="text-[11px] font-mono text-[var(--cs-ink-muted)] cs-tabular">
                      {doc.pageCount} page(s) / {doc.chunkCount} searchable chunks
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {tab === 'account' && profile && (
            <div className="space-y-3.5">
              <div className="cs-panel p-4 space-y-2">
                <div>
                  <div className="cs-heading text-sm font-bold text-[var(--cs-ink)]">{profile.displayName}</div>
                  <div className="text-xs text-[var(--cs-ink-muted)]">{profile.email}</div>
                </div>
                <div className="grid grid-cols-3 gap-2 pt-2 border-t border-[var(--cs-border)]">
                  <div className="rounded-md bg-[var(--cs-canvas)] border border-[var(--cs-border)] px-2.5 py-1.5">
                    <div className="text-[10px] text-[var(--cs-ink-muted)]">Devices</div>
                    <div className="font-mono text-sm font-bold text-[var(--cs-ink)] cs-tabular">{devices.length}</div>
                  </div>
                  <div className="rounded-md bg-[var(--cs-canvas)] border border-[var(--cs-border)] px-2.5 py-1.5">
                    <div className="text-[10px] text-[var(--cs-ink-muted)]">Cases</div>
                    <div className="font-mono text-sm font-bold text-[var(--cs-ink)] cs-tabular">{cases.length}</div>
                  </div>
                  <div className="rounded-md bg-[var(--cs-canvas)] border border-[var(--cs-border)] px-2.5 py-1.5">
                    <div className="text-[10px] text-[var(--cs-ink-muted)]">Manuals</div>
                    <div className="font-mono text-sm font-bold text-[var(--cs-ink)] cs-tabular">{docs.length}</div>
                  </div>
                </div>
              </div>

              <div className="cs-panel p-3.5 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold text-[var(--cs-ink)] flex items-center gap-1.5">
                    <Smartphone className="h-3.5 w-3.5 text-[var(--cs-accent)]" />
                    <span>Android App &amp; Updates</span>
                  </div>
                  <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[var(--cs-canvas)] border border-[var(--cs-border)] text-[var(--cs-ink-muted)]">
                    v{CORESENSE_VERSION} · {nativeApp ? 'APK' : 'PWA'}
                  </span>
                </div>
                <p className="text-[11px] text-[var(--cs-ink-muted)] leading-relaxed">
                  {nativeApp
                    ? 'Installed via cryptographically signed CoreSense Android APK. Tap below to check GitHub Releases for newer signed updates.'
                    : 'Install the signed native Android .apk directly (100% free, zero Play Store required) for offline access, native camera/sensors, and home-screen launch.'}
                </p>
                {updateCheckMsg && (
                  <div className="rounded-md bg-[var(--cs-canvas)] border border-[var(--cs-border)] px-2.5 py-1.5 text-[11px] text-[var(--cs-ink-2)]">
                    {updateCheckMsg}
                  </div>
                )}
                <div className="flex gap-2">
                  {(!nativeApp || hasNewerApk) && (
                    <button
                      type="button"
                      onClick={() => handleDownloadApk(mobileRelease)}
                      className="cs-btn-primary flex-1 py-2 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>
                        {hasNewerApk && mobileRelease
                          ? `Download v${mobileRelease.version} APK`
                          : `Download Android APK (v${mobileRelease?.version || CORESENSE_VERSION})`}
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={checkingUpdate}
                    onClick={handleCheckMobileUpdate}
                    className={`cs-btn-secondary ${nativeApp && !hasNewerApk ? 'flex-1' : 'px-3'} py-2 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-60`}
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${checkingUpdate ? 'animate-spin' : ''}`} />
                    <span>{nativeApp && !hasNewerApk ? 'Check for App Updates' : 'Check'}</span>
                  </button>
                </div>
              </div>

              <div className="cs-panel p-3.5 space-y-2">
                <div className="text-xs font-semibold text-[var(--cs-ink)] flex items-center gap-1.5">
                  <Globe className="h-3.5 w-3.5 text-[var(--cs-accent)]" />
                  <span>Backend API server</span>
                </div>
                <div className="flex gap-1.5">
                  <input
                    value={mobileServerUrl}
                    onChange={(e) => setMobileServerUrl(e.target.value)}
                    placeholder="https://api.coresense.app"
                    className="cs-input flex-1 px-2.5 py-1.5 text-[11px] font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setMobileApiBaseUrl(mobileServerUrl);
                      setSyncMsg(`Server endpoint updated to ${mobileServerUrl}.`);
                    }}
                    className="cs-btn-secondary px-3 py-1.5 text-[11px] font-semibold cursor-pointer"
                  >
                    Save
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={handleSync}
                className="cs-btn-secondary w-full flex items-center justify-center gap-2 py-2.5 text-xs font-semibold cursor-pointer"
              >
                <Cloud className="h-4 w-4 text-[var(--cs-accent)]" />
                <span>Pull latest desktop sync</span>
              </button>

              <button
                type="button"
                onClick={handleMobileExport}
                className="cs-btn-secondary w-full flex items-center justify-center gap-2 py-2.5 text-xs font-semibold cursor-pointer"
              >
                <Download className="h-4 w-4 text-[var(--cs-ok)]" />
                <span>Export personal data (JSON)</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  void signOutMobileSupabase();
                  setMobileToken(null);
                  setAuthed(false);
                }}
                className="w-full flex items-center justify-center gap-2 rounded-lg border border-[var(--cs-danger-border)] bg-[var(--cs-danger-soft)] py-2.5 text-xs font-semibold text-[var(--cs-danger-ink)] cursor-pointer"
              >
                <LogOut className="h-4 w-4" />
                <span>Sign out</span>
              </button>
            </div>
          )}
        </main>

        {/* Bottom Navigation Bar */}
        <nav className="shrink-0 w-full border-t border-[var(--cs-border)] bg-[var(--cs-surface)] grid grid-cols-5 z-20">
          {[
            { id: 'copilot', label: 'Copilot', icon: MessageSquare },
            { id: 'phone', label: 'Checks', icon: Activity },
            { id: 'devices', label: 'Devices', icon: Laptop },
            { id: 'manuals', label: 'Manuals', icon: BookOpen },
            { id: 'account', label: 'Account', icon: User },
          ].map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id as MobileTab)}
                className={`relative flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium transition-colors cursor-pointer ${
                  active ? 'text-[var(--cs-accent)] font-semibold' : 'text-[var(--cs-ink-muted)]'
                }`}
              >
                <span
                  className={`absolute top-0 left-3 right-3 h-[2.5px] bg-[var(--cs-accent)] transition-transform duration-200 ${
                    active ? 'scale-x-100' : 'scale-x-0'
                  }`}
                />
                <Icon className="h-4 w-4" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
};
