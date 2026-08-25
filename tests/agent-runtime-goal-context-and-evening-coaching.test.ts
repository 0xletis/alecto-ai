import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal, createMemory, prisma } from "../packages/db/src/index.ts";
import { loadContext } from "../apps/api/src/agent-runtime/context-loader.ts";
import { buildUserPayload, describeLocalTime } from "../apps/api/src/agent-runtime/planner.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Deterministic coverage for fix/private-alpha-goal-context-and-evening-coaching — a real
 * Telegram transcript had "customize your resume" proposed after the user had said, during goal
 * setup, that their resume and web CV were already up to date. Root cause (see this branch's own
 * report): the fact was never durably saved (only ever reflected in the short recent-message
 * window, which reliably ages out of a normal-length conversation) — not a gap in the veto's own
 * vocabulary. This file covers the two things that ARE deterministic: (1) a durable memory (not
 * just a recent message) is enough on its own to trip the resume/CV/portfolio veto, and (2) the
 * planner payload now actually carries a real local-time-of-day signal. The evening-coaching
 * PROMPT judgment itself is LLM behavior, covered by the gated real-LLM eval suite instead.
 */

// --- Task 2/3: a DURABLE memory (not a recent message) is enough to trip the veto -----------------

test("A: a memory.create'd 'resume already up to date' fact (no matching recent message) still vetoes a later resume proposedAction", async () => {
  const server = buildServer();
  const userId = `goal-ctx-a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    // Simulates a fact saved during goal setup, long enough ago that it's no longer in the
    // session's own recent-message window — createMemory bypasses conversation entirely, exactly
    // like a fact durably saved in an earlier session would look to a fresh conversation.
    await createMemory(userId, { type: "goal_context", summary: "User's resume and web CV are already up to date — do not suggest updating/customizing them." });

    const beforeCount = await prisma.actionItem.count({ where: { userId } });
    mockPlan({
      topic: "goals",
      intent: "next_action",
      operations: [op("goal.recommend_next_action", { recommendation: "Let's keep momentum.", proposedAction: "Customize your resume for remote Web3 roles" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "what should I do next?");

    assert.doesNotMatch(reply.reply, /customize your resume|update your resume/i);
    assert.equal(reply.debug.pendingOperation, false, "must not open a create-confirmation for the vetoed resume action");
    const afterCount = await prisma.actionItem.count({ where: { userId } });
    assert.equal(afterCount, beforeCount, "no action may be created for the vetoed proposal");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B: memory.create actually persists a goal_context row with the stated fact", async () => {
  const server = buildServer();
  const userId = `goal-ctx-b-${randomUUID()}`;
  try {
    await seedUser(userId);

    mockPlan({
      topic: "general",
      intent: "remember",
      operations: [op("memory.create", { summary: "User's resume and web CV are already up to date — do not suggest updating/customizing them.", type: "goal_context" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Got it, noted."
    });
    await sendAgentMessage(server, userId, "just so you know, my resume and web CV are already up to date");

    const rows = await prisma.memoryEntry.findMany({ where: { userId, type: "goal_context" } });
    assert.equal(rows.length, 1);
    assert.match(rows[0].summary, /resume and web cv are already up to date/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C: widened vocabulary — 'tailor your CV' and 'polish your resume' are both vetoed by a durable up-to-date memory", async () => {
  const server = buildServer();
  const userId = `goal-ctx-c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await createMemory(userId, { type: "goal_context", summary: "User's CV is already current." });

    for (const proposedAction of ["Tailor your CV for remote Web3 roles", "Polish your resume before applying"]) {
      mockPlan({
        topic: "goals",
        intent: "next_action",
        operations: [op("goal.recommend_next_action", { recommendation: "Let's keep momentum.", proposedAction })],
        needsClarification: false,
        clarificationQuestion: null,
        replyDraft: ""
      });
      const reply = await sendAgentMessage(server, userId, "what should I do next?");
      assert.equal(reply.debug.pendingOperation, false, `must veto: "${proposedAction}"`);
    }
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D: 'update portfolio' is vetoed once the user said their web CV/portfolio is current", async () => {
  const server = buildServer();
  const userId = `goal-ctx-d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await createMemory(userId, { type: "goal_context", summary: "User's portfolio is already up to date." });

    mockPlan({
      topic: "goals",
      intent: "next_action",
      operations: [op("goal.recommend_next_action", { recommendation: "Let's keep momentum.", proposedAction: "Update your portfolio with recent projects" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "what should I do next?");

    assert.equal(reply.debug.pendingOperation, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E: no false veto — a resume proposal with no prior resume/CV statement anywhere still opens a normal confirmation", async () => {
  const server = buildServer();
  const userId = `goal-ctx-e-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    mockPlan({
      topic: "goals",
      intent: "next_action",
      operations: [op("goal.recommend_next_action", { recommendation: "Let's keep momentum.", proposedAction: "Tailor your resume for remote Web3 roles" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "what should I do next?");

    assert.match(reply.reply, /tailor your resume/i);
    assert.equal(reply.debug.pendingOperation, true, "with no stated context, the proposal should open a normal confirmation");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F: a role-specific tailored NOTE that never mentions resume/CV/portfolio is not vetoed by an up-to-date memory", async () => {
  const server = buildServer();
  const userId = `goal-ctx-f-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await createMemory(userId, { type: "goal_context", summary: "User's resume and web CV are already up to date." });

    mockPlan({
      topic: "goals",
      intent: "next_action",
      operations: [op("goal.recommend_next_action", { recommendation: "Let's keep momentum.", proposedAction: "Draft a short tailored note for the recruiter about the Acme role" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "what should I do next?");

    assert.match(reply.reply, /tailored note/i);
    assert.equal(reply.debug.pendingOperation, true, "a tailored note unrelated to resume/CV/portfolio must not be swept up by the veto");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 4: the planner payload now carries a real local-time-of-day signal ----------------------

test("F2: memory.create is a deterministic no-op when a near-duplicate summary already exists, even if the planner keeps re-proposing it", async () => {
  const server = buildServer();
  const userId = `goal-ctx-f2-${randomUUID()}`;
  try {
    await seedUser(userId);
    await createMemory(userId, { type: "important_fact", summary: "User's resume and web CV are already up to date — do not suggest updating/customizing them." });

    mockPlan({
      topic: "memory",
      intent: "remember",
      operations: [op("memory.create", { summary: "User's resume and web CV are already up to date — do not suggest updating/customizing them.", type: "important_fact" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Got it."
    });
    await sendAgentMessage(server, userId, "ok, thanks");

    const rows = await prisma.memoryEntry.findMany({ where: { userId } });
    assert.equal(rows.length, 1, "a near-duplicate memory.create must not create a second row");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("G: describeLocalTime buckets night/morning/afternoon/evening correctly for a fixed timezone", () => {
  const timezone = "Europe/Madrid";
  assert.equal(describeLocalTime(new Date("2026-08-20T02:00:00Z"), timezone).timeOfDay, "night");
  assert.equal(describeLocalTime(new Date("2026-08-20T08:00:00Z"), timezone).timeOfDay, "morning");
  assert.equal(describeLocalTime(new Date("2026-08-20T13:00:00Z"), timezone).timeOfDay, "afternoon");
  assert.equal(describeLocalTime(new Date("2026-08-20T20:00:00Z"), timezone).timeOfDay, "evening");
});

test("H: buildUserPayload includes localTime when passed, and omits it entirely when not (existing call sites stay unaffected)", async () => {
  const userId = `goal-ctx-h-${randomUUID()}`;
  try {
    await seedUser(userId);
    const context = await loadContext(userId, "telegram");

    const withoutTime = JSON.parse(buildUserPayload("what should I do today?", context)) as Record<string, unknown>;
    assert.equal("localTime" in withoutTime, false, "localTime must be omitted, not null/undefined, when the caller doesn't pass it");

    const localTime = describeLocalTime(new Date("2026-08-20T21:00:00Z"), "Europe/Madrid");
    const withTime = JSON.parse(buildUserPayload("what should I do today?", context, localTime)) as { localTime: { timeOfDay: string; timezone: string } };
    assert.equal(withTime.localTime.timeOfDay, "evening");
    assert.equal(withTime.localTime.timezone, "Europe/Madrid");
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
