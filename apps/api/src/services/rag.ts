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

export type RetrievalMatchMode = 'hybrid_rrf' | 'semantic_vector' | 'lexical_fts';

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
  matchMode: RetrievalMatchMode;
  lexicalScore: number | null;
  semanticSimilarity: number | null;
  flaggedInjectionAttempt: boolean;
}

export interface UserRagStats {
  documentCount: number;
  totalChunks: number;
  embeddedChunks: number;
  embeddingCoveragePercent: number;
  embeddingModel: string;
  embeddingDimensions: number;
  fusionMethod: string;
  vectorSearchActive: boolean;
}

const EMBEDDING_DIMS = 768;
const RRF_K = 60;

async function extractPagesFromBuffer(
  buffer: Buffer,
  detectedKind: 'pdf' | 'text',
): Promise<Array<{ pageNumber: number; text: string }>> {
  if (detectedKind === 'pdf') {
    const pdfParseModule = await import('pdf-parse');
    const pdfParse =
      pdfParseModule.default ??
      (pdfParseModule as unknown as (b: Buffer, opts?: unknown) => Promise<{ text: string; numpages: number }>);
    const pages: Array<{ pageNumber: number; text: string }> = [];
    let currentPage = 0;

    try {
      await pdfParse(buffer, {
        pagerender: (pageData: {
          getTextContent: () => Promise<{ items: Array<{ str: string; hasEOL?: boolean }> }>;
        }) =>
          pageData.getTextContent().then((tc) => {
            currentPage += 1;
            const text = tc.items.map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join('');
            pages.push({ pageNumber: currentPage, text: text.trim() });
            return text;
          }),
      });
    } catch {
      const raw = buffer.toString('latin1');
      const cleaned = raw.replace(/[^\x20-\x7E\r\n]/g, ' ').replace(/\s{3,}/g, '\n');
      return [{ pageNumber: 1, text: cleaned.slice(0, 60_000) }];
    }

    return pages.length > 0 ? pages : [{ pageNumber: 1, text: '' }];
  }

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

function l2Normalize(vec: number[]): number[] {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq);
  if (norm <= 1e-12) return vec;
  const out = new Array<number>(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = Math.round((vec[i] / norm) * 100_000) / 100_000;
  }
  return out;
}

