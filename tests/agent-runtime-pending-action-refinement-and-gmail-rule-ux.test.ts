import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, getAgentSession, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Deterministic coverage for fix/private-alpha-pending-action-refinement-and-gmail-rule-ux — a
 * real Telegram transcript found a pending action.create proposal completely ignored: "change it
 * to send 5 CVs its more direct and i wanna connect my mail so u can use it for updates" only
 * ever got a Gmail-connection reply, because gmailConnectionShortcutOperation ran unconditionally
 * and hijacked the whole turn before the planner (the only place that could otherwise understand
 * "change it to X") ever got a chance to run. Separately, "do u use my mail now for my goal?" got
 * a generic "no rules active, say enable job search rule" answer even though the active goal was
 * clearly job-search-shaped — buildGmailAutonomyState already computed the matching
 * recommendation, it just was never surfaced in the V3 chat reply.
 */

async function seedPendingActionCreate(server: ReturnType<typeof buildServer>, userId: string, title: string): Promise<void> {
  const goalResult = await createGoal(userId, { title: "Find a fully remote developer job, ideally in Web3", category: "career", priority: "medium" });
  if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
  mockPlan({
    topic: "goals",
    intent: "next_action",
    operations: [op("goal.recommend_next_action", { recommendation: "Let's keep momentum.", proposedAction: title })],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft: ""
  });
  const reply = await sendAgentMessage(server, userId, "what should I do today?");
  assert.equal(reply.debug.pendingOperation, true, "test setup: a pending action.create proposal must actually open");
  clearAgentRuntimeMocks();
}

async function seedConnectedGmail(userId: string): Promise<void> {
  await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
}

async function enableJobSearchRule(server: ReturnType<typeof buildServer>, userId: string): Promise<void> {
  const reply = await sendAgentMessage(server, userId, "enable job search rule for Gmail");
  assert.match(reply.reply, /job.search/i, "test setup: the job-search rule must actually turn on");
}

// --- Task 2: pending action refinement wins, no Gmail mentioned ------------------------------------

