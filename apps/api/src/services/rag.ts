import crypto from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { sanitizeUntrustedDocumentExcerpt } from '@coresense/shared';
import type { CustomerDatabase } from '../db/customerDb.js';
import type { OwnerDatabase } from '../db/ownerDb.js';
import type { AppConfig } from '../config.js';

export interface ParsedChunk {
  chunkIndex: number;
  pageNumber: number;
  sectionHeading: string;
  hasTable: boolean;
  hasCommandBlock: boolean;
  content: string;
}

export interface RetrievedCitation {
  documentId: string;
  documentTitle: string;
  docVersion: string;
  chunkId: string;
  pageNumber: number;
  sectionHeading: string;
  excerpt: string;
  hasTable: boolean;
  hasCommandBlock: boolean;
  relevanceScore: number;
  flaggedInjectionAttempt: boolean;
}

async function extractPagesFromBuffer(
  buffer: Buffer,
  detectedKind: 'pdf' | 'text',
): Promise<Array<{ pageNumber: number; text: string }>> {
  if (detectedKind === 'pdf') {
    // Use pdf-parse with per-page rendering hook to preserve exact page numbers
    const pdfParseModule = await import('pdf-parse');
    const pdfParse = pdfParseModule.default ?? (pdfParseModule as unknown as (b: Buffer, opts?: unknown) => Promise<{ text: string; numpages: number }>);
    const pages: Array<{ pageNumber: number; text: string }> = [];
    let currentPage = 0;

    try {
      await pdfParse(buffer, {
        pagerender: (pageData: { getTextContent: () => Promise<{ items: Array<{ str: string; hasEOL?: boolean }> }> }) =>
          pageData.getTextContent().then((tc) => {
            currentPage += 1;
            const text = tc.items.map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join('');
            pages.push({ pageNumber: currentPage, text: text.trim() });
            return text;
          }),
      });
    } catch {
      // Fallback: extract printable ASCII/UTF-8 text runs if PDF has unusual xref
      const raw = buffer.toString('latin1');
      const cleaned = raw.replace(/[^\x20-\x7E\r\n]/g, ' ').replace(/\s{3,}/g, '\n');
      return [{ pageNumber: 1, text: cleaned.slice(0, 60_000) }];
    }

    return pages.length > 0 ? pages : [{ pageNumber: 1, text: '' }];
  }

  // Plain text / Markdown — support explicit form-feed (\f) or `--- Page N ---` markers
  const fullText = buffer.toString('utf8');
  const rawPages = fullText.split(/\f|\n-{3,}\s*page\s+\d+\s*-{3,}\n/i);
  return rawPages.map((text, idx) => ({
    pageNumber: idx + 1,
    text: text.trim(),
  }));
}

function detectHeading(lines: string[], fallback: string): string {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const md = trimmed.match(/^#{1,4}\s+(.+)$/);
    if (md) return md[1].trim().slice(0, 120);
    const numbered = trimmed.match(/^(\d+(?:\.\d+)*\s+[A-Z][^\n]{3,90})$/);
    if (numbered) return numbered[1].trim().slice(0, 120);
    if (trimmed.length >= 4 && trimmed.length <= 75 && trimmed === trimmed.toUpperCase() && /[A-Z]{3}/.test(trimmed)) {
      return trimmed;
    }
  }
  return fallback;
}

function chunkDocumentPages(pages: Array<{ pageNumber: number; text: string }>): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  let runningHeading = 'General Specification';
  let chunkIndex = 0;

  for (const page of pages) {
    if (!page.text.trim()) continue;
    // Split on double newlines while preserving fenced code blocks and tables
    const paragraphs = page.text.split(/\n{2,}/);
    let buffer = '';

    const flush = () => {
      const content = buffer.trim();
      if (!content) return;
      const lines = content.split('\n');
      runningHeading = detectHeading(lines, runningHeading);
      const hasTable = /\|.+\|/.test(content) || /\t.+\t/.test(content);
      const hasCommandBlock = /```|`[^`]+`|\$\s+[a-z0-9_-]+|C:\\>/i.test(content);
      chunks.push({
        chunkIndex: chunkIndex++,
        pageNumber: page.pageNumber,
        sectionHeading: runningHeading,
        hasTable,
        hasCommandBlock,
        content,
      });
      buffer = '';
    };

    for (const para of paragraphs) {
      if (buffer.length + para.length > 1100 && buffer.length > 250) {
        flush();
      }
      buffer = buffer ? `${buffer}\n\n${para}` : para;
    }
    flush();
  }

  return chunks;
}

