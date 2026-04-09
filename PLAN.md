# Knowledge Janitor Agent — Plan

**Created**: 2026-04-08
**Status**: Planned
**Port**: 3007
**Schedule**: Weekly via MC Backend CronRunner

---

## Purpose

Automated agent that audits `knowledge/` for stale, invalid, and broken documentation. Proposes cleanup actions via MC Web approval UI and ingests validated docs into the RAG pipeline (pgvector via blog-api).

---

## Staleness Audit (2026-04-08 Baseline)

### 🔴 STALE — Needs Update or Archive

| File | Issue | Action |
|------|-------|--------|
| `knowledge/infrastructure/CURRENT-STATUS.md` | Last updated 2026-03-31. References old `blog-homelab` repo, Java Spring Boot blog-api, Phase 7 "Planned" items already done (Prometheus/Grafana live), stale CI info (Maven/Node builds), paths like `homelab/knowledge/phase-*` that don't exist. | Archive + replace |
| `knowledge/infrastructure/QUICK-REFERENCE.md` | References old Media Stack as primary focus. IPs use old MetalLB/Tailscale ranges. Missing all current K8s services (agents, web-search, observability). | Archive + replace |
| `knowledge/architecture/RAG-PIPELINE-PLAN.md` | Says "In Progress — implementing today" but Phases 1A-1C completed 2026-03-29 per STATUS.md. Verification checklist unchecked. | Update status to COMPLETE |
| `knowledge/architecture/PETE-VISION-PLAN.md` | Entire doc pasted twice (lines 1-267 duplicated at 268-621). Ollama model ref is `qwen2.5:7b` but primary is `gemma4:e4b`. | Deduplicate + update model |
| `knowledge/mission-control/INDEX.md` | Last updated Feb 24, 2026. References Phase 3A/3B/3C (long done). No mention of Agent Platform, dispatcher, EventRouter, CronRunner, GitHub webhook. | Major rewrite |
| `knowledge/guides/KUBECTL-BEST-PRACTICES-2025.md` | Year in filename is 2025 (we're in 2026). | Rename |
| `knowledge/infrastructure/STORAGE-DOCS-INDEX.md` | References `project-management/inventory/machines.md` — old path. | Update path |
| `knowledge/infrastructure/STORAGE-RUNBOOK-REFERENCES.md` | Tiny file (940B) referencing old runbook paths. | Verify or archive |

### 🟡 NEEDS MINOR UPDATES

| File | Issue |
|------|-------|
| `knowledge/INDEX.md` | Missing sessions (04-06, 04-08), career section, dead roadmap/completed ref |
| `knowledge/STATUS.md` | Mostly current but known issues need live validation |
| `knowledge/architecture/OBSERVABILITY-SETUP.md` | References `discord-bot` instead of `pete-bot` |
| `knowledge/career/BLOG-ENTERPRISE-PLAN.md` | Status should be COMPLETE per milestones |
| `knowledge/infrastructure/LOCAL-ACCESS.md` | MC Prod hostname mismatch vs CLAUDE.md |

### 🟢 CURRENT / OK

- All session summaries (historical records, correctly dated)
- `knowledge/architecture/REMOTE-DEV-WORKSTATION-PLAN.md` (planning doc)
- `knowledge/career/GROWTH-PLAN.md` (action-oriented, stable)
- `knowledge/career/BLOG-COVER-IMAGE-PLAN.md` (active roadmap)
- `knowledge/guides/blog/*` (stable reference docs)
- `knowledge/guides/ONBOARDING.md`, `GITHUB_ACTIONS_SECRETS_GUIDE.md`
- `knowledge/infrastructure/inventory/*` (structurally OK)
- `knowledge/infrastructure/storage/*` (stable reference)
- `knowledge/infrastructure/LEVEL-UP-PLAN.md` (long-term plan)

---

## Agent Architecture

Follows the `ops-investigator` pattern (Bun + Express v5 + Gemma 4 tool loop).

```
agents/knowledge-janitor/
├── package.json
├── PLAN.md                    # This file
├── src/
│   ├── index.ts               # Entry: POST /run, GET /health
│   ├── scanner.ts             # Walks knowledge/, collects metadata
│   ├── staleness.ts           # Rules engine: age, dead links, stale WIP, dupes
│   ├── cleaner.ts             # Proposes cleanup actions (archive, fix links)
│   ├── rag-ingest.ts          # Feeds validated docs to blog-api RAG endpoints
│   └── tools.ts               # Gemma 4 tools for LLM loop
```

### Scanner (`scanner.ts`)

Walks `knowledge/` recursively, collects per file:
- Path, size, last modified date (`fs.stat`)
- Content hash (SHA-256) for change detection
- Extracts `last_updated` / `Last Updated` / `Status` from MCP-CONTEXT blocks and headers
- Extracts internal links and verifies they resolve

### Staleness Rules (`staleness.ts`)

| Rule | Threshold | Flag |
|------|-----------|------|
| `last_updated` > 14 days | Age-based | `stale` |
| Internal links that 404 | Dead links | `broken-links` |
| `Status: In Progress` + `last_updated` > 7 days | Stale WIP | `stale-wip` |
| Session summaries > 30 days | Historical | `archive-candidate` |
| Duplicate content hash | Dedup | `duplicate` |
| File size < 50 bytes | Empty | `empty` |
| References `blog-homelab`, `homelab/knowledge/phase-*` | Old paths | `legacy-paths` |

### Cleaner (`cleaner.ts`)

Proposes actions — **no destructive changes without MC Web approval**:
- Move stale files to `knowledge/archive/`
- Fix dead internal links
- Update stale status headers
- Report findings to MC Backend

### RAG Ingest (`rag-ingest.ts`)

After validation, ingest valid docs into the existing RAG pipeline:
- Calls `POST /api/v1/rag/ingest` on blog-api
- Source type: `'doc'` (distinct from `'post'` and `'session'`)
- Only ingests files that pass staleness checks
- Tracks file hash → avoids re-ingesting unchanged files
- Incremental on re-runs

### Gemma 4 Tools (`tools.ts`)

- `scan_knowledge` — run scanner, return summary stats
- `check_staleness` — run rules engine, return report
- `list_stale_files` — return flagged files with reasons
- `propose_cleanup` — generate cleanup actions for approval
- `ingest_to_rag` — trigger RAG ingest for validated docs
- `verify_links` — check all internal doc links resolve

---

## CronRunner Integration

Add to MC Backend `cronRunner.ts`:

```typescript
{
  name: 'weekly-knowledge-audit',
  agentName: 'knowledge-janitor',
  input: { scope: 'full' },
  interval: 7 * 24 * 60 * 60 * 1000,  // 7 days
  initialDelay: 8 * 60 * 60 * 1000,    // 8h after startup
}
```

---

## Deployment

Runs locally on dev-workstation (LXC 113), not K8s. Same pattern as Pete-Vision backend.

```bash
cd agents/knowledge-janitor
bun install
bun run dev    # dev mode
bun run start  # production
```

---

## Verification

1. `bun tsc --noEmit` — typecheck passes
2. `bun test` — staleness rules unit tests
3. `POST /run` with test payload → reports to MC Backend
4. RAG ingest → `POST /api/v1/rag/query` returns knowledge docs
5. MC Web `/agents` dashboard shows janitor runs
