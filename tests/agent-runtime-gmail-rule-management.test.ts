import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { buildServer, clearAgentRuntimeMocks, getAgentSession, mockPlan, op, prisma, sendAgentMessage, seedUser, type MockPlan } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Agent Runtime v3 Gmail rule management flow — migrating rule pause/resume/removal from the
 * legacy /messages/process brain (apps/api/src/legacy/gmail-conversation.ts's
 * manageCustomGmailRuleForConversation) into v3's own typed
 * gmail.rule.propose_update/gmail.rule.apply_update tools
 * (apps/api/src/agent-runtime/tool-catalog.ts). Target-name resolution
 * (apps/api/src/conversation/email-rule-selection.ts) and rule listing
 * (apps/api/src/gmail/gmail-rule-service.ts) were already non-legacy and are reused as-is;
 * apps/api/src/gmail/gmail-rule-management.ts is new, non-legacy, small — supported-operation
 * plain-language description and already-in-state checks only. Scope is deliberately narrow:
 * pause/resume/remove only. No Gmail API writes, no OAuth/sync code touched, no review/auto-log
 * toggling for an existing rule (not existing domain behavior — fixed at creation time only).
 */

async function seedGmailUser(userId: string): Promise<string> {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
  return connection.id;
}

async function seedCustomRule(
  userId: string,
  connectionId: string,
  name: string,
  status: "active" | "paused" | "archived" = "active"
) {
  return prisma.emailSignalRule.create({
    data: { userId, connectionId, adapterId: "custom_email_review", name, status, createdBy: "user" }
  });
}

