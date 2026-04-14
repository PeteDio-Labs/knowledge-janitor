/**
 * knowledge-janitor — Audits knowledge/ for stale/broken docs.
 *
 * Modes (via input.scope):
 *   full:    scan → staleness → propose cleanup (approval-gated) → RAG ingest
 *   audit:   scan → staleness → propose cleanup (approval-gated)
 *   ingest:  scan → staleness → RAG ingest only
 *
 * Cleanup execution is always approval-gated via MC Web after the plan completes.
 */

import express from 'express';
import pino from 'pino';
import { z } from 'zod';
import { KnowledgeJanitorInputSchema } from './schema.ts';
import { buildPlan, executeStep, formatReport, type JanitorState, type JanitorStep, type JanitorStepLog } from './tools.ts';
import { formatActionsForApproval, executeCleanupActions } from './cleaner.ts';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const PORT = parseInt(process.env.PORT ?? '3007', 10);
const MC_BACKEND_URL = process.env.MC_BACKEND_URL ?? 'http://localhost:3000';
const BLOG_API_URL = process.env.BLOG_API_URL ?? 'http://localhost:3000';
const KNOWLEDGE_ROOT = process.env.KNOWLEDGE_ROOT ?? '/home/pedro/PeteDio-Labs/knowledge';
const SHARED_AGENTS_MODULE_PATH = process.env.SHARED_AGENTS_MODULE_PATH ?? '@petedio/shared/agents';

interface SharedAgentReporter {
  running(message: string): Promise<void>;
  complete(result: {
    taskId: string;
    agentName: string;
    status: 'complete';
    summary: string;
    artifacts: Array<{ type: string; label: string; content: string }>;
    durationMs: number;
    completedAt: string;
  }): Promise<void>;
  fail(message: string): Promise<void>;
  requestApproval(action: {
    actionType: string;
    description: string;
    preview?: string;
  }): Promise<{ outcome: 'approved' | 'rejected'; reason?: string }>;
}

interface SharedAgentsModule {
  AgentReporter: new (opts: { mcUrl: string; taskId: string; agentName: string }) => SharedAgentReporter;
  TaskPayloadSchema: z.ZodType<{
    taskId: string;
    agentName: string;
    trigger: string;
    input: Record<string, unknown>;
    issuedAt: string;
  }>;
  runDeterministicPlan: (opts: {
    steps: JanitorStep[];
    executeStep: (step: JanitorStep) => Promise<string>;
    onStepStart?: (step: JanitorStep, index: number) => void | Promise<void>;
    onStepComplete?: (log: JanitorStepLog, index: number) => void | Promise<void>;
  }) => Promise<{
    status: 'complete' | 'failed';
    logs: JanitorStepLog[];
    completedSteps: number;
    skippedSteps: number;
    failedStep?: JanitorStepLog;
  }>;
}

async function loadSharedAgents(): Promise<SharedAgentsModule> {
  return import(SHARED_AGENTS_MODULE_PATH) as Promise<SharedAgentsModule>;
}

// ─── Agent Logic ──────────────────────────────────────────────────

