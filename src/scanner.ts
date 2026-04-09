/**
 * scanner.ts — Walks knowledge/ and collects per-file metadata.
 */

import { readdir, stat, readFile } from 'fs/promises';
import { join, relative, extname } from 'path';
import { createHash } from 'crypto';

export interface FileEntry {
  path: string;          // absolute
  relativePath: string;  // relative to knowledgeRoot
  size: number;
  modifiedAt: Date;
  contentHash: string;
  content: string;
  lastUpdated: Date | null;   // from doc header/MCP-CONTEXT
  status: string | null;      // from doc header
  internalLinks: string[];    // relative md links found in content
}

const LAST_UPDATED_RE = /(?:last[_\s-]?updated|Last Updated)[:\s]+(\d{4}-\d{2}-\d{2})/i;
const STATUS_RE = /^(?:status|Status):\s*(.+)$/im;
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

function extractLastUpdated(content: string): Date | null {
  const match = content.match(LAST_UPDATED_RE);
  if (!match) return null;
  const d = new Date(match[1]);
  return isNaN(d.getTime()) ? null : d;
}

function extractStatus(content: string): string | null {
  const match = content.match(STATUS_RE);
  return match ? match[1].trim() : null;
}

function extractInternalLinks(content: string): string[] {
  const links: string[] = [];
  let m: RegExpExecArray | null;
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(content)) !== null) {
    const href = m[2];
    // Internal: doesn't start with http(s), mailto, or #
    if (href && !href.startsWith('http') && !href.startsWith('mailto') && !href.startsWith('#')) {
      links.push(href.split('#')[0]); // strip anchor
    }
  }
  return [...new Set(links)];
}

async function scanDir(dir: string, root: string, entries: FileEntry[]): Promise<void> {
  let items: string[];
  try {
    items = await readdir(dir);
  } catch {
    return;
  }

  for (const item of items) {
    if (item.startsWith('.')) continue;
    const fullPath = join(dir, item);
    const st = await stat(fullPath).catch(() => null);
    if (!st) continue;

    if (st.isDirectory()) {
      await scanDir(fullPath, root, entries);
    } else if (st.isFile() && extname(item) === '.md') {
      const content = await readFile(fullPath, 'utf-8').catch(() => '');
      const hash = createHash('sha256').update(content).digest('hex');
      entries.push({
        path: fullPath,
        relativePath: relative(root, fullPath),
        size: st.size,
        modifiedAt: st.mtime,
        contentHash: hash,
        content,
        lastUpdated: extractLastUpdated(content),
        status: extractStatus(content),
        internalLinks: extractInternalLinks(content),
      });
    }
  }
}

export async function scanKnowledge(knowledgeRoot: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  await scanDir(knowledgeRoot, knowledgeRoot, entries);
  return entries;
}
