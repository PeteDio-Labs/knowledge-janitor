/**
 * tools.ts — Gemma 4 tool definitions for the knowledge janitor loop.
 */

import type { ToolDef } from '@petedio/shared/agents';
import type { FileEntry } from './scanner.ts';
import type { StalenessReport, FlaggedFile } from './staleness.ts';
import type { CleanupAction } from './cleaner.ts';
import type { IngestResult } from './rag-ingest.ts';

export interface JanitorState {
  entries?: FileEntry[];
  report?: StalenessReport;
  flagged?: FlaggedFile[];
  actions?: CleanupAction[];
  ingestResults?: IngestResult[];
}

export function buildTools(
  state: JanitorState,
  knowledgeRoot: string,
  blogApiUrl: string,
): ToolDef[] {
  return [
    {
      name: 'scan_knowledge',
      description: 'Walk the knowledge/ directory and collect file metadata (size, age, links). Returns a summary of total files found.',
      parameters: {
        type: 'object' as const,
        properties: {} as Record<string, { type: string; description: string }>,
        required: [],
      },
      async execute(_args: Record<string, unknown>): Promise<string> {
        const { scanKnowledge } = await import('./scanner.ts');
        state.entries = await scanKnowledge(knowledgeRoot);
        return `Scanned ${state.entries.length} markdown files in knowledge/.`;
      },
    },

    {
      name: 'check_staleness',
      description: 'Run staleness rules against scanned files. Returns a report of flagged files by category. Must call scan_knowledge first.',
      parameters: {
        type: 'object' as const,
        properties: {} as Record<string, { type: string; description: string }>,
        required: [],
      },
      async execute(_args: Record<string, unknown>): Promise<string> {
        if (!state.entries) return 'Error: run scan_knowledge first.';
        const { checkStaleness, buildReport } = await import('./staleness.ts');
        state.flagged = await checkStaleness(state.entries, knowledgeRoot);
        state.report = buildReport(state.entries, state.flagged);
        const { byFlag, scannedCount, flaggedCount } = state.report;
        const flagSummary = Object.entries(byFlag)
          .map(([f, n]) => `${f}: ${n}`)
          .join(', ');
        return `Checked ${scannedCount} files — ${flaggedCount} flagged. Breakdown: ${flagSummary || 'none'}`;
      },
    },

    {
      name: 'list_stale_files',
      description: 'List flagged files with their staleness reasons. Optionally filter by flag type.',
      parameters: {
        type: 'object' as const,
        properties: {
          flag: {
            type: 'string',
            description: 'Optional: filter to a specific flag (stale, broken-links, legacy-paths, stale-wip, duplicate, archive-candidate, empty)',
          },
          limit: {
            type: 'number',
            description: 'Max files to return (default 20)',
          },
        },
        required: [],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        if (!state.flagged) return 'Error: run check_staleness first.';
        const filter = args.flag as string | undefined;
        const limit = (args.limit as number | undefined) ?? 20;
        let items = state.flagged;
        if (filter) {
          items = items.filter(f => f.flags.includes(filter as never));
        }
        items = items.slice(0, limit);
        if (items.length === 0) return `No files flagged${filter ? ` with "${filter}"` : ''}.`;
        return items.map(f =>
          `- ${f.entry.relativePath}\n  flags: [${f.flags.join(', ')}]\n  ${f.reasons.join(' | ')}`
        ).join('\n');
      },
    },

    {
      name: 'propose_cleanup',
      description: 'Generate cleanup action proposals based on staleness report. Returns a formatted list for approval. Must call check_staleness first.',
      parameters: {
        type: 'object' as const,
        properties: {} as Record<string, { type: string; description: string }>,
        required: [],
      },
      async execute(_args: Record<string, unknown>): Promise<string> {
        if (!state.flagged) return 'Error: run check_staleness first.';
        const { proposeCleanupActions, formatActionsForApproval } = await import('./cleaner.ts');
        state.actions = proposeCleanupActions(state.flagged);
        return formatActionsForApproval(state.actions);
      },
    },

    {
      name: 'verify_links',
      description: 'Check all internal markdown links across scanned files and return broken ones. Must call scan_knowledge first.',
      parameters: {
        type: 'object' as const,
        properties: {} as Record<string, { type: string; description: string }>,
        required: [],
      },
      async execute(_args: Record<string, unknown>): Promise<string> {
        if (!state.flagged) return 'Error: run check_staleness first (it also verifies links).';
        const broken = state.flagged.filter(f => f.flags.includes('broken-links'));
        if (broken.length === 0) return 'No broken links found.';
        return broken.map(f =>
          `- ${f.entry.relativePath}: ${f.reasons.find(r => r.includes('Broken')) ?? ''}`
        ).join('\n');
      },
    },

    {
      name: 'ingest_to_rag',
      description: 'Feed validated (non-flagged) docs to the blog-api RAG pipeline. Must call check_staleness first.',
      parameters: {
        type: 'object' as const,
        properties: {
          include_flagged: {
            type: 'boolean',
            description: 'If true, ingest all files including flagged ones (default: false — only clean files)',
          },
        },
        required: [],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        if (!state.entries || !state.flagged) return 'Error: run check_staleness first.';
        const includeFlagged = args.include_flagged === true;
        const flaggedPaths = new Set(state.flagged.map(f => f.entry.relativePath));
        const toIngest = includeFlagged
          ? state.entries
          : state.entries.filter(e => !flaggedPaths.has(e.relativePath));

        const { ingestToRag, formatIngestSummary } = await import('./rag-ingest.ts');
        state.ingestResults = await ingestToRag(toIngest, blogApiUrl);
        return formatIngestSummary(state.ingestResults);
      },
    },
  ];
}
