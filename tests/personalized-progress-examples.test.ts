import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDailyCheckinPrompt,
  progressExampleCategoryForGoal,
  progressExamplesForGoals,
  progressExamplesLineForGoal
} from "../packages/core/src/index.ts";
import { createGoal, prisma } from "../packages/db/src/index.ts";
import { buildServer } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-gmail-account-switch-and-personalized-examples (Part B): a real reported gap —
 * Alecto suggested the same generic "40 min gym, 2 CVs"-shaped example for ANY active goal,
 * regardless of relevance. progress-examples.ts (packages/core) now classifies a goal into one of
 * five deterministic buckets (job_search/fitness/life_meaning/finance_admin/travel) from its own
 * templateId/category/title — never inventing a metric the goal didn't declare — and both
 * reachable surfaces that used to hardcode "gym 45m and sent 2 CVs" (the daily check-in prompt in
 * reminders.ts, and the evening proactive nudge in apps/api/src/operator/proactive.ts) now draw
 * from it instead.
 */

const MORNING_UTC = "2026-08-20T07:00:00.000Z"; // 09:00 Europe/Madrid
const EVENING_UTC = "2026-08-20T17:00:00.000Z"; // 19:00 Europe/Madrid

async function seedUserWithNotificationSettings(userId: string) {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  await prisma.notificationSettings.create({
    data: { userId, dailyLoopEnabled: true, morningTimeMinutes: 540, eveningTimeMinutes: 1140, timezone: "Europe/Madrid" }
  });
}

async function seedGoal(userId: string, title: string, category: string, templateId?: string) {
  const result = await createGoal(userId, { title, category, templateId });
  if (result.duplicate) throw new Error("unexpected duplicate goal in test setup");
  return result.goal;
}

async function previewEvening(server: ReturnType<typeof buildServer>, userId: string) {
  const response = await server.inject({ method: "GET", url: `/users/${userId}/operator/proactive/preview?now=${encodeURIComponent(EVENING_UTC)}` });
  assert.equal(response.statusCode, 200);
  return response.json().decision as { decision: string; message?: string; suggestedReplies?: string[] };
}

void MORNING_UTC;

// --- Task 9: category-specific examples --------------------------------------------------------