async function computeEmbeddingIfConfigured(
  text: string,
  config: AppConfig,
  ownerDb: OwnerDatabase,
  anonymousUserHash?: string,
): Promise<number[] | null> {
  if (!config.geminiApiKey) return null;
  const started = Date.now();
  try {
    const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
    const res = await ai.models.embedContent({
      model: config.geminiEmbeddingModel,
      contents: text.slice(0, 4000),
    });
    const values = res.embeddings?.[0]?.values ?? null;
    ownerDb.recordAiUsage({
      anonymousUserHash,
      provider: 'gemini',
      model: config.geminiEmbeddingModel,
      feature: 'knowledge_base_embedding',
      modality: 'embedding',
      inputTokens: Math.ceil(text.length / 4),
      outputTokens: 0,
      latencyMs: Date.now() - started,
      estimatedCostUsd: (Math.ceil(text.length / 4) / 1_000_000) * 0.025,
      success: true,
    });
    return values ?? null;
  } catch (err) {
    ownerDb.recordAiUsage({
      anonymousUserHash,
      provider: 'gemini',
      model: config.geminiEmbeddingModel,
      feature: 'knowledge_base_embedding',
      modality: 'embedding',
      inputTokens: Math.ceil(text.length / 4),
      outputTokens: 0,
      latencyMs: Date.now() - started,
      estimatedCostUsd: 0,
      success: false,
      errorCode: err instanceof Error ? err.name : 'EMBED_ERROR',
    });
    return null;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

export async function ingestTechnicalDocument(params: {
  customerDb: CustomerDatabase;
  ownerDb: OwnerDatabase;
  config: AppConfig;
  userId: string;
  anonymousUserHash?: string;
  deviceId?: string;
  title: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  detectedKind: 'pdf' | 'text';
  docVersion?: string;
}): Promise<{
  documentId: string;
  pageCount: number;
  chunkCount: number;
  summary: string;
}> {
  const { customerDb, ownerDb, config, userId, anonymousUserHash, deviceId, title, filename, mimeType, buffer, detectedKind } = params;
  const pages = await extractPagesFromBuffer(buffer, detectedKind);
  const chunks = chunkDocumentPages(pages);
  const docId = crypto.randomUUID();
  const now = new Date().toISOString();
  const summary =
    chunks.length > 0
      ? `Indexed ${chunks.length} section chunk(s) across ${pages.length} page(s). Key sections: ${Array.from(new Set(chunks.map((c) => c.sectionHeading))).slice(0, 4).join(', ')}.`
      : 'Document stored, but no extractable text was found (may be a scanned image-only PDF).';

  customerDb.db
    .prepare(
      `INSERT INTO documents (
        id, user_id, device_id, title, filename, mime_type, file_size_bytes,
        page_count, doc_version, summary, chunk_count, status, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'indexed', 1, ?, ?)`,
    )
    .run(
      docId,
      userId,
      deviceId ?? null,
      title,
      filename,
      mimeType,
      buffer.length,
      pages.length,
      params.docVersion || '1.0',
      summary,
      chunks.length,
      now,
      now,
    );

  const insertChunk = customerDb.db.prepare(
    `INSERT INTO document_chunks (
      id, document_id, user_id, chunk_index, page_number, section_heading,
      has_table, has_command_block, content, embedding_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = customerDb.db.prepare(
    'INSERT INTO document_chunks_fts (chunk_id, document_id, user_id, title, section_heading, content) VALUES (?, ?, ?, ?, ?, ?)',
  );

  // Embed up to first 20 chunks when Gemini API is active so uploads remain fast
  for (const ch of chunks) {
    const chunkId = crypto.randomUUID();
    const embedding =
      ch.chunkIndex < 20
        ? await computeEmbeddingIfConfigured(
            `${title} — ${ch.sectionHeading}\n${ch.content}`,
            config,
            ownerDb,
            anonymousUserHash,
          )
        : null;
    insertChunk.run(
      chunkId,
      docId,
      userId,
      ch.chunkIndex,
      ch.pageNumber,
      ch.sectionHeading,
      ch.hasTable ? 1 : 0,
      ch.hasCommandBlock ? 1 : 0,
      ch.content,
      embedding ? JSON.stringify(embedding) : null,
      now,
    );
    insertFts.run(chunkId, docId, userId, title, ch.sectionHeading, ch.content);
  }

  customerDb.recordSyncChange(userId, 'document', docId, 'upsert', 1);
  customerDb.recordAudit(userId, 'document_uploaded', 'document', docId, {
    pageCount: pages.length,
    chunkCount: chunks.length,
  });

  return { documentId: docId, pageCount: pages.length, chunkCount: chunks.length, summary };
}

function buildSafeFtsQuery(rawQuery: string): string {
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'what', 'when',
    'where', 'does', 'your', 'about', 'into', 'why', 'how', 'can', 'not', 'are', 'was',
  ]);
  const tokens = rawQuery
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !stopWords.has(t))
    .slice(0, 12);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

export async function searchUserKnowledgeBase(params: {
  customerDb: CustomerDatabase;
  ownerDb: OwnerDatabase;
  config: AppConfig;
  userId: string;
  anonymousUserHash?: string;
  query: string;
  deviceId?: string;
  limit?: number;
}): Promise<RetrievedCitation[]> {
  const { customerDb, ownerDb, config, userId, anonymousUserHash, query, limit = 5 } = params;
  const ftsQuery = buildSafeFtsQuery(query);
  if (!ftsQuery) return [];

  const rows = customerDb.db
    .prepare(
      `SELECT
        dc.id AS chunk_id,
        dc.document_id,
        d.title AS document_title,
        d.doc_version,
        dc.page_number,
        dc.section_heading,
        dc.has_table,
        dc.has_command_block,
        dc.content,
        dc.embedding_json,
        bm25(document_chunks_fts) AS bm25_rank
      FROM document_chunks_fts
      JOIN document_chunks dc ON dc.id = document_chunks_fts.chunk_id
      JOIN documents d ON d.id = dc.document_id
      WHERE document_chunks_fts MATCH ?
        AND dc.user_id = ?
        AND d.deleted_at IS NULL
      ORDER BY bm25_rank ASC
      LIMIT ?`,
    )
    .all(ftsQuery, userId, limit * 3) as Array<{
    chunk_id: string;
    document_id: string;
    document_title: string;
    doc_version: string;
    page_number: number;
    section_heading: string;
    has_table: number;
    has_command_block: number;
    content: string;
    embedding_json: string | null;
    bm25_rank: number;
  }>;

  if (rows.length === 0) return [];

  let queryEmbedding: number[] | null = null;
  if (config.geminiApiKey && rows.some((r) => r.embedding_json)) {
    queryEmbedding = await computeEmbeddingIfConfigured(query, config, ownerDb, anonymousUserHash);
  }

  const scored = rows.map((r) => {
    const bm25Score = 1 / (1 + Math.abs(r.bm25_rank || 0));
    let semanticScore = 0;
    if (queryEmbedding && r.embedding_json) {
      try {
        semanticScore = cosineSimilarity(queryEmbedding, JSON.parse(r.embedding_json) as number[]);
      } catch {
        semanticScore = 0;
      }
    }
    const combined = queryEmbedding ? bm25Score * 0.45 + semanticScore * 0.55 : bm25Score;
    const { sanitized, flaggedInjectionAttempt } = sanitizeUntrustedDocumentExcerpt(r.content);
    return {
      documentId: r.document_id,
      documentTitle: r.document_title,
      docVersion: r.doc_version,
      chunkId: r.chunk_id,
      pageNumber: r.page_number,
      sectionHeading: r.section_heading,
      excerpt: sanitized.slice(0, 600),
      hasTable: r.has_table === 1,
      hasCommandBlock: r.has_command_block === 1,
      relevanceScore: Math.round(combined * 1000) / 1000,
      flaggedInjectionAttempt,
    };
  });

  scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return scored.slice(0, limit);
}

export function deleteUserDocument(customerDb: CustomerDatabase, userId: string, documentId: string): boolean {
  const existing = customerDb.db
    .prepare('SELECT id, revision FROM documents WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(documentId, userId) as { id: string; revision: number } | undefined;
  if (!existing) return false;

  const now = new Date().toISOString();
  const nextRev = existing.revision + 1;
  customerDb.db.prepare('DELETE FROM document_chunks_fts WHERE document_id = ? AND user_id = ?').run(documentId, userId);
  customerDb.db.prepare('DELETE FROM document_chunks WHERE document_id = ? AND user_id = ?').run(documentId, userId);
  customerDb.db
    .prepare('UPDATE documents SET deleted_at = ?, revision = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(now, nextRev, now, documentId, userId);
  customerDb.recordSyncChange(userId, 'document', documentId, 'delete', nextRev);
  customerDb.recordAudit(userId, 'document_deleted', 'document', documentId);
  return true;
}
