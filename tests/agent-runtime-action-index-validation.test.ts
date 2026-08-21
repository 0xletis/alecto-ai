import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, getAgentSession, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Real Telegram smoke test: with only 8 actions ever shown (indices 1-8), "complete action 10 and
 * 9 now" was marked valid for BOTH resulting action.complete operations and mutated real data.
 * Root cause: the planner emitted two SEPARATE action.complete calls (not one action.hygiene_apply
 * call), each carrying some actionId — the previous pass's own safety net only handled a message
 * naming EXACTLY one number (overriding it against session.visibleEntities' real index) and
 * deliberately SKIPPED all of its grounding checks whenever the message contained ANY digit at
 * all, on the unenforced assumption that a multi-number request would always arrive as a single
 * action.hygiene_apply call instead. Fixed with a new turn-level pre-pass
 * (validator.ts's resolveExplicitActionIndexReferences, run once in validateOperations before any
 * individual action.complete/archive/snooze op is validated): every explicit number in the raw
 * message is resolved ONLY against the current session.visibleEntities range, atomically — if any
 * one number is out of range, the WHOLE set is blocked, never a partial mutation on the refs that
 * happened to be valid, and the planner's own actionId is never trusted once explicit numbers are
 * present.
 */

async function seedNumberedActions(userId: string, titlesNewestFirst: string[]): Promise<void> {
  // getActionItems orders ties (no dueAt) by updatedAt DESC — the LAST one created lands at
  // position 1. Seeding in reverse of the desired numbered order gives an exact, predictable page.
  for (const title of [...titlesNewestFirst].reverse()) {
    await createActionItem(userId, { source: "manual", title });
  }
}

async function listActions(server: ReturnType<typeof buildServer>, userId: string) {
  mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
  return sendAgentMessage(server, userId, "show me my actions");
}

const EIGHT_TITLES = [
  "Write 5 bullets for the YouTube script",
  "Read 20 minutes on 3 days",
  "Do 2 strength sessions",
  "Upgrade Nest.js 24 as soon as po",
  "Follow up on Settings",
  "Read for 20 minutes daily",
  "Set aside time each day to read",
  "Hola Miquel, tu opinión es muy importante para nosotros."
];

test("A. explicit out-of-range visible indices block all mutation", async () => {
  const server = buildServer();
  const userId = `action-index-a-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNumberedActions(userId, EIGHT_TITLES);

    const list = await listActions(server, userId);
    assert.match(list.reply, /you have 8 open actions:/i);
    const sessionBefore = await getAgentSession(userId, "telegram");
    const visibleBefore = sessionBefore?.visibleEntities as Array<{ index: number; id: string }>;
    assert.equal(visibleBefore.length, 8);

    // Simulates the exact reported bug: the planner emitted two separate action.complete calls
    // (not one action.hygiene_apply call) for a message naming two numbers, each with SOME
    // actionId of its own guessing.
    const rows = await prisma.actionItem.findMany({ where: { userId } });
    mockPlan({
      topic: "actions",
      intent: "complete",
      operations: [op("action.complete", { actionId: rows[0]!.id }), op("action.complete", { actionId: rows[1]!.id })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "complete action 10 and 9 now");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /8 actions/i);
    assert.match(reply.reply, /1.{1,3}8/, "must name the real valid range 1-8");
    assert.equal(reply.needsConfirmation, false, "an out-of-range block has nothing pending to confirm/cancel");

    const rowsAfter = await prisma.actionItem.findMany({ where: { userId } });
    assert.ok(rowsAfter.every((row) => row.status === "open"), "no action may be completed");

    const sessionAfter = await getAgentSession(userId, "telegram");
    const visibleAfter = sessionAfter?.visibleEntities as Array<{ index: number; id: string }>;
    assert.deepEqual(visibleAfter, visibleBefore, "visibleEntities must remain intact after a blocked out-of-range command");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. mixed valid + invalid indices block the whole set, including the valid one", async () => {
  const server = buildServer();
  const userId = `action-index-b-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNumberedActions(userId, EIGHT_TITLES);

    await listActions(server, userId);
    const session = await getAgentSession(userId, "telegram");
    const visible = session?.visibleEntities as Array<{ index: number; id: string; label: string }>;
    const idAtTwo = visible.find((e) => e.index === 2)!.id;

    mockPlan({
      topic: "actions",
      intent: "complete",
      operations: [op("action.complete", { actionId: idAtTwo }), op("action.complete", { actionId: visible[0]!.id })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "complete action 2 and 10");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /10/);
    assert.match(reply.reply, /shown list|1.{1,3}8/i);

    const rowTwo = await prisma.actionItem.findUnique({ where: { id: idAtTwo } });
    assert.equal(rowTwo?.status, "open", "the valid ref (2) must never be partially completed when another ref in the same command is invalid");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. explicit valid indices still work, resolved against the shown list, not DB order", async () => {
  const server = buildServer();
  const userId = `action-index-c-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNumberedActions(userId, EIGHT_TITLES);

    await listActions(server, userId);
    const session = await getAgentSession(userId, "telegram");
    const visible = session?.visibleEntities as Array<{ index: number; id: string; label: string }>;
    const idAtTwo = visible.find((e) => e.index === 2)!.id;
    const idAtThree = visible.find((e) => e.index === 3)!.id;

    // Deliberately supplies the WRONG actionIds — the fix must ignore these entirely once
    // explicit numbers are present and resolve strictly against the visible index instead.
    mockPlan({
      topic: "actions",
      intent: "complete",
      operations: [op("action.complete", { actionId: visible[7]!.id }), op("action.complete", { actionId: visible[6]!.id })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "complete action 2 and 3");

    assert.equal(reply.debug.mutationExecuted, true);
    assert.match(reply.reply, new RegExp(visible.find((e) => e.index === 2)!.label.slice(0, 15).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));

    const rowTwo = await prisma.actionItem.findUnique({ where: { id: idAtTwo } });
    const rowThree = await prisma.actionItem.findUnique({ where: { id: idAtThree } });
    assert.equal(rowTwo?.status, "completed");
    assert.equal(rowThree?.status, "completed");

    const untouched = visible.filter((e) => e.index !== 2 && e.index !== 3);
    for (const entity of untouched) {
      const row = await prisma.actionItem.findUnique({ where: { id: entity.id } });
      assert.equal(row?.status, "open", `visible index ${entity.index} must remain untouched`);
    }
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. after a blocked invalid-index command, cancel must not claim it prevented a mutation", async () => {
  const server = buildServer();
  const userId = `action-index-d-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNumberedActions(userId, EIGHT_TITLES);

    await listActions(server, userId);
    const rows = await prisma.actionItem.findMany({ where: { userId } });
    mockPlan({
      topic: "actions",
      intent: "complete",
      operations: [op("action.complete", { actionId: rows[0]!.id }), op("action.complete", { actionId: rows[1]!.id })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const blockedReply = await sendAgentMessage(server, userId, "complete action 10 and 9 now");
    assert.equal(blockedReply.debug.mutationExecuted, false);
    assert.equal(blockedReply.needsConfirmation, false, "an atomic block never opens a pending confirmation to cancel");

    const cancelReply = await sendAgentMessage(server, userId, "cancel");
    assert.doesNotMatch(cancelReply.reply, /i won't complete anything/i, "must never claim to have prevented a mutation that was never pending");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. an explicit numbered command supersedes a pending clarification and is still validated on its own merits", async () => {
  const server = buildServer();
  const userId = `action-index-e-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNumberedActions(userId, EIGHT_TITLES);

    await listActions(server, userId);
    const rows = await prisma.actionItem.findMany({ where: { userId } });

    // "complete brainstorm meeting" names nothing real and nothing visible — opens some kind of
    // pending clarification (exact shape doesn't matter for this test).
    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: rows[0]!.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const pendingReply = await sendAgentMessage(server, userId, "complete brainstorm meeting");
    assert.equal(pendingReply.debug.mutationExecuted, false);

    mockPlan({
      topic: "actions",
      intent: "complete",
      operations: [op("action.complete", { actionId: rows[2]!.id }), op("action.complete", { actionId: rows[3]!.id })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const numberedReply = await sendAgentMessage(server, userId, "complete action 10 and 9 now");

    assert.equal(numberedReply.debug.mutationExecuted, false, "10/9 are invalid against an 8-item list");
    assert.match(numberedReply.reply, /8 actions/i);
    assert.doesNotMatch(numberedReply.reply, /still have a pending confirmation/i, "an explicit numbered command must supersede the stale suggestion, not be blocked behind it");

    // No stale pending suggestion remains — a later bare "yes" has nothing real to confirm.
    const yesReply = await sendAgentMessage(server, userId, "yes");
    assert.equal(yesReply.debug.mutationExecuted, false);
    assert.match(yesReply.reply, /nothing pending|don't have anything pending/i);

    const rowsAfter = await prisma.actionItem.findMany({ where: { userId } });
    assert.ok(rowsAfter.every((row) => row.status === "open"));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F. with 12 actions seeded and only the first 10 shown, 9/10 resolve to the displayed page, never DB order", async () => {
  const server = buildServer();
  const userId = `action-index-f-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNumberedActions(userId, [
      "Upgrade to Node.js 24",
      "Apply to 3 developer jobs",
      "Renew passport",
      "Follow up with recruiter",
      "Plan next quarter roadmap",
      "Buy birthday gift",
      "Book dentist appointment",
      "Draft weekly status update",
      "Set aside time each day to read",
      "Hola Miquel, tu opinión es muy importante para nosotros.",
      "Branding direction meeting",
      "Extra task"
    ]);

    const list = await listActions(server, userId);
    assert.match(list.reply, /showing 10 of 12 open actions:/i);
    assert.match(list.reply, /9\. set aside time each day to read/i);
    assert.match(list.reply, /10\. .*hola miquel/i);

    const session = await getAgentSession(userId, "telegram");
    const visible = session?.visibleEntities as Array<{ index: number; id: string }>;
    const idAtNine = visible.find((e) => e.index === 9)!.id;
    const idAtTen = visible.find((e) => e.index === 10)!.id;

    mockPlan({
      topic: "actions",
      intent: "complete",
      operations: [op("action.complete", { actionId: idAtTen }), op("action.complete", { actionId: idAtNine })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "complete action 10 and 9");

    assert.equal(reply.debug.mutationExecuted, true);
    const rowNine = await prisma.actionItem.findUnique({ where: { id: idAtNine } });
    const rowTen = await prisma.actionItem.findUnique({ where: { id: idAtTen } });
    assert.equal(rowNine?.status, "completed");
    assert.equal(rowTen?.status, "completed");

    const apply = await prisma.actionItem.findFirstOrThrow({ where: { userId, title: "Apply to 3 developer jobs" } });
    const upgrade = await prisma.actionItem.findFirstOrThrow({ where: { userId, title: "Upgrade to Node.js 24" } });
    assert.equal(apply.status, "open");
    assert.equal(upgrade.status, "open");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