test("9A. job-search goal classifies as job_search and gets job-search examples", async () => {
  const userId = `progress-ex-jobsearch-${randomUUID()}`;
  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const goal = await seedGoal(userId, "Find a fully remote developer job", "career", "career.job_search");
    assert.equal(progressExampleCategoryForGoal(goal), "job_search");
    const line = progressExamplesLineForGoal(goal);
    assert.match(line ?? "", /sent 2 CVs/);
    assert.match(line ?? "", /got 1 recruiter reply/);
    assert.match(line ?? "", /scheduled 1 interview/);
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("9B. fitness goal gets fitness examples, never job-search wording", async () => {
  const userId = `progress-ex-fitness-${randomUUID()}`;
  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const goal = await seedGoal(userId, "Train 3 times per week", "health", "health.strength_energy");
    assert.equal(progressExampleCategoryForGoal(goal), "fitness");
    const line = progressExamplesLineForGoal(goal) ?? "";
    assert.match(line, /45 min gym|8k steps|slept 7h/);
    assert.doesNotMatch(line, /CVs?|recruiter|interview/i);
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("9C. life-meaning/personal-development goal gets journaling/connection/mindfulness examples", async () => {
  const userId = `progress-ex-meaning-${randomUUID()}`;
  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const goal = await seedGoal(userId, "Journal and reflect more", "personal development", undefined);
    assert.equal(progressExampleCategoryForGoal(goal), "life_meaning");
    assert.equal(
      progressExamplesLineForGoal(goal),
      "Examples for your meaning goal: 'journaled 10 minutes', 'had one meaningful conversation', 'did one mindful activity'."
    );
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("9D. finance/admin goal gets bill/invoice/insurance examples, not gambling-risk wording", async () => {
  const userId = `progress-ex-finance-admin-${randomUUID()}`;
  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const goal = await seedGoal(userId, "Keep up with bills and admin", "finance", undefined);
    assert.equal(progressExampleCategoryForGoal(goal), "finance_admin");
    const line = progressExamplesLineForGoal(goal) ?? "";
    assert.match(line, /paid one bill|reviewed one invoice|called insurance/);
    assert.doesNotMatch(line, /gambling|betting/i);
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("9E. travel goal gets flight/hotel examples", async () => {
  const userId = `progress-ex-travel-${randomUUID()}`;
  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const goal = await seedGoal(userId, "Plan the Japan trip", "travel", undefined);
    assert.equal(progressExampleCategoryForGoal(goal), "travel");
    const line = progressExamplesLineForGoal(goal) ?? "";
    assert.match(line, /checked flight update|confirmed hotel booking/);
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("9F. no active goals falls back to the honest generic prompt, never a category example", async () => {
  assert.equal(progressExamplesForGoals([]), "Tell me what you did, and I'll help log it against the right goal.");
});

test("9G. multiple active goals of different categories each get their own example line", async () => {
  const userId = `progress-ex-multi-${randomUUID()}`;
  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const jobGoal = await seedGoal(userId, "Find a fully remote developer job", "career", "career.job_search");
    const fitnessGoal = await seedGoal(userId, "Train 3 times per week", "health", "health.strength_energy");
    const combined = progressExamplesForGoals([jobGoal, fitnessGoal]);
    assert.match(combined, /job-search/);
    assert.match(combined, /fitness/);
    assert.equal(combined.split("\n").length, 2, "one example line per distinct goal category");
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 10: deterministic mapping, not LLM invention ------------------------------------------

const ALL_CANNED_EXAMPLES = new Set([
  "sent 2 CVs",
  "got 1 recruiter reply",
  "scheduled 1 interview",
  "got 1 rejection",
  "45 min gym",
  "8k steps",
  "slept 7h",
  "journaled 10 minutes",
  "had one meaningful conversation",
  "did one mindful activity",
  "paid one bill",
  "reviewed one invoice",
  "called insurance",
  "checked flight update",
  "confirmed hotel booking"
]);

test("10A. every generated example is drawn from the fixed canned list — nothing invented", async () => {
  const userId = `progress-ex-canned-${randomUUID()}`;
  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const goals = await Promise.all([
      seedGoal(userId, "Find a fully remote developer job", "career", "career.job_search"),
      seedGoal(userId, "Train 3 times per week", "health", "health.strength_energy"),
      seedGoal(userId, "Journal daily", "personal development", undefined),
      seedGoal(userId, "Keep up with bills", "finance", undefined),
      seedGoal(userId, "Plan the trip", "travel", undefined)
    ]);
    for (const goal of goals) {
      const line = progressExamplesLineForGoal(goal);
      assert.ok(line, `expected a line for goal "${goal.title}"`);
      const quoted = [...(line as string).matchAll(/'([^']+)'/g)].map((m) => m[1]!);
      assert.ok(quoted.length > 0);
      for (const phrase of quoted) {
        assert.ok(ALL_CANNED_EXAMPLES.has(phrase), `"${phrase}" is not one of the fixed canned examples — looks invented`);
      }
    }
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("10B. a goal's example category stays aligned with its own real category/template, not a sibling goal's", async () => {
  const userId = `progress-ex-align-${randomUUID()}`;
  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const fitnessGoal = await seedGoal(userId, "Train 3 times per week", "health", "health.strength_energy");
    assert.equal(progressExampleCategoryForGoal(fitnessGoal), "fitness");
    assert.notEqual(progressExampleCategoryForGoal(fitnessGoal), "job_search");
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("10C. examples update when the underlying goal category changes", async () => {
  const userId = `progress-ex-update-${randomUUID()}`;
  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const fitnessGoal = await seedGoal(userId, "Train 3 times per week", "health", "health.strength_energy");
    const financeGoal = await prisma.goal.update({ where: { id: fitnessGoal.id }, data: { category: "finance", templateId: null, title: "Pay bills on time" } });
    assert.equal(progressExampleCategoryForGoal(financeGoal as unknown as typeof fitnessGoal), "finance_admin");
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("10D. a gambling/trading-control goal keeps its own risk framing, never finance_admin bill wording", async () => {
  const userId = `progress-ex-gambling-${randomUUID()}`;
  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const goal = await seedGoal(userId, "Control betting impulses", "finance", "finance.control_betting_trading");
    assert.notEqual(progressExampleCategoryForGoal(goal), "finance_admin");
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 11: exact live UX example wording ------------------------------------------------------

test("11A. exact live UX wording for a job-search goal", async () => {
  const userId = `progress-ex-live-jobsearch-${randomUUID()}`;
  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const goal = await seedGoal(userId, "Find a fully remote developer job", "career", "career.job_search");
    assert.equal(
      progressExamplesLineForGoal(goal),
      "Examples for your job-search goal: 'sent 2 CVs', 'got 1 recruiter reply', 'scheduled 1 interview'."
    );
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("11B. exact live UX wording for a life-meaning goal", async () => {
  const userId = `progress-ex-live-meaning-${randomUUID()}`;
  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const goal = await seedGoal(userId, "Have a more meaningful daily life", "personal development", undefined);
    assert.equal(
      progressExamplesLineForGoal(goal),
      "Examples for your meaning goal: 'journaled 10 minutes', 'had one meaningful conversation', 'did one mindful activity'."
    );
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Wiring: the two real reachable surfaces that used to hardcode "gym 45m and sent 2 CVs" -----

test("wiring A. daily check-in prompt shows a fitness example, not the old generic 'trained 40 min' wording, for a fitness-only user", async () => {
  const userId = `progress-ex-checkin-fitness-${randomUUID()}`;
  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const goal = await seedGoal(userId, "Train 3 times per week", "health", "health.strength_energy");
    const prompt = buildDailyCheckinPrompt({ activeGoals: [goal] });
    assert.match(prompt, /45 min gym/);
    assert.doesNotMatch(prompt, /trained 40 min/);
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("wiring B. daily check-in prompt shows finance/travel/meaning examples only when a matching goal is active", async () => {
  const userId = `progress-ex-checkin-mix-${randomUUID()}`;
  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const financeGoal = await seedGoal(userId, "Keep up with bills", "finance", undefined);
    const prompt = buildDailyCheckinPrompt({ activeGoals: [financeGoal] });
    assert.match(prompt, /paid one bill/);
    assert.doesNotMatch(prompt, /sent 2 CVs|45 min gym|journaled 10 minutes|checked flight update/);
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("wiring C. evening proactive nudge suggests a fitness-shaped reply for a fitness-only untracked goal, never 'sent 2 CVs'", async () => {
  const server = buildServer();
  const userId = `progress-ex-evening-fitness-${randomUUID()}`;
  try {
    await seedUserWithNotificationSettings(userId);
    await createGoal(userId, {
      title: "Train 3 times per week",
      category: "health",
      templateId: "health.strength_energy",
      targetMetrics: [{ key: "workouts", label: "Workouts", eventType: "health.workout_completed", aggregation: "count", window: "daily" }]
    });

    const decision = await previewEvening(server, userId);
    assert.equal(decision.decision, "proposed_message");
    assert.match(decision.message ?? "", /45 min gym/);
    assert.doesNotMatch(decision.message ?? "", /sent 2 CVs/);
    assert.ok(decision.suggestedReplies?.includes("45 min gym"));
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("wiring D. evening proactive nudge suggests a travel-shaped reply for a travel-only untracked goal", async () => {
  const server = buildServer();
  const userId = `progress-ex-evening-travel-${randomUUID()}`;
  try {
    await seedUserWithNotificationSettings(userId);
    await createGoal(userId, {
      title: "Plan the Japan trip",
      category: "travel",
      targetMetrics: [{ key: "travel_tasks", label: "Travel tasks", eventType: "travel.task_completed", aggregation: "count", window: "daily" }]
    });

    const decision = await previewEvening(server, userId);
    assert.equal(decision.decision, "proposed_message");
    assert.match(decision.message ?? "", /checked flight update|confirmed hotel booking/);
    assert.doesNotMatch(decision.message ?? "", /sent 2 CVs|45 min gym/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