async function runJanitor(payload: { taskId: string; input: Record<string, unknown> }): Promise<void> {
  const startMs = Date.now();
  const input = KnowledgeJanitorInputSchema.parse(payload.input);
  const shared = await loadSharedAgents();
  const { AgentReporter, runDeterministicPlan } = shared;

  const reporter = new AgentReporter({
    mcUrl: MC_BACKEND_URL,
    taskId: payload.taskId,
    agentName: 'knowledge-janitor',
  });

  await reporter.running(`Starting knowledge-janitor (scope: ${input.scope})`);
  log.info({ taskId: payload.taskId, input }, 'knowledge-janitor starting');

  const state: JanitorState = {};
  const steps = buildPlan(input);

  try {
    const result = await runDeterministicPlan({
      steps,
      executeStep: (step) => executeStep(step, { state, knowledgeRoot: KNOWLEDGE_ROOT, blogApiUrl: BLOG_API_URL }),
      onStepStart: async (step, index) => {
        await reporter.running(`Step ${index + 1}/${steps.length}: ${step.title}`);
      },
    });

    const durationMs = Date.now() - startMs;
    const report = formatReport(result.logs);
    const artifacts: Array<{ type: string; label: string; content: string }> = [];

    // Audit report (step log)
    artifacts.push({
      type: 'log',
      label: 'Knowledge Audit Steps',
      content: report,
    });

    // Staleness report detail
    if (state.report) {
      const { scannedCount, flaggedCount, byFlag } = state.report;
      const flagLines = Object.entries(byFlag).map(([f, n]) => `- ${f}: ${n}`).join('\n');
      artifacts.push({
        type: 'log',
        label: `Staleness Report (${flaggedCount}/${scannedCount} flagged)`,
        content: flagLines || 'No flags raised.',
      });
    }

    // Cleanup approval gate — runs after the plan, on the proposed actions
    if (state.actions && state.actions.length > 0) {
      const preview = formatActionsForApproval(state.actions);
      const highCount = state.actions.filter(a => a.priority === 'high').length;

      artifacts.push({
        type: 'task-list',
        label: `${state.actions.length} cleanup actions proposed (${highCount} high priority)`,
        content: preview,
      });

      const approval = await reporter.requestApproval({
        actionType: 'remediate',
        description: `Apply ${state.actions.length} cleanup actions to knowledge/`,
        preview,
      });

      if (approval.outcome === 'approved') {
        const execResults = await executeCleanupActions(state.actions, KNOWLEDGE_ROOT);
        const done = execResults.filter(r => r.outcome === 'done').length;
        const skipped = execResults.filter(r => r.outcome === 'skipped').length;
        const failed = execResults.filter(r => r.outcome === 'error').length;
        const execLines = execResults
          .map(r => `- ${r.file} [${r.actionType}]: ${r.outcome} — ${r.detail}`)
          .join('\n');
        artifacts.push({
          type: 'log',
          label: `Cleanup executed: ${done} done, ${skipped} skipped, ${failed} failed`,
          content: execLines,
        });
      } else {
        artifacts.push({
          type: 'log',
          label: 'Cleanup approval',
          content: `Rejected${approval.reason ? ': ' + approval.reason : ''}`,
        });
      }
    }

    // RAG ingest summary
    if (state.ingestResults) {
      const ingested = state.ingestResults.filter(r => !r.skipped).length;
      const totalChunks = state.ingestResults.reduce((n, r) => n + r.chunks, 0);
      artifacts.push({
        type: 'log',
        label: `RAG Ingest: ${ingested} files, ${totalChunks} chunks`,
        content: state.ingestResults
          .filter(r => !r.skipped)
          .map(r => `- ${r.file}: ${r.chunks} chunks`)
          .join('\n') || 'Nothing new to ingest.',
      });
    }

    const summary = result.failedStep
      ? `Failed at: ${result.failedStep.step.title}`
      : `Audited ${state.report?.scannedCount ?? 0} files — ${state.report?.flaggedCount ?? 0} flagged`;

    log.info({ taskId: payload.taskId, durationMs, steps: result.logs.length, status: result.status }, 'knowledge-janitor complete');

    if (result.status === 'failed') {
      await reporter.fail(`${summary}\n\n${report}`);
      return;
    }

    await reporter.complete({
      taskId: payload.taskId,
      agentName: 'knowledge-janitor',
      status: 'complete',
      summary,
      artifacts,
      durationMs,
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

const shared = await loadSharedAgents();
const { TaskPayloadSchema } = shared;

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
  res.json({ status: 'ok', agent: 'knowledge-janitor', sharedAgentsModulePath: SHARED_AGENTS_MODULE_PATH });
});

app.listen(PORT, () => {
  log.info({ port: PORT, knowledgeRoot: KNOWLEDGE_ROOT, sharedAgentsModulePath: SHARED_AGENTS_MODULE_PATH }, 'knowledge-janitor listening');
});
