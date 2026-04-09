/**
 * knowledge-janitor — Audits knowledge/ for stale/broken docs.
 *
 * Modes (via input.scope):
 *   full:    scan → staleness → propose cleanup → RAG ingest
 *   audit:   scan → staleness → report only (no ingest)
 *   ingest:  scan → staleness → RAG ingest only (no cleanup proposals)
 *
 * Cleanup proposals are always approval-gated via MC Web.
 */

import express from 'express';
import pino from 'pino';
import { AgentReporter, runToolLoop } from '@petedio/shared/agents';
import { TaskPayloadSchema } from '@petedio/shared/agents';
import { KnowledgeJanitorInputSchema } from './schema.ts';
import { buildTools, type JanitorState } from './tools.ts';
import { formatActionsForApproval } from './cleaner.ts';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const PORT = parseInt(process.env.PORT ?? '3007', 10);
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://192.168.50.59:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'gemma4';
const MC_BACKEND_URL = process.env.MC_BACKEND_URL ?? 'http://localhost:3000';
const BLOG_API_URL = process.env.BLOG_API_URL ?? 'http://localhost:3000';
const KNOWLEDGE_ROOT = process.env.KNOWLEDGE_ROOT ?? '/home/pedro/PeteDio-Labs/knowledge';

// ─── Agent Logic ──────────────────────────────────────────────────

async function runJanitor(payload: ReturnType<typeof TaskPayloadSchema.parse>): Promise<void> {
  const startMs = Date.now();
  const input = KnowledgeJanitorInputSchema.parse(payload.input);

  const reporter = new AgentReporter({
    mcUrl: MC_BACKEND_URL,
    taskId: payload.taskId,
    agentName: 'knowledge-janitor',
  });

  await reporter.running(`Starting knowledge-janitor (scope: ${input.scope})`);
  log.info({ taskId: payload.taskId, input }, 'knowledge-janitor starting');

  const state: JanitorState = {};

  const includeIngest = input.scope === 'full' || input.scope === 'ingest';
  const includeCleanup = input.scope === 'full' || input.scope === 'audit';

  const userPrompt = `
You are the Knowledge Janitor for a homelab project documentation base.
Your job is to audit the knowledge/ directory and maintain its quality.

Scope: ${input.scope}
${input.fileFilter ? `File filter: only process files matching "${input.fileFilter}"` : ''}

Follow these steps IN ORDER:
1. Call scan_knowledge to discover all markdown files.
2. Call check_staleness to run the rules engine.
3. Call list_stale_files to review what was flagged.
${includeCleanup ? '4. Call propose_cleanup to generate cleanup action proposals.' : ''}
${includeIngest ? `${includeCleanup ? '5' : '4'}. Call ingest_to_rag to feed clean docs into the RAG pipeline.` : ''}

After all tool calls, write a concise audit report:
- Total files scanned
- Number flagged and top issues
- Cleanup actions proposed (if any)
- RAG ingest summary (if any)
- Recommended next priorities

Be specific about file names. Keep the report under 400 words.
  `.trim();

  try {
    const { finalResponse } = await runToolLoop({
      ollamaUrl: OLLAMA_URL,
      model: OLLAMA_MODEL,
      system: 'You are a disciplined documentation auditor. Follow the steps in order. Be concise and specific.',
      userPrompt,
      tools: buildTools(state, KNOWLEDGE_ROOT, BLOG_API_URL),
      onIteration: (i, content) => {
        if (content) log.info({ taskId: payload.taskId, iteration: i }, 'janitor loop');
      },
    });

    const artifacts = [];

    // Audit report
    artifacts.push({
      type: 'summary' as const,
      label: 'Knowledge Audit Report',
      content: finalResponse || 'No report generated',
    });

    // Staleness report detail
    if (state.report) {
      const { scannedCount, flaggedCount, byFlag } = state.report;
      const flagLines = Object.entries(byFlag).map(([f, n]) => `- ${f}: ${n}`).join('\n');
      artifacts.push({
        type: 'log' as const,
        label: `Staleness Report (${flaggedCount}/${scannedCount} flagged)`,
        content: flagLines || 'No flags raised.',
      });
    }

    // Cleanup proposal — gate through approval
    if (state.actions && state.actions.length > 0) {
      const preview = formatActionsForApproval(state.actions);

      const highCount = state.actions.filter(a => a.priority === 'high').length;
      artifacts.push({
        type: 'task-list' as const,
        label: `${state.actions.length} cleanup actions proposed (${highCount} high priority)`,
        content: preview,
      });

      const approval = await reporter.requestApproval({
        actionType: 'remediate',
        description: `Apply ${state.actions.length} cleanup actions to knowledge/`,
        preview,
      });

      artifacts.push({
        type: 'log' as const,
        label: 'Cleanup approval',
        content: approval.outcome === 'approved'
          ? 'Approved — actions queued for execution in next session.'
          : `Rejected${approval.reason ? ': ' + approval.reason : ''}`,
      });
    }

    // RAG ingest summary
    if (state.ingestResults) {
      const ingested = state.ingestResults.filter(r => !r.skipped).length;
      const totalChunks = state.ingestResults.reduce((n, r) => n + r.chunks, 0);
      artifacts.push({
        type: 'log' as const,
        label: `RAG Ingest: ${ingested} files, ${totalChunks} chunks`,
        content: state.ingestResults
          .filter(r => !r.skipped)
          .map(r => `- ${r.file}: ${r.chunks} chunks`)
          .join('\n') || 'Nothing new to ingest.',
      });
    }

    await reporter.complete({
      taskId: payload.taskId,
      agentName: 'knowledge-janitor',
      status: 'complete',
      summary: `Audited ${state.report?.scannedCount ?? 0} files — ${state.report?.flaggedCount ?? 0} flagged`,
      artifacts,
      durationMs: Date.now() - startMs,
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ taskId: payload.taskId, err: msg }, 'knowledge-janitor failed');
    await reporter.fail(msg);
  }
}

// ─── HTTP Server ──────────────────────────────────────────────────

const app = express();
app.use(express.json());

let activeTaskId: string | null = null;

app.post('/run', async (req, res) => {
  const parsed = TaskPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid task payload', details: parsed.error.flatten() });
    return;
  }

  if (activeTaskId) {
    res.status(409).json({ error: 'Already running', activeTaskId });
    return;
  }

  activeTaskId = parsed.data.taskId;
  res.json({ accepted: true, taskId: parsed.data.taskId });

  runJanitor(parsed.data)
    .catch(err => {
      log.error({ err: err instanceof Error ? err.message : err }, 'Unhandled janitor error');
    })
    .finally(() => {
      activeTaskId = null;
    });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agent: 'knowledge-janitor', model: OLLAMA_MODEL });
});

app.listen(PORT, () => {
  log.info({ port: PORT, knowledgeRoot: KNOWLEDGE_ROOT }, 'knowledge-janitor listening');
});