function gmailRuleListPlan(): MockPlan {
  return { topic: "gmail_rules", intent: "list_active_rules", operations: [op("gmail.rule.list")], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

function gmailRuleProposeUpdatePlan(ref: string, operation: "pause" | "resume" | "archive"): MockPlan {
  return {
    topic: "gmail_rule_management",
    intent: "propose_gmail_rule_update",
    operations: [op("gmail.rule.propose_update", { ref, operation })],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft: ""
  };
}

test("agent/message: 'what email rules are active?' lists actual rules and stores visible rule entities with indexes", async () => {
  const server = buildServer();
  const userId = `gmail-rules-list-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    await seedCustomRule(userId, connectionId, "Endesa bills");
    await seedCustomRule(userId, connectionId, "Naturgy invoices");

    mockPlan(gmailRuleListPlan());
    const reply = await sendAgentMessage(server, userId, "what email rules are active?");

    assert.match(reply.reply, /endesa bills/i);
    assert.match(reply.reply, /naturgy invoices/i);
    assert.equal(reply.debug.mutationExecuted, false);

    const row = await getAgentSession(userId);
    const entities = (row?.visibleEntities as Array<{ type: string; label: string; index?: number }> | null) ?? [];
    assert.ok(entities.length >= 2);
    assert.ok(entities.every((entity) => entity.type === "gmail_rule"));
    assert.ok(entities.every((entity) => typeof entity.index === "number" && entity.index > 0));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'turn off Endesa' proposes pausing the Endesa rule and mutates nothing before 'yes'", async () => {
  const server = buildServer();
  const userId = `gmail-rules-propose-pause-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const endesa = await seedCustomRule(userId, connectionId, "Endesa bills");
    await seedCustomRule(userId, connectionId, "Naturgy invoices");

    mockPlan(gmailRuleProposeUpdatePlan("Endesa", "pause"));
    const reply = await sendAgentMessage(server, userId, "turn off Endesa");

    assert.match(reply.reply, /about to pause endesa bills/i);
    assert.match(reply.reply, /reply yes to confirm or cancel/i);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.ok(reply.debug.pendingOperation, "a pending Gmail rule change must be open");

    const unchanged = await prisma.emailSignalRule.findUnique({ where: { id: endesa.id } });
    assert.equal(unchanged?.status, "active", "must not mutate before confirmation");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'yes' applies the pending Gmail rule pause", async () => {
  const server = buildServer();
  const userId = `gmail-rules-apply-pause-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const endesa = await seedCustomRule(userId, connectionId, "Endesa bills");

    mockPlan(gmailRuleProposeUpdatePlan("Endesa", "pause"));
    await sendAgentMessage(server, userId, "turn off Endesa");

    // No mockPlan: exact "yes" is handled deterministically before the planner runs.
    const reply = await sendAgentMessage(server, userId, "yes");

    assert.equal(reply.debug.mutationExecuted, true);
    assert.match(reply.reply, /done — endesa bills is now paused/i);
    assert.equal(reply.debug.pendingOperation, false, "the pending change clears once applied");

    const updated = await prisma.emailSignalRule.findUnique({ where: { id: endesa.id } });
    assert.equal(updated?.status, "paused");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'cancel' clears the pending Gmail rule change and mutates nothing", async () => {
  const server = buildServer();
  const userId = `gmail-rules-cancel-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const endesa = await seedCustomRule(userId, connectionId, "Endesa bills");

    mockPlan(gmailRuleProposeUpdatePlan("Endesa", "pause"));
    await sendAgentMessage(server, userId, "turn off Endesa");

    const cancelReply = await sendAgentMessage(server, userId, "cancel");
    assert.equal(cancelReply.debug.plannerUsed, "none");
    assert.equal(cancelReply.debug.mutationExecuted, false);
    assert.equal(cancelReply.debug.pendingOperation, false);

    const unchanged = await prisma.emailSignalRule.findUnique({ where: { id: endesa.id } });
    assert.equal(unchanged?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'delete Naturgy' proposes removing only the Naturgy rule, and 'yes' archives just that one", async () => {
  const server = buildServer();
  const userId = `gmail-rules-delete-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const endesa = await seedCustomRule(userId, connectionId, "Endesa bills");
    const naturgy = await seedCustomRule(userId, connectionId, "Naturgy invoices");

    mockPlan(gmailRuleProposeUpdatePlan("Naturgy", "archive"));
    const proposeReply = await sendAgentMessage(server, userId, "delete Naturgy");
    assert.match(proposeReply.reply, /about to remove naturgy invoices/i);
    assert.equal(proposeReply.debug.mutationExecuted, false);

    const applyReply = await sendAgentMessage(server, userId, "yes");
    assert.equal(applyReply.debug.mutationExecuted, true);
    assert.match(applyReply.reply, /done — naturgy invoices is now removed/i);

    const naturgyAfter = await prisma.emailSignalRule.findUnique({ where: { id: naturgy.id } });
    const endesaAfter = await prisma.emailSignalRule.findUnique({ where: { id: endesa.id } });
    assert.equal(naturgyAfter?.status, "archived");
    assert.equal(endesaAfter?.status, "active", "only the targeted rule may change");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: an ambiguous rule reference asks for clarification and mutates nothing", async () => {
  const server = buildServer();
  const userId = `gmail-rules-ambiguous-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const endesaBills = await seedCustomRule(userId, connectionId, "Endesa bills");
    const endesaOld = await seedCustomRule(userId, connectionId, "Endesa invoices old");

    mockPlan(gmailRuleProposeUpdatePlan("Endesa", "pause"));
    const reply = await sendAgentMessage(server, userId, "turn off Endesa");

    assert.match(reply.reply, /found more than one matching rule/i);
    assert.match(reply.reply, /endesa bills/i);
    assert.match(reply.reply, /endesa invoices old/i);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(reply.debug.pendingOperation, false, "ambiguous match must not open a pending change");

    const first = await prisma.emailSignalRule.findUnique({ where: { id: endesaBills.id } });
    const second = await prisma.emailSignalRule.findUnique({ where: { id: endesaOld.id } });
    assert.equal(first?.status, "active");
    assert.equal(second?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: an unknown rule reference asks for clarification and mutates nothing", async () => {
  const server = buildServer();
  const userId = `gmail-rules-unknown-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    await seedCustomRule(userId, connectionId, "Endesa bills");

    mockPlan(gmailRuleProposeUpdatePlan("car insurance", "pause"));
    const reply = await sendAgentMessage(server, userId, "turn off car insurance emails");

    assert.match(reply.reply, /couldn't find an active gmail rule matching "car insurance"/i);
    assert.match(reply.reply, /nothing was changed/i);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(reply.debug.pendingOperation, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'yes' with no pending Gmail rule change gives the fixed no-pending reply", async () => {
  const server = buildServer();
  const userId = `gmail-rules-yes-no-pending-${randomUUID()}`;

  try {
    await seedUser(userId);

    const reply = await sendAgentMessage(server, userId, "yes");
    assert.equal(reply.reply, "I don't have anything pending to confirm.");
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: a rule can be resolved and paused without listing rules first", async () => {
  const server = buildServer();
  const userId = `gmail-rules-direct-lookup-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const naturgy = await seedCustomRule(userId, connectionId, "Naturgy invoices");

    // No prior "what email rules are active?" turn — this must still resolve via a fresh DB
    // lookup, not depend on session.visibleEntities from an earlier list.
    mockPlan(gmailRuleProposeUpdatePlan("Naturgy", "pause"));
    const reply = await sendAgentMessage(server, userId, "pause the Naturgy rule");
    assert.match(reply.reply, /about to pause naturgy invoices/i);

    await sendAgentMessage(server, userId, "yes");
    const updated = await prisma.emailSignalRule.findUnique({ where: { id: naturgy.id } });
    assert.equal(updated?.status, "paused");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: resuming a paused rule works, and pausing/resuming an already-matching rule is a truthful no-op", async () => {
  const server = buildServer();
  const userId = `gmail-rules-resume-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const endesa = await seedCustomRule(userId, connectionId, "Endesa bills", "paused");

    mockPlan(gmailRuleProposeUpdatePlan("Endesa", "resume"));
    const proposeReply = await sendAgentMessage(server, userId, "resume Endesa");
    assert.match(proposeReply.reply, /about to resume endesa bills/i);

    await sendAgentMessage(server, userId, "yes");
    const resumed = await prisma.emailSignalRule.findUnique({ where: { id: endesa.id } });
    assert.equal(resumed?.status, "active");

    // Already active — must not claim it will change anything.
    mockPlan(gmailRuleProposeUpdatePlan("Endesa", "resume"));
    const alreadyReply = await sendAgentMessage(server, userId, "resume Endesa");
    assert.match(alreadyReply.reply, /already active/i);
    assert.equal(alreadyReply.debug.mutationExecuted, false);
    assert.equal(alreadyReply.debug.pendingOperation, false, "nothing to confirm when already in the target state");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: gmail.rule.apply_update can never be planned by the LLM directly, only reached via the confirm whitelist", async () => {
  const server = buildServer();
  const userId = `gmail-rules-no-direct-apply-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const endesa = await seedCustomRule(userId, connectionId, "Endesa bills");

    mockPlan(gmailRuleProposeUpdatePlan("Endesa", "pause"));
    await sendAgentMessage(server, userId, "turn off Endesa");

    mockPlan({
      topic: "gmail_rule_management",
      intent: "apply_gmail_rule_update",
      operations: [op("gmail.rule.apply_update", { ruleId: endesa.id, ruleName: endesa.name, operation: "pause" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "please just do it now");

    assert.equal(reply.debug.toolValidationPassed, false, "a direct gmail.rule.apply_update plan must be rejected");
    assert.equal(reply.debug.mutationExecuted, false);

    const unchanged = await prisma.emailSignalRule.findUnique({ where: { id: endesa.id } });
    assert.equal(unchanged?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
