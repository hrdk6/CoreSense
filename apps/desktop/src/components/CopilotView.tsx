import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Download,
  FileCheck2,
  Image as ImageIcon,
  Layers,
  Mic,
  MicOff,
  Play,
  Plus,
  Send,
  ShieldAlert,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { EvidenceItem, ExpertiseMode, Hypothesis, VerificationReport } from '@coresense/shared';
import { apiRequest } from '../api';
import { MarkdownBlock } from './MarkdownBlock';

interface DeviceOption {
  id: string;
  name: string;
  category: string;
  manufacturer: string;
  model: string;
}

interface InvestigationSummary {
  id: string;
  deviceId: string | null;
  deviceName: string | null;
  title: string;
  initialSymptom: string;
  expertiseMode: ExpertiseMode;
  status: string;
  verificationOutcome: string | null;
  hypothesisCount: number;
  evidenceCount: number;
  safetyFlagCount: number;
  updatedAt: string;
}

interface ProposedTool {
  id: string;
  toolId: string;
  toolName: string;
  reason: string;
  riskLevel: 'read_only' | 'user_guided' | 'system_modifying';
  requiresExplicitApproval: boolean;
  approvalWarning?: string;
  parameters: Record<string, unknown>;
  status: string;
}

interface MessageItem {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  inputModality: string;
  attachments: Array<{ id: string; filename: string; clarityNote: string }>;
  citations: Array<{ documentTitle: string; pageNumber: number; sectionHeading: string; excerpt: string }>;
  toolCalls: ProposedTool[];
  aiProvider?: string | null;
  aiModel?: string | null;
  createdAt: string;
}

interface InvestigationDetail {
  id: string;
  deviceId: string | null;
  title: string;
  initialSymptom: string;
  expertiseMode: ExpertiseMode;
  status: string;
  verificationOutcome: string | null;
  verificationReport: VerificationReport | null;
  evidence: EvidenceItem[];
  hypotheses: Hypothesis[];
  pendingTools: ProposedTool[];
  safetyFlags: Array<{ code: string; title: string; severity: string }>;
  baselineSnapshotId: string | null;
  followupSnapshotId: string | null;
}

