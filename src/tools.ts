/**
 * Deterministic step runner for knowledge-janitor.
 * Each scope maps to a fixed sequence of JanitorSteps.
 * No Ollama — all logic is coded.
 */

import type { KnowledgeJanitorInput } from './schema.ts';
import type { FileEntry } from './scanner.ts';
import type { StalenessReport, FlaggedFile } from './staleness.ts';
import type { CleanupAction } from './cleaner.ts';
import type { IngestResult } from './rag-ingest.ts';

// ─── Step types ───────────────────────────────────────────────────

export type JanitorAction = 'scan' | 'check-staleness' | 'propose-cleanup' | 'ingest-to-rag';

export interface JanitorStep {
  title: string;
  action: JanitorAction;
}

export interface JanitorStepLog {
  step: JanitorStep;
  status: 'complete' | 'failed' | 'skipped';
  output: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

// ─── Shared state (passed by reference across steps) ─────────────

export interface JanitorState {
  entries?: FileEntry[];
  report?: StalenessReport;
  flagged?: FlaggedFile[];
  actions?: CleanupAction[];
  ingestResults?: IngestResult[];
}

export interface JanitorStepOpts {
  state: JanitorState;
  knowledgeRoot: string;
  blogApiUrl: string;
}

// ─── Plan builder ─────────────────────────────────────────────────

export function buildPlan(input: KnowledgeJanitorInput): JanitorStep[] {
  const includeCleanup = input.scope === 'full' || input.scope === 'audit';
  const includeIngest = input.scope === 'full' || input.scope === 'ingest';

  const steps: JanitorStep[] = [
    { title: 'Scan knowledge directory', action: 'scan' },
    { title: 'Check staleness', action: 'check-staleness' },
  ];

  if (includeCleanup) {
    steps.push({ title: 'Propose cleanup actions', action: 'propose-cleanup' });
  }
  if (includeIngest) {
    steps.push({ title: 'Ingest clean docs to RAG', action: 'ingest-to-rag' });
  }

  return steps;
}

// ─── Step executor ────────────────────────────────────────────────

export async function executeStep(step: JanitorStep, opts: JanitorStepOpts): Promise<string> {
  const { state, knowledgeRoot, blogApiUrl } = opts;

  switch (step.action) {
    case 'scan': {
      const { scanKnowledge } = await import('./scanner.ts');
      state.entries = await scanKnowledge(knowledgeRoot);
      return `Scanned ${state.entries.length} markdown files in knowledge/.`;
    }

    case 'check-staleness': {
      if (!state.entries) throw new Error('scan must run before check-staleness');
      const { checkStaleness, buildReport } = await import('./staleness.ts');
      state.flagged = await checkStaleness(state.entries, knowledgeRoot);
      state.report = buildReport(state.entries, state.flagged);
      const { byFlag, scannedCount, flaggedCount } = state.report;
      const flagSummary = Object.entries(byFlag)
        .map(([f, n]) => `${f}: ${n}`)
        .join(', ');
      return `Checked ${scannedCount} files — ${flaggedCount} flagged. ${flagSummary || 'No flags raised.'}`;
    }

    case 'propose-cleanup': {
      if (!state.flagged) throw new Error('check-staleness must run before propose-cleanup');
      const { proposeCleanupActions, formatActionsForApproval } = await import('./cleaner.ts');
      state.actions = proposeCleanupActions(state.flagged);
      if (state.actions.length === 0) return 'No cleanup actions proposed.';
      return formatActionsForApproval(state.actions);
    }

    case 'ingest-to-rag': {
      if (!state.entries || !state.flagged) throw new Error('check-staleness must run before ingest-to-rag');
      const flaggedPaths = new Set(state.flagged.map(f => f.entry.relativePath));
      const toIngest = state.entries.filter(e => !flaggedPaths.has(e.relativePath));
      const { ingestToRag, formatIngestSummary } = await import('./rag-ingest.ts');
      state.ingestResults = await ingestToRag(toIngest, blogApiUrl);
      return formatIngestSummary(state.ingestResults);
    }

    default:
      throw new Error(`Unknown janitor action: ${(step as JanitorStep).action}`);
  }
}

// ─── Report formatter ─────────────────────────────────────────────

export function formatReport(logs: JanitorStepLog[]): string {
  if (logs.length === 0) return 'No steps executed.';
  return logs.map((log, index) => {
    const lines = [
      `${index + 1}. ${log.step.title} [${log.status}]`,
      `duration: ${log.durationMs}ms`,
    ];
    if (log.output) {
      lines.push('output:');
      lines.push(log.output);
    }
    return lines.join('\n');
  }).join('\n\n');
}
