import React, { useEffect, useState } from 'react';
import {
  Activity,
  BrainCircuit,
  CheckCircle2,
  Cpu,
  Database,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  XCircle,
} from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { SystemHealthAnalysis } from '@coresense/shared';
import { apiRequest } from '../api';

interface RagStats {
  documentCount: number;
  totalChunks: number;
  embeddedChunks: number;
  embeddingCoveragePercent: number;
  embeddingModel: string;
  embeddingDimensions: number;
  fusionMethod: string;
  vectorSearchActive: boolean;
}

interface TelemetryTrendPoint {
  collectedAt: string;
  timeLabel: string;
  cpuLoad: number | null;
  ramUsed: number | null;
  cpuTemp: number | null;
  dnsLatencyMs: number | null;
  diskUsed: number | null;
  batteryWear: number | null;
}

interface AiLabOverview {
  generatedAt: string;
  appVersion: string;
  pipeline: {
    llmEngine: string;
    streamingProtocol: string;
    visionEngine: string;
    embeddingEngine: string;
    retrievalFusion: string;
    anomalyAlgorithm: string;
    forecastAlgorithm: string;
    registeredToolsCount: number;
  };
  ragStats: RagStats;
  healthAnalysis: SystemHealthAnalysis;
  trendSeries: TelemetryTrendPoint[];
}

interface BenchmarkCase {
  id: string;
  category: string;
  name: string;
  passed: boolean;
  latencyMs: number;
  detail: string;
}

interface LiveBenchmarkReport {
  executedAt: string;
  appVersion: string;
  totalCases: number;
  passedCases: number;
  passRatePercent: number;
  totalDurationMs: number;
  byCategory: Array<{
    category: string;
    label: string;
    passed: number;
    total: number;
    ratePercent: number;
  }>;
  cases: BenchmarkCase[];
}

interface RagSandboxHit {
  documentTitle: string;
  pageNumber: number;
  sectionHeading: string;
  excerpt: string;
  relevanceScore: number;
  matchMode: 'hybrid_rrf' | 'semantic_vector' | 'lexical_fts';
  lexicalScore: number | null;
  semanticSimilarity: number | null;
}

