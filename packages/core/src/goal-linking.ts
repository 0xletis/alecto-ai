import type { Goal } from "./goals.js";

export interface GoalLinkResult {
  goalId: string | null;
  goalSlug: string | null;
  confidence: number;
  reason: string;
  matchedGoalTitle?: string;
}

export interface InferActionGoalLinkInput {
  actionTitle: string;
  actionDescription?: string;
  evidence?: string;
  activeGoals: Goal[];
}

type GoalSignal =
  | "career"
  | "health"
  | "learning"
  | "youtube"
  | "car"
  | "finance_risk"
  | "creative"
  | "social"
  | "work";

const minimumConfidence = 0.7;

export function inferGoalLinkForAction(input: InferActionGoalLinkInput): GoalLinkResult {
  const activeGoals = input.activeGoals.filter((goal) => goal.status === "active");
  const text = normalizeMatchText([input.actionTitle, input.actionDescription, input.evidence].filter(Boolean).join(" "));
  const signals = signalsForText(text);

  if (signals.has("finance_risk")) {
    return noGoalLink("risk actions are handled by guardrails, not linked as normal actions");
  }

  let best: GoalLinkResult = noGoalLink("no active goal matched action keywords");

  for (const goal of activeGoals) {
    const score = scoreGoal(goal, text, signals);

    if (score.confidence > best.confidence) {
      best = {
        goalId: goal.id,
        goalSlug: goal.templateId ?? null,
        confidence: score.confidence,
        reason: score.reason,
        matchedGoalTitle: goal.title
      };
    }
  }

  return best.confidence >= minimumConfidence ? best : noGoalLink("no active goal reached link confidence threshold");
}

function scoreGoal(goal: Goal, text: string, signals: Set<GoalSignal>): { confidence: number; reason: string } {
  const templateId = goal.templateId ?? "";
  const category = normalizeMatchText(goal.category);
  const title = normalizeMatchText(goal.title);
  const titleWords = title.split(" ").filter((word) => word.length >= 4);
  const sharedTitleWords = titleWords.filter((word) => text.includes(word));
  let confidence = 0;
  let reason = "";

  if ((templateId === "career.job_search" || category.includes("career")) && signals.has("career")) {
    confidence = 0.95;
    reason = "career/job-search action matched active goal";
  }

  if ((templateId.includes("health") || category.includes("health")) && signals.has("health")) {
    confidence = Math.max(confidence, 0.9);
    reason ||= "health action matched active goal";
  }

  if ((templateId.includes("learning") || category.includes("learning")) && signals.has("learning")) {
    confidence = Math.max(confidence, 0.9);
    reason ||= "learning action matched active goal";
  }

  if ((templateId.includes("creative") || category.includes("creative") || title.includes("youtube")) && signals.has("youtube")) {
    confidence = Math.max(confidence, 0.95);
    reason ||= "YouTube/content action matched active creative goal";
  }

  if ((title.includes("car") || category.includes("custom")) && signals.has("car")) {
    confidence = Math.max(confidence, 0.9);
    reason ||= "car-search action matched active custom goal";
  }

  if ((templateId.includes("creative") || category.includes("creative")) && signals.has("creative")) {
    confidence = Math.max(confidence, 0.8);
    reason ||= "creative/build action matched active goal";
  }

  if ((templateId.includes("social") || category.includes("social")) && signals.has("social")) {
    confidence = Math.max(confidence, 0.85);
    reason ||= "social action matched active goal";
  }

  if ((templateId.includes("work") || category.includes("work")) && signals.has("work")) {
    confidence = Math.max(confidence, 0.8);
    reason ||= "work action matched active goal";
  }

  if (sharedTitleWords.length > 0) {
    confidence = Math.max(confidence, Math.min(0.85, 0.55 + sharedTitleWords.length * 0.15));
    reason ||= "action shares keywords with active goal title";
  }

  return { confidence, reason: reason || "no keyword match" };
}

function signalsForText(text: string): Set<GoalSignal> {
  const signals = new Set<GoalSignal>();

  if (/\b(cv|resume|application|applications|apply|job|jobs|recruiter|interview|portfolio)\b/.test(text)) {
    signals.add("career");
  }

  if (/\b(train|training|workout|gym|run|steps|sleep|energy|legs|push|pull)\b/.test(text)) {
    signals.add("health");
  }

  if (/\b(read|reading|book|study|course|practice|learn|notes)\b/.test(text)) {
    signals.add("learning");
  }

  if (/\b(youtube|channel|script|video|edit|upload|thumbnail|content)\b/.test(text)) {
    signals.add("youtube");
  }

  if (/\b(car|cars|dealership|listing|listings|insurance|mechanic)\b/.test(text)) {
    signals.add("car");
  }

  if (/\b(bet|betting|gamble|apuesta|apostar|polymarket|trade|trading|long|short|leverage)\b/.test(text)) {
    signals.add("finance_risk");
  }

  if (/\b(build|write|publish|design|ship|create)\b/.test(text)) {
    signals.add("creative");
  }

  if (/\b(friend|family|call|message|conversation|meet|social)\b/.test(text)) {
    signals.add("social");
  }

  if (/\b(review|dashboard|client|project|task|deadline|send|follow up)\b/.test(text)) {
    signals.add("work");
  }

  return signals;
}

function noGoalLink(reason: string): GoalLinkResult {
  return {
    goalId: null,
    goalSlug: null,
    confidence: 0,
    reason
  };
}

function normalizeMatchText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