test("2A: pending action + 'change it to send 5 CVs' updates the pending title", async () => {
  const server = buildServer();
  const userId = `refine-2a-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedPendingActionCreate(server, userId, "Research 5 new remote Web3 job postings today");

    const reply = await sendAgentMessage(server, userId, "change it to send 5 CVs");

    assert.match(reply.reply, /send 5 cvs/i);
    assert.match(reply.reply, /reply yes to create it or cancel/i);
    assert.equal(reply.debug.pendingOperation, true, "the refined action must still be pending");
    assert.equal(reply.debug.mutationExecuted, false, "refining is not itself a mutation");

    const session = await getAgentSession(userId);
    const pending = session?.pendingOperation as { operations: Array<{ args: { title: string } }> };
    assert.match(pending.operations[0]!.args.title, /send 5 cvs/i);
    assert.doesNotMatch(pending.operations[0]!.args.title, /research 5 new remote web3/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2B: next 'yes' creates the REFINED action, not the original", async () => {
  const server = buildServer();
  const userId = `refine-2b-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedPendingActionCreate(server, userId, "Research 5 new remote Web3 job postings today");
    await sendAgentMessage(server, userId, "change it to send 5 CVs");

    const reply = await sendAgentMessage(server, userId, "yes");

    assert.equal(reply.debug.mutationExecuted, true);
    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(actions.length, 1, "exactly one action must be created, never both");
    assert.match(actions[0]!.title, /send 5 cvs/i);
    assert.doesNotMatch(actions[0]!.title, /research 5 new remote web3/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2C: next 'cancel' cancels the REFINED action — nothing is created", async () => {
  const server = buildServer();
  const userId = `refine-2c-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedPendingActionCreate(server, userId, "Research 5 new remote Web3 job postings today");
    await sendAgentMessage(server, userId, "change it to send 5 CVs");

    const reply = await sendAgentMessage(server, userId, "cancel");

    assert.equal(reply.debug.mutationExecuted, false);
    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(actions.length, 0, "no action of either title may be created after cancelling");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 3: mixed intent — refinement + Gmail/mail in the same message ---------------------------

test("3A: exact live transcript — refinement + Gmail-not-connected mention updates the action AND shows connect help", async () => {
  const server = buildServer();
  const userId = `refine-3a-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedPendingActionCreate(server, userId, "Research 5 new remote Web3 job postings today");

    const reply = await sendAgentMessage(
      server,
      userId,
      "change it to send 5 CVs its more direct and i wanna connect my mail so u can use it for updates"
    );

    assert.match(reply.reply, /send 5 cvs/i, "the refined action must be in the reply");
    assert.match(reply.reply, /reply yes to create it or cancel/i);
    assert.match(reply.reply, /gmail is not connected yet/i, "Gmail help must still be shown");
    assert.match(reply.reply, /readonly/i);
    assert.doesNotMatch(reply.reply, /cannot send emails or change labels its more direct/i, "the tail justification must not leak into the reply");
    assert.equal(reply.debug.pendingOperation, true);

    const session = await getAgentSession(userId);
    const pending = session?.pendingOperation as { operations: Array<{ args: { title: string } }> };
    assert.match(pending.operations[0]!.args.title, /send 5 cvs/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3B: next 'yes' after the mixed-intent turn creates the refined action", async () => {
  const server = buildServer();
  const userId = `refine-3b-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedPendingActionCreate(server, userId, "Research 5 new remote Web3 job postings today");
    await sendAgentMessage(server, userId, "change it to send 5 CVs and connect my mail");

    const reply = await sendAgentMessage(server, userId, "yes");

    assert.equal(reply.debug.mutationExecuted, true);
    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(actions.length, 1);
    assert.match(actions[0]!.title, /send 5 cvs/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3D: Gmail ALREADY connected — refinement still works, and status text reflects the real connection", async () => {
  const server = buildServer();
  const userId = `refine-3d-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedConnectedGmail(userId);
    await seedPendingActionCreate(server, userId, "Research 5 new remote Web3 job postings today");

    const reply = await sendAgentMessage(server, userId, "change it to send 5 CVs and connect my mail");

    assert.match(reply.reply, /send 5 cvs/i);
    assert.match(reply.reply, /gmail is connected/i);
    assert.doesNotMatch(reply.reply, /gmail is not connected yet/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3F: no duplicate action is ever created across the mixed-intent + confirm sequence", async () => {
  const server = buildServer();
  const userId = `refine-3f-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedPendingActionCreate(server, userId, "Research 5 new remote Web3 job postings today");
    await sendAgentMessage(server, userId, "change it to send 5 CVs and connect my mail");
    await sendAgentMessage(server, userId, "yes");

    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(actions.length, 1, "only the refined action may exist, never a second/duplicate one");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 4: no over-triggering ---------------------------------------------------------------------

test("4A: no pending action + 'connect my mail' behaves exactly as before", async () => {
  const server = buildServer();
  const userId = `refine-4a-${randomUUID()}`;
  try {
    await seedUser(userId);

    const reply = await sendAgentMessage(server, userId, "connect my mail");

    assert.match(reply.reply, /gmail is not connected yet/i);
    assert.equal(reply.debug.pendingOperation, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4B: pending action + Gmail-only (no refinement) keeps the pending action alive and reminds the user", async () => {
  const server = buildServer();
  const userId = `refine-4b-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedPendingActionCreate(server, userId, "Research 5 new remote Web3 job postings today");

    const reply = await sendAgentMessage(server, userId, "connect Gmail");

    assert.match(reply.reply, /gmail is not connected yet/i);
    assert.match(reply.reply, /still have the proposed action pending/i);
    assert.equal(reply.debug.pendingOperation, true);

    const session = await getAgentSession(userId);
    const pending = session?.pendingOperation as { operations: Array<{ args: { title: string } }> };
    assert.match(pending.operations[0]!.args.title, /research 5 new remote web3/i, "the ORIGINAL title must be untouched");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4D: 'yes' after a Gmail-only turn still confirms the untouched original pending action", async () => {
  const server = buildServer();
  const userId = `refine-4d-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedPendingActionCreate(server, userId, "Research 5 new remote Web3 job postings today");
    await sendAgentMessage(server, userId, "connect Gmail");

    const reply = await sendAgentMessage(server, userId, "yes");

    assert.equal(reply.debug.mutationExecuted, true);
    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(actions.length, 1);
    assert.match(actions[0]!.title, /research 5 new remote web3/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 3/4: "do u use my mail now for my goal?" + goal-specific rule proposal -------------------

test("goal-usage A: Gmail connected, no rules, job-search goal -> says not used yet and proposes the job-search rule", async () => {
  const server = buildServer();
  const userId = `refine-usage-a-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedConnectedGmail(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote developer job, ideally in Web3", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const reply = await sendAgentMessage(server, userId, "do u use my mail now for my goal?");

    assert.match(reply.reply, /^no —/i);
    assert.match(reply.reply, /not using it for this goal yet/i);
    assert.match(reply.reply, /job-search/i);
    assert.match(reply.reply, /want me to enable/i);
    assert.equal(reply.debug.pendingOperation, true, "the rule proposal must be a real, confirmable pending operation");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("goal-usage B: confirming the proposed rule actually enables it", async () => {
  const server = buildServer();
  const userId = `refine-usage-b-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedConnectedGmail(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote developer job, ideally in Web3", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await sendAgentMessage(server, userId, "do u use my mail now for my goal?");

    const reply = await sendAgentMessage(server, userId, "yes");

    assert.equal(reply.debug.mutationExecuted, true);
    const rules = await prisma.emailSignalRule.findMany({ where: { userId, status: "active" } });
    assert.ok(rules.some((rule) => rule.adapterId === "job_search_email"), "the job-search rule must actually be active now");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("goal-usage C: Gmail not connected -> gives the connect link, never claims usage", async () => {
  const server = buildServer();
  const userId = `refine-usage-c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote developer job, ideally in Web3", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const reply = await sendAgentMessage(server, userId, "do u use my mail now for my goal?");

    assert.match(reply.reply, /^no —/i);
    assert.match(reply.reply, /gmail is not connected yet/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("goal-usage D: Gmail connected AND the job-search rule already active -> says yes, mail is being used", async () => {
  const server = buildServer();
  const userId = `refine-usage-d-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedConnectedGmail(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote developer job, ideally in Web3", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await enableJobSearchRule(server, userId);

    const reply = await sendAgentMessage(server, userId, "do u use my mail now for my goal?");

    assert.match(reply.reply, /^yes —/i);
    assert.match(reply.reply, /job-search rule is active/i);
    assert.equal(reply.debug.pendingOperation, false, "nothing new to confirm — the rule is already on");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("goal-usage E: an unrelated goal never gets a job-search-specific proposal, just the honest not-in-use answer", async () => {
  const server = buildServer();
  const userId = `refine-usage-e-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedConnectedGmail(userId);
    const goalResult = await createGoal(userId, { title: "Read one book a month this year", category: "reading", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const reply = await sendAgentMessage(server, userId, "do u use my mail now for my goal?");

    assert.match(reply.reply, /^no —/i);
    assert.doesNotMatch(reply.reply, /job-search/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 4: goal-specific rule proposal also surfaces from a plain Gmail status check -------------

test("status-proposal A: a plain 'is gmail connected?' with a job-search goal and no rules proposes the job-search rule", async () => {
  const server = buildServer();
  const userId = `refine-status-a-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedConnectedGmail(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote developer job, ideally in Web3", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const reply = await sendAgentMessage(server, userId, "is gmail connected?");

    assert.match(reply.reply, /gmail is connected/i);
    assert.match(reply.reply, /want me to enable a readonly rule/i);
    assert.equal(reply.debug.pendingOperation, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("status-proposal B: with an existing active job-search rule, plain Gmail status never proposes a duplicate", async () => {
  const server = buildServer();
  const userId = `refine-status-b-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedConnectedGmail(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote developer job, ideally in Web3", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await enableJobSearchRule(server, userId);

    const reply = await sendAgentMessage(server, userId, "is gmail connected?");

    assert.doesNotMatch(reply.reply, /want me to enable a readonly rule/i);
    assert.equal(reply.debug.pendingOperation, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Readonly/cannot-send truth is always preserved -------------------------------------------------

test("truth: mixed-intent and goal-usage replies never claim Gmail can send/reply/change labels", async () => {
  const server = buildServer();
  const userId = `refine-truth-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedPendingActionCreate(server, userId, "Research 5 new remote Web3 job postings today");

    const reply = await sendAgentMessage(server, userId, "change it to send 5 CVs and connect my mail");

    assert.doesNotMatch(reply.reply, /alecto (can|will) send/i);
    assert.doesNotMatch(reply.reply, /i('ll| will) (send|reply to) (the |your )?email/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
