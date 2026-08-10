import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../packages/db/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";

test("conversation-first onboarding smoke routes through /messages/process safely", async () => {
  const server = buildServer();
  const userId = `api-smoke-${randomUUID()}`;

  const send = async (message: string) => {
    const response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message }
    });
    assert.equal(response.statusCode, 200, message);
    const body = response.json();
    const reply = String(body.reply ?? body.message ?? "");
    assert.ok(reply.length > 0, message);
    assert.doesNotMatch(reply, /accessToken|refreshToken|OPENAI_API_KEY|TELEGRAM_BOT_TOKEN|client_secret|raw provider/i);
    return reply;
  };

  const counts = async () => ({
    actions: await prisma.actionItem.count({ where: { userId } }),
    events: await prisma.event.count({ where: { userId } }),
    memories: await prisma.memoryEntry.count({ where: { userId } }),
    pending: await prisma.pendingAction.count({ where: { userId, status: "pending" } }),
    emailRules: await prisma.emailSignalRule.count({ where: { userId } }),
    integrations: await prisma.integrationConnection.count({ where: { userId } }),
    settings: await prisma.notificationSettings.findUnique({ where: { userId } })
  });

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await prisma.notificationSettings.create({ data: { userId, timezone: "Europe/Madrid" } });
    const jobGoal = await prisma.goal.create({
      data: {
        userId,
        title: "Find a new developer job",
        category: "career",
        templateId: "career.job_search",
        priority: "critical",
        importanceScore: 70
      }
    });
    const youtubeGoal = await prisma.goal.create({
      data: {
        userId,
        title: "Build a YouTube channel",
        category: "creative",
        priority: "medium",
        importanceScore: 25
      }
    });
    await prisma.goal.create({
      data: {
        userId,
        title: "Control impulsive betting",
        category: "finance",
        templateId: "finance.control_betting",
        priority: "critical",
        importanceScore: 70
      }
    });
    await prisma.actionItem.createMany({
      data: [
        {
          userId,
          source: "manual",
          title: "Apply to 2 jobs",
          status: "open",
          priority: "medium",
          dueAt: new Date("2026-08-10T07:00:00.000Z"),
          goalId: jobGoal.id,
          goalTitleSnapshot: jobGoal.title,
          evidence: "apply to 2 jobs"
        },
        {
          userId,
          source: "manual",
          title: "Write YouTube script",
          status: "open",
          priority: "medium",
          dueAt: new Date("2026-08-10T14:30:00.000Z"),
          goalId: youtubeGoal.id,
          goalTitleSnapshot: youtubeGoal.title,
          evidence: "write youtube script"
        }
      ]
    });
    await prisma.event.create({
      data: {
        userId,
        type: "career.application_sent",
        timestamp: new Date("2026-08-10T08:00:00.000Z"),
        source: "manual",
        data: { count: 1 },
        confidence: 1,
        evidence: { text: "sent 1 CV" }
      }
    });

    const before = await counts();

    assert.match(await send("what can you do"), /I can help with|Daily planning|Goals|Guardrails/i);
    assert.match(await send("help me set up"), /Alecto setup|Goals: 3 active|Actions: 2 open/i);
    assert.match(await send("how do I start"), /Quickstart:|what should I do today/i);
    assert.match(await send("set up goals"), /Goal setup:|Tell me one outcome/i);
    assert.match(await send("set up daily loop"), /Daily loop setup:|morning brief/i);

    const afterReadOnly = await counts();
    assert.equal(afterReadOnly.actions, before.actions);
    assert.equal(afterReadOnly.events, before.events);
    assert.equal(afterReadOnly.memories, before.memories);
    assert.equal(afterReadOnly.emailRules, before.emailRules);
    assert.equal(afterReadOnly.integrations, before.integrations);

    assert.match(await send("turn on morning brief at 9"), /Morning brief: 09:00/i);
    const afterSettings = await counts();
    assert.equal(afterSettings.settings?.dailyLoopEnabled, true);
    assert.equal(afterSettings.settings?.morningTimeMinutes, 540);

    assert.match(await send("connect Gmail"), /Gmail is readonly|connect_gmail|enable_email_rule/i);
    assert.match(await send("connect GitHub"), /public GitHub|author=LOGIN|connect_github/i);
    const afterIntegrationsGuidance = await counts();
    assert.equal(afterIntegrationsGuidance.emailRules, 0);
    assert.equal(afterIntegrationsGuidance.integrations, 0);

    assert.match(await send("what should I do today"), /Today -|Top priorities|Next move/i);

    const planReply = await send("plan next week");
    assert.match(planReply, /Next week plan|Suggested actions|create/i);
    const afterPlan = await counts();
    assert.equal(afterPlan.actions, before.actions);
    assert.equal(afterPlan.pending, 1);

    const riskReply = await send("I want to bet 500 because it is safe");
    assert.match(riskReply, /RED|cooldown|No betting|blocked|guardrail/i);
    assert.doesNotMatch(riskReply, /Reply yes to save it to memory/i);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
