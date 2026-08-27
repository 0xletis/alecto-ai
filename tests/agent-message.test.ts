import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal, prisma, updateUserOperatingProfile } from "../packages/db/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";

interface MockPlan {
  topic: string;
  intent: string;
  operations: Array<{ tool: string; args: unknown; rationale?: string }>;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  replyDraft: string;
}

function op(tool: string, args: unknown = {}, rationale?: string) {
  return { tool, args, rationale };
}

function mockPlan(plan: MockPlan): void {
  process.env.AGENT_RUNTIME_PLANNER_MOCK_RESPONSE = JSON.stringify(plan);
}

function clearMocks(): void {
  delete process.env.AGENT_RUNTIME_PLANNER_MOCK_RESPONSE;
  delete process.env.AGENT_RUNTIME_PLANNER_MOCK_THROW;
}

async function send(server: ReturnType<typeof buildServer>, userId: string, message: string, debugRaw = false) {
  const response = await server.inject({
    method: "POST",
    url: "/agent/message",
    payload: { userId, message, channel: "telegram", debugRaw }
  });
  assert.equal(response.statusCode, 200, message);
  return response.json();
}

test("agent/message: gmail rule creation golden transcript — 'yes' executes deterministically", async () => {
  const server = buildServer();
  const userId = `agent-gmail-rule-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await prisma.integrationConnection.create({
      data: { userId, integrationId: "gmail", status: "active", config: {} }
    });

    mockPlan({
      topic: "gmail_tracking_endesa",
      intent: "create_review_first_gmail_rule",
      operations: [op("gmail.rule.create", { label: "Endesa bills" }, "user wants Endesa bill tracking")],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft:
        "I can watch for Endesa bill emails. Matches will go to email review first, not instant tracking. Want me to set that up?"
    });
    const turn1 = await send(server, userId, "track Endesa bills from Gmail");
    assert.match(turn1.reply, /review/i);
    assert.match(turn1.reply, /not instant/i);
    assert.equal(turn1.needsConfirmation, true);
    assert.equal(turn1.debug.pendingOperation, true);
    assert.equal(turn1.operationsExecuted.length, 0);
    // Topic is derived from the tool that was actually planned (ground truth), not the LLM's freeform label.
    assert.equal(turn1.debug.conversationTopic, "gmail_rule_creation");

    // No mockPlan here on purpose: the pending-Gmail-followup phrasing is now handled
    // deterministically, before the planner is ever invoked.
    const turn2 = await send(server, userId, "let me know when I receive one");
    assert.match(turn2.reply, /scheduled|manual/i);
    assert.match(turn2.reply, /not instant/i);
    assert.match(turn2.reply, /Endesa bills/i);
    assert.equal(turn2.debug.plannerUsed, "none");
    assert.equal(turn2.operationsExecuted.length, 0);
    assert.equal(turn2.needsConfirmation, true, "pending rule confirmation must still be open");
    assert.equal(turn2.debug.conversationTopic, "gmail_rule_creation", "no operations this turn — topic must not go stale/drift");

    // No mockPlan here on purpose: a bare "yes" against a pending operation must be resolved
    // deterministically, without depending on the live LLM planner emitting confirmation.confirm.
    const turn3 = await send(server, userId, "yes");
    assert.equal(turn3.needsConfirmation, false);
    assert.equal(turn3.debug.pendingOperation, false);
    assert.equal(turn3.debug.mutationExecuted, true);
    assert.equal(turn3.operationsExecuted.length, 1);
    assert.equal(turn3.operationsExecuted[0].tool, "gmail.rule.create");
    assert.equal(turn3.operationsExecuted[0].status, "executed");
    assert.match(turn3.reply, /Endesa/i);
    assert.match(turn3.reply, /review/i);

    const rules = await prisma.emailSignalRule.findMany({ where: { userId } });
    assert.equal(rules.length, 1);
    assert.equal(rules[0].adapterId, "custom_email_review");
    assert.equal(rules[0].reviewBeforeLogging, true);
    assert.match(rules[0].name, /Endesa/i);

    // Read-only follow-up in the same conversation must not resurrect a pending confirmation.
    mockPlan({
      topic: "gmail_rules",
      intent: "list_active_rules",
      operations: [op("gmail.rule.list")],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const turn4 = await send(server, userId, "what email rules are active?");
    assert.equal(turn4.needsConfirmation, false);
    assert.equal(turn4.debug.pendingOperation, false);
    assert.equal(turn4.debug.mutationExecuted, false);
    assert.equal(turn4.debug.conversationTopic, "gmail_rules");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: unrelated unsupported-Gmail request does not hijack a pending Endesa confirmation", async () => {
  const server = buildServer();
  const userId = `agent-gmail-hijack-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await prisma.integrationConnection.create({
      data: { userId, integrationId: "gmail", status: "active", config: {} }
    });

    mockPlan({
      topic: "gmail_tracking_endesa",
      intent: "create_review_first_gmail_rule",
      operations: [op("gmail.rule.create", { label: "Endesa bills" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "I can watch for Endesa bill emails, review-first. Want me to set that up?"
    });
    await send(server, userId, "track Endesa bills from Gmail");

    // No mockPlan: this must be caught deterministically before ever reaching the planner.
    const hijackTurn = await send(server, userId, "reply to the Endesa email");
    assert.match(hijackTurn.reply, /can't reply|isn't supported|not supported/i);
    assert.doesNotMatch(hijackTurn.reply, /I'll set up|review-first Gmail tracking/i);
    assert.equal(hijackTurn.operationsExecuted.length, 0);
    assert.equal(hijackTurn.debug.mutationExecuted, false);
    assert.equal(hijackTurn.debug.pendingOperation, true, "the unrelated Endesa pending operation must survive untouched");
    assert.equal(hijackTurn.debug.conversationTopic, "gmail_unsupported_action");

    // The original Endesa confirmation must still be exactly what gets executed.
    const confirmTurn = await send(server, userId, "yes");
    assert.equal(confirmTurn.operationsExecuted.length, 1);
    assert.equal(confirmTurn.operationsExecuted[0].tool, "gmail.rule.create");
    assert.equal(confirmTurn.operationsExecuted[0].status, "executed");

    const rules = await prisma.emailSignalRule.findMany({ where: { userId } });
    assert.equal(rules.length, 1);
    assert.match(rules[0].name, /Endesa/i);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: memory.create with malformed/missing args never claims success", async () => {
  const server = buildServer();
  const userId = `agent-memory-malformed-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    mockPlan({
      topic: "memory",
      intent: "create_memory",
      operations: [op("memory.create", { type: "preference" })], // missing required `summary`
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Got it, I'll remember that."
    });
    const missingFieldTurn = await send(server, userId, "remember I prefer blunt feedback");
    assert.doesNotMatch(missingFieldTurn.reply, /got it|i'll remember|i've noted|remembered/i);
    assert.match(missingFieldTurn.reply, /couldn't save that memory/i);
    assert.match(missingFieldTurn.reply, /nothing was changed/i);
    assert.equal(missingFieldTurn.operationsExecuted.length, 0);
    assert.equal(missingFieldTurn.debug.toolValidationPassed, false);
    assert.equal(missingFieldTurn.debug.mutationExecuted, false);

    // Structured args (not a JSON string) mean the planner literally cannot hand the
    // validator a non-object/array for `args` — normalizePlan coerces anything that
    // isn't a plain object to `{}` before validation ever runs. That still safely
    // fails schema validation (as above) rather than silently executing with junk
    // data; the validator's dedicated "malformed" branch is retained as defense in
    // depth for callers that bypass normalizePlan, but is unreachable through the
    // real planner path — a direct, positive consequence of switching off argsJson.

    const memoryCount = await prisma.memoryEntry.count({ where: { userId } });
    assert.equal(memoryCount, 0);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: memory golden transcript — valid save then recall", async () => {
  const server = buildServer();
  const userId = `agent-memory-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    mockPlan({
      topic: "memory",
      intent: "create_memory",
      operations: [op("memory.create", { summary: "Prefers blunt feedback", type: "preference" }, "explicit remember request")],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Got it, I'll remember that you prefer blunt feedback."
    });
    const turn1 = await send(server, userId, "remember I prefer blunt feedback");
    assert.match(turn1.reply, /blunt feedback/i);
    assert.equal(turn1.operationsExecuted[0].status, "executed");
    assert.equal(turn1.debug.mutationExecuted, true);
    assert.equal(turn1.debug.conversationTopic, "memory");

    const memoryCount = await prisma.memoryEntry.count({ where: { userId, status: "active" } });
    assert.equal(memoryCount, 1);

    mockPlan({
      topic: "memory",
      intent: "recall_memory",
      operations: [op("memory.search", { query: "blunt" }, "user asking to recall")],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const turn2 = await send(server, userId, "what did you remember?");
    assert.match(turn2.reply, /blunt feedback/i);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: zero-width characters and stray whitespace in planner args are sanitized", async () => {
  const server = buildServer();
  const userId = `agent-sanitize-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    mockPlan({
      topic: "memory",
      intent: "create_memory",
      operations: [op("memory.create", { summary: "  Prefers blunt feedback​ ", type: "preference" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const turn1 = await send(server, userId, "remember I prefer blunt feedback");
    assert.equal(turn1.operationsExecuted[0].status, "executed");

    const memory = await prisma.memoryEntry.findFirst({ where: { userId } });
    assert.equal(memory?.summary, "Prefers blunt feedback");
    assert.doesNotMatch(memory?.summary ?? "", /​/);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: action cleanup golden transcript resolves 'it'", async () => {
  const server = buildServer();
  const userId = `agent-cleanup-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const action = await prisma.actionItem.create({
      data: { userId, source: "manual", title: "Write YouTube script", status: "open", priority: "medium", evidence: "manual" }
    });

    mockPlan({
      topic: "action_cleanup",
      intent: "list_actions_for_cleanup",
      operations: [op("action.list", { status: "open" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const turn1 = await send(server, userId, "clean up my tasks");
    assert.match(turn1.reply, /Write YouTube script/i);

    mockPlan({
      topic: "action_cleanup",
      intent: "snooze_referenced_action",
      operations: [op("action.snooze", { untilText: "tomorrow" }, "resolve 'it' to the single visible action")],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const turn2 = await send(server, userId, "snooze it to tomorrow");
    assert.equal(turn2.operationsExecuted.length, 1);
    assert.equal(turn2.operationsExecuted[0].status, "executed");
    assert.match(turn2.reply, /bring "write youtube script" back/i);

    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.status, "snoozed");
    assert.ok(updated?.snoozedUntil);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: gmail read golden transcript is read-only and never sets pendingOperation", async () => {
  const server = buildServer();
  const userId = `agent-gmail-read-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const connection = await prisma.integrationConnection.create({
      data: { userId, integrationId: "gmail", status: "active", config: {} }
    });
    await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "job_search_email",
        name: "Job search emails",
        status: "active",
        createdBy: "user"
      }
    });

    mockPlan({
      topic: "gmail_rules",
      intent: "list_active_rules",
      operations: [op("gmail.rule.list")],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const turn1 = await send(server, userId, "what email rules are active?");
    assert.match(turn1.reply, /Job search emails/i);
    assert.equal(turn1.needsConfirmation, false);
    assert.equal(turn1.debug.pendingOperation, false);
    assert.equal(turn1.debug.mutationExecuted, false);

    mockPlan({
      topic: "gmail_rules",
      intent: "explain_endesa_rule",
      operations: [op("gmail.rule.explain", { label: "Endesa" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const turn2 = await send(server, userId, "does Endesa auto-log?");
    assert.match(turn2.reply, /does not auto-log/i);
    assert.match(turn2.reply, /email review/i);
    assert.equal(turn2.needsConfirmation, false);
    assert.equal(turn2.debug.pendingOperation, false);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: unknown context asks a narrow clarifying question, no gmail dump", async () => {
  const server = buildServer();
  const userId = `agent-unknown-context-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    mockPlan({
      topic: "general",
      intent: "ambiguous_tracking_request",
      operations: [op("clarification.ask", { question: "Which emails do you want me to track?" })],
      needsClarification: true,
      clarificationQuestion: "Which emails do you want me to track?",
      replyDraft: ""
    });
    const turn1 = await send(server, userId, "track those emails");
    assert.equal(turn1.reply, "Which emails do you want me to track?");
    assert.doesNotMatch(turn1.reply, /webhook|classifierMode|reviewBeforeLogging|adapterId/i);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: hallucinated unsupported tool is blocked by the validator, not just the prompt", async () => {
  const server = buildServer();
  const userId = `agent-unsupported-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    mockPlan({
      topic: "gmail_autolabel",
      intent: "unsupported_gmail_autolabel",
      operations: [op("gmail.autolabel", { label: "Bills" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "I'll set that up to auto-label instantly."
    });
    const turn1 = await send(server, userId, "auto-label my bill emails the instant they arrive");
    assert.doesNotMatch(turn1.reply, /I'll set that up/i);
    assert.match(turn1.reply, /isn't something I can do yet|nothing was changed/i);
    assert.equal(turn1.operationsExecuted.length, 0);
    assert.equal(turn1.debug.mutationExecuted, false);
    assert.equal(turn1.debug.toolValidationPassed, false);

    const rulesCount = await prisma.emailSignalRule.count({ where: { userId } });
    assert.equal(rulesCount, 0);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: generic user policy guardrail blocks before planning, no hardcoded domain", async () => {
  const server = buildServer();
  const userId = `agent-guardrail-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await updateUserOperatingProfile(userId, { knownTriggers: ["chasing losses"] });

    // No mocked plan: the guardrail must short-circuit before the planner is ever invoked.
    const turn1 = await send(server, userId, "I think I'm chasing losses again tonight");
    assert.match(turn1.reply, /slow down|careful/i);
    assert.equal(turn1.debug.plannerUsed, "none");
    assert.equal(turn1.debug.llmPlannerAttempted, false);
    // The generic goal/guardrail engine (apps/api/src/agent-runtime/goal-guardrails.ts) logs a
    // detected conflict as a risk_pattern memory — reusing the existing memory infrastructure
    // that insights/daily-review already read — rather than silently dropping it. No action/event
    // is ever created; only that one deterministic, non-LLM-driven memory write happens.
    assert.equal(turn1.operationsExecuted.length, 1);
    assert.equal(turn1.operationsExecuted[0]?.tool, "memory.create");
    assert.equal(turn1.debug.mutationExecuted, true);

    const eventCount = await prisma.event.count({ where: { userId } });
    assert.equal(eventCount, 0);
    const riskMemories = await prisma.memoryEntry.count({ where: { userId, type: "risk_pattern" } });
    assert.equal(riskMemories, 1);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: falls back to the heuristic planner when the LLM planner is unavailable", async () => {
  const server = buildServer();
  const userId = `agent-fallback-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    process.env.AGENT_RUNTIME_PLANNER_MOCK_THROW = "true";

    const turn1 = await send(server, userId, "something totally unscripted");
    assert.equal(turn1.debug.plannerUsed, "fallback");
    assert.equal(turn1.debug.llmPlannerAttempted, true);
    assert.equal(turn1.debug.llmPlannerUsed, false);
    assert.ok(turn1.reply.length > 0);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: progress logging golden transcript, and topic updates progress -> memory -> gmail", async () => {
  const server = buildServer();
  const userId = `agent-progress-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    mockPlan({
      topic: "progress_log",
      intent: "log_progress",
      operations: [
        op("event.log_job_applications", { count: 2 }, "2 CVs sent"),
        op("event.log_workout", { minutes: 45 }, "45 minutes training")
      ],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "I logged: 2 CVs sent, 45 minutes of training."
    });
    const turn1 = await send(server, userId, "I sent two CVs and trained 45 minutes");
    assert.match(turn1.reply, /2 CVs/i);
    assert.match(turn1.reply, /45 minutes/i);
    assert.equal(turn1.operationsExecuted.length, 2);
    assert.ok(turn1.operationsExecuted.every((executed: { status: string }) => executed.status === "executed"));
    assert.equal(turn1.debug.mutationExecuted, true);
    assert.equal(turn1.debug.conversationTopic, "progress_logging");

    const applicationCount = await prisma.event.count({ where: { userId, type: "career.application_sent" } });
    const workoutCount = await prisma.event.count({ where: { userId, type: "health.workout_completed" } });
    assert.equal(applicationCount, 2);
    assert.equal(workoutCount, 1);

    mockPlan({
      topic: "progress_log",
      intent: "answer_recent_changes",
      operations: [op("operator.recent_changes")],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const turn2 = await send(server, userId, "qué has cambiado?");
    assert.match(turn2.reply, /2 job application/i);
    assert.match(turn2.reply, /45 minutes/i);
    // operator.recent_changes ran this turn, so ground-truth inference reclassifies the
    // topic to reflect that (an operator/summary interaction), rather than blindly
    // repeating "progress_logging" from the prior turn.
    assert.equal(turn2.debug.conversationTopic, "operator_summary");

    mockPlan({
      topic: "irrelevant_label_the_llm_might_repeat",
      intent: "create_memory",
      operations: [op("memory.create", { summary: "Prefers blunt feedback" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Got it — I'll remember that."
    });
    const turn3 = await send(server, userId, "remember I prefer blunt feedback");
    assert.equal(turn3.debug.conversationTopic, "memory");

    mockPlan({
      topic: "irrelevant_label_the_llm_might_repeat",
      intent: "list_rules",
      operations: [op("gmail.rule.list")],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const turn4 = await send(server, userId, "what email rules are active?");
    assert.equal(turn4.debug.conversationTopic, "gmail_rules");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: operationsExecuted omits raw DB rows by default, includes them only with debugRaw", async () => {
  const server = buildServer();
  const userId = `agent-debugraw-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    mockPlan({
      topic: "memory",
      intent: "create_memory",
      operations: [op("memory.create", { summary: "Prefers blunt feedback" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const defaultTurn = await send(server, userId, "remember I prefer blunt feedback", false);
    assert.equal(defaultTurn.operationsExecuted[0].status, "executed");
    assert.equal(defaultTurn.operationsExecuted[0].result, undefined, "default response must not leak raw DB rows");
    assert.ok(defaultTurn.operationsExecuted[0].summary.length > 0);

    mockPlan({
      topic: "memory",
      intent: "recall_memory",
      operations: [op("memory.search", { query: "blunt" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const rawTurn = await send(server, userId, "what did you remember?", true);
    assert.equal(rawTurn.operationsExecuted[0].status, "executed");
    assert.ok(Array.isArray(rawTurn.operationsExecuted[0].result), "debugRaw:true must include the raw DB result");
    assert.equal(rawTurn.operationsExecuted[0].result[0].summary, "Prefers blunt feedback");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// ---------------------------------------------------------------------------
// Objective 1/2/6 — v3 UX cleanup, existing-Gmail-rule handling, no command wording
// ---------------------------------------------------------------------------

test("agent/message: memory recall is not duplicated even if replyDraft says the same thing", async () => {
  const server = buildServer();
  const userId = `agent-memory-dup-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    mockPlan({
      topic: "memory",
      intent: "create_memory",
      operations: [op("memory.create", { summary: "Prefers blunt feedback" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await send(server, userId, "remember I prefer blunt feedback");

    // The LLM's draft deliberately restates the same fact the ground-truth memory.search
    // summary will also state — this is exactly the shape of the real duplication bug.
    mockPlan({
      topic: "memory",
      intent: "recall_memory",
      operations: [op("memory.search", { query: "blunt" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "I remember that you prefer blunt feedback."
    });
    const reply = await send(server, userId, "what did you remember?");

    const occurrences = (reply.reply.match(/blunt feedback/gi) ?? []).length;
    assert.equal(occurrences, 1, `expected "blunt feedback" to appear exactly once, got: ${JSON.stringify(reply.reply)}`);
    assert.doesNotMatch(reply.reply, /I remember.*I remember/is);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: gmail.rule.list has no duplicated raw summary appended after the list", async () => {
  const server = buildServer();
  const userId = `agent-gmail-list-dup-${randomUUID()}`;

  try {
    await seedGmailUser(userId);
    const connection = await prisma.integrationConnection.findFirstOrThrow({ where: { userId, integrationId: "gmail" } });
    // reviewBeforeLogging: true matches what gmail.rule.create actually sets for every real
    // custom_email_review rule — needed so gmailRuleTrackingPolicyLabel's real, accurate wording
    // (used by both gmail.status and this advanced view) matches what this test expects.
    await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Naturgy invoices", status: "active", reviewBeforeLogging: true, createdBy: "user" }
    });
    await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Endesa bills", status: "active", reviewBeforeLogging: true, createdBy: "user" }
    });

    mockPlan({
      topic: "gmail_rules",
      intent: "list_active_rules",
      operations: [op("gmail.rule.list")],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Here are your active Gmail rules:"
    });
    const reply = await send(server, userId, "what email rules are active?");

    assert.doesNotMatch(reply.reply, /Here are your active Gmail rules:/i, "the LLM's decoy prefix must not survive alongside the ground-truth list");
    const listOccurrences = (reply.reply.match(/Naturgy invoices/gi) ?? []).length;
    assert.equal(listOccurrences, 1, "each rule must appear exactly once, not once in a list and again in a trailing raw summary");
    assert.doesNotMatch(reply.reply, /\d+ active Gmail rule\(s\):/i, "no trailing raw 'N active Gmail rule(s): ...' dump");
    // Order between the two rules isn't guaranteed (both are created in rapid succession, so
    // their createdAt values can tie) — only the numbering/format and no-duplication matter here.
    assert.match(reply.reply, /\d\. Naturgy invoices — review-first tracking/);
    assert.match(reply.reply, /\d\. Endesa bills — review-first tracking/);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: tracking a Gmail rule that already exists reports already-active, asks nothing, mutates nothing", async () => {
  const server = buildServer();
  const userId = `agent-gmail-existing-${randomUUID()}`;

  try {
    await seedGmailUser(userId);
    const connection = await prisma.integrationConnection.findFirstOrThrow({ where: { userId, integrationId: "gmail" } });
    await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Naturgy invoices", status: "active", createdBy: "user" }
    });

    mockPlan({
      topic: "gmail_tracking",
      intent: "create_review_first_gmail_rule",
      operations: [op("gmail.rule.create", { label: "Naturgy invoices" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "I can set up a tracking rule for Naturgy invoices in Gmail, but I need your confirmation to proceed."
    });
    const reply = await send(server, userId, "track Naturgy invoices from Gmail");

    assert.equal(reply.needsConfirmation, false, "no pending confirmation when the rule already exists");
    assert.equal(reply.debug.pendingOperation, false);
    assert.equal(reply.debug.mutationExecuted, false, "nothing was actually created");
    assert.match(reply.reply, /already active/i);
    assert.match(reply.reply, /review/i);
    assert.doesNotMatch(reply.reply, /need your confirmation|would you like to proceed|shall I/i, "must not still ask to create it");

    const rules = await prisma.emailSignalRule.count({ where: { userId, name: "Naturgy invoices" } });
    assert.equal(rules, 1, "no duplicate rule was created");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: tracking a paused Gmail rule explains it exists and is paused, does not invent resume", async () => {
  const server = buildServer();
  const userId = `agent-gmail-paused-${randomUUID()}`;

  try {
    await seedGmailUser(userId);
    const connection = await prisma.integrationConnection.findFirstOrThrow({ where: { userId, integrationId: "gmail" } });
    await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Naturgy invoices", status: "paused", createdBy: "user" }
    });

    mockPlan({
      topic: "gmail_tracking",
      intent: "create_review_first_gmail_rule",
      operations: [op("gmail.rule.create", { label: "Naturgy invoices" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await send(server, userId, "track Naturgy invoices from Gmail");

    assert.equal(reply.needsConfirmation, false);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /paused/i);
    assert.doesNotMatch(reply.reply, /resumed|resuming it now|I've resumed/i, "must not claim to have resumed it — v3 has no resume capability");

    const rules = await prisma.emailSignalRule.count({ where: { userId, name: "Naturgy invoices" } });
    assert.equal(rules, 1, "no duplicate rule was created alongside the paused one");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: tracking a genuinely new Gmail rule still asks for confirmation", async () => {
  const server = buildServer();
  const userId = `agent-gmail-new-${randomUUID()}`;

  try {
    await seedGmailUser(userId);

    mockPlan({
      topic: "gmail_tracking",
      intent: "create_review_first_gmail_rule",
      operations: [op("gmail.rule.create", { label: "Naturgy invoices" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await send(server, userId, "track Naturgy invoices from Gmail");

    assert.equal(reply.needsConfirmation, true);
    assert.equal(reply.debug.pendingOperation, true);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /review/i);
    assert.match(reply.reply, /not instant/i);

    const rules = await prisma.emailSignalRule.count({ where: { userId, name: "Naturgy invoices" } });
    assert.equal(rules, 0, "nothing is created before confirmation");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: operator.today never recommends a slash command, suggests natural phrasing instead", async () => {
  const server = buildServer();
  const userId = `agent-today-no-commands-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    // A goal anchor, so "so what today" hits the normal operator.today flow this test is
    // actually testing, not the new empty-user goal-anchor nudge (agent-runtime/runtime.ts).
    await createGoal(userId, { title: "Apply to developer jobs", category: "career", priority: "medium" });
    await prisma.actionItem.createMany({
      data: [
        { userId, source: "manual", title: "Apply to jobs", status: "open", priority: "medium", evidence: "manual" },
        { userId, source: "manual", title: "Review CV", status: "open", priority: "medium", evidence: "manual" }
      ]
    });

    mockPlan({
      topic: "operator_summary",
      intent: "show_today",
      operations: [op("operator.today")],
      needsClarification: false,
      clarificationQuestion: null,
      // Decoy replyDraft mimicking the real observed bug (command-oriented wording) —
      // ground truth must win and this text must never reach the user.
      replyDraft: "Today - 2026-08-18. Action hygiene: 2 actions need cleanup decisions. Run /action_hygiene."
    });
    const reply = await send(server, userId, "so what today");

    assert.doesNotMatch(reply.reply, /\/action_hygiene|\/gmail_rules|\/sync_gmail|run \//i, "no slash-command recommendation in v3 normal chat");
    assert.match(reply.reply, /clean up my actions/i, "natural next step instead of a command");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

async function seedGmailUser(userId: string): Promise<void> {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
}

function mockAiguesGmailRulePlan(): void {
  mockPlan({
    topic: "gmail_tracking_aigues",
    intent: "create_review_first_gmail_rule",
    operations: [op("gmail.rule.create", { label: "Aigues de Barcelona invoices" })],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft: "I can create a review-first Gmail tracking rule for Aigues de Barcelona invoices. Would you like to proceed?"
  });
}

// Test A (real HTTP layer): two same-user /agent/message calls fired without waiting for the
// first to finish must still process in order, and the second must see the first's session
// changes (the pending confirmation it created) rather than racing past it. See also
// tests/agent-runtime-user-lock.test.ts for a fast, dependency-free unit proof of the
// underlying primitive.
test("agent/message: per-user serialization — concurrent calls process in order for the same user", async () => {
  const server = buildServer();
  const userId = `agent-serialize-${randomUUID()}`;

  try {
    await seedGmailUser(userId);
    process.env.AGENT_RUNTIME_PLANNER_MOCK_DELAY_MS = "150";
    mockAiguesGmailRulePlan();

    const call1 = send(server, userId, "track Aigues de Barcelona invoices from Gmail");
    await new Promise((resolve) => setTimeout(resolve, 20));
    delete process.env.AGENT_RUNTIME_PLANNER_MOCK_DELAY_MS; // "yes" is deterministic and never touches the planner anyway
    const call2 = send(server, userId, "yes");

    const [result1, result2] = await Promise.all([call1, call2]);

    assert.equal(result1.debug.pendingOperation, true, "first message must finish creating the pending confirmation");
    assert.equal(
      result2.debug.mutationExecuted,
      true,
      "second message ('yes') must see the pending operation the first message created, not race past it"
    );
    assert.equal(result2.operationsExecuted[0]?.tool, "gmail.rule.create");
    assert.equal(result2.operationsExecuted[0]?.status, "executed");

    const rules = await prisma.emailSignalRule.findMany({ where: { userId } });
    assert.equal(rules.length, 1, "exactly one rule should exist — no duplicate/racing execution");
  } finally {
    delete process.env.AGENT_RUNTIME_PLANNER_MOCK_DELAY_MS;
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// Test B: pending Gmail rule + notification-followup phrasing must not execute, not call
// action.list, not ask a generic clarification, not dump Gmail setup — deterministic reply only.
test("agent/message: pending Gmail rule + notification followup stays pending with a deterministic reply", async () => {
  const server = buildServer();
  const userId = `agent-gmail-followup-${randomUUID()}`;

  try {
    await seedGmailUser(userId);
    mockAiguesGmailRulePlan();
    await send(server, userId, "track Aigues de Barcelona invoices from Gmail");

    // No mockPlan: this phrasing must be handled deterministically, before the planner runs.
    const followUp = await send(server, userId, "let me know when I receive one");

    assert.equal(followUp.debug.plannerUsed, "none");
    assert.equal(followUp.debug.mutationExecuted, false);
    assert.equal(followUp.debug.pendingOperation, true);
    assert.equal(followUp.operationsExecuted.length, 0);
    assert.equal(followUp.operationsPlanned.length, 0, "no action.list or any other tool should have been planned");
    assert.match(followUp.reply, /manual or scheduled/i);
    assert.match(followUp.reply, /not instant/i);
    assert.match(followUp.reply, /Aigues de Barcelona invoices/i);
    assert.doesNotMatch(followUp.reply, /action item|found \d+ action/i, "must not bleed in an action.list result");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// Test C: a non-exact confirmation ("just let me know i wanna know") must never execute the
// pending mutation, regardless of which deterministic guard catches it.
test("agent/message: non-exact confirmation phrasing never executes the pending mutation", async () => {
  const server = buildServer();
  const userId = `agent-non-exact-${randomUUID()}`;

  try {
    await seedGmailUser(userId);
    mockAiguesGmailRulePlan();
    await send(server, userId, "track Aigues de Barcelona invoices from Gmail");

    const reply = await send(server, userId, "just let me know i wanna know");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(reply.debug.pendingOperation, true);
    assert.equal(reply.operationsExecuted.length, 0);
    assert.doesNotMatch(reply.reply, /tracking is on|has been created/i, "must never claim the rule was created");

    const rules = await prisma.emailSignalRule.count({ where: { userId } });
    assert.equal(rules, 0);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// Test D: an exact "yes" against a real pending Gmail rule executes it and clears pending.
test("agent/message: exact 'yes' executes the pending Gmail rule and clears pendingOperation", async () => {
  const server = buildServer();
  const userId = `agent-exact-yes-${randomUUID()}`;

  try {
    await seedGmailUser(userId);
    mockAiguesGmailRulePlan();
    await send(server, userId, "track Aigues de Barcelona invoices from Gmail");

    const confirmed = await send(server, userId, "yes");

    assert.equal(confirmed.debug.mutationExecuted, true);
    assert.equal(confirmed.debug.pendingOperation, false);
    assert.equal(confirmed.needsConfirmation, false);

    const rules = await prisma.emailSignalRule.findMany({ where: { userId } });
    assert.equal(rules.length, 1);
    assert.match(rules[0].name, /Aigues de Barcelona/i);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// Test E: exact "yes" with nothing pending must be a fixed deterministic reply, never reach
// the LLM planner, never mutate.
test("agent/message: exact 'yes' with no pending operation gives a fixed reply and never calls the planner", async () => {
  const server = buildServer();
  const userId = `agent-yes-no-pending-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    // No mockPlan on purpose — if this reached the planner it would throw (no OPENAI_API_KEY
    // in test env) and fall back to the heuristic planner instead of failing loudly, which
    // would silently hide a real routing bug. Asserting plannerUsed:"none" is the real proof.
    const reply = await send(server, userId, "yes");

    assert.equal(reply.reply, "I don't have anything pending to confirm.");
    assert.equal(reply.debug.plannerUsed, "none");
    assert.equal(reply.debug.llmPlannerAttempted, false);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.ok(
      reply.operationsExecuted.every((executed: { status: string }) => executed.status === "skipped"),
      "no real tool executed — only a transparency entry noting there was nothing to confirm"
    );

    const eventCount = await prisma.event.count({ where: { userId } });
    assert.equal(eventCount, 0);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// Test F: a genuine read-only question while pending is answered normally, without touching
// the pending confirmation.
test("agent/message: read-only question during a pending confirmation answers without clearing pending", async () => {
  const server = buildServer();
  const userId = `agent-read-during-pending-${randomUUID()}`;

  try {
    await seedGmailUser(userId);
    mockAiguesGmailRulePlan();
    await send(server, userId, "track Aigues de Barcelona invoices from Gmail");

    mockPlan({
      topic: "gmail_rules",
      intent: "list_active_rules",
      operations: [op("gmail.rule.list")],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await send(server, userId, "what email rules are active?");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(reply.debug.pendingOperation, true, "the Aigues de Barcelona confirmation must still be pending");
    assert.match(reply.reply, /active Gmail rule/i);

    const rules = await prisma.emailSignalRule.count({ where: { userId } });
    assert.equal(rules, 0, "the pending rule must not have been created as a side effect of a read question");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// Test G: an unsupported Gmail send/reply request during a pending confirmation refuses
// safely and does not execute the pending mutation.
test("agent/message: unsupported Gmail reply request during pending confirmation refuses without executing pending", async () => {
  const server = buildServer();
  const userId = `agent-unsupported-during-pending-${randomUUID()}`;

  try {
    await seedGmailUser(userId);
    mockAiguesGmailRulePlan();
    await send(server, userId, "track Aigues de Barcelona invoices from Gmail");

    const reply = await send(server, userId, "reply to the Endesa email");

    assert.match(reply.reply, /can't reply|isn't supported|not supported/i);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(reply.debug.pendingOperation, true);

    const rules = await prisma.emailSignalRule.count({ where: { userId } });
    assert.equal(rules, 0);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// Test H: "what changed" is a clean bulleted list from ground truth, never a raw
// semicolon-joined dump, and never blended with an unrelated LLM paraphrase.
test("agent/message: recent-changes composer produces a clean bulleted summary, no raw dump", async () => {
  const server = buildServer();
  const userId = `agent-recent-changes-clean-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    mockPlan({
      topic: "memory",
      intent: "create_memory",
      operations: [op("memory.create", { summary: "Prefers blunt feedback" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Got it — I'll remember that."
    });
    await send(server, userId, "remember I prefer blunt feedback");

    mockPlan({
      topic: "progress_log",
      intent: "log_progress",
      operations: [
        op("event.log_job_applications", { count: 2 }, "2 CVs sent"),
        op("event.log_workout", { minutes: 45 }, "45 minutes training")
      ],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Logged both."
    });
    await send(server, userId, "I sent two CVs and trained 45 minutes");

    mockPlan({
      topic: "progress_log",
      intent: "answer_recent_changes",
      operations: [op("operator.recent_changes")],
      needsClarification: false,
      clarificationQuestion: null,
      // Deliberately a decoy that doesn't match ground truth, to prove the composer
      // ignores replyDraft entirely for this tool rather than blending the two.
      replyDraft: "He cambiado la configuración para recordar que prefieres comentarios directos."
    });
    const reply = await send(server, userId, "qué has cambiado?");

    assert.doesNotMatch(reply.reply, /cambiado la configuración/i, "must not blend the LLM's decoy paraphrase into the answer");
    assert.doesNotMatch(reply.reply, /;/, "must not be a raw semicolon-joined dump");
    assert.match(reply.reply, /- .*(CV|application)/i);
    assert.match(reply.reply, /- .*45 minutes/i);
    assert.match(reply.reply, /- .*blunt feedback/i);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// Regression: operator.recent_changes is itself read-only and must never be recorded into
// recentMutations — otherwise a second "what changed?" nests and duplicates the first answer.
test("agent/message: asking 'what changed' twice in a row does not nest/duplicate the answer", async () => {
  const server = buildServer();
  const userId = `agent-recent-changes-idempotent-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    mockPlan({
      topic: "memory",
      intent: "create_memory",
      operations: [op("memory.create", { summary: "Prefers blunt feedback" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await send(server, userId, "remember I prefer blunt feedback");

    const recentChangesPlan = () =>
      mockPlan({
        topic: "operator_summary",
        intent: "answer_recent_changes",
        operations: [op("operator.recent_changes")],
        needsClarification: false,
        clarificationQuestion: null,
        replyDraft: ""
      });

    recentChangesPlan();
    const first = await send(server, userId, "what changed?");
    assert.match(first.reply, /- .*blunt feedback/i);

    recentChangesPlan();
    const second = await send(server, userId, "what changed?");

    assert.doesNotMatch(second.reply, /Here's what I've recorded:[\s\S]*Here's what I've recorded:/i, "must not nest a prior answer inside a new one");
    assert.doesNotMatch(second.reply, /(blunt feedback[\s\S]*){2,}/i, "must not duplicate the same recorded item");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
