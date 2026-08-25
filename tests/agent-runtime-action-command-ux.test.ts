import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createGoal, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Deterministic coverage for fix/private-alpha-action-command-ux — a real Telegram transcript
 * found the action-list footer referencing invalid indexes ("Reply: complete 1, snooze 2
 * tomorrow, archive 3." shown under a single-action list), and action.complete/action.snooze
 * replies that could be overridden by the planner's own unverified pre-execution replyDraft
 * instead of what actually happened. Natural-phrase recognition itself (English/Spanish/Catalan)
 * is a planner-quality question, covered by the gated real-LLM eval suite — these tests instead
 * mock the planner having already recognized a phrase (as it would in production) and verify the
 * VALIDATOR's existing single-visible-action resolution and the EXECUTOR's grounded reply text,
 * matching the pattern already established in agent-runtime-clarification-followup-hardening.test.ts
 * and agent-runtime-closed-loop-coaching.test.ts.
 */

async function seedActionItems(userId: string, titles: string[]): Promise<string[]> {
  await seedUser(userId);
  const ids: string[] = [];
  for (const title of titles) {
    const item = await createActionItem(userId, { source: "manual", title });
    ids.push(item.id);
  }
  return ids;
}

function actionListPlan() {
  return { topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

// --- Task 1: footer never references an invalid index -----------------------------------------

test("1A: one open action's footer uses natural phrasing, no numbered index at all", async () => {
  const server = buildServer();
  const userId = `action-ux-footer-1-${randomUUID()}`;
  try {
    await seedActionItems(userId, ["Renew passport"]);
    mockPlan(actionListPlan());
    const reply = await sendAgentMessage(server, userId, "show me my actions");

    assert.match(reply.reply, /you have 1 open action:/i);
    assert.match(reply.reply, /"done"/i);
    assert.doesNotMatch(reply.reply, /archive 2/i);
    assert.doesNotMatch(reply.reply, /archive 3/i);
    assert.doesNotMatch(reply.reply, /snooze 2/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1B: two open actions' footer only references 1 and 2, never 3", async () => {
  const server = buildServer();
  const userId = `action-ux-footer-2-${randomUUID()}`;
  try {
    await seedActionItems(userId, ["Renew passport", "Book dentist appointment"]);
    mockPlan(actionListPlan());
    const reply = await sendAgentMessage(server, userId, "show me my actions");

    assert.match(reply.reply, /complete 1/i);
    assert.match(reply.reply, /snooze 2 tomorrow/i);
    assert.doesNotMatch(reply.reply, /archive 3/i);
    assert.doesNotMatch(reply.reply, /\b3\b/);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1C: three+ open actions' footer can reference 1, 2, and 3", async () => {
  const server = buildServer();
  const userId = `action-ux-footer-3-${randomUUID()}`;
  try {
    await seedActionItems(userId, ["Renew passport", "Book dentist appointment", "Follow up with recruiter"]);
    mockPlan(actionListPlan());
    const reply = await sendAgentMessage(server, userId, "show me my actions");

    assert.match(reply.reply, /complete 1/i);
    assert.match(reply.reply, /snooze 2 tomorrow/i);
    assert.match(reply.reply, /archive 3/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1D: an archived-only history list shows no open-action footer", async () => {
  const server = buildServer();
  const userId = `action-ux-footer-archived-${randomUUID()}`;
  try {
    const ids = await seedActionItems(userId, ["Old task one", "Old task two"]);
    for (const id of ids) {
      mockPlan({ topic: "actions", intent: "archive", operations: [op("action.archive", { actionId: id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
      await sendAgentMessage(server, userId, `archive ${id}`);
    }

    mockPlan({ topic: "actions", intent: "list_archived", operations: [op("action.list", { status: "archived" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "show me archived actions");

    assert.doesNotMatch(reply.reply, /you can say/i);
    assert.doesNotMatch(reply.reply, /reply: complete/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1E: typo 'show me ma actions' still routes to the open action list with a valid footer", async () => {
  const server = buildServer();
  const userId = `action-ux-footer-typo-${randomUUID()}`;
  try {
    await seedActionItems(userId, ["Renew passport"]);
    mockPlan(actionListPlan());
    const reply = await sendAgentMessage(server, userId, "show me ma actions");

    assert.match(reply.reply, /you have 1 open action:/i);
    assert.doesNotMatch(reply.reply, /archive 3/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 2: natural phrases resolve against the single visible action -------------------------

test("2A: single visible action + 'done' (actionId omitted) completes it via the existing resolver", async () => {
  const server = buildServer();
  const userId = `action-ux-natural-done-${randomUUID()}`;
  try {
    const [id] = await seedActionItems(userId, ["Renew passport"]);
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "done");

    assert.equal(reply.debug.mutationExecuted, true);
    const item = await prisma.actionItem.findUnique({ where: { id: id! } });
    assert.equal(item?.status, "completed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2B: single visible action + 'I did it' completes it", async () => {
  const server = buildServer();
  const userId = `action-ux-natural-diddit-${randomUUID()}`;
  try {
    const [id] = await seedActionItems(userId, ["Renew passport"]);
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "I did it");

    assert.equal(reply.debug.mutationExecuted, true);
    const item = await prisma.actionItem.findUnique({ where: { id: id! } });
    assert.equal(item?.status, "completed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2C: single visible action + 'remind me tomorrow' snoozes it", async () => {
  const server = buildServer();
  const userId = `action-ux-natural-remindme-${randomUUID()}`;
  try {
    const [id] = await seedActionItems(userId, ["Renew passport"]);
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({
      topic: "actions",
      intent: "snooze",
      operations: [op("action.snooze", { untilText: "tomorrow" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "remind me tomorrow");

    assert.equal(reply.debug.mutationExecuted, true);
    assert.match(reply.reply, /bring "renew passport" back/i);
    const item = await prisma.actionItem.findUnique({ where: { id: id! } });
    assert.equal(item?.status, "snoozed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2D: single visible action + 'drop it' archives it, not completes it", async () => {
  const server = buildServer();
  const userId = `action-ux-natural-dropit-${randomUUID()}`;
  try {
    const [id] = await seedActionItems(userId, ["Renew passport"]);
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({ topic: "actions", intent: "archive", operations: [op("action.archive", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "drop it");

    assert.equal(reply.debug.mutationExecuted, true);
    assert.match(reply.reply, /archived "renew passport"/i);
    assert.doesNotMatch(reply.reply, /\bcomplete\b|\bdone\b/i);
    const item = await prisma.actionItem.findUnique({ where: { id: id! } });
    assert.equal(item?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2E: multiple visible actions + 'done' (actionId omitted) asks which one, never guesses", async () => {
  const server = buildServer();
  const userId = `action-ux-natural-ambiguous-${randomUUID()}`;
  try {
    const ids = await seedActionItems(userId, ["Renew passport", "Book dentist appointment"]);
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "done");

    assert.match(reply.reply, /which action do you mean/i);
    for (const id of ids) {
      const item = await prisma.actionItem.findUnique({ where: { id: id! } });
      assert.equal(item?.status, "open");
    }
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2F: Spanish 'hecho' and Catalan 'fet' complete the single visible action the same way", async () => {
  const server = buildServer();
  const userIdEs = `action-ux-natural-es-${randomUUID()}`;
  const userIdCa = `action-ux-natural-ca-${randomUUID()}`;
  try {
    const [idEs] = await seedActionItems(userIdEs, ["Renovar el pasaporte"]);
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userIdEs, "muéstrame mis tareas");
    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const replyEs = await sendAgentMessage(server, userIdEs, "hecho");
    assert.equal(replyEs.debug.mutationExecuted, true);
    assert.equal((await prisma.actionItem.findUnique({ where: { id: idEs! } }))?.status, "completed");

    const [idCa] = await seedActionItems(userIdCa, ["Renovar el passaport"]);
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userIdCa, "mostra'm les meves tasques");
    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const replyCa = await sendAgentMessage(server, userIdCa, "fet");
    assert.equal(replyCa.debug.mutationExecuted, true);
    assert.equal((await prisma.actionItem.findUnique({ where: { id: idCa! } }))?.status, "completed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [userIdEs, userIdCa] } } });
  }
});

test("2G: no visible action + 'done' asks honestly and does not mutate anything", async () => {
  const server = buildServer();
  const userId = `action-ux-natural-none-${randomUUID()}`;
  try {
    const [id] = await seedActionItems(userId, ["Renew passport"]);

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "done");

    assert.match(reply.reply, /don't have one in view/i);
    const item = await prisma.actionItem.findUnique({ where: { id: id! } });
    assert.equal(item?.status, "open");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 3: mutation replies are grounded in the executor's own post-execution facts -----------

test("3A: complete reply uses the executor-confirmed title, never the planner's own replyDraft", async () => {
  const server = buildServer();
  const userId = `action-ux-grounded-complete-${randomUUID()}`;
  try {
    const [id] = await seedActionItems(userId, ["Renew passport"]);
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({
      topic: "actions",
      intent: "complete",
      operations: [op("action.complete", { actionId: id })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "All set — that's taken care of now."
    });
    const reply = await sendAgentMessage(server, userId, "complete it");

    assert.match(reply.reply, /marked "renew passport" complete/i);
    assert.doesNotMatch(reply.reply, /all set — that's taken care of/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3B: snooze reply uses the executor-confirmed title and a real when-label, never the replyDraft", async () => {
  const server = buildServer();
  const userId = `action-ux-grounded-snooze-${randomUUID()}`;
  try {
    const [id] = await seedActionItems(userId, ["Renew passport"]);
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({
      topic: "actions",
      intent: "snooze",
      operations: [op("action.snooze", { actionId: id, untilText: "tomorrow" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Sure thing, pushed that back for you."
    });
    const reply = await sendAgentMessage(server, userId, "snooze it tomorrow");

    assert.match(reply.reply, /bring "renew passport" back tomorrow/i);
    assert.doesNotMatch(reply.reply, /pushed that back for you/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3C: archive reply never implies completion", async () => {
  const server = buildServer();
  const userId = `action-ux-grounded-archive-${randomUUID()}`;
  try {
    const [id] = await seedActionItems(userId, ["Renew passport"]);
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({
      topic: "actions",
      intent: "archive",
      operations: [op("action.archive", { actionId: id })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Done — completed that for you."
    });
    const reply = await sendAgentMessage(server, userId, "archive it");

    assert.match(reply.reply, /archived "renew passport"/i);
    assert.doesNotMatch(reply.reply, /completed/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3D: linked-goal context is included in the complete reply when the action is linked to a goal", async () => {
  const server = buildServer();
  const userId = `action-ux-grounded-goal-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const action = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles", goalId: goalResult.goal.id });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: action.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete it");

    assert.match(reply.reply, /for your "find a fully remote web3 developer job" goal/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 4: lightweight post-completion coaching ------------------------------------------------

test("4A: completing the last goal-linked open action offers next-step help", async () => {
  const server = buildServer();
  const userId = `action-ux-coaching-last-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const action = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles", goalId: goalResult.goal.id });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: action.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete it");

    assert.match(reply.reply, /you have no open actions left/i);
    assert.match(reply.reply, /want me to suggest the next action/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4B: completing one of several goal-linked open actions points to the next one, no auto-creation", async () => {
  const server = buildServer();
  const userId = `action-ux-coaching-next-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    // Deliberately no digit in either title — a stray number would be caught by the numbered-
    // reference pre-pass (resolveExplicitActionIndexReferences) instead of exercising the exact-
    // title grounding match this test is actually about.
    const first = await createActionItem(userId, { source: "manual", title: "Apply to more remote developer roles", goalId: goalResult.goal.id, priority: "high" });
    await createActionItem(userId, { source: "manual", title: "Update resume", goalId: goalResult.goal.id, priority: "medium" });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    const beforeCount = await prisma.actionItem.count({ where: { userId } });
    // Names the target explicitly (an exact title match) rather than a bare pronoun, since two
    // actions are visible here and a bare "complete it" would honestly ask which one is meant —
    // exactly what 2E already covers.
    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: first.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete Apply to more remote developer roles");

    assert.match(reply.reply, /next up: "update resume"/i);
    const afterCount = await prisma.actionItem.count({ where: { userId } });
    assert.equal(afterCount, beforeCount, "completing an action must never silently create a new one");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4C: completing an action with no linked goal never fabricates evidence or a follow-up claim", async () => {
  const server = buildServer();
  const userId = `action-ux-coaching-nogoal-${randomUUID()}`;
  try {
    const [id] = await seedActionItems(userId, ["Renew passport"]);
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete it");

    assert.match(reply.reply, /marked "renew passport" complete/i);
    assert.doesNotMatch(reply.reply, /for your ".*" goal/i);
    assert.doesNotMatch(reply.reply, /next up/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 6: pluralization ------------------------------------------------------------------

test("6D: a NEW goal created from a built-in template (career.job_search) shows '1 Application sent', not '1 Applications sent'", async () => {
  const server = buildServer();
  const userId = `action-ux-plural-template-${randomUUID()}`;
  try {
    await seedUser(userId);
    // Root-cause finding for task 6: this is the one path where a genuinely NEW goal could still
    // show the "1 CVs sent"-shaped bug — goal-templates.ts's own built-in suggestedMetrics had
    // grammatically plural labels with no labelSingular at all (unlike the adaptive
    // goal.create_propose path, which the real planner reliably sets labelSingular for — see
    // agent-runtime-closed-loop-coaching.test.ts's 7A/7B, already on main). Fixed directly in
    // goal-templates.ts rather than here; this locks that fix in.
    const goalResult = await createGoal(userId, { title: "Find a job", category: "career", templateId: "career.job_search" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const { createEvent } = await import("../packages/db/src/index.ts");
    await createEvent(userId, { type: "career.application_sent", source: "manual", confidence: 1, data: {} });

    mockPlan({ topic: "goals", intent: "status", operations: [op("goal.status", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "show my progress");

    assert.match(reply.reply, /1 application sent/i);
    assert.doesNotMatch(reply.reply, /1 applications sent/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6C: a goal metric with no labelSingular (simulating a pre-existing goal) falls back to the plural label instead of crashing or fabricating a singular form", async () => {
  const server = buildServer();
  const userId = `action-ux-plural-fallback-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, {
      title: "Find a fully remote Web3 developer job",
      category: "career",
      priority: "medium",
      targetMetrics: [{ key: "applications_sent", label: "CVs sent", eventType: "career.application_sent", aggregation: "count", window: "daily" }]
    });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const { createEvent } = await import("../packages/db/src/index.ts");
    await createEvent(userId, { type: "career.application_sent", source: "manual", confidence: 1, data: {} });

    mockPlan({ topic: "goals", intent: "status", operations: [op("goal.status", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "show my progress");

    // Documented, accepted limitation (executor.ts's countLabel): no general pluralization
    // heuristic can safely guess a singular form for every label shape ("CVs sent" has its
    // countable noun first, "recruiter replies" has it last), so a metric missing labelSingular
    // — always true for a goal created before this field existed — deterministically falls back
    // to the plural label rather than fabricating a possibly-wrong singular.
    assert.match(reply.reply, /1 cvs sent/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
