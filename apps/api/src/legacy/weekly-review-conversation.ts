/**
 * Legacy weekly-review conversation cluster, extracted from
 * apps/api/src/server.ts. Backs the three weekly-review HTTP routes
 * (POST/GET .../weekly-review, GET .../weekly-review/last,
 * GET .../weekly-review/context — the implementation behind several
 * Telegram weekly-review slash commands, confirmed via
 * apps/telegram-bot/src/index.ts) and the legacy /messages/process
 * conversation surface.
 *
 * Everything this module used to define directly turned out to have zero
 * PendingAction/legacy-specific coupling — no confirmation flow, no stored
 * pending-action row, just context-building + deterministic generation +
 * formatting + persistence, all reusable as-is. As part of the Weekly-Review
 * V3 Migration, the entire implementation moved verbatim into two new,
 * non-legacy modules — apps/api/src/weekly-review/context.ts (context
 * building) and apps/api/src/weekly-review/review.ts (generation, saving,
 * formatting) — so Agent Runtime v3 can reuse it without importing from
 * legacy/*. This file now only re-exports both, so its existing callers
 * (server.ts, legacy/messages-process.ts, apps/api/src/planning/next-week.ts)
 * are unaffected. See docs/09-architecture-inventory.md's "Weekly-Review V3
 * Migration" for the full boundary rationale.
 */

export * from "../weekly-review/context.js";
export * from "../weekly-review/review.js";