export function cosineSimilarity(a: number[], b: number[]): number {
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

export async function computeEmbeddingIfConfigured(
  text: string,
  config: AppConfig,
  ownerDb: OwnerDatabase,
  anonymousUserHash?: string,
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' = 'RETRIEVAL_DOCUMENT',
): Promise<number[] | null> {
  if (!config.geminiApiKey) return null;
  const started = Date.now();
  const modelsToTry = Array.from(new Set([config.geminiEmbeddingModel || 'gemini-embedding-2', 'gemini-embedding-001']));

  for (const activeModel of modelsToTry) {
    try {
      const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
      const res = await ai.models.embedContent({
        model: activeModel,
        contents: text.slice(0, 4000),
        config: {
          outputDimensionality: EMBEDDING_DIMS,
          taskType,
        },
      });
      const rawValues = res.embeddings?.[0]?.values ?? null;
      if (rawValues && rawValues.length > 0) {
        const normalized = l2Normalize(rawValues);
        await ownerDb.recordAiUsage({
          anonymousUserHash,
          provider: 'gemini',
          model: activeModel,
          feature: 'knowledge_base_embedding',
          modality: 'embedding',
          inputTokens: Math.ceil(text.length / 4),
          outputTokens: 0,
          latencyMs: Date.now() - started,
          estimatedCostUsd: (Math.ceil(text.length / 4) / 1_000_000) * 0.025,
          success: true,
        });
        return normalized;
      }
    } catch (err) {
      await ownerDb.recordAiUsage({
        anonymousUserHash,
        provider: 'gemini',
        model: activeModel,
        feature: 'knowledge_base_embedding',
        modality: 'embedding',
        inputTokens: Math.ceil(text.length / 4),
        outputTokens: 0,
        latencyMs: Date.now() - started,
        estimatedCostUsd: 0,
        success: false,
        errorCode: err instanceof Error ? err.name : 'EMBED_ERROR',
      });
    }
  }
  return null;
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
  embeddedChunkCount: number;
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

  await customerDb.db.run(
    `INSERT INTO documents (
      id, user_id, device_id, title, filename, mime_type, file_size_bytes,
      page_count, doc_version, summary, chunk_count, status, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'indexed', 1, ?, ?)`,
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

  // Batch-embed up to 40 chunks concurrently (batches of 5) using gemini-embedding-2 (768d)
  const embeddingsByIndex = new Map<number, number[] | null>();
  const maxEmbedChunks = Math.min(chunks.length, 40);
  if (config.geminiApiKey && maxEmbedChunks > 0) {
    const batchSize = 5;
    for (let i = 0; i < maxEmbedChunks; i += batchSize) {
      const slice = chunks.slice(i, Math.min(i + batchSize, maxEmbedChunks));
      const results = await Promise.all(
        slice.map((ch) =>
          computeEmbeddingIfConfigured(
            `${title} — ${ch.sectionHeading}\n${ch.content}`,
            config,
            ownerDb,
            anonymousUserHash,
            'RETRIEVAL_DOCUMENT',
          ),
        ),
      );
      slice.forEach((ch, idx) => embeddingsByIndex.set(ch.chunkIndex, results[idx]));
    }
  }

  let embeddedChunkCount = 0;
  for (const ch of chunks) {
    const chunkId = crypto.randomUUID();
    const embedding = embeddingsByIndex.get(ch.chunkIndex) ?? null;
    if (embedding) embeddedChunkCount += 1;

    await customerDb.db.run(
      `INSERT INTO document_chunks (
        id, document_id, user_id, chunk_index, page_number, section_heading,
        has_table, has_command_block, content, embedding_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    if (customerDb.db.dialect === 'sqlite') {
      await customerDb.db.run(
        'INSERT INTO document_chunks_fts (chunk_id, document_id, user_id, title, section_heading, content) VALUES (?, ?, ?, ?, ?, ?)',
        chunkId,
        docId,
        userId,
        title,
        ch.sectionHeading,
        ch.content,
      );
    }
  }

  await customerDb.recordSyncChange(userId, 'document', docId, 'upsert', 1);
  await customerDb.recordAudit(userId, 'document_uploaded', 'document', docId, {
    pageCount: pages.length,
    chunkCount: chunks.length,
    embeddedChunkCount,
  });

  return { documentId: docId, pageCount: pages.length, chunkCount: chunks.length, embeddedChunkCount, summary };
}

export async function reembedUserDocuments(params: {
  customerDb: CustomerDatabase;
  ownerDb: OwnerDatabase;
  config: AppConfig;
  userId: string;
  anonymousUserHash?: string;
  maxChunks?: number;
}): Promise<{ embeddedNow: number; remainingUnembedded: number; totalChunks: number }> {
  const { customerDb, ownerDb, config, userId, anonymousUserHash, maxChunks = 50 } = params;
  const totalRow = await customerDb.db.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM document_chunks dc
     JOIN documents d ON d.id = dc.document_id
     WHERE dc.user_id = ? AND d.deleted_at IS NULL`,
    userId,
  );
  const totalChunks = Number(totalRow?.c ?? 0);

  if (!config.geminiApiKey) {
    const missingRow = await customerDb.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM document_chunks dc
       JOIN documents d ON d.id = dc.document_id
       WHERE dc.user_id = ? AND d.deleted_at IS NULL AND dc.embedding_json IS NULL`,
      userId,
    );
    return { embeddedNow: 0, remainingUnembedded: Number(missingRow?.c ?? 0), totalChunks };
  }

  const pending = await customerDb.db.all<{
    id: string;
    title: string;
    section_heading: string;
    content: string;
  }>(
    `SELECT dc.id, d.title, dc.section_heading, dc.content
     FROM document_chunks dc
     JOIN documents d ON d.id = dc.document_id
     WHERE dc.user_id = ? AND d.deleted_at IS NULL AND dc.embedding_json IS NULL
     LIMIT ?`,
    userId,
    maxChunks,
  );

  let embeddedNow = 0;
  const batchSize = 5;
  for (let i = 0; i < pending.length; i += batchSize) {
    const slice = pending.slice(i, i + batchSize);
    const vecs = await Promise.all(
      slice.map((row) =>
        computeEmbeddingIfConfigured(
          `${row.title} — ${row.section_heading}\n${row.content}`,
          config,
          ownerDb,
          anonymousUserHash,
          'RETRIEVAL_DOCUMENT',
        ),
      ),
    );
    for (let j = 0; j < slice.length; j++) {
      if (vecs[j]) {
        await customerDb.db.run('UPDATE document_chunks SET embedding_json = ? WHERE id = ?', JSON.stringify(vecs[j]), slice[j].id);
        embeddedNow += 1;
      }
    }
  }

  const remainingRow = await customerDb.db.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM document_chunks dc
     JOIN documents d ON d.id = dc.document_id
     WHERE dc.user_id = ? AND d.deleted_at IS NULL AND dc.embedding_json IS NULL`,
    userId,
  );

  return {
    embeddedNow,
    remainingUnembedded: Number(remainingRow?.c ?? 0),
    totalChunks,
  };
}

export async function getUserRagStats(
  customerDb: CustomerDatabase,
  config: AppConfig,
  userId: string,
): Promise<UserRagStats> {
  const docRow = await customerDb.db.get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM documents WHERE user_id = ? AND deleted_at IS NULL',
    userId,
  );
  const chunkRow = await customerDb.db.get<{ total: number; embedded: number }>(
    `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN dc.embedding_json IS NOT NULL THEN 1 ELSE 0 END) AS embedded
     FROM document_chunks dc
     JOIN documents d ON d.id = dc.document_id
     WHERE dc.user_id = ? AND d.deleted_at IS NULL`,
    userId,
  );
  const totalChunks = Number(chunkRow?.total ?? 0);
  const embeddedChunks = Number(chunkRow?.embedded ?? 0);
  const coverage = totalChunks > 0 ? Math.round((embeddedChunks / totalChunks) * 1000) / 10 : 0;

  return {
    documentCount: Number(docRow?.c ?? 0),
    totalChunks,
    embeddedChunks,
    embeddingCoveragePercent: coverage,
    embeddingModel: config.geminiEmbeddingModel || 'gemini-embedding-2',
    embeddingDimensions: EMBEDDING_DIMS,
    fusionMethod: 'Reciprocal Rank Fusion (RRF k=60: FTS Lexical + 768d Cosine Vector)',
    vectorSearchActive: Boolean(config.geminiApiKey) && embeddedChunks > 0,
  };
}

function extractQueryTokens(rawQuery: string): string[] {
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'what', 'when',
    'where', 'does', 'your', 'about', 'into', 'why', 'how', 'can', 'not', 'are', 'was',
  ]);
  return rawQuery
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !stopWords.has(t))
    .slice(0, 12);
}