function formatLabel(raw: string): string {
  const spaced = raw.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function hypothesisStatusStyle(status: string): string {
  switch (status) {
    case 'confirmed':
    case 'strengthened':
      return 'bg-[var(--cs-ok-soft)] text-[var(--cs-ok-ink)] border-[var(--cs-ok-border)]';
    case 'ruled_out':
      return 'bg-[var(--cs-well)] text-[var(--cs-ink-muted)] border-[var(--cs-border)] line-through';
    case 'weakened':
      return 'bg-[var(--cs-warn-soft)] text-[var(--cs-warn-ink)] border-[var(--cs-warn-border)]';
    default:
      return 'bg-[var(--cs-accent-soft)] text-[var(--cs-accent-ink)] border-[var(--cs-accent-border)]';
  }
}

function provenanceStyle(type: string): string {
  switch (type) {
    case 'measured':
      return 'bg-[var(--cs-ok-soft)] text-[var(--cs-ok-ink)] border-[var(--cs-ok-border)]';
    case 'simulated':
      return 'bg-[var(--cs-warn-soft)] text-[var(--cs-warn-ink)] border-[var(--cs-warn-border)]';
    case 'unavailable':
      return 'bg-[var(--cs-danger-soft)] text-[var(--cs-danger-ink)] border-[var(--cs-danger-border)]';
    default:
      return 'bg-[var(--cs-well)] text-[var(--cs-ink-2)] border-[var(--cs-border)]';
  }
}

export const CopilotView: React.FC<{
  devices: DeviceOption[];
  expertiseMode: ExpertiseMode;
}> = ({ devices, expertiseMode }) => {
  const [investigations, setInvestigations] = useState<InvestigationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<InvestigationDetail | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [draft, setDraft] = useState('');
  const [imagePreview, setImagePreview] = useState<{ base64: string; mimeType: string; filename: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [runningToolId, setRunningToolId] = useState<string | null>(null);
  const [approvalModalTool, setApprovalModalTool] = useState<ProposedTool | null>(null);
  const [inspectorTab, setInspectorTab] = useState<'hypotheses' | 'evidence' | 'verify'>('hypotheses');
  const [listening, setListening] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(false);
  const [measurementModal, setMeasurementModal] = useState(false);
  const [measTitle, setMeasTitle] = useState('');
  const [measValue, setMeasValue] = useState('');
  const [measInstrument, setMeasInstrument] = useState('Digital Multimeter');
  const [verifyStatus, setVerifyStatus] = useState<'resolved' | 'improved' | 'unchanged' | 'worsened' | 'unknown'>('resolved');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  const inspectorIndex = inspectorTab === 'hypotheses' ? 0 : inspectorTab === 'evidence' ? 1 : 2;

  const loadInvestigations = async (autoSelectFirst = true) => {
    const res = await apiRequest<{ investigations: InvestigationSummary[] }>('/api/v1/investigations');
    setInvestigations(res.investigations);
    if (autoSelectFirst && !selectedId && res.investigations.length > 0) {
      setSelectedId(res.investigations[0].id);
    }
  };

  const loadDetail = async (id: string) => {
    const res = await apiRequest<{ investigation: InvestigationDetail; messages: MessageItem[] }>(
      `/api/v1/investigations/${id}`,
    );
    setDetail(res.investigation);
    setMessages(res.messages);
  };

  useEffect(() => {
    loadInvestigations(true).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedId) {
      loadDetail(selectedId).catch((e) => setError(e instanceof Error ? e.message : 'Unable to load investigation.'));
    } else {
      setDetail(null);
      setMessages([]);
    }
  }, [selectedId]);

  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, [messages.length, sending]);

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setApprovalModalTool(null);
        setMeasurementModal(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const speakText = (text: string) => {
    if (!speakReplies || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const cleaned = text.replace(/[#*_`>-]/g, ' ').slice(0, 700);
    const u = new SpeechSynthesisUtterance(cleaned);
    u.rate = 1.04;
    window.speechSynthesis.speak(u);
  };

  const toggleVoiceInput = () => {
    const SpeechRec =
      (window as unknown as { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => any }).webkitSpeechRecognition;
    if (!SpeechRec) {
      setError('Speech recognition is unavailable in this browser. Type your symptom or attach a photo instead.');
      return;
    }
    if (listening) {
      setListening(false);
      return;
    }
    const rec = new SpeechRec();
    rec.lang = 'en-US';
    rec.interimResults = false;
    setListening(true);
    rec.onresult = (ev: any) => {
      const transcript = ev.results?.[0]?.[0]?.transcript || '';
      setDraft((prev) => (prev ? `${prev} ${transcript}` : transcript));
      setListening(false);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    rec.start();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImagePreview({
        base64: String(reader.result || ''),
        mimeType: file.type || 'image/png',
        filename: file.name,
      });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleSend = async (e?: React.FormEvent, overrideText?: string) => {
    e?.preventDefault();
    const text = (overrideText ?? draft).trim();
    if (!text || sending) return;
    setError(null);
    setSending(true);
    try {
      if (!selectedId) {
        const res = await apiRequest<{
          investigation: { id: string };
          assistantMessage: { content: string };
        }>('/api/v1/investigations', {
          method: 'POST',
          body: {
            initialSymptom: text,
            deviceId: selectedDeviceId || undefined,
            expertiseMode,
            inputModality: imagePreview ? 'image' : listening ? 'voice' : 'text',
            imageBase64: imagePreview?.base64,
            imageMimeType: imagePreview?.mimeType,
            imageFilename: imagePreview?.filename,
          },
        });
        setDraft('');
        setImagePreview(null);
        await loadInvestigations(false);
        setSelectedId(res.investigation.id);
        await loadDetail(res.investigation.id);
        speakText(res.assistantMessage.content);
      } else {
        const res = await apiRequest<{ assistantMessage: { content: string } }>(
          `/api/v1/investigations/${selectedId}/messages`,
          {
            method: 'POST',
            body: {
              message: text,
              inputModality: imagePreview ? 'image' : 'text',
              imageBase64: imagePreview?.base64,
              imageMimeType: imagePreview?.mimeType,
              imageFilename: imagePreview?.filename,
            },
          },
        );
        setDraft('');
        setImagePreview(null);
        await loadDetail(selectedId);
        await loadInvestigations(false);
        speakText(res.assistantMessage.content);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to send message. Verify the backend API is reachable.');
    } finally {
      setSending(false);
    }
  };

  const executeProposedTool = async (tool: ProposedTool, explicitApproval = false) => {
    const targetId = selectedId || detail?.id;
    if (!targetId) return;
    if (tool.requiresExplicitApproval && !explicitApproval) {
      setApprovalModalTool(tool);
      return;
    }
    setApprovalModalTool(null);
    setRunningToolId(tool.toolId);
    setError(null);
    try {
      await apiRequest(`/api/v1/investigations/${targetId}/execute-tool`, {
        method: 'POST',
        body: {
          toolId: tool.toolId,
          parameters: tool.parameters || {},
          explicitUserApproval: explicitApproval,
        },
      });
      await loadDetail(targetId);
      await loadInvestigations(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Diagnostic tool run failed.');
    } finally {
      setRunningToolId(null);
    }
  };

  const handleAddMeasurement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedId || !measTitle.trim() || !measValue.trim()) return;
    await apiRequest(`/api/v1/investigations/${selectedId}/measurements`, {
      method: 'POST',
      body: { title: measTitle, value: measValue, instrument: measInstrument },
    });
    setMeasTitle('');
    setMeasValue('');
    setMeasurementModal(false);
    await loadDetail(selectedId);
  };

  const handleRunVerification = async (runFreshScan: boolean) => {
    if (!selectedId) return;
    setVerifying(true);
    setError(null);
    try {
      let followupSnapshotId: string | undefined;
      if (runFreshScan) {
        const snapRes = await apiRequest<{ snapshot: { id: string } }>('/api/v1/diagnostics/run', {
          method: 'POST',
          body: { toolId: 'full_system_snapshot', investigationId: selectedId, deviceId: detail?.deviceId || undefined },
        });
        followupSnapshotId = snapRes.snapshot.id;
      }
      await apiRequest(`/api/v1/investigations/${selectedId}/verify`, {
        method: 'POST',
        body: { userSymptomStatus: verifyStatus, followupSnapshotId },
      });
      await loadDetail(selectedId);
      await loadInvestigations(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification check failed.');
    } finally {
      setVerifying(false);
    }
  };

  const handleExportReport = async () => {
    if (!selectedId) return;
    const res = await apiRequest<{ markdown: string }>(`/api/v1/investigations/${selectedId}/report`);
    const blob = new Blob([res.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `coresense-report-${selectedId.slice(0, 8)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDeleteInvestigation = async (id: string) => {
    await apiRequest(`/api/v1/investigations/${id}`, { method: 'DELETE' });
    if (selectedId === id) setSelectedId(null);
    await loadInvestigations(false);
  };

  const starterPrompts = [
    {
      label: 'Performance',
      prompt: 'My laptop has become extremely slow and sometimes freezes.',
    },
    {
      label: 'Connectivity',
      prompt: "My phone's Wi-Fi stopped working after an update.",
    },
    {
      label: 'Storage SMART',
      prompt: 'Is my SSD failing? I keep seeing storage warnings.',
    },
    {
      label: 'Thermals',
      prompt: 'My laptop gets very hot and shuts down under load.',
    },
  ];

  return (
    <div className="flex-1 h-full min-h-0 flex flex-col lg:flex-row overflow-hidden bg-[var(--cs-canvas)]">
      {/* Left Rail: Investigation Sessions */}
      <aside className="lg:w-64 xl:w-72 shrink-0 min-h-0 overflow-hidden border-b lg:border-b-0 lg:border-r border-[var(--cs-border)] bg-[var(--cs-chassis)] flex flex-col max-h-48 lg:max-h-none">
        <div className="px-4 py-3 border-b border-[var(--cs-border)] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="cs-heading text-sm font-bold text-[var(--cs-ink)]">Investigations</h2>
            <span className="font-mono text-[11px] cs-tabular px-1.5 py-0.5 rounded bg-[var(--cs-well)] text-[var(--cs-ink-muted)]">
              {investigations.length}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              setSelectedId(null);
              setDetail(null);
              setMessages([]);
            }}
            className="cs-btn-primary flex items-center gap-1 px-2.5 py-1.5 text-xs cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>New</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-[var(--cs-border)]">
          {investigations.length === 0 ? (
            <div className="p-5 text-xs text-[var(--cs-ink-muted)] leading-relaxed">
              No saved investigations yet. Start a session in the center bench to track evidence and test results.
            </div>
          ) : (
            investigations.map((inv) => {
              const active = selectedId === inv.id;
              return (
                <div
                  key={inv.id}
                  onClick={() => setSelectedId(inv.id)}
                  className={`group relative px-4 py-3 cursor-pointer transition-colors ${
                    active
                      ? 'bg-[var(--cs-surface)]'
                      : 'hover:bg-[var(--cs-canvas)]'
                  }`}
                >
                  {active && (
                    <span
                      aria-hidden="true"
                      className="absolute left-0 top-0 bottom-0 w-[3px] bg-[var(--cs-accent)]"
                    />
                  )}
                  <div className="flex items-start justify-between gap-2">
                    <div
                      className={`text-xs leading-snug line-clamp-2 ${
                        active ? 'font-semibold text-[var(--cs-ink)]' : 'font-medium text-[var(--cs-ink-2)]'
                      }`}
                    >
                      {inv.title}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteInvestigation(inv.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 text-[var(--cs-ink-muted)] hover:text-[var(--cs-danger)] p-0.5 transition-opacity cursor-pointer"
                      title="Delete investigation"
                      aria-label="Delete investigation"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="px-1.5 py-0.5 rounded bg-[var(--cs-well)] text-[var(--cs-ink-muted)] capitalize">
                      {inv.expertiseMode}
                    </span>
                    {inv.deviceName && (
                      <span className="px-1.5 py-0.5 rounded bg-[var(--cs-accent-soft)] text-[var(--cs-accent-ink)] truncate max-w-[110px]">
                        {inv.deviceName}
                      </span>
                    )}
                    {inv.verificationOutcome && (
                      <span className="px-1.5 py-0.5 rounded bg-[var(--cs-ok-soft)] text-[var(--cs-ok-ink)]">
                        {formatLabel(inv.verificationOutcome)}
                      </span>
                    )}
                    {inv.safetyFlagCount > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-[var(--cs-danger-soft)] text-[var(--cs-danger-ink)] font-medium">
                        Safety flag
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* Center Pane: Diagnostic Conversation Bench */}
      <section className="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col bg-[var(--cs-canvas)]">
        {/* Session Header Bar */}
        <div className="shrink-0 px-5 py-3 border-b border-[var(--cs-border)] bg-[var(--cs-surface)] flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="cs-heading text-sm font-bold text-[var(--cs-ink)] truncate">
              {detail ? detail.title : 'New repair investigation'}
            </h1>
            <div className="flex items-center gap-2 mt-0.5 text-xs text-[var(--cs-ink-muted)]">
              <span className="capitalize">{detail?.expertiseMode || expertiseMode} depth</span>
              {detail && (
                <span className="font-mono text-[11px] cs-tabular px-1.5 py-0.5 rounded bg-[var(--cs-well)] text-[var(--cs-ink-2)]">
                  {detail.evidence.length} evidence
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {!selectedId && (
              <select
                value={selectedDeviceId}
                onChange={(e) => setSelectedDeviceId(e.target.value)}
                aria-label="Select device for investigation"
                className="cs-input px-2.5 py-1.5 text-xs max-w-[165px]"
              >
                <option value="">Local host / unspecified</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => setSpeakReplies((s) => !s)}
              title={speakReplies ? 'Mute spoken replies' : 'Read replies aloud'}
              aria-label={speakReplies ? 'Mute spoken replies' : 'Read replies aloud'}
              className={`h-8 w-8 rounded-lg border flex items-center justify-center transition-colors cursor-pointer ${
                speakReplies
                  ? 'border-[var(--cs-accent)] bg-[var(--cs-accent-soft)] text-[var(--cs-accent-ink)]'
                  : 'border-[var(--cs-border)] bg-[var(--cs-surface)] text-[var(--cs-ink-muted)] hover:text-[var(--cs-ink)]'
              }`}
            >
              {speakReplies ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
            </button>
            {selectedId && (
              <button
                type="button"
                onClick={handleExportReport}
                title="Export diagnostic report (.md)"
                className="cs-btn-secondary flex items-center gap-1.5 px-2.5 py-1.5 text-xs cursor-pointer"
              >
                <Download className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Export</span>
              </button>
            )}
          </div>
        </div>

        {/* Message Stream */}
        <div ref={chatScrollRef} className="flex-1 min-h-0 overflow-y-auto px-5 py-6 space-y-5">
          {messages.length === 0 ? (
            <div className="max-w-xl mx-auto py-8 space-y-7 cs-animate-view">
              <div className="space-y-2.5">
                <div className="inline-flex items-center gap-2 text-xs text-[var(--cs-ink-muted)]">
                  <span className="h-2 w-2 rounded-full bg-[var(--cs-ok)] cs-animate-led" />
                  <span>Ready for symptom intake, board photos, or error codes</span>
                </div>
                <h2 className="cs-heading text-2xl sm:text-[28px] font-bold text-[var(--cs-ink)] leading-tight">
                  What fault are you investigating?
                </h2>
                <p className="text-sm text-[var(--cs-ink-2)] leading-relaxed max-w-[56ch]">
                  CoreSense separates reported symptoms from measured telemetry, uploaded service
                  manuals, and visual inspections so every recommendation stays grounded.
                </p>
              </div>

              <div className="border-t border-[var(--cs-border)] divide-y divide-[var(--cs-border)]">
                {starterPrompts.map((item) => (
                  <button
                    key={item.prompt}
                    type="button"
                    onClick={() => handleSend(undefined, item.prompt)}
                    className="group w-full text-left py-3.5 px-3 -mx-3 rounded-lg hover:bg-[var(--cs-surface)] flex items-baseline justify-between gap-4 transition-colors cursor-pointer"
                  >
                    <div className="space-y-0.5">
                      <div className="text-[11px] font-medium text-[var(--cs-accent-ink)]">
                        {item.label}
                      </div>
                      <div className="text-sm text-[var(--cs-ink)] group-hover:text-[var(--cs-accent)] transition-colors">
                        {item.prompt}
                      </div>
                    </div>
                    <span className="text-xs font-medium text-[var(--cs-ink-muted)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      Start
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-5">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex flex-col cs-animate-msg ${m.role === 'user' ? 'items-end' : 'items-start'}`}
                >
                  {m.role === 'user' ? (
                    <div className="max-w-[85%] rounded-lg bg-[var(--cs-well)] border border-[var(--cs-border)] px-4 py-3 text-[var(--cs-ink)]">
                      {m.attachments?.length > 0 && (
                        <div className="mb-2 flex flex-wrap gap-1.5">
                          {m.attachments.map((att) => (
                            <span
                              key={att.id}
                              className="inline-flex items-center gap-1 rounded bg-[var(--cs-surface)] border border-[var(--cs-border)] px-2 py-0.5 text-[11px] text-[var(--cs-ink-2)]"
                            >
                              <ImageIcon className="h-3 w-3 text-[var(--cs-accent)]" />
                              {att.filename}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="text-sm leading-relaxed whitespace-pre-wrap">{m.content}</p>
                    </div>
                  ) : (
                    <article className="w-full rounded-lg bg-[var(--cs-surface)] border border-[var(--cs-border)] border-l-[3px] border-l-[var(--cs-accent)] px-4 py-3.5 space-y-3">
                      <MarkdownBlock content={m.content} />

                      {m.citations?.length > 0 && (
                        <div className="pt-3 border-t border-[var(--cs-border)] space-y-1.5">
                          <div className="text-xs font-semibold text-[var(--cs-ink)] flex items-center gap-1.5">
                            <BookOpen className="h-3.5 w-3.5 text-[var(--cs-accent)]" />
                            <span>Manual references</span>
                          </div>
                          <div className="space-y-1">
                            {m.citations.map((c, idx) => (
                              <div
                                key={idx}
                                className="flex flex-wrap items-center gap-2 text-xs text-[var(--cs-ink-2)] bg-[var(--cs-canvas)] border border-[var(--cs-border)] rounded px-2.5 py-1.5"
                              >
                                <span className="font-semibold text-[var(--cs-ink)]">{c.documentTitle}</span>
                                <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-[var(--cs-well)] text-[var(--cs-accent-ink)]">
                                  p.{c.pageNumber}
                                </span>
                                <span className="text-[var(--cs-ink-muted)]">{c.sectionHeading}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {m.toolCalls?.length > 0 && (
                        <div className="pt-3 border-t border-[var(--cs-border)] space-y-2">
                          <div className="text-xs font-semibold text-[var(--cs-ink)]">
                            Suggested diagnostic checks
                          </div>
                          {m.toolCalls.map((tool) => {
                            const isRunning = runningToolId === tool.toolId;
                            return (
                              <div
                                key={tool.id}
                                className="relative overflow-hidden rounded-lg bg-[var(--cs-canvas)] border border-[var(--cs-border)] p-3 flex items-center justify-between gap-3"
                              >
                                {isRunning && (
                                  <div className="absolute top-0 left-0 right-0 h-[2.5px] bg-[var(--cs-well)] overflow-hidden">
                                    <div className="h-full w-1/3 bg-[var(--cs-accent)] cs-animate-scan" />
                                  </div>
                                )}
                                <div className="min-w-0 space-y-0.5">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-xs font-semibold text-[var(--cs-ink)]">
                                      {tool.toolName}
                                    </span>
                                    <span
                                      className={`text-[11px] px-1.5 py-0.5 rounded border ${
                                        tool.requiresExplicitApproval
                                          ? 'bg-[var(--cs-warn-soft)] text-[var(--cs-warn-ink)] border-[var(--cs-warn-border)]'
                                          : 'bg-[var(--cs-ok-soft)] text-[var(--cs-ok-ink)] border-[var(--cs-ok-border)]'
                                      }`}
                                    >
                                      {tool.requiresExplicitApproval ? 'Approval required' : 'Read-only'}
                                    </span>
                                  </div>
                                  <p className="text-xs text-[var(--cs-ink-muted)]">{tool.reason}</p>
                                </div>
                                <button
                                  type="button"
                                  disabled={runningToolId !== null}
                                  onClick={() => executeProposedTool(tool, false)}
                                  className="cs-btn-accent shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs disabled:opacity-50 cursor-pointer"
                                >
                                  <Play className="h-3 w-3" />
                                  <span>{isRunning ? 'Running...' : 'Run check'}</span>
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {m.aiProvider && (
                        <div className="pt-2 border-t border-[var(--cs-border)] text-[11px] text-[var(--cs-ink-muted)] font-mono cs-tabular flex items-center justify-between gap-2">
                          <span>
                            {m.aiProvider} / {m.aiModel}
                          </span>
                          <span>{new Date(m.createdAt).toLocaleTimeString()}</span>
                        </div>
                      )}
                    </article>
                  )}
                </div>
              ))}

              {sending && (
                <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-[var(--cs-surface)] border border-[var(--cs-border)] text-xs text-[var(--cs-ink-muted)] cs-animate-msg">
                  <div className="flex items-end gap-0.5 h-3.5" aria-hidden="true">
                    {[0, 90, 180, 270, 360].map((delay) => (
                      <span
                        key={delay}
                        className="w-1 h-full rounded-[1px] bg-[var(--cs-accent)] cs-animate-eq"
                        style={{ animationDelay: `${delay}ms` }}
                      />
                    ))}
                  </div>
                  <span>Analyzing symptoms and diagnostic evidence...</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Bottom Grounded Input Composer */}
        <form
          onSubmit={handleSend}
          className="shrink-0 px-5 py-3.5 border-t border-[var(--cs-border)] bg-[var(--cs-surface)] space-y-2.5"
        >
          {error && (
            <div className="rounded-lg bg-[var(--cs-danger-soft)] border border-[var(--cs-danger-border)] px-3 py-2 text-xs text-[var(--cs-danger-ink)] flex items-center justify-between gap-2 cs-animate-view">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => setError(null)}
                className="text-[var(--cs-danger-ink)] hover:opacity-75 cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {imagePreview && (
            <div className="flex items-center justify-between rounded-lg bg-[var(--cs-canvas)] border border-[var(--cs-border)] px-3 py-2 text-xs cs-animate-view">
              <div className="flex items-center gap-2.5 min-w-0">
                <img src={imagePreview.base64} alt="Attachment preview" className="h-9 w-9 rounded object-cover border border-[var(--cs-border)]" />
                <div className="min-w-0">
                  <div className="font-medium text-[var(--cs-ink)] truncate">{imagePreview.filename}</div>
                  <div className="text-[11px] text-[var(--cs-ink-muted)]">Attached for visual inspection</div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setImagePreview(null)}
                className="p-1 text-[var(--cs-ink-muted)] hover:text-[var(--cs-ink)] cursor-pointer"
                aria-label="Remove attachment"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          <div className="flex items-center gap-2 max-w-3xl mx-auto">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleFileChange}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Attach hardware photo or error screenshot"
              aria-label="Attach photo"
              className="cs-btn-secondary h-10 w-10 shrink-0 flex items-center justify-center cursor-pointer"
            >
              <ImageIcon className="h-4 w-4 text-[var(--cs-ink-2)]" />
            </button>
            <button
              type="button"
              onClick={toggleVoiceInput}
              title={listening ? 'Stop voice dictation' : 'Dictate symptoms'}
              aria-label={listening ? 'Stop voice dictation' : 'Dictate symptoms'}
              className={`h-10 w-10 shrink-0 rounded-lg border flex items-center justify-center transition-colors cursor-pointer ${
                listening
                  ? 'bg-[var(--cs-danger-soft)] border-[var(--cs-danger)] text-[var(--cs-danger)]'
                  : 'cs-btn-secondary text-[var(--cs-ink-2)]'
              }`}
            >
              {listening ? <MicOff className="h-4 w-4 cs-animate-led" /> : <Mic className="h-4 w-4" />}
            </button>
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Describe symptoms, paste an error code, or ask about a component..."
              className="cs-input flex-1 min-w-0 h-10 px-3.5 text-sm"
            />
            <button
              type="submit"
              disabled={sending || !draft.trim()}
              className="cs-btn-primary shrink-0 h-10 px-4 text-xs flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
            >
              <Send className="h-3.5 w-3.5" />
              <span>{sending ? 'Sending' : 'Send'}</span>
            </button>
          </div>
        </form>
      </section>

      {/* Right Pane: Structured Evidence, Hypotheses & Resolution Verification */}
      <aside className="lg:w-80 xl:w-[376px] shrink-0 min-h-0 overflow-hidden border-t lg:border-t-0 lg:border-l border-[var(--cs-border)] bg-[var(--cs-surface)] flex flex-col">
        {/* Sliding Segmented Inspector Switch */}
        <div className="shrink-0 p-2.5 border-b border-[var(--cs-border)] bg-[var(--cs-chassis)]">
          <div className="relative grid grid-cols-3 p-1 rounded-lg bg-[var(--cs-well)] border border-[var(--cs-border)]">
            <div
              aria-hidden="true"
              className="absolute top-1 bottom-1 left-1 w-[calc(33.333%-2.67px)] rounded-md bg-[var(--cs-surface)] border border-[var(--cs-border)] transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
              style={{ transform: `translateX(${inspectorIndex * 100}%)` }}
            />
            {[
              { id: 'hypotheses', label: `Hypotheses`, count: detail?.hypotheses.length ?? 0, icon: Layers },
              { id: 'evidence', label: `Evidence`, count: detail?.evidence.length ?? 0, icon: FileCheck2 },
              { id: 'verify', label: 'Verify', count: null, icon: CheckCircle2 },
            ].map((t) => {
              const Icon = t.icon;
              const active = inspectorTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setInspectorTab(t.id as 'hypotheses' | 'evidence' | 'verify')}
                  className={`relative z-10 flex items-center justify-center gap-1 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                    active ? 'text-[var(--cs-ink)]' : 'text-[var(--cs-ink-muted)] hover:text-[var(--cs-ink)]'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{t.label}</span>
                  {t.count !== null && (
                    <span className="font-mono text-[10px] cs-tabular opacity-80">({t.count})</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div key={inspectorTab} className="flex-1 overflow-y-auto p-4 space-y-3.5 cs-animate-view">
          {!detail ? (
            <div className="py-12 px-4 text-center space-y-2">
              <div className="text-xs font-semibold text-[var(--cs-ink)]">Diagnostic ledger ready</div>
              <p className="text-xs text-[var(--cs-ink-muted)] leading-relaxed">
                Start or select an investigation to inspect ranked hypotheses, measured evidence provenance, and before/after verification.
              </p>
            </div>
          ) : inspectorTab === 'hypotheses' ? (
            <>
              {detail.safetyFlags.length > 0 && (
                <div className="rounded-lg border border-[var(--cs-danger-border)] border-l-[4px] border-l-[var(--cs-danger)] bg-[var(--cs-danger-soft)] p-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-[var(--cs-danger-ink)]">
                    <ShieldAlert className="h-4 w-4 shrink-0" />
                    <span>Hardware safety warning</span>
                  </div>
                  {detail.safetyFlags.map((f, i) => (
                    <div key={i} className="text-xs text-[var(--cs-danger-ink)]">
                      {f.title} ({f.severity})
                    </div>
                  ))}
                </div>
              )}

              {detail.hypotheses.length === 0 ? (
                <div className="text-xs text-[var(--cs-ink-muted)] py-6 text-center">
                  No hypotheses generated yet for this session.
                </div>
              ) : (
                detail.hypotheses.map((h) => (
                  <div
                    key={h.id}
                    className="rounded-lg bg-[var(--cs-canvas)] border border-[var(--cs-border)] p-3.5 space-y-2.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="text-xs font-semibold text-[var(--cs-ink)] leading-snug">{h.title}</h4>
                      <span
                        className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium border ${hypothesisStatusStyle(
                          h.status,
                        )}`}
                      >
                        {formatLabel(h.status)}
                      </span>
                    </div>
                    <p className="text-xs text-[var(--cs-ink-2)] leading-relaxed">{h.whyPossible}</p>

                    {h.supportingEvidence.length > 0 && (
                      <div className="text-xs leading-relaxed">
                        <span className="font-semibold text-[var(--cs-ok-ink)]">Supports: </span>
                        <span className="text-[var(--cs-ink-2)]">{h.supportingEvidence.join('; ')}</span>
                      </div>
                    )}

                    {h.conflictingEvidence.length > 0 && (
                      <div className="text-xs leading-relaxed">
                        <span className="font-semibold text-[var(--cs-warn-ink)]">Missing or conflicts: </span>
                        <span className="text-[var(--cs-ink-2)]">{h.conflictingEvidence.join('; ')}</span>
                      </div>
                    )}

                    <div className="rounded-md bg-[var(--cs-surface)] border border-[var(--cs-border)] border-l-[3px] border-l-[var(--cs-accent)] p-2.5 text-xs text-[var(--cs-ink-2)]">
                      <span className="font-semibold text-[var(--cs-ink)]">Discriminating test: </span>
                      {h.discriminatingTest}
                    </div>
                  </div>
                ))
              )}
            </>
          ) : inspectorTab === 'evidence' ? (
            <>
              <button
                type="button"
                onClick={() => setMeasurementModal(true)}
                className="cs-btn-secondary w-full py-2 px-3 text-xs font-semibold border-dashed cursor-pointer"
              >
                + Record bench measurement (multimeter, thermal, USB-C)
              </button>

              {detail.evidence.map((ev) => (
                <div
                  key={ev.id}
                  className="rounded-lg bg-[var(--cs-canvas)] border border-[var(--cs-border)] p-3 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium text-[var(--cs-ink-muted)]">
                      {formatLabel(ev.kind)}
                    </span>
                    <span
                      className={`text-[11px] font-mono px-1.5 py-0.5 rounded border ${provenanceStyle(
                        ev.measurementType,
                      )}`}
                    >
                      {formatLabel(ev.measurementType)}
                    </span>
                  </div>
                  <div className="text-xs font-semibold text-[var(--cs-ink)]">{ev.title}</div>
                  <p className="text-xs text-[var(--cs-ink-2)] leading-relaxed">{ev.summary}</p>
                  <div className="pt-1 text-[11px] text-[var(--cs-ink-muted)] font-mono cs-tabular flex items-center justify-between gap-2">
                    <span className="truncate">{ev.source}</span>
                    <span className="shrink-0">{new Date(ev.collectedAt).toLocaleTimeString()}</span>
                  </div>
                </div>
              ))}
            </>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg bg-[var(--cs-canvas)] border border-[var(--cs-border)] p-4 space-y-3.5">
                <div className="space-y-1">
                  <h4 className="cs-heading text-sm font-bold text-[var(--cs-ink)]">Resolution verification</h4>
                  <p className="text-xs text-[var(--cs-ink-muted)] leading-relaxed">
                    Confirm a fix by comparing current symptoms with fresh system measurements against the baseline snapshot.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-[var(--cs-ink-2)] mb-1.5">
                    Current symptom state
                  </label>
                  <select
                    value={verifyStatus}
                    onChange={(e) => setVerifyStatus(e.target.value as typeof verifyStatus)}
                    className="cs-input w-full px-3 py-2 text-xs"
                  >
                    <option value="resolved">Original symptoms completely resolved</option>
                    <option value="improved">Symptoms partially improved</option>
                    <option value="unchanged">Symptoms unchanged</option>
                    <option value="worsened">Symptoms worsened</option>
                    <option value="unknown">Unable to test yet</option>
                  </select>
                </div>

                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    disabled={verifying}
                    onClick={() => handleRunVerification(true)}
                    className="cs-btn-accent w-full py-2 px-3 text-xs cursor-pointer disabled:opacity-50"
                  >
                    {verifying ? 'Collecting fresh scan...' : 'Run fresh scan and verify'}
                  </button>
                  <button
                    type="button"
                    disabled={verifying}
                    onClick={() => handleRunVerification(false)}
                    className="cs-btn-secondary w-full py-2 px-3 text-xs cursor-pointer disabled:opacity-50"
                  >
                    Verify without new scan
                  </button>
                </div>
              </div>

              {detail.verificationReport && (
                <div className="rounded-lg border border-[var(--cs-ok-border)] bg-[var(--cs-ok-soft)] p-4 space-y-3 cs-animate-view">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-[var(--cs-ok-ink)]">Verification outcome</span>
                    <span className="rounded bg-[var(--cs-surface)] border border-[var(--cs-ok-border)] px-2 py-0.5 text-[11px] font-mono text-[var(--cs-ok-ink)]">
                      {formatLabel(detail.verificationReport.outcome)}
                    </span>
                  </div>
                  <p className="text-xs text-[var(--cs-ink)] leading-relaxed">
                    {detail.verificationReport.summary}
                  </p>
                  {detail.verificationReport.metricComparisons.length > 0 && (
                    <div className="space-y-1.5 pt-1">
                      {detail.verificationReport.metricComparisons.map((mc, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between gap-2 text-xs rounded bg-[var(--cs-surface)] border border-[var(--cs-border)] px-2.5 py-2"
                        >
                          <span className="text-[var(--cs-ink-2)]">{mc.metric}</span>
                          <span className="font-mono text-[11px] text-[var(--cs-ink)] cs-tabular">
                            {mc.before} to {mc.after} ({mc.deltaAssessment})
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      {/* Explicit Approval Modal for State-Modifying Tools */}
      {approvalModalTool && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 cs-animate-backdrop"
          style={{ backgroundColor: 'var(--cs-scrim)' }}
        >
          <div className="cs-panel max-w-md w-full p-6 space-y-4 border-[var(--cs-warn-border)] cs-animate-modal">
            <div className="flex items-center gap-2.5 text-[var(--cs-warn)]">
              <AlertTriangle className="h-5 w-5 shrink-0" />
              <h3 className="cs-heading text-base font-bold text-[var(--cs-ink)]">
                Approve system change
              </h3>
            </div>
            <p className="text-xs text-[var(--cs-ink-2)] leading-relaxed">
              You are authorizing CoreSense to run{' '}
              <strong className="text-[var(--cs-ink)]">{approvalModalTool.toolName}</strong> (
              <code className="font-mono text-[11px] px-1 py-0.5 rounded bg-[var(--cs-well)]">
                {approvalModalTool.toolId}
              </code>
              ).
            </p>
            <div className="rounded-lg bg-[var(--cs-warn-soft)] border border-[var(--cs-warn-border)] p-3 text-xs text-[var(--cs-warn-ink)] leading-relaxed">
              {approvalModalTool.approvalWarning || 'This action modifies local system configuration.'}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setApprovalModalTool(null)}
                className="cs-btn-secondary px-4 py-2 text-xs cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => executeProposedTool(approvalModalTool, true)}
                className="px-4 py-2 rounded-lg bg-[var(--cs-warn)] text-white font-semibold text-xs hover:opacity-90 cursor-pointer"
              >
                Approve and run
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manual Bench Measurement Modal */}
      {measurementModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 cs-animate-backdrop"
          style={{ backgroundColor: 'var(--cs-scrim)' }}
        >
          <form onSubmit={handleAddMeasurement} className="cs-panel max-w-md w-full p-6 space-y-4 cs-animate-modal">
            <div className="flex items-center justify-between">
              <h3 className="cs-heading text-base font-bold text-[var(--cs-ink)]">
                Record bench measurement
              </h3>
              <button
                type="button"
                onClick={() => setMeasurementModal(false)}
                className="text-[var(--cs-ink-muted)] hover:text-[var(--cs-ink)] cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--cs-ink-2)] mb-1">
                Measurement label
              </label>
              <input
                required
                value={measTitle}
                onChange={(e) => setMeasTitle(e.target.value)}
                placeholder="e.g. PPBUS_G3H rail or USB-C PD draw"
                className="cs-input w-full px-3 py-2 text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--cs-ink-2)] mb-1">
                Measured reading
              </label>
              <input
                required
                value={measValue}
                onChange={(e) => setMeasValue(e.target.value)}
                placeholder="e.g. 12.56V DC / 19.8V @ 2.1A"
                className="cs-input w-full px-3 py-2 text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--cs-ink-2)] mb-1">
                Instrument used
              </label>
              <input
                value={measInstrument}
                onChange={(e) => setMeasInstrument(e.target.value)}
                className="cs-input w-full px-3 py-2 text-xs"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setMeasurementModal(false)}
                className="cs-btn-secondary px-4 py-2 text-xs cursor-pointer"
              >
                Cancel
              </button>
              <button type="submit" className="cs-btn-primary px-4 py-2 text-xs cursor-pointer">
                Add to evidence ledger
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
