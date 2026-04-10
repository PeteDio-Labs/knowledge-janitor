/**
 * cleaner.ts — Proposes cleanup actions. No destructive ops without approval.
 */

import type { FlaggedFile, StalenessFlag } from './staleness.ts';

export type CleanupActionType =
  | 'archive'          // move to knowledge/archive/
  | 'update-status'    // update Status header to STALE
  | 'report-broken'    // report broken links for manual fix
  | 'deduplicate'      // flag for manual dedup review
  | 'rename'           // suggest filename fix (e.g. year in name)
  | 'review';          // general review needed

export interface CleanupAction {
  file: string;         // relativePath
  actionType: CleanupActionType;
  description: string;
  flags: StalenessFlag[];
  priority: 'high' | 'medium' | 'low';
}

const FLAG_PRIORITY: Record<StalenessFlag, 'high' | 'medium' | 'low'> = {
  'stale-wip': 'high',
  'broken-links': 'high',
  'legacy-paths': 'high',
  'duplicate': 'medium',
  'stale': 'medium',
  'archive-candidate': 'low',
  'empty': 'low',
};

function topPriority(flags: StalenessFlag[]): 'high' | 'medium' | 'low' {
  if (flags.some(f => FLAG_PRIORITY[f] === 'high')) return 'high';
  if (flags.some(f => FLAG_PRIORITY[f] === 'medium')) return 'medium';
  return 'low';
}

export function proposeCleanupActions(flagged: FlaggedFile[]): CleanupAction[] {
  const actions: CleanupAction[] = [];

  for (const { entry, flags, reasons } of flagged) {
    const priority = topPriority(flags);
    const file = entry.relativePath;

    if (flags.includes('broken-links')) {
      actions.push({
        file,
        actionType: 'report-broken',
        description: `Fix broken internal links: ${reasons.find(r => r.includes('Broken'))?.replace('Broken links: ', '') ?? 'see report'}`,
        flags,
        priority: 'high',
      });
    }

    if (flags.includes('legacy-paths')) {
      actions.push({
        file,
        actionType: 'archive',
        description: `Archive: contains legacy references (${reasons.find(r => r.includes('legacy'))?.replace('References legacy patterns: ', '') ?? ''})`,
        flags,
        priority: 'high',
      });
    }

    if (flags.includes('stale-wip')) {
      actions.push({
        file,
        actionType: 'update-status',
        description: `Update Status from "${entry.status}" → STALE (no activity in >7 days)`,
        flags,
        priority: 'high',
      });
    }

    if (flags.includes('duplicate')) {
      actions.push({
        file,
        actionType: 'deduplicate',
        description: 'Duplicate content detected — review and merge or remove',
        flags,
        priority: 'medium',
      });
    }

    if (flags.includes('archive-candidate') && !flags.includes('legacy-paths')) {
      actions.push({
        file,
        actionType: 'archive',
        description: `Archive old session summary (>30 days)`,
        flags,
        priority: 'low',
      });
    }

    if (flags.includes('stale') && !flags.includes('legacy-paths') && !flags.includes('stale-wip')) {
      actions.push({
        file,
        actionType: 'review',
        description: `Review for accuracy — last updated ${Math.round((Date.now() - (entry.lastUpdated ?? entry.modifiedAt).getTime()) / (24 * 60 * 60 * 1000))} days ago`,
        flags,
        priority,
      });
    }

    // Filename with wrong year
    if (/20\d{2}/.test(entry.relativePath)) {
      const yearMatch = entry.relativePath.match(/(20\d{2})/);
      if (yearMatch && yearMatch[1] !== String(new Date().getFullYear())) {
        actions.push({
          file,
          actionType: 'rename',
          description: `Filename contains year ${yearMatch[1]} — consider renaming to ${new Date().getFullYear()}`,
          flags,
          priority: 'low',
        });
      }
    }
  }

  // Sort: high → medium → low
  const order = { high: 0, medium: 1, low: 2 };
  return actions.sort((a, b) => order[a.priority] - order[b.priority]);
}

// ─── Executor ────────────────────────────────────────────────────

export interface ExecutionResult {
  file: string;
  actionType: CleanupActionType;
  outcome: 'done' | 'skipped' | 'error';
  detail: string;
}

/**
 * Execute automatable cleanup actions (archive, update-status).
 * Skips actions that require human judgment (deduplicate, report-broken, review, rename).
 */
export async function executeCleanupActions(
  actions: CleanupAction[],
  knowledgeRoot: string,
): Promise<ExecutionResult[]> {
  const fs = await import('fs/promises');
  const path = await import('path');
  const results: ExecutionResult[] = [];

  for (const action of actions) {
    const absPath = path.join(knowledgeRoot, action.file);

    if (action.actionType === 'archive') {
      try {
        const archiveDir = path.join(knowledgeRoot, 'archive');
        await fs.mkdir(archiveDir, { recursive: true });
        const dest = path.join(archiveDir, path.basename(action.file));
        await fs.rename(absPath, dest);
        results.push({ file: action.file, actionType: action.actionType, outcome: 'done', detail: `Moved → archive/${path.basename(action.file)}` });
      } catch (err) {
        results.push({ file: action.file, actionType: action.actionType, outcome: 'error', detail: (err as Error).message });
      }

    } else if (action.actionType === 'update-status') {
      try {
        const content = await fs.readFile(absPath, 'utf8');
        const updated = content.replace(/^Status:\s*.+$/m, 'Status: STALE');
        if (updated === content) {
          results.push({ file: action.file, actionType: action.actionType, outcome: 'skipped', detail: 'No Status header found' });
        } else {
          await fs.writeFile(absPath, updated, 'utf8');
          results.push({ file: action.file, actionType: action.actionType, outcome: 'done', detail: 'Status updated to STALE' });
        }
      } catch (err) {
        results.push({ file: action.file, actionType: action.actionType, outcome: 'error', detail: (err as Error).message });
      }

    } else {
      results.push({ file: action.file, actionType: action.actionType, outcome: 'skipped', detail: 'Manual action required' });
    }
  }

  return results;
}

export function formatActionsForApproval(actions: CleanupAction[]): string {
  if (actions.length === 0) return 'No cleanup actions proposed.';

  const byPriority = {
    high: actions.filter(a => a.priority === 'high'),
    medium: actions.filter(a => a.priority === 'medium'),
    low: actions.filter(a => a.priority === 'low'),
  };

  const lines: string[] = [];

  for (const [level, group] of Object.entries(byPriority)) {
    if (group.length === 0) continue;
    lines.push(`\n**${level.toUpperCase()} priority (${group.length}):**`);
    for (const a of group) {
      lines.push(`- \`${a.file}\` [${a.actionType}]: ${a.description}`);
    }
  }

  return lines.join('\n');
}
