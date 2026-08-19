import { buildDailyReview, getLocalTodayRange } from "@operator-agent/core";
import {
  getActionItems,
  getActiveGoals,
  getEmailSignalRules,
  getEventsBetween,
  getIntegrationConnections,
  getOrCreateNotificationSettings,
  getOrCreateUserOperatingProfile,
  getRelevantMemories,
  updateNotificationSettings
} from "@operator-agent/db";
import { analyzeActionHygiene, cleanupDecisionGrammar } from "../actions/hygiene-session.js";
import { sortGoalsForDisplay } from "../utils/goal-priority.js";
import { getUserTimezone } from "../utils/user-timezone.js";

/**
 * Legacy onboarding/setup + daily-review + natural daily-loop-settings
 * conversation cluster, extracted from apps/api/src/server.ts. Handles the
 * onboarding-state summary and its natural-language reply composition, the
 * lightweight conversational daily-review surface, and natural-language
 * parsing for turning on/adjusting the morning-brief/evening-review daily
 * loop, all used directly by the legacy `handleConversationSurfaceIntent`
 * dispatcher (which stays in server.ts).
 *
 * This module has zero dependency on
 * apps/api/src/operator/attention.ts (the sibling operator-attention/
 * daily-brief cluster extracted in the same pass) and vice versa — both are
 * independent siblings imported only by server.ts.
 */

type OnboardingIntent =
  | "first_run_intro"
  | "setup_overview"
  | "quickstart"
  | "configure_goals"
  | "configure_actions"
  | "configure_daily_loop"
  | "configure_reminders"
  | "configure_integrations"
  | "explain_capabilities"
  | "missing_setup";

interface OnboardingState {
  userId: string;
  profileSummary: string;
  goalsCount: number;
  topGoals: string[];
  openActionsCount: number;
  overdueOrStaleActionsCount: number;
  dailyLoopEnabled: boolean;
  morningTime: string;
  eveningTime: string;
  actionReminderDefaultTime: string;
  notificationSummary: string;
  connectedIntegrationsCount: number;
  gmailStatus: "connected" | "not_connected";
  activeEmailRulesCount: number;
  githubConnectionCount: number;
  dailyBriefUsable: boolean;
  missingSetupItems: string[];
  recommendedNextStep: string;
  timezone: string;
}

export type { OnboardingIntent, OnboardingState };

export async function buildOnboardingState(userId: string, now: Date, timezone: string): Promise<OnboardingState> {
  const [goals, actions, settings, connections, emailRules, profile, hygiene] = await Promise.all([
    getActiveGoals(userId),
    getActionItems(userId, { status: "open", limit: 100 }),
    getOrCreateNotificationSettings(userId),
    getIntegrationConnections(userId),
    getEmailSignalRules(userId),
    getOrCreateUserOperatingProfile(userId),
    analyzeActionHygiene(userId, now, timezone)
  ]);
  const activeConnections = connections.filter((connection) => connection.status === "active");
  const activeEmailRules = emailRules.filter((rule) => rule.status === "active");
  const gmailConnected = activeConnections.some((connection) => connection.integrationId === "gmail");
  const githubConnectionCount = activeConnections.filter((connection) => connection.integrationId === "github_public").length;
  const missingSetupItems = [
    goals.length === 0 ? "goals" : undefined,
    !settings.dailyLoopEnabled ? "daily loop" : undefined,
    actions.length === 0 ? "first action" : undefined,
    !gmailConnected ? "Gmail optional" : activeEmailRules.length === 0 ? "email rules optional" : undefined,
    githubConnectionCount === 0 ? "GitHub optional" : undefined
  ].filter((item): item is string => Boolean(item));
  const recommendedNextStep =
    goals.length === 0
      ? "Tell me a real goal, for example: I want to find a new developer job."
      : actions.length === 0
        ? "Create one concrete next action, for example: remind me to apply tomorrow."
        : !settings.dailyLoopEnabled
          ? "Say: turn on morning brief at 9 and evening review at 21:30."
          : hygiene.suggestedCleanupCandidates.length > 0
            ? "Say: clean up my tasks."
            : "Ask: what should I do today.";

  return {
    userId,
    profileSummary: `${profile.motivationalStyle}, directness ${profile.directness}/5, guardrails ${profile.gamblingGuardrails}`,
    goalsCount: goals.length,
    topGoals: sortGoalsForDisplay(goals).slice(0, 3).map((goal) => goal.title),
    openActionsCount: actions.length,
    overdueOrStaleActionsCount: hygiene.suggestedCleanupCandidates.length,
    dailyLoopEnabled: settings.dailyLoopEnabled,
    morningTime: formatMinutesOfDay(settings.morningTimeMinutes),
    eveningTime: formatMinutesOfDay(settings.eveningTimeMinutes),
    actionReminderDefaultTime: formatMinutesOfDay(settings.defaultActionTimeMinutes),
    notificationSummary: `timezone ${settings.timezone}, default action time ${formatMinutesOfDay(settings.defaultActionTimeMinutes)}`,
    timezone: settings.timezone,
    connectedIntegrationsCount: activeConnections.length,
    gmailStatus: gmailConnected ? "connected" : "not_connected",
    githubConnectionCount,
    activeEmailRulesCount: activeEmailRules.length,
    dailyBriefUsable: goals.length > 0 || actions.length > 0,
    missingSetupItems,
    recommendedNextStep
  };
}

