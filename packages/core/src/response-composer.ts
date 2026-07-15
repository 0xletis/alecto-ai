import { z } from "zod";
import type { AgentMode, MessageIntent } from "./message-processing.js";
import type { Goal } from "./goals.js";
import type { MemoryEntry } from "./memory.js";
import type { StoredEvent } from "./events.js";
import type { RiskState } from "./risk.js";
import type { UserOperatingProfile } from "./user-operating-profile.js";

export const AgentResponseSchema = z.object({
  reply: z.string().min(1),
  mode: z.string().min(1),
  tone: z.string().min(1),
  evidenceUsed: z.array(z.string()).default([])
});

export interface AgentResponseComposerInput {
  userId: string;
  message: string;
  intent: MessageIntent | string;
  mode: AgentMode | string;
  riskState: RiskState | string;
  extractedEvents?: StoredEvent[];
  activeGoals?: Goal[];
  recentEvents?: StoredEvent[];
  memories?: MemoryEntry[];
  pendingAction?: Record<string, unknown>;
  profile?: UserOperatingProfile;
  todaySummary?: string;
}

export type AgentResponse = z.infer<typeof AgentResponseSchema>;

export function composeAgentResponse(input: AgentResponseComposerInput): AgentResponse {
  const mode = selectComposerMode(input);
  const tone = selectTone(mode, input.profile, input.riskState);
  const evidenceUsed = collectEvidence(input);
  const reply = composeReplyForMode({ ...input, mode }, tone, evidenceUsed);

  return AgentResponseSchema.parse({
    reply,
    mode,
    tone,
    evidenceUsed
  });
}

function selectComposerMode(input: AgentResponseComposerInput): string {
  if (input.riskState === "RED" || input.riskState === "ORANGE") {
    return "guardian";
  }

  if (input.mode === "mirror" && isVulnerableMessage(input.message)) {
    return "support";
  }

  return input.mode;
}

function selectTone(mode: string, profile: UserOperatingProfile | undefined, riskState: string): string {
  if (mode === "guardian" && riskState === "RED") {
    return profile?.gamblingGuardrails === "hard_guardian" ? "hard_guardian" : "firm_guardian";
  }

  if (mode === "support") {
    return profile?.vulnerableMode === "soften" ? "soft_direct" : "direct_support";
  }

  if (profile && (profile.directness >= 5 || profile.motivationalStyle === "tough_love")) {
    return "direct";
  }

  return "balanced";
}

function composeReplyForMode(
  input: AgentResponseComposerInput & { mode: string },
  tone: string,
  evidenceUsed: string[]
): string {
  if (input.mode === "guardian") {
    return composeGuardianReply(input);
  }

  if (isNextActionRequest(input.message)) {
    return composeNextActionReply(input);
  }

  if (input.mode === "fiscal") {
    return composeFiscalReply(input);
  }

  if (input.mode === "support") {
    return composeSupportReply(input, evidenceUsed);
  }

  if (input.mode === "builder") {
    return "Builder mode. Send the code, error, repo context, or the smallest failing example. Next clean move: isolate the failing case, then we fix one thing at a time.";
  }

  if (input.mode === "review") {
    return input.todaySummary ?? "Review mode. I will keep this factual: logged evidence first, interpretation second.";
  }

  if (input.mode === "mirror") {
    return composeMirrorReply(input, evidenceUsed);
  }

  if (input.intent === "research_request") {
    return "Research mode. Give me the exact question and the decision it supports. I will separate facts, uncertainty, and next action.";
  }

  return tone === "direct"
    ? "Got it. I do not see a structured event in that. If you want action, give me the next concrete target."
    : "Got it. No structured event needed from that message. If you want, we can turn it into one concrete next step.";
}