/**
 * Pure Reciprocal Rank Fusion (RRF, Cormack et al.) helper exported for deterministic unit tests & live hybrid search.
 */
export function computeHybridRrfScore(params: {
  lexicalRank: number | null; // 1-based rank, or null if not matched lexically
  vectorRank: number | null;  // 1-based rank, or null if not matched semantically
  k?: number;
}): number {
  const k = params.k ?? RRF_K;
  let score = 0;
  if (params.lexicalRank !== null && params.lexicalRank >= 1) {
    score += 1 / (k + params.lexicalRank);
  }
  if (params.vectorRank !== null && params.vectorRank >= 1) {
    score += 1 / (k + params.vectorRank);
  }
  return Math.round(score * 100_000) / 100_000;
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
  const trimmedQuery = query.trim();
  if (trimmedQuery.length < 2) return [];
  const tokens = extractQueryTokens(trimmedQuery);

  type ChunkCandidate = {
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
    bm25_rank?: number;
  };

  // Channel A: Lexical FTS Search (Postgres GIN tsvector / SQLite FTS5 BM25)
  const runLexicalSearch = async (): Promise<ChunkCandidate[]> => {
    if (tokens.length === 0) return [];
    if (customerDb.db.dialect === 'postgres') {
      const pgTsQuery = tokens.map((t) => t.replace(/[^a-z0-9]/g, '')).filter(Boolean).join(' | ');
      if (!pgTsQuery) return [];
      return customerDb.db.all<ChunkCandidate>(
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
          -ts_rank(
            to_tsvector('english', d.title || ' ' || dc.section_heading || ' ' || dc.content),
            to_tsquery('english', ?)
          ) AS bm25_rank
        FROM document_chunks dc
        JOIN documents d ON d.id = dc.document_id
        WHERE to_tsvector('english', d.title || ' ' || dc.section_heading || ' ' || dc.content) @@ to_tsquery('english', ?)
          AND dc.user_id = ?
          AND d.deleted_at IS NULL
        ORDER BY bm25_rank ASC
        LIMIT ?`,
        pgTsQuery,
        pgTsQuery,
        userId,
        limit * 4,
      );
    }
    const ftsQuery = tokens.map((t) => `"${t}"`).join(' OR ');
    return customerDb.db.all<ChunkCandidate>(
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
      ftsQuery,
      userId,
      limit * 4,
    );
  };

  // Channel B: Dense Semantic Vector Retrieval (works even when 0 keywords overlap!)
  const runSemanticSearch = async (): Promise<Array<{ row: ChunkCandidate; similarity: number }>> => {
    if (!config.geminiApiKey) return [];
    const embeddedRows = await customerDb.db.all<ChunkCandidate>(
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
        dc.embedding_json
      FROM document_chunks dc
      JOIN documents d ON d.id = dc.document_id
      WHERE dc.user_id = ?
        AND d.deleted_at IS NULL
        AND dc.embedding_json IS NOT NULL
      LIMIT 400`,
      userId,
    );
    if (embeddedRows.length === 0) return [];

    const queryEmbedding = await computeEmbeddingIfConfigured(
      trimmedQuery,
      config,
      ownerDb,
      anonymousUserHash,
      'RETRIEVAL_QUERY',
    );
    if (!queryEmbedding) return [];

    const scoredVecs: Array<{ row: ChunkCandidate; similarity: number }> = [];
    for (const row of embeddedRows) {
      if (!row.embedding_json) continue;
      try {
        const vec = JSON.parse(row.embedding_json) as number[];
        const sim = cosineSimilarity(queryEmbedding, vec);
        if (sim >= 0.36) {
          scoredVecs.push({ row, similarity: sim });
        }
      } catch {
        // skip malformed vector
      }
    }
    scoredVecs.sort((a, b) => b.similarity - a.similarity);
    return scoredVecs.slice(0, limit * 4);
  };

  const [lexicalRows, vectorHits] = await Promise.all([runLexicalSearch(), runSemanticSearch()]);

  if (lexicalRows.length === 0 && vectorHits.length === 0) return [];

  // Merge candidates via Reciprocal Rank Fusion (RRF, k = 60)
  const merged = new Map<
    string,
    {
      row: ChunkCandidate;
      lexicalRank: number | null;
      lexicalScore: number | null;
      vectorRank: number | null;
      semanticSimilarity: number | null;
    }
  >();

  lexicalRows.forEach((row, idx) => {
    const lexScore = Math.round((1 / (1 + Math.abs(row.bm25_rank || 0))) * 1000) / 1000;
    merged.set(row.chunk_id, {
      row,
      lexicalRank: idx + 1,
      lexicalScore: lexScore,
      vectorRank: null,
      semanticSimilarity: null,
    });
  });

  vectorHits.forEach((hit, idx) => {
    const existing = merged.get(hit.row.chunk_id);
    const roundedSim = Math.round(hit.similarity * 1000) / 1000;
    if (existing) {
      existing.vectorRank = idx + 1;
      existing.semanticSimilarity = roundedSim;
    } else if (hit.similarity >= 0.42) {
      // Semantic-only match (zero exact keyword overlap required!)
      merged.set(hit.row.chunk_id, {
        row: hit.row,
        lexicalRank: null,
        lexicalScore: null,
        vectorRank: idx + 1,
        semanticSimilarity: roundedSim,
      });
    }
  });

  const maxPossibleRrf = 2 / (RRF_K + 1);
  const results: RetrievedCitation[] = [];

  for (const entry of merged.values()) {
    const rrf = computeHybridRrfScore({
      lexicalRank: entry.lexicalRank,
      vectorRank: entry.vectorRank,
    });
    const matchMode: RetrievalMatchMode =
      entry.lexicalRank !== null && entry.vectorRank !== null
        ? 'hybrid_rrf'
        : entry.vectorRank !== null
          ? 'semantic_vector'
          : 'lexical_fts';

    // Normalize fused score cleanly to 0..1 scale for readable UI display
    const normalizedScore = Math.min(1, Math.round((rrf / maxPossibleRrf) * 1000) / 1000);
    const { sanitized, flaggedInjectionAttempt } = sanitizeUntrustedDocumentExcerpt(entry.row.content);

    results.push({
      documentId: entry.row.document_id,
      documentTitle: entry.row.document_title,
      docVersion: entry.row.doc_version,
      chunkId: entry.row.chunk_id,
      pageNumber: entry.row.page_number,
      sectionHeading: entry.row.section_heading,
      excerpt: sanitized.slice(0, 600),
      hasTable: entry.row.has_table === 1,
      hasCommandBlock: entry.row.has_command_block === 1,
      relevanceScore: normalizedScore,
      matchMode,
      lexicalScore: entry.lexicalScore,
      semanticSimilarity: entry.semanticSimilarity,
      flaggedInjectionAttempt,
    });
  }

  results.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return results.slice(0, limit);
}

export async function deleteUserDocument(
  customerDb: CustomerDatabase,
  userId: string,
  documentId: string,
): Promise<boolean> {
  const existing = await customerDb.db.get<{ id: string; revision: number }>(
    'SELECT id, revision FROM documents WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    documentId,
    userId,
  );
  if (!existing) return false;

  const now = new Date().toISOString();
  const nextRev = existing.revision + 1;
  if (customerDb.db.dialect === 'sqlite') {
    await customerDb.db.run('DELETE FROM document_chunks_fts WHERE document_id = ? AND user_id = ?', documentId, userId);
  }
  await customerDb.db.run('DELETE FROM document_chunks WHERE document_id = ? AND user_id = ?', documentId, userId);
  await customerDb.db.run(
    'UPDATE documents SET deleted_at = ?, revision = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    now,
    nextRev,
    now,
    documentId,
    userId,
  );
  await customerDb.recordSyncChange(userId, 'document', documentId, 'delete', nextRev);
  await customerDb.recordAudit(userId, 'document_deleted', 'document', documentId);
  return true;
}
