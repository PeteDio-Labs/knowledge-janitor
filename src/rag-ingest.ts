/**
 * rag-ingest.ts — Feeds validated docs into blog-api RAG pipeline.
 * Only ingests files that pass staleness checks. Tracks hashes to avoid re-ingesting.
 */

import { readFileSync, writeFileSync } from 'fs';
import type { FileEntry } from './scanner.ts';

export interface IngestResult {
  file: string;
  chunks: number;
  skipped: boolean;
  reason?: string;
}

const HASH_CACHE_PATH = process.env.INGEST_HASH_CACHE ?? '/opt/knowledge-janitor/ingest-hashes.json';

function loadHashCache(): Map<string, string> {
  try {
    const raw = readFileSync(HASH_CACHE_PATH, 'utf-8');
    return new Map(Object.entries(JSON.parse(raw)));
  } catch {
    return new Map();
  }
}

function saveHashCache(cache: Map<string, string>): void {
  try {
    writeFileSync(HASH_CACHE_PATH, JSON.stringify(Object.fromEntries(cache), null, 2));
  } catch (err) {
    console.warn(`[rag-ingest] Failed to save hash cache: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function ingestToRag(
  entries: FileEntry[],
  blogApiUrl: string,
): Promise<IngestResult[]> {
  const ingestedHashes = loadHashCache();
  const results: IngestResult[] = [];

  for (const entry of entries) {
    // Skip if unchanged since last ingest
    if (ingestedHashes.get(entry.relativePath) === entry.contentHash) {
      results.push({ file: entry.relativePath, chunks: 0, skipped: true, reason: 'unchanged' });
      continue;
    }

    // Skip empty files
    if (entry.size < 50) {
      results.push({ file: entry.relativePath, chunks: 0, skipped: true, reason: 'too small' });
      continue;
    }

    try {
      const res = await fetch(`${blogApiUrl}/api/v1/rag/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: entry.content,
          sourceType: 'doc',
          sourceRef: entry.relativePath,
        }),
      });

      if (!res.ok) {
        const err = await res.text().catch(() => res.statusText);
        results.push({ file: entry.relativePath, chunks: 0, skipped: true, reason: `API error: ${err}` });
        continue;
      }

      const data = await res.json() as { chunks: number };
      ingestedHashes.set(entry.relativePath, entry.contentHash);
      results.push({ file: entry.relativePath, chunks: data.chunks, skipped: false });
    } catch (err) {
      results.push({
        file: entry.relativePath,
        chunks: 0,
        skipped: true,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  saveHashCache(ingestedHashes);
  return results;
}

export function formatIngestSummary(results: IngestResult[]): string {
  const ingested = results.filter(r => !r.skipped);
  const skipped = results.filter(r => r.skipped && r.reason === 'unchanged');
  const failed = results.filter(r => r.skipped && r.reason !== 'unchanged' && r.reason !== 'too small');
  const totalChunks = ingested.reduce((n, r) => n + r.chunks, 0);

  return [
    `Ingested: ${ingested.length} files (${totalChunks} chunks)`,
    `Skipped (unchanged): ${skipped.length}`,
    failed.length > 0 ? `Failed: ${failed.length} — ${failed.map(f => `${f.file}: ${f.reason}`).join(', ')}` : null,
  ].filter(Boolean).join('\n');
}