export function composeOnboardingReply(state: OnboardingState, intent: OnboardingIntent): string {
  if (intent === "first_run_intro") {
    return [
      "Hey, I'm Alecto. You can talk normally.",
      "",
      "I can help with:",
      "- deciding what to do today",
      "- tracking goals and actions",
      "- remembering preferences",
      "- reviewing your week",
      "- keeping guardrails around risky patterns",
      "",
      "Try:",
      '- "I want to find a new job"',
      '- "remind me to apply tomorrow"',
      '- "what should I do today"',
      '- "help me set up"',
      "",
      "Commands are optional shortcuts."
    ].join("\n");
  }

  if (intent === "explain_capabilities") {
    return [
      "I help you operate from evidence, not vibes.",
      "",
      "- Daily planning: what to do today, start/end day, tomorrow prep.",
      "- Goals: track active goals, priorities, and progress evidence.",
      "- Actions/reminders: create, complete, snooze, archive, and get due reminders.",
      "- Check-ins/events: log sleep, energy, anxiety, focus, training, reading, applications, and other approved events.",
      "- Memory: remember preferences and recurring patterns.",
      "- Guardrails: hard-stop betting/trading risk before it becomes a task or rationalization.",
      "- Weekly review/planning: review the week and propose next-week actions only after confirmation.",
      "- Signals: Gmail/GitHub can add context after explicit connection and approved rules.",
      "",
      "You can talk normally. Commands like /today, /actions, /weekly, and /plan_next_week are shortcuts."
    ].join("\n");
  }

  if (intent === "quickstart") {
    const firstStep =
      state.goalsCount === 0
        ? 'Start here: say "I want to find a new developer job" or another real goal.'
        : state.openActionsCount === 0
          ? 'Start here: say "remind me to apply tomorrow" or another concrete next action.'
          : state.overdueOrStaleActionsCount > 0
            ? 'Start here: say "clean up my tasks".'
            : 'Start here: ask "what should I do today".';

    return [
      "Quickstart:",
      "1. Set 1-3 real goals.",
      "2. Add one next action.",
      "3. Let Alecto pick the next move each day.",
      "",
      firstStep,
      "",
      "Examples:",
      '- "I want to find a new developer job"',
      '- "remind me to apply tomorrow"',
      '- "what should I do today"',
      "",
      `Best next step: ${state.recommendedNextStep}`
    ].join("\n");
  }

  if (intent === "configure_goals") {
    if (state.topGoals.length > 0) {
      return [
        "Goal setup:",
        `Current goals: ${state.topGoals.join(", ")}${state.goalsCount > state.topGoals.length ? `, +${state.goalsCount - state.topGoals.length} more` : ""}.`,
        "",
        "That is enough to operate. Adding more goals may add noise unless something truly matters now.",
        "",
        "If you do want another one, say it naturally. I will ask confirmation before creating it."
      ].join("\n");
    }

    return [
      "Goal setup:",
      "Choose 1-3 goals only. Fewer goals makes the operator loop sharper.",
      "",
      "Good first goals:",
      '- "I want to find a new developer job"',
      '- "I want to improve strength and energy"',
      '- "I want to read more"',
      "",
      "I will ask confirmation before creating a goal."
    ].join("\n");
  }

  if (intent === "configure_actions") {
    return [
      "Actions are concrete things you might do, with optional reminders.",
      "",
      "Try:",
      '- "remind me to apply to 3 jobs tomorrow"',
      '- "I need to review homepage copy Friday"',
      '- "move YouTube script to tomorrow afternoon"',
      "",
      "You can also say things like done with it, snooze it to tomorrow, or archive the car task. I will ask if the target is ambiguous."
    ].join("\n");
  }

  if (intent === "configure_daily_loop" || intent === "configure_reminders") {
    return [
      "Daily loop setup:",
      `- status: ${state.dailyLoopEnabled ? "on" : "off"}`,
      `- morning brief: ${state.morningTime} ${state.timezone}`,
      `- evening review: ${state.eveningTime} ${state.timezone}`,
      `- default action time: ${state.actionReminderDefaultTime}`,
      "",
      "Morning brief picks the first move. Evening review closes the day and catches cleanup.",
      'Natural option: "turn on morning brief at 9 and evening review at 21:30".',
      "Optional shortcut: /set_daily_loop morning=09:00 evening=21:30 enabled=true."
    ].join("\n");
  }

  if (intent === "configure_integrations") {
    return [
      "Integration setup:",
      `- Gmail: ${state.gmailStatus === "connected" ? "connected" : "not connected"}`,
      `- active email rules: ${state.activeEmailRulesCount}`,
      `- GitHub public connections: ${state.githubConnectionCount}`,
      "",
      "Gmail is readonly and local-MVP. It does not scan until you connect Gmail and explicitly enable a rule.",
      "Optional shortcuts: /connect_gmail, /enable_email_rule job_search, /connect_github OWNER/REPO author=LOGIN."
    ].join("\n");
  }

  const ready = [
    `Goals: ${state.goalsCount} active${state.topGoals.length > 0 ? ` (${state.topGoals.join(", ")})` : ""}`,
    `Actions: ${state.openActionsCount} open`,
    `Daily brief: ${state.dailyLoopEnabled ? `enabled, ${state.morningTime}` : "disabled"}`,
    `Evening review: ${state.dailyLoopEnabled ? `enabled, ${state.eveningTime}` : "disabled"}`
  ];
  const needsAttention = [
    state.goalsCount === 0 ? "No goals yet" : undefined,
    state.openActionsCount === 0 ? "No open actions yet" : undefined,
    !state.dailyLoopEnabled ? "Daily loop is off" : undefined,
    state.overdueOrStaleActionsCount > 0 ? cleanupDecisionGrammar(state.overdueOrStaleActionsCount) : undefined
  ].filter((item): item is string => Boolean(item));
  const optional = [
    `Gmail: ${state.gmailStatus === "connected" ? "connected" : "not connected"}`,
    `GitHub: ${state.githubConnectionCount} public ${state.githubConnectionCount === 1 ? "connection" : "connections"}`,
    `Email rules: ${state.activeEmailRulesCount} active`,
    `Timezone: ${state.timezone}`
  ];

  return [
    "Alecto setup",
    "",
    "Ready:",
    ...ready.map((item) => `- ${item}`),
    "",
    "Needs attention:",
    ...(needsAttention.length > 0 ? needsAttention : ["Nothing blocking the local alpha loop."]).map((item) => `- ${item}`),
    "",
    "Optional:",
    ...optional.map((item) => `- ${item}`),
    "",
    `Best next step: ${state.recommendedNextStep}`
  ].filter(Boolean).join("\n");
}