export const AiMlLabView: React.FC = () => {
  const [overview, setOverview] = useState<AiLabOverview | null>(null);
  const [benchmark, setBenchmark] = useState<LiveBenchmarkReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningEval, setRunningEval] = useState(false);
  const [reembedding, setReembedding] = useState(false);
  const [reembedNotice, setReembedNotice] = useState<string | null>(null);
  const [ragQuery, setRagQuery] = useState('');
  const [ragHits, setRagHits] = useState<RagSandboxHit[]>([]);
  const [searchingRag, setSearchingRag] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<{ overview: AiLabOverview }>('/api/v1/ai-lab/overview');
      setOverview(res.overview);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load AI/ML Lab overview.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOverview().catch(() => {});
  }, []);

  const handleRunBenchmark = async () => {
    setRunningEval(true);
    setError(null);
    try {
      const res = await apiRequest<{ report: LiveBenchmarkReport }>('/api/v1/ai-lab/run-benchmark', {
        method: 'POST',
        body: {},
      });
      setBenchmark(res.report);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to execute AI/ML evaluation suite.');
    } finally {
      setRunningEval(false);
    }
  };

  const handleReembed = async () => {
    setReembedding(true);
    setReembedNotice(null);
    try {
      const res = await apiRequest<{
        embeddedNow: number;
        remainingUnembedded: number;
        totalChunks: number;
      }>('/api/v1/documents/reembed', { method: 'POST', body: {} });
      setReembedNotice(
        `Embedded ${res.embeddedNow} chunk(s) into 768d vectors (${res.totalChunks - res.remainingUnembedded}/${res.totalChunks} indexed).`,
      );
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Vector backfill failed.');
    } finally {
      setReembedding(false);
    }
  };

  const handleRagSandbox = async (e: React.FormEvent) => {
    e.preventDefault();
    if (ragQuery.trim().length < 2) return;
    setSearchingRag(true);
    try {
      const res = await apiRequest<{ results: RagSandboxHit[] }>(
        `/api/v1/documents/search?q=${encodeURIComponent(ragQuery.trim())}`,
      );
      setRagHits(res.results);
    } finally {
      setSearchingRag(false);
    }
  };

  if (loading && !overview) {
    return (
      <div className="max-w-7xl mx-auto py-16 text-center text-xs text-[var(--cs-ink-muted)]">
        Loading AI/ML Lab & live telemetry pipeline...
      </div>
    );
  }

  const pipeline = overview?.pipeline;
  const rag = overview?.ragStats;
  const trends = overview?.trendSeries ?? [];
  const health = overview?.healthAnalysis;

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 pb-4 border-b border-[var(--cs-border)]">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <BrainCircuit className="h-5 w-5 text-[var(--cs-accent)]" />
            <h1 className="cs-heading text-2xl font-bold text-[var(--cs-ink)]">
              AI / ML Evaluation & Telemetry Lab
            </h1>
          </div>
          <p className="text-xs text-[var(--cs-ink-muted)] max-w-2xl">
            Live inspection of CoreSense’s multimodal Gemini 4 streaming stack, 768-dim Hybrid RRF Vector RAG,
            Iglewicz-Hoaglin MAD anomaly engine, OLS degradation regressions, and automated safety/grounding benchmarks.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={loadOverview}
            disabled={loading}
            className="cs-btn-secondary flex items-center gap-1.5 px-3 py-2 text-xs cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh telemetry</span>
          </button>
          <button
            type="button"
            onClick={handleRunBenchmark}
            disabled={runningEval}
            className="cs-btn-primary flex items-center gap-1.5 px-4 py-2 text-xs cursor-pointer disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" />
            <span>{runningEval ? 'Running 12-case eval...' : 'Run live AI/ML eval benchmark'}</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-[var(--cs-danger-border)] bg-[var(--cs-danger-soft)] px-4 py-2.5 text-xs text-[var(--cs-danger-ink)]">
          {error}
        </div>
      )}

      {/* Active AI / ML Pipeline Architecture Cards */}
      {pipeline && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="cs-panel p-3.5 space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--cs-accent-ink)] uppercase tracking-wide">
              <Sparkles className="h-3.5 w-3.5" />
              <span>LLM + SSE Streaming</span>
            </div>
            <div className="font-mono text-xs font-bold text-[var(--cs-ink)]">{pipeline.llmEngine}</div>
            <div className="text-[11px] text-[var(--cs-ink-muted)]">{pipeline.streamingProtocol}</div>
          </div>

          <div className="cs-panel p-3.5 space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--cs-accent-ink)] uppercase tracking-wide">
              <Cpu className="h-3.5 w-3.5" />
              <span>Structured PCB Vision</span>
            </div>
            <div className="font-mono text-xs font-bold text-[var(--cs-ink)] truncate" title={pipeline.visionEngine}>
              {pipeline.visionEngine}
            </div>
            <div className="text-[11px] text-[var(--cs-ink-muted)]">
              Zod-enforced JSON Schema + visual-vs-electrical guardrails
            </div>
          </div>

          <div className="cs-panel p-3.5 space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--cs-ok-ink)] uppercase tracking-wide">
              <Database className="h-3.5 w-3.5" />
              <span>Hybrid Vector RAG</span>
            </div>
            <div className="font-mono text-xs font-bold text-[var(--cs-ink)]">{pipeline.embeddingEngine}</div>
            <div className="text-[11px] text-[var(--cs-ink-muted)]">{pipeline.retrievalFusion}</div>
          </div>

          <div className="cs-panel p-3.5 space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--cs-warn-ink)] uppercase tracking-wide">
              <TrendingUp className="h-3.5 w-3.5" />
              <span>Predictive ML Math</span>
            </div>
            <div className="font-mono text-xs font-bold text-[var(--cs-ink)]">
              MAD Modified Z + OLS RUL
            </div>
            <div className="text-[11px] text-[var(--cs-ink-muted)]">
              {pipeline.registeredToolsCount} validated read-only/gated diagnostic tools
            </div>
          </div>
        </div>
      )}

      {/* Live 12-Case AI/ML Safety, Grounding & Math Evaluation Suite */}
      <section className="cs-panel p-4 space-y-4 border-l-[4px] border-l-[var(--cs-ok)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="cs-heading text-sm font-bold text-[var(--cs-ink)] flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-[var(--cs-ok)]" />
              <span>Automated AI Safety, Grounding & ML Math Evaluation Suite</span>
            </h2>
            <p className="text-xs text-[var(--cs-ink-muted)] mt-0.5">
              Executes 12 real-time assertions against live safety blocks, prompt-injection neutralization, RRF/cosine math, MAD Z-score detection, OLS regression RUL, and Zod vision schemas.
            </p>
          </div>

          {benchmark && (
            <div className="flex items-center gap-2 font-mono cs-tabular">
              <span
                className={`px-2.5 py-1 rounded text-xs font-bold border ${
                  benchmark.passRatePercent === 100
                    ? 'bg-[var(--cs-ok-soft)] border-[var(--cs-ok-border)] text-[var(--cs-ok-ink)]'
                    : 'bg-[var(--cs-warn-soft)] border-[var(--cs-warn-border)] text-[var(--cs-warn-ink)]'
                }`}
              >
                {benchmark.passedCases}/{benchmark.totalCases} PASSED ({benchmark.passRatePercent}%)
              </span>
              <span className="text-[11px] text-[var(--cs-ink-muted)]">{benchmark.totalDurationMs} ms</span>
            </div>
          )}
        </div>

        {!benchmark ? (
          <div className="rounded-lg bg-[var(--cs-canvas)] border border-dashed border-[var(--cs-border)] p-6 text-center space-y-2">
            <div className="text-xs font-semibold text-[var(--cs-ink)]">
              Ready to run live deterministic evaluation suite
            </div>
            <p className="text-xs text-[var(--cs-ink-muted)] max-w-lg mx-auto">
              Click <strong>Run live AI/ML eval benchmark</strong> above to execute real live checks — zero pre-baked or hardcoded scores.
            </p>
          </div>
        ) : (
          <div className="space-y-4 cs-animate-view">
            {/* Category Score Bars */}
            <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
              {benchmark.byCategory.map((cat) => (
                <div
                  key={cat.category}
                  className="rounded-md bg-[var(--cs-canvas)] border border-[var(--cs-border)] p-2.5 space-y-1.5"
                >
                  <div className="text-[11px] font-semibold text-[var(--cs-ink)] leading-snug">{cat.label}</div>
                  <div className="flex items-center justify-between font-mono text-xs cs-tabular">
                    <span className="text-[var(--cs-ok-ink)] font-bold">{cat.ratePercent}%</span>
                    <span className="text-[var(--cs-ink-muted)]">
                      {cat.passed}/{cat.total}
                    </span>
                  </div>
                  <div className="h-1.5 w-full rounded-sm bg-[var(--cs-well)] overflow-hidden">
                    <div
                      className="h-full"
                      style={{
                        width: `${cat.ratePercent}%`,
                        backgroundColor: cat.ratePercent === 100 ? 'var(--cs-ok)' : 'var(--cs-warn)',
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>

            {/* Individual Case Assertion Ledger */}
            <div className="overflow-x-auto rounded-md border border-[var(--cs-border)] bg-[var(--cs-canvas)]">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[11px] text-[var(--cs-ink-muted)] border-b border-[var(--cs-border)] bg-[var(--cs-chassis)]">
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Evaluation Case</th>
                    <th className="px-3 py-2 font-medium">Measured Evidence</th>
                    <th className="px-3 py-2 text-right font-medium">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--cs-border)]">
                  {benchmark.cases.map((c) => (
                    <tr key={c.id} className="text-[var(--cs-ink-2)]">
                      <td className="px-3 py-2 whitespace-nowrap">
                        {c.passed ? (
                          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--cs-ok-ink)] font-semibold">
                            <CheckCircle2 className="h-3.5 w-3.5" /> PASS
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--cs-danger-ink)] font-semibold">
                            <XCircle className="h-3.5 w-3.5" /> FAIL
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-medium text-[var(--cs-ink)]">{c.name}</td>
                      <td className="px-3 py-2 font-mono text-[11px] text-[var(--cs-ink-muted)]">{c.detail}</td>
                      <td className="px-3 py-2 text-right font-mono text-[11px] cs-tabular whitespace-nowrap">
                        {c.latencyMs} ms
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* Bottom 2-Column Lab: Real Telemetry Trends + Hybrid Vector RAG Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Live Telemetry Time-Series Chart */}
        <section className="lg:col-span-7 cs-panel p-4 space-y-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="cs-heading text-sm font-bold text-[var(--cs-ink)] flex items-center gap-1.5">
                <Activity className="h-4 w-4 text-[var(--cs-accent)]" />
                <span>Historical Hardware Telemetry Baseline</span>
              </h2>
              <p className="text-[11px] text-[var(--cs-ink-muted)]">
                Real chronological scans feeding the MAD Z-Score & OLS degradation models ({trends.length} point(s))
              </p>
            </div>
            {health && (
              <span className="font-mono text-xs px-2 py-0.5 rounded bg-[var(--cs-well)] border border-[var(--cs-border)] text-[var(--cs-ink)] cs-tabular">
                Health: {health.overallHealthScore ?? '—'}/100
              </span>
            )}
          </div>

          {trends.length < 2 ? (
            <div className="rounded-lg bg-[var(--cs-canvas)] border border-[var(--cs-border)] p-8 text-center text-xs text-[var(--cs-ink-muted)]">
              Run at least 2 real scans in the <strong>Diagnostics</strong> tab to plot live chronological CPU, RAM, and network latency trajectories.
            </div>
          ) : (
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trends} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--cs-border)" vertical={false} />
                  <XAxis dataKey="timeLabel" tick={{ fill: 'var(--cs-ink-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: 'var(--cs-ink-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--cs-surface)',
                      borderColor: 'var(--cs-border-strong)',
                      color: 'var(--cs-ink)',
                      borderRadius: '8px',
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="cpuLoad" name="CPU %" stroke="var(--cs-accent)" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                  <Line type="monotone" dataKey="ramUsed" name="RAM %" stroke="var(--cs-ok)" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                  <Line type="monotone" dataKey="dnsLatencyMs" name="Latency ms" stroke="var(--cs-warn)" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {health && health.summaryBullets.length > 0 && (
            <div className="space-y-1 pt-2 border-t border-[var(--cs-border)]">
              {health.summaryBullets.map((b, i) => (
                <div key={i} className="text-xs text-[var(--cs-ink-2)]">
                  • {b}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Hybrid Vector + Lexical RRF RAG Inspector */}
        <section className="lg:col-span-5 cs-panel p-4 space-y-3.5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="cs-heading text-sm font-bold text-[var(--cs-ink)] flex items-center gap-1.5">
                <Database className="h-4 w-4 text-[var(--cs-ok)]" />
                <span>Hybrid Vector RAG Inspector</span>
              </h2>
              <p className="text-[11px] text-[var(--cs-ink-muted)]">
                {rag?.embeddingModel} ({rag?.embeddingDimensions}d) + Lexical FTS RRF
              </p>
            </div>
            {rag && rag.embeddedChunks < rag.totalChunks && (
              <button
                type="button"
                disabled={reembedding}
                onClick={handleReembed}
                className="cs-btn-accent px-2.5 py-1 text-[11px] cursor-pointer disabled:opacity-50"
              >
                {reembedding ? 'Embedding...' : 'Embed missing'}
              </button>
            )}
          </div>

          {rag && (
            <div className="rounded-md bg-[var(--cs-canvas)] border border-[var(--cs-border)] p-3 space-y-2 text-xs">
              <div className="flex items-center justify-between font-mono cs-tabular">
                <span className="text-[var(--cs-ink-2)]">
                  {rag.documentCount} manual(s) • {rag.embeddedChunks}/{rag.totalChunks} chunks vectorized
                </span>
                <span className="font-bold text-[var(--cs-ok-ink)]">{rag.embeddingCoveragePercent}%</span>
              </div>
              <div className="h-2 w-full rounded-sm bg-[var(--cs-well)] overflow-hidden">
                <div
                  className="h-full"
                  style={{
                    width: `${rag.embeddingCoveragePercent}%`,
                    backgroundColor: rag.vectorSearchActive ? 'var(--cs-ok)' : 'var(--cs-warn)',
                  }}
                />
              </div>
              {reembedNotice && <div className="text-[11px] text-[var(--cs-ok-ink)]">{reembedNotice}</div>}
            </div>
          )}

          {/* Interactive Hybrid Search Sandbox */}
          <form onSubmit={handleRagSandbox} className="flex gap-1.5">
            <input
              value={ragQuery}
              onChange={(e) => setRagQuery(e.target.value)}
              placeholder="Test semantic or keyword query across manuals..."
              className="cs-input flex-1 px-3 py-2 text-xs"
            />
            <button
              type="submit"
              disabled={searchingRag || ragQuery.trim().length < 2}
              className="cs-btn-secondary px-3 py-2 text-xs flex items-center gap-1 cursor-pointer disabled:opacity-50"
            >
              <Search className="h-3.5 w-3.5" />
              <span>{searchingRag ? '...' : 'Test'}</span>
            </button>
          </form>

          {ragHits.length > 0 ? (
            <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
              {ragHits.map((h, i) => (
                <div
                  key={i}
                  className="rounded-md bg-[var(--cs-canvas)] border border-[var(--cs-border)] p-2.5 text-xs space-y-1"
                >
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <span className="font-semibold text-[var(--cs-ink)] truncate">
                      {h.documentTitle} (p.{h.pageNumber})
                    </span>
                    <span
                      className={`font-mono text-[10px] px-1.5 py-0.5 rounded border uppercase ${
                        h.matchMode === 'hybrid_rrf'
                          ? 'bg-[var(--cs-ok-soft)] border-[var(--cs-ok-border)] text-[var(--cs-ok-ink)]'
                          : h.matchMode === 'semantic_vector'
                            ? 'bg-[var(--cs-accent-soft)] border-[var(--cs-accent-border)] text-[var(--cs-accent-ink)]'
                            : 'bg-[var(--cs-well)] border-[var(--cs-border)] text-[var(--cs-ink-muted)]'
                      }`}
                    >
                      {h.matchMode.replace(/_/g, ' ')}
                    </span>
                  </div>
                  <div className="font-mono text-[10px] text-[var(--cs-ink-muted)] cs-tabular">
                    RRF: {h.relevanceScore}
                    {h.semanticSimilarity !== null ? ` • Cosine: ${h.semanticSimilarity}` : ''}
                    {h.lexicalScore !== null ? ` • Lexical: ${h.lexicalScore}` : ''}
                  </div>
                  <p className="text-[11px] text-[var(--cs-ink-2)] line-clamp-2">{h.excerpt}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-[var(--cs-ink-muted)]">
              Upload a manual in <strong>Manuals</strong>, then run a conceptual query here (even with different phrasing) to inspect Hybrid RRF vs Cosine Vector scores live.
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
