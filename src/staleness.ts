/**
 * staleness.ts — Rules engine that flags files needing attention.
 */

import { access } from 'fs/promises';
import { resolve, dirname, join } from 'path';
import type { FileEntry } from './scanner.ts';

export type StalenessFlag =
  | 'stale'
  | 'stale-wip'
  | 'broken-links'
  | 'archive-candidate'
  | 'duplicate'
  | 'empty'
  | 'legacy-paths';

export interface FlaggedFile {
  entry: FileEntry;
  flags: StalenessFlag[];
  reasons: string[];
}

const NOW = () => new Date();
const DAY_MS = 24 * 60 * 60 * 1000;

const LEGACY_PATTERNS = [
  'blog-homelab',
  'homelab/knowledge/phase-',
  'Java Spring Boot',
  'Maven',
  'qwen2.5:7b',                // old primary LLM
  'project-management/inventory/machines.md',
];

const WIP_STATUSES = ['in progress', 'in-progress', 'implementing', 'wip'];

async function linkExists(link: string, fileDir: string, knowledgeRoot: string): Promise<boolean> {
  // Absolute path from workspace
  const absPath = link.startsWith('/')
    ? resolve(knowledgeRoot, '..', link.slice(1))
    : resolve(fileDir, link);
  try {
    await access(absPath);
    return true;
  } catch {
    return false;
  }
}

export async function checkStaleness(
  entries: FileEntry[],
  knowledgeRoot: string,
): Promise<FlaggedFile[]> {
  const now = NOW();
  const hashCount = new Map<string, number>();
  for (const e of entries) {
    hashCount.set(e.contentHash, (hashCount.get(e.contentHash) ?? 0) + 1);
  }

  const flagged: FlaggedFile[] = [];

  for (const entry of entries) {
    const flags: StalenessFlag[] = [];
    const reasons: string[] = [];

    // Empty file
    if (entry.size < 50) {
      flags.push('empty');
      reasons.push(`File is only ${entry.size} bytes`);
    }

    // Duplicate content
    if ((hashCount.get(entry.contentHash) ?? 0) > 1) {
      flags.push('duplicate');
      reasons.push('Identical content hash found in another file');
    }

    // Legacy path patterns
    const legacyFound = LEGACY_PATTERNS.filter(p => entry.content.includes(p));
    if (legacyFound.length > 0) {
      flags.push('legacy-paths');
      reasons.push(`References legacy patterns: ${legacyFound.slice(0, 3).join(', ')}`);
    }

    // Age-based staleness (use lastUpdated header, fall back to mtime)
    const ageDate = entry.lastUpdated ?? entry.modifiedAt;
    const ageDays = (now.getTime() - ageDate.getTime()) / DAY_MS;

    if (ageDays > 14) {
      flags.push('stale');
      reasons.push(`Last updated ${Math.floor(ageDays)} days ago`);
    }

    // Stale WIP
    const statusLower = (entry.status ?? '').toLowerCase();
    const isWip = WIP_STATUSES.some(w => statusLower.includes(w));
    if (isWip && ageDays > 7) {
      flags.push('stale-wip');
      reasons.push(`Status is "${entry.status}" but hasn't changed in ${Math.floor(ageDays)} days`);
    }

    // Archive candidate: session summaries older than 30 days
    if (entry.relativePath.startsWith('sessions/') && ageDays > 30) {
      flags.push('archive-candidate');
      reasons.push(`Session summary is ${Math.floor(ageDays)} days old`);
    }

    // Broken internal links
    const fileDir = dirname(entry.path);
    const brokenLinks: string[] = [];
    for (const link of entry.internalLinks) {
      const exists = await linkExists(link, fileDir, knowledgeRoot);
      if (!exists) brokenLinks.push(link);
    }
    if (brokenLinks.length > 0) {
      flags.push('broken-links');
      reasons.push(`Broken links: ${brokenLinks.slice(0, 3).join(', ')}`);
    }

    if (flags.length > 0) {
      flagged.push({ entry, flags, reasons });
    }
  }

  return flagged;
}

export interface StalenessReport {
  scannedCount: number;
  flaggedCount: number;
  byFlag: Record<StalenessFlag, number>;
  flagged: FlaggedFile[];
}

export function buildReport(entries: FileEntry[], flagged: FlaggedFile[]): StalenessReport {
  const byFlag = {} as Record<StalenessFlag, number>;
  for (const f of flagged) {
    for (const flag of f.flags) {
      byFlag[flag] = (byFlag[flag] ?? 0) + 1;
    }
  }
  return {
    scannedCount: entries.length,
    flaggedCount: flagged.length,
    byFlag,
    flagged,
  };
}