export async function buildConversationDailyReview(userId: string, now = new Date()) {
  const todayRange = getLocalTodayRange(now, await getUserTimezone(userId));
  return buildDailyReview({
    userId,
    activeGoals: await getActiveGoals(userId),
    todayEvents: await getEventsBetween(userId, todayRange.start, todayRange.end),
    activeMemories: await getRelevantMemories(userId, {
      types: ["risk_pattern"],
      limit: 3
    })
  });
}

export function formatConversationDailyReview(review: ReturnType<typeof buildDailyReview>): string {
  return [
    review.summary,
    review.checkIn.length > 0 ? `Check-in: ${review.checkIn.join(", ")}` : undefined,
    `Wins: ${review.wins.length > 0 ? review.wins.join(", ") : "none logged"}`,
    `Gaps: ${review.gaps.length > 0 ? review.gaps.join(", ") : "none obvious"}`,
    review.warnings.length > 0 ? `Warnings:\n${review.warnings.map((warning) => `- ${warning}`).join("\n")}` : undefined,
    `Next step: ${review.suggestedFocus}`
  ].filter(Boolean).join("\n");
}

export async function handleNaturalDailyLoopSettings(userId: string, message: string): Promise<string> {
  const settings = await getOrCreateNotificationSettings(userId);
  const parsed = parseNaturalDailyLoopSettings(message);

  if (!parsed) {
    return [
      "I can help set the daily loop, but I need a concrete time.",
      "Examples: turn on morning brief at 09:00, set evening review at 21:30."
    ].join("\n");
  }

  const updated = await updateNotificationSettings(userId, {
    dailyLoopEnabled: true,
    morningTimeMinutes: parsed.morningTimeMinutes,
    eveningTimeMinutes: parsed.eveningTimeMinutes
  });

  return [
    "Daily loop updated.",
    parsed.morningTimeMinutes !== undefined ? `Morning brief: ${formatMinutesOfDay(parsed.morningTimeMinutes)} ${updated.timezone}` : undefined,
    parsed.eveningTimeMinutes !== undefined ? `Evening review: ${formatMinutesOfDay(parsed.eveningTimeMinutes)} ${updated.timezone}` : undefined,
    parsed.morningTimeMinutes === undefined && parsed.eveningTimeMinutes === undefined ? `Enabled with current times: morning ${formatMinutesOfDay(settings.morningTimeMinutes)}, evening ${formatMinutesOfDay(settings.eveningTimeMinutes)} ${updated.timezone}` : undefined
  ].filter(Boolean).join("\n");
}

