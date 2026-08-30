import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createGoal, createMemory, prisma, snoozeActionItem, updateNotificationSettings } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-live-action-and-coaching-regressions (Task 8): the exact live private-alpha
 * transcript, replayed end to end in one continuous conversation, with all five numbered
 * regressions' fixes exercised together — not in isolation, the way the per-task test files above
 * cover them. Mirrors the real dated (29/08-30/08) Telegram session:
 *   1. a stale morning-brief resume suggestion contradicting an already-stated durable fact,
 *   2. "do I already have an action to send CVs?" checked only today's actions,
 *   3. "show me all actions" silently narrowed to today,
 *   4. "yes do so and show me my actions" created a duplicate action,
 *   5. a vague weekend update got silently rescheduled, and the follow-up "is it okay?" got a
 *      mechanical mutation reply instead of a coaching answer.
 * The seeded action is titled "Send CVs" (not the transcript's literal "Send 3 CVs") — the same,
 * deliberate, already-documented adjustment tests/action-reschedule-search-scope.test.ts makes:
 * the shared substring-matching candidate resolver used by action.reschedule's ref lookup can't
 * match "send CVs" against a title containing an embedded "3 ", a separate, pre-existing, narrow
 * limitation outside this fix's scope — the number itself was never load-bearing to any of the
 * five reported regressions.
 */

const MORNING_UTC = "2026-08-29T07:00:00.000Z";

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  return fn().finally(() => {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

test("exact live transcript replay: morning brief, action-scope queries, confirm+list, and weekend coaching all behave correctly in one conversation", async () => {
  await withEnv(
    {
      PROACTIVE_BRIEF_LLM_ENABLED: "true",
      OPENAI_API_KEY: "test-key",
      PROACTIVE_BRIEF_LLM_MOCK_RESPONSE: JSON.stringify({ message: "Good morning! Today could be a great day to update your resume before applying." })
    },
    async () => {
      const userId = `live-replay-${randomUUID()}`;
      const server = buildServer();
      try {
        await seedUser(userId);
        const goalResult = await createGoal(userId, { title: "Find a fully remote developer job, ideally in Web3", category: "career" });
        if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
        await createMemory(userId, {
          type: "goal_context",
          summary: "User's resume and web CV are already up to date — do not suggest updating/customizing them.",
          source: "explicit_user_request",
          confidence: 1
        });
        await updateNotificationSettings(userId, { morningBriefEnabled: true, dailyLoopEnabled: true });

        // --- 1. Morning brief must not contradict the already-stated durable fact -----------------
        const briefResponse = await server.inject({ method: "GET", url: `/users/${userId}/operator/proactive/preview?now=${encodeURIComponent(MORNING_UTC)}` });
        const briefBody = briefResponse.json();
        assert.equal(briefBody.personalization.source, "fallback_invalid", "a stale resume-update suggestion must be rejected, not delivered");
        assert.doesNotMatch(briefBody.decision.message, /update.{0,20}resume/i);

        // Seed the deferred action the rest of the conversation revolves around — snoozed a few
        // days out, exactly like something the user set aside earlier and forgot about.
        const action = await createActionItem(userId, { source: "manual", title: "Send CVs", priority: "high" });
        await snoozeActionItem(userId, action.id, new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));
        const overdue = await createActionItem(userId, {
          source: "manual",
          title: "Follow up with recruiter",
          priority: "medium",
          dueAt: new Date(Date.now() - 24 * 60 * 60 * 1000)
        });

        // --- 2. "Do i have an action already to send CVs? Move it to today if so" -----------------
        mockPlan({ topic: "actions", intent: "reschedule", operations: [op("action.reschedule", { ref: "send CVs", dueText: "today" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
        const findReply = await sendAgentMessage(server, userId, "Do i have an action already to send CVs? Move it to today if so");
        assert.match(findReply.reply, /send cvs|today/i, `expected the deferred action to be found and moved — got: ${findReply.reply}`);
        assert.doesNotMatch(findReply.reply, /don't have any actions scheduled for today/i);
        const movedAction = await prisma.actionItem.findUnique({ where: { id: action.id } });
        assert.equal(movedAction?.status, "open", "pulling a deferred action back to today re-opens it");

        // --- 3. "And showme all actions" must never narrow to today only --------------------------
        mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { when: "today" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
        const allReply = await sendAgentMessage(server, userId, "And showme all actions");
        assert.match(allReply.reply, /send cvs/i, `expected the just-moved action to be listed — got: ${allReply.reply}`);
        assert.match(allReply.reply, /follow up with recruiter/i, `expected the overdue action to be listed too — got: ${allReply.reply}`);
        assert.doesNotMatch(allReply.reply, /don't have any actions scheduled for today/i);

        // --- 4. "schedule sending 3 CVs today" then "Yes do so and show me my actions" must never
        // create a duplicate — the deferred/reopened action from step 2 already covers this title,
        // so the create must recognize it as the same task rather than a fresh one.
        mockPlan({
          topic: "actions",
          intent: "create",
          operations: [op("action.create", { title: "Send CVs", dueText: "today" })],
          needsClarification: false,
          clarificationQuestion: null,
          replyDraft: 'Want me to add "Send CVs" for today? Reply yes to confirm.'
        });
        await sendAgentMessage(server, userId, "schedule sending CVs today");

        mockPlan({
          topic: "actions",
          intent: "create",
          operations: [op("action.create", { title: "Send CVs", dueText: "today" }), op("action.list", {})],
          needsClarification: false,
          clarificationQuestion: null,
          replyDraft: "Done — here are your actions:"
        });
        const confirmReply = await sendAgentMessage(server, userId, "Yes do so and show me my actions so i can verify");
        assert.match(confirmReply.reply, /send cvs/i);

        const allSendCvsActions = await prisma.actionItem.findMany({ where: { userId, title: "Send CVs" } });
        assert.equal(allSendCvsActions.length, 1, "must never end up with two 'Send CVs' actions after a confirm+list turn");

        // --- 5. A vague weekend update must never silently reschedule anything --------------------
        const beforeWeekendUpdate = await prisma.actionItem.findUnique({ where: { id: action.id } });
        mockPlan({
          topic: "actions",
          intent: "reschedule",
          operations: [op("action.reschedule", { actionId: action.id, dueText: "tomorrow" })],
          needsClarification: false,
          clarificationQuestion: null,
          replyDraft: "Moved it to tomorrow 09:00."
        });
        const weekendReply = await sendAgentMessage(
          server,
          userId,
          "Hey Ive been this weekend doing some mindfulnes w friends, today I will go back to Barcelona and will lock in will try to send some when I get there this night and also lot this week"
        );
        assert.equal(weekendReply.debug.mutationExecuted, false, "a vague, mixed-timing update must never silently mutate the schedule");
        const afterWeekendUpdate = await prisma.actionItem.findUnique({ where: { id: action.id } });
        assert.equal(afterWeekendUpdate?.dueAt?.getTime(), beforeWeekendUpdate?.dueAt?.getTime(), "the due date must stay exactly what it was");

        // --- 6. "Is it okay? About the weekend thing" must answer as a coach, not mechanically -----
        mockPlan({
          topic: "actions",
          intent: "reschedule",
          operations: [op("action.reschedule", { actionId: action.id, dueText: "tomorrow" })],
          needsClarification: false,
          clarificationQuestion: null,
          replyDraft: "A mindful weekend with friends is real rest, not avoidance — good call. Want to plan tonight's send instead?"
        });
        const coachingReply = await sendAgentMessage(server, userId, "Is it okay? About the weekend thing");
        assert.doesNotMatch(coachingReply.reply, /action rescheduled|due:/i, "must never fall back to a mechanical mutation-confirmation line");
        assert.equal(coachingReply.debug.mutationExecuted, false, "a judgment question must never itself mutate anything");
        assert.match(coachingReply.reply, /rest|mindful|real|good call/i, `expected the real coaching answer — got: ${coachingReply.reply}`);
      } finally {
        clearAgentRuntimeMocks();
        await server.close();
        await prisma.user.deleteMany({ where: { id: userId } });
      }
    }
  );
});