function composeGuardianReply(input: AgentResponseComposerInput): string {
  if (input.riskState === "RED") {
    const signals = guardianSignals(input);
    const signalText = signals.length > 0 ? ` Evidence: ${signals.join(", ")}.` : "";

    if (input.profile?.gamblingGuardrails === "hard_guardian") {
      return `No. Hard stop.${signalText} I am not helping you turn this into permission. Cooldown now. If it still matters later, bring a written thesis, exact size, invalidation point, and emotional state.`;
    }

    return `No. I am not validating this right now.${signalText} Cooldown first. If it still makes sense later, bring a written thesis, size, invalidation point, and emotional state.`;
  }

  return "Guardian mode. Before any bet or trade: thesis, size, invalidation point, and emotional state. If you cannot write those cleanly, no action.";
}

function composeFiscalReply(input: AgentResponseComposerInput): string {
  const eventSummary = summarizeEvents(input.extractedEvents ?? []);
  const gap = nextUsefulGap(input.activeGoals ?? [], input.recentEvents ?? []);

  if (eventSummary) {
    return gap
      ? `Logged: ${eventSummary}. Good. ${gap}`
      : `Logged: ${eventSummary}. Good. Keep the next action concrete.`;
  }

  const activeGoal = newestActiveGoal(input.activeGoals ?? []);
  return activeGoal
    ? `Accountability mode. No event logged from that. Clean next move: one concrete action for ${activeGoal.title}.`
    : "Accountability mode. No event logged from that. Create or choose one active goal, then log one concrete action.";
}