function parseNaturalDailyLoopSettings(message: string): { morningTimeMinutes?: number; eveningTimeMinutes?: number } | undefined {
  const text = message.trim();
  const morningMatch = text.match(/\bmorning(?:\s+brief)?\s+(?:at|a las)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  const eveningMatch = text.match(/\b(?:evening|night)(?:\s+review)?\s+(?:at|a las)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  const parsed: { morningTimeMinutes?: number; eveningTimeMinutes?: number } = {};

  if (morningMatch) {
    parsed.morningTimeMinutes = parseNaturalTimeToMinutes(morningMatch[1], morningMatch[2], morningMatch[3]);
  }

  if (eveningMatch) {
    parsed.eveningTimeMinutes = parseNaturalTimeToMinutes(eveningMatch[1], eveningMatch[2], eveningMatch[3]);
  }

  if (parsed.morningTimeMinutes !== undefined || parsed.eveningTimeMinutes !== undefined) {
    return parsed;
  }

  const timeMatch = text.match(/\b(?:at|a las)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  const minutes = timeMatch ? parseNaturalTimeToMinutes(timeMatch[1], timeMatch[2], timeMatch[3]) : undefined;

  if (/\bmorning\b/i.test(text) && minutes !== undefined) {
    return { morningTimeMinutes: minutes };
  }

  if (/\bevening|night|review\b/i.test(text) && minutes !== undefined) {
    return { eveningTimeMinutes: minutes };
  }

  if (/\bremind me every morning\b/i.test(text)) {
    return {};
  }

  return undefined;
}

function parseNaturalTimeToMinutes(hourText: string, minuteText?: string, meridiem?: string): number | undefined {
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;

  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return undefined;
  }

  if (meridiem?.toLowerCase() === "pm" && hour < 12) {
    hour += 12;
  }

  if (meridiem?.toLowerCase() === "am" && hour === 12) {
    hour = 0;
  }

  if (hour < 0 || hour > 23) {
    return undefined;
  }

  return hour * 60 + minute;
}

function formatMinutesOfDay(minutes: number): string {
  const safe = Number.isInteger(minutes) && minutes >= 0 && minutes <= 1439 ? minutes : 0;
  const hours = Math.floor(safe / 60);
  const mins = safe % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}
