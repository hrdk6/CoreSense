import React, { useEffect, useRef, useState } from 'react';
import { Database, FileText, Search, Shield, Trash2, Upload } from 'lucide-react';
import { apiRequest } from '../api';

interface DocumentRow {
  id: string;
  title: string;
  filename: string;
  pageCount: number;
  docVersion: string;
  summary: string;
  chunkCount: number;
  embeddedChunkCount?: number;
  fileSizeBytes: number;
  createdAt: string;
}

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

interface SearchHit {
  documentId: string;
  documentTitle: string;
  pageNumber: number;
  sectionHeading: string;
  excerpt: string;
  hasTable: boolean;
  hasCommandBlock: boolean;
  relevanceScore: number;
  matchMode?: 'hybrid_rrf' | 'semantic_vector' | 'lexical_fts';
  lexicalScore?: number | null;
  semanticSimilarity?: number | null;
}

export const KnowledgeBaseView: React.FC = () => {
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [ragStats, setRagStats] = useState<RagStats | null>(null);
  const [reembedding, setReembedding] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [uploading, setUploading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [pasteMode, setPasteMode] = useState(false);
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteContent, setPasteContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const loadDocs = async () => {
    const res = await apiRequest<{ documents: DocumentRow[]; ragStats?: RagStats }>('/api/v1/documents');
    setDocs(res.documents);
    if (res.ragStats) setRagStats(res.ragStats);
  };

  const handleReembed = async () => {
    setReembedding(true);
    setError(null);
    try {
      await apiRequest('/api/v1/documents/reembed', { method: 'POST', body: {} });
      await loadDocs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to embed missing chunks.');
    } finally {
      setReembedding(false);
    }
  };

  useEffect(() => {
    loadDocs().catch(() => {});
  }, []);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('title', file.name.replace(/\.[^.]+$/, ''));
      form.append('file', file);
      await apiRequest('/api/v1/documents', { method: 'POST', body: form, isFormData: true });
      await loadDocs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to upload and index file.');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handlePasteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setUploading(true);
    setError(null);
    try {
      await apiRequest('/api/v1/documents', {
        method: 'POST',
        body: {
          title: pasteTitle,
          filename: `${pasteTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`,
          mimeType: 'text/markdown',
          contentText: pasteContent,
        },
      });
      setPasteTitle('');
      setPasteContent('');
      setPasteMode(false);
      await loadDocs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to index pasted notes.');
    } finally {
      setUploading(false);
    }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim().length < 2) return;
    setSearching(true);
    try {
      const res = await apiRequest<{ results: SearchHit[] }>(
        `/api/v1/documents/search?q=${encodeURIComponent(query)}`,
      );
      setHits(res.results);
    } finally {
      setSearching(false);
    }
  };

  const handleDelete = async (id: string) => {
    await apiRequest(`/api/v1/documents/${id}`, { method: 'DELETE' });
    await loadDocs();
  };

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 pb-4 border-b border-[var(--cs-border)]">
        <div className="space-y-1">
          <h1 className="cs-heading text-2xl font-bold text-[var(--cs-ink)]">
            Technical manuals & reference library
          </h1>
          <p className="text-xs text-[var(--cs-ink-muted)] max-w-2xl">
            Index PDF service manuals, schematic notes, pinout tables, and error-code guides with traceable page citations for the copilot.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.md,.txt,.json,.csv,.log"
            onChange={handleFileUpload}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => setPasteMode((v) => !v)}
            className="cs-btn-secondary px-3.5 py-2 text-xs cursor-pointer"
          >
            {pasteMode ? 'Hide note editor' : 'Paste technical notes'}
          </button>
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            className="cs-btn-primary flex items-center gap-1.5 px-4 py-2 text-xs cursor-pointer disabled:opacity-50"
          >
            <Upload className="h-3.5 w-3.5" />
            <span>{uploading ? 'Indexing...' : 'Upload manual'}</span>
          </button>
        </div>
      </div>

      {/* Collapsible Paste Tech Notes Drawer */}
      {pasteMode && (
        <form onSubmit={handlePasteSubmit} className="cs-panel p-5 space-y-3 cs-animate-view">
          <div className="text-xs font-semibold text-[var(--cs-ink)]">Index pasted service notes</div>
          <input
            required
            value={pasteTitle}
            onChange={(e) => setPasteTitle(e.target.value)}
            placeholder="Manual or reference title (e.g. ThinkPad T14 Gen 3 Hardware Maintenance Manual)"
            className="cs-input w-full px-3 py-2 text-xs"
          />
          <textarea
            required
            rows={5}
            value={pasteContent}
            onChange={(e) => setPasteContent(e.target.value)}
            placeholder="Paste procedures, pinouts, beep-code tables, or service notes (use --- Page 2 --- to mark page breaks)..."
            className="cs-input w-full px-3 py-2 text-xs font-mono"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPasteMode(false)}
              className="cs-btn-secondary px-3 py-1.5 text-xs cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={uploading}
              className="cs-btn-accent px-4 py-1.5 text-xs cursor-pointer disabled:opacity-50"
            >
              Index document
            </button>
          </div>
        </form>
      )}

      {error && (
        <div className="rounded-lg border border-[var(--cs-danger-border)] bg-[var(--cs-danger-soft)] px-4 py-2.5 text-xs text-[var(--cs-danger-ink)]">
          {error}
        </div>
      )}

      {/* Hybrid Vector RAG Status Bar */}
      {ragStats && (
        <div className="cs-panel px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <Database className="h-3.5 w-3.5 text-[var(--cs-ok)] shrink-0" />
            <span className="font-semibold text-[var(--cs-ink)]">Hybrid Vector + Lexical RRF Index</span>
            <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-[var(--cs-well)] text-[var(--cs-ink-2)]">
              {ragStats.embeddingModel} ({ragStats.embeddingDimensions}d)
            </span>
            <span className="font-mono text-[11px] text-[var(--cs-ink-muted)] cs-tabular">
              {ragStats.embeddedChunks}/{ragStats.totalChunks} chunks vectorized ({ragStats.embeddingCoveragePercent}%)
            </span>
          </div>
          {ragStats.embeddedChunks < ragStats.totalChunks && (
            <button
              type="button"
              disabled={reembedding}
              onClick={handleReembed}
              className="cs-btn-secondary px-2.5 py-1 text-[11px] font-semibold cursor-pointer disabled:opacity-50"
            >
              {reembedding ? 'Vectorizing...' : 'Embed missing chunks'}
            </button>
          )}
        </div>
      )}

      {/* Search Bar */}
      <form onSubmit={handleSearch} className="cs-panel p-2 flex items-center gap-2">
        <Search className="h-4 w-4 text-[var(--cs-ink-muted)] ml-2 shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search indexed manuals (e.g. 'beep code 3-3-1', 'thermal paste torque', 'USB-C PD 20V')..."
          className="flex-1 bg-transparent text-sm text-[var(--cs-ink)] placeholder:text-[var(--cs-ink-muted)] focus:outline-none py-1.5"
        />
        <button
          type="submit"
          disabled={searching}
          className="cs-btn-accent px-4 py-2 text-xs cursor-pointer disabled:opacity-50"
        >
          {searching ? 'Searching...' : 'Search library'}
        </button>
      </form>

      {/* Retrieval Results */}
      {hits.length > 0 && (
        <div className="cs-panel p-4 space-y-3 cs-animate-view">
          <div className="flex items-center justify-between border-b border-[var(--cs-border)] pb-2.5">
            <h2 className="cs-heading text-sm font-bold text-[var(--cs-ink)]">
              Matching excerpts ({hits.length})
            </h2>
            <span className="text-xs text-[var(--cs-ink-muted)]">Available to Copilot automatically</span>
          </div>
          <div className="space-y-2.5">
            {hits.map((h, i) => (
              <div
                key={i}
                className="rounded-lg bg-[var(--cs-canvas)] border border-[var(--cs-border)] border-l-[3px] border-l-[var(--cs-accent)] p-3.5 space-y-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-[var(--cs-ink)]">{h.documentTitle}</span>
                    <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-[var(--cs-well)] text-[var(--cs-accent-ink)]">
                      Page {h.pageNumber}
                    </span>
                    <span className="text-[var(--cs-ink-muted)]">{h.sectionHeading}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 font-mono text-[11px]">
                    {h.matchMode && (
                      <span
                        className={`rounded px-1.5 py-0.5 border uppercase text-[10px] ${
                          h.matchMode === 'hybrid_rrf'
                            ? 'bg-[var(--cs-ok-soft)] border-[var(--cs-ok-border)] text-[var(--cs-ok-ink)]'
                            : h.matchMode === 'semantic_vector'
                              ? 'bg-[var(--cs-accent-soft)] border-[var(--cs-accent-border)] text-[var(--cs-accent-ink)]'
                              : 'bg-[var(--cs-well)] border-[var(--cs-border)] text-[var(--cs-ink-muted)]'
                        }`}
                      >
                        {h.matchMode.replace(/_/g, ' ')}
                      </span>
                    )}
                    {h.semanticSimilarity != null && (
                      <span className="rounded bg-[var(--cs-accent-soft)] text-[var(--cs-accent-ink)] px-1.5 py-0.5 cs-tabular">
                        Cosine {h.semanticSimilarity}
                      </span>
                    )}
                    {h.hasTable && (
                      <span className="rounded bg-[var(--cs-accent-soft)] text-[var(--cs-accent-ink)] px-1.5 py-0.5">
                        Table
                      </span>
                    )}
                    {h.hasCommandBlock && (
                      <span className="rounded bg-[var(--cs-ok-soft)] text-[var(--cs-ok-ink)] px-1.5 py-0.5">
                        Commands
                      </span>
                    )}
                    <span className="rounded bg-[var(--cs-well)] text-[var(--cs-ink-muted)] px-1.5 py-0.5 cs-tabular">
                      RRF {h.relevanceScore}
                    </span>
                  </div>
                </div>
                <p className="text-xs text-[var(--cs-ink-2)] leading-relaxed whitespace-pre-wrap max-w-[76ch]">
                  {h.excerpt}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Document Inventory */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
        {docs.length === 0 ? (
          <div className="md:col-span-2 cs-panel p-12 text-center space-y-2.5">
            <FileText className="h-9 w-9 text-[var(--cs-accent)] mx-auto" />
            <h2 className="cs-heading text-base font-bold text-[var(--cs-ink)]">No manuals indexed yet</h2>
            <p className="text-xs text-[var(--cs-ink-muted)] max-w-md mx-auto leading-relaxed">
              Upload laptop, phone, or motherboard service PDFs. CoreSense parses documents as
              reference data and links page citations directly inside copilot answers.
            </p>
          </div>
        ) : (
          docs.map((doc) => (
            <div
              key={doc.id}
              className="cs-panel p-4 flex items-start justify-between gap-3 hover:border-[var(--cs-border-strong)] transition-colors"
            >
              <div className="space-y-1.5 min-w-0">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-[var(--cs-accent)] shrink-0" />
                  <h3 className="cs-heading text-sm font-bold text-[var(--cs-ink)] truncate">
                    {doc.title}
                  </h3>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono text-[var(--cs-ink-muted)] cs-tabular">
                  <span className="truncate max-w-[180px]">{doc.filename}</span>
                  <span className="px-1.5 py-0.5 rounded bg-[var(--cs-well)] text-[var(--cs-ink-2)]">
                    {doc.pageCount} pg
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-[var(--cs-well)] text-[var(--cs-ink-2)]">
                    {doc.chunkCount} chunks
                  </span>
                  <span>v{doc.docVersion}</span>
                </div>
                <p className="text-xs text-[var(--cs-ink-2)] line-clamp-2 leading-relaxed">{doc.summary}</p>
              </div>
              <button
                type="button"
                onClick={() => handleDelete(doc.id)}
                className="p-1.5 rounded-md hover:bg-[var(--cs-danger-soft)] text-[var(--cs-ink-muted)] hover:text-[var(--cs-danger)] transition-colors cursor-pointer shrink-0"
                title="Delete manual"
                aria-label="Delete manual"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))
        )}
      </div>

      {/* Security Assurance Footer */}
      <div className="flex items-center gap-2 text-xs text-[var(--cs-ink-muted)] pt-1">
        <Shield className="h-4 w-4 text-[var(--cs-ok)] shrink-0" />
        <span>
          Prompt-injection isolation active: uploaded manuals are read strictly as untrusted reference text and cannot override safety policies or trigger commands.
        </span>
      </div>
    </div>
  );
};