function composeSupportReply(input: AgentResponseComposerInput, evidenceUsed: string[]): string {
  const lower = input.message.toLowerCase();

  if (/\b(shit|fatal|horrible|awful)\b/i.test(lower)) {
    return "Okay. Lower the bar, don't disappear. Minimum viable day: one honest check-in, one 20-minute action, and no risk decisions.";
  }

  if (/\b(stuck|bloqueado|atascado|don't know what to do|dont know what to do|no se que hacer|no sé qué hacer)\b/i.test(lower)) {
    const choices = actionChoiceLabels(input.activeGoals ?? []);
    const riskNote = riskControlNote(input);
    const hypothesis = choices.length >= 2
      ? `You may not be stuck because you lack motivation. You have too many active tracks open. Pick one: ${joinReadableListWithOr(choices)}.`
      : "You may not be stuck because you lack motivation. The state is noisy; reduce the decision.";
    return `${hypothesis} Do 20 minutes and log it. No redesigning the whole system right now.${riskNote ? ` ${riskNote}` : ""}`;
  }

  if (input.profile?.vulnerableMode === "soften") {
    return "I hear you. Keep the bar small and real: one check-in, one concrete action, then reassess. No big identity conclusions from a bad state.";
  }

  return "Noted. Keep this factual: what happened, what state are you in, and what is the next small action?";
}

function composeNextActionReply(input: AgentResponseComposerInput): string {
  const actions = nextConcreteActions(input.activeGoals ?? [], input.recentEvents ?? []).slice(0, 2);

  if (actions.length === 0) {
    return "Next move: pick one active goal and do 20 minutes. Then log it. Do not add another track.";
  }

  const alreadyDone = completedGoalLabels(input.activeGoals ?? [], input.recentEvents ?? []);
  const doneText = alreadyDone.length > 0
    ? ` You already logged ${joinReadableList(alreadyDone)}, so do not add another ${alreadyDone[0]} task.`
    : "";

  const actionText = actions.length === 1
    ? `Next: ${actions[0]}.`
    : `Pick one: ${joinReadableListWithOr(actions)}. Do not add a third track.`;

  return `${actionText}${doneText} Log it when done.`;
}

function composeMirrorReply(input: AgentResponseComposerInput, evidenceUsed: string[]): string {
  if (evidenceUsed.length > 0) {
    return `I think there may be a pattern here. Evidence: ${evidenceUsed.slice(0, 2).join("; ")}. Treat that as a hypothesis, not a verdict. What is the smallest action that would test it today?`;
  }

  return "I can mirror this, but the evidence is thin. My read: name the pattern as a hypothesis, then test it with one concrete action today.";
}

function summarizeEvents(events: StoredEvent[]): string {
  const parts = events.map((event) => {
    if (event.type === "career.application_sent" && typeof event.data.count === "number") {
      return `${event.data.count} application${event.data.count === 1 ? "" : "s"}`;
    }

    if (event.type === "health.workout_completed" && typeof event.data.duration_minutes === "number") {
      return `${event.data.duration_minutes} minutes training`;
    }

    if (event.type === "learning.reading_session_completed" && typeof event.data.duration_minutes === "number") {
      return `${event.data.duration_minutes} minutes reading`;
    }

    if (event.type === "health.sleep_logged" && typeof event.data.duration_hours === "number") {
      return `slept ${event.data.duration_hours}h`;
    }

    if (event.type === "custom.goal_progress_logged") {
      const goalTitle = typeof event.data.goalTitle === "string" ? event.data.goalTitle : "custom goal";
      const value = typeof event.data.value === "number" && event.data.unit === "minutes"
        ? `${event.data.value} focused minutes`
        : "progress logged";
      return `${goalTitle}: ${value}`;
    }

    return event.type.replace(/_/g, " ");
  });

  return joinReadableList(parts);
}

function nextUsefulGap(activeGoals: Goal[], recentEvents: StoredEvent[]): string | undefined {
  if (activeGoals.length === 0) {
    return "Next useful step: create one active goal so progress has a target.";
  }

  const todayTypes = new Set(
    recentEvents
      .filter((event) => isToday(event.timestamp))
      .map((event) => event.type)
  );

  const goalWithoutProgress = activeGoals.find((goal) => {
    if (goal.templateId === "career.job_search" || goal.category === "career") {
      return !hasAny(todayTypes, ["career.application_sent", "career.recruiter_reply_received", "career.interview_scheduled"]);
    }

    if (goal.templateId === "health.strength_energy" || goal.category === "health") {
      return !hasAny(todayTypes, ["health.workout_completed", "health.steps_logged"]);
    }

    if (goal.templateId === "learning.reading_more" || goal.category === "learning") {
      return !hasAny(todayTypes, ["learning.reading_session_completed", "learning.note_created"]);
    }

    if (!goal.templateId) {
      return !recentEvents.some((event) => event.type === "custom.goal_progress_logged" && event.data.goalId === goal.id && isToday(event.timestamp));
    }

    return false;
  });

  return goalWithoutProgress ? `Next useful gap: one concrete action for ${goalWithoutProgress.title}.` : undefined;
}

function nextConcreteActions(activeGoals: Goal[], recentEvents: StoredEvent[]): string[] {
  const actions: string[] = [];
  const todayTypes = new Set(recentEvents.filter((event) => isToday(event.timestamp)).map((event) => event.type));

  for (const goal of activeGoals.filter((item) => item.status === "active" && !isRiskControlGoal(item))) {
    if ((goal.templateId === "career.job_search" || goal.category === "career") && !todayTypes.has("career.application_sent")) {
      actions.push("send 1 more CV");
      continue;
    }

    if (!goal.templateId && !hasCustomProgressToday(goal, recentEvents)) {
      actions.push(`do 30 minutes on ${shortGoalName(goal.title)}`);
      continue;
    }

    if (
      (goal.templateId === "learning.reading_more" || goal.category === "learning") &&
      !todayTypes.has("learning.reading_session_completed")
    ) {
      actions.push("read 20 minutes");
      continue;
    }

    if (
      (goal.templateId === "health.strength_energy" || goal.category === "health") &&
      !todayTypes.has("health.workout_completed")
    ) {
      actions.push("train 30 minutes");
    }
  }

  return unique(actions);
}

function completedGoalLabels(activeGoals: Goal[], recentEvents: StoredEvent[]): string[] {
  const todayEvents = recentEvents.filter((event) => isToday(event.timestamp));
  const labels: string[] = [];

  if (todayEvents.some((event) => event.type === "health.workout_completed")) {
    labels.push("training");
  }

  if (todayEvents.some((event) => event.type === "career.application_sent")) {
    labels.push("job-search");
  }

  if (todayEvents.some((event) => event.type === "learning.reading_session_completed")) {
    labels.push("reading");
  }

  for (const goal of activeGoals.filter((item) => !item.templateId)) {
    if (hasCustomProgressToday(goal, todayEvents)) {
      labels.push(shortGoalName(goal.title));
    }
  }

  return unique(labels);
}

function actionChoiceLabels(activeGoals: Goal[]): string[] {
  return activeGoals
    .filter((goal) => goal.status === "active" && !isRiskControlGoal(goal))
    .slice(0, 3)
    .map((goal) => shortGoalName(goal.title));
}

function riskControlNote(input: AgentResponseComposerInput): string | undefined {
  const hasRiskGoal = (input.activeGoals ?? []).some(isRiskControlGoal);

  if (!hasRiskGoal && input.riskState !== "RED" && input.riskState !== "ORANGE") {
    return undefined;
  }

  return "Risk control is separate: no betting/trading decisions tonight.";
}

function isRiskControlGoal(goal: Goal): boolean {
  const text = `${goal.title} ${goal.category} ${goal.templateId ?? ""}`.toLowerCase();
  return /\b(betting|trading|gambling|impulse|impulsive|risk-control|risk control|apuesta|apostar)\b/.test(text);
}

function hasCustomProgressToday(goal: Goal, recentEvents: StoredEvent[]): boolean {
  return recentEvents.some(
    (event) =>
      event.type === "custom.goal_progress_logged" &&
      event.data.goalId === goal.id &&
      isToday(event.timestamp)
  );
}

function shortGoalName(title: string): string {
  if (/job|career|cv/i.test(title)) {
    return "job search";
  }

  if (/youtube|channel|video|content/i.test(title)) {
    return "YouTube";
  }

  if (/health|strength|gym|train/i.test(title)) {
    return "health";
  }

  return title;
}

function collectEvidence(input: AgentResponseComposerInput): string[] {
  const evidence: string[] = [];

  for (const event of (input.extractedEvents ?? []).slice(0, 3)) {
    evidence.push(`logged ${event.type}`);
  }

  for (const memory of (input.memories ?? []).slice(0, 2)) {
    evidence.push(`memory: ${memory.summary}`);
  }

  const activeGoals = input.activeGoals?.filter((goal) => goal.status === "active") ?? [];
  if (activeGoals.length > 0) {
    evidence.push(`${activeGoals.length} active goal${activeGoals.length === 1 ? "" : "s"}`);
  }

  if (input.todaySummary && input.todaySummary !== "No events logged yet today.") {
    evidence.push(input.todaySummary);
  }

  return evidence;
}

function guardianSignals(input: AgentResponseComposerInput): string[] {
  const signals: string[] = [];
  const currentEventIds = new Set((input.extractedEvents ?? []).map((event) => event.id));

  if (/\b(safe|sure|guaranteed|seguro|casi seguro|free money)\b/i.test(input.message)) {
    signals.push("certainty language");
  }

  if (
    (input.recentEvents ?? []).some(
      (event) =>
        !currentEventIds.has(event.id) &&
        event.type === "finance.betting.cooldown_triggered" &&
        isWithinHours(event.timestamp, 24)
    )
  ) {
    signals.push("recent cooldown");
  }

  return signals;
}

function newestActiveGoal(goals: Goal[]): Goal | undefined {
  return goals
    .filter((goal) => goal.status === "active")
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
}

function hasAny(values: Set<string>, expected: string[]): boolean {
  return expected.some((value) => values.has(value));
}

function isVulnerableMessage(message: string): boolean {
  return /\b(i feel|me siento|stuck|shit|fatal|tired|cansado|lost|perdido|no se que hacer|no sé qué hacer)\b/i.test(message);
}

function isNextActionRequest(message: string): boolean {
  return /\b(what should i do next|what do i do next|what next|next today|que hago ahora|qué hago ahora)\b/i.test(message);
}

function isToday(date: Date): boolean {
  return date.toDateString() === new Date().toDateString();
}

function isWithinHours(date: Date, hours: number): boolean {
  return Date.now() - date.getTime() <= hours * 60 * 60 * 1000;
}

function joinReadableList(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }

  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function joinReadableListWithOr(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }

  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
