import { z } from "zod";
import { GoalPrioritySchema } from "./goals.js";

const compactText = z.string().trim().min(1);

export const DailyBriefContextSchema = z.object({
  date: z.string().min(1),
  timezone: z.string().min(1),
  activeGoals: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      priority: GoalPrioritySchema,
      importanceScore: z.number().nullable().optional(),
      statusToday: z.string(),
      openLinkedActions: z.array(z.string()).default([]),
      completedLinkedActionsToday: z.array(z.string()).default([]),
      guardrailActivityToday: z.array(z.string()).default([])
    })
  ),
  scoredPriorities: z.array(
    z.object({
      actionId: z.string(),
      title: z.string(),
      dueAt: z.string().optional(),
      dueLabel: z.string(),
      score: z.number(),
      rankReason: z.string(),
      linkedGoalTitle: z.string().optional(),
      linkedGoalPriority: GoalPrioritySchema.optional()
    })
  ),
  recentWins: z.array(z.string()).default([]),
  risksOrWatchouts: z.array(z.string()).default([]),
  nextMove: z.string().min(1),
  userOperatingProfile: z
    .object({
      directness: z.number(),
      warmth: z.number(),
      confrontation: z.number(),
      verbosity: z.number(),
      preferredStyle: z.string()
    })
    .optional()
});

export const DailyCoachResponseSchema = z.object({
  diagnosis: compactText,
  nextMove: compactText,
  warning: z.string().trim().min(1).nullable(),
  encouragement: z.string().trim().min(1).nullable()
});

export type DailyBriefContext = z.infer<typeof DailyBriefContextSchema>;
export type DailyCoachResponse = z.infer<typeof DailyCoachResponseSchema>;
export type DailyCoachValidationFailureCode =
  | "invalid_json"
  | "schema_missing_field"
  | "schema_invalid"
  | "too_long"
  | "unknown_action_or_goal"
  | "next_move_mismatch"
  | "priority_reordered"
  | "unsafe_guardrail_advice";

export class DailyCoachValidationError extends Error {
  constructor(
    public readonly failureCodes: DailyCoachValidationFailureCode[],
    public readonly details: DailyCoachValidationDetails = {},
    message = "Daily coach response failed validation."
  ) {
    super(message);
  }
}

export interface DailyCoachValidationDetails {
  rawResponseType?: "json_object" | "text" | "empty" | "unknown";
  parsedFieldsPresent?: string[];
  responseLength?: number;
  diagnosisLength?: number;
  nextMoveLength?: number;
  warningLength?: number;
  encouragementLength?: number;
}

export function buildDeterministicDailyCoachResponse(context: DailyBriefContext): DailyCoachResponse {
  const topPriority = context.scoredPriorities[0];
  const topGoal = topPriority?.linkedGoalTitle ? ` because it supports ${topPriority.linkedGoalTitle}` : "";
  const diagnosis =
    topPriority
      ? `Highest priority is ${topPriority.title}${topGoal}.`
      : context.activeGoals.length > 0
        ? "No concrete action is queued yet. The day needs one explicit move."
        : "No goals or actions are active yet. Keep the brief factual.";
  const warning = deterministicDailyCoachWarning(context);

  return DailyCoachResponseSchema.parse({
    diagnosis,
    nextMove: context.nextMove,
    warning,
    encouragement: context.recentWins.length > 0 ? "Good. Keep it factual and finish the next move." : null
  });
}

export function validateDailyCoachResponseAgainstContext(
  response: unknown,
  context: DailyBriefContext
): DailyCoachResponse {
  const failureCodes: DailyCoachValidationFailureCode[] = [];
  const schemaResult = DailyCoachResponseSchema.safeParse(response);

  if (!schemaResult.success) {
    failureCodes.push(hasMissingRequiredField(response) ? "schema_missing_field" : "schema_invalid");
    throw new DailyCoachValidationError(uniqueFailureCodes(failureCodes), {
      parsedFieldsPresent: parsedFieldsPresent(response),
      ...responseLengthDetails(response),
      rawResponseType: rawResponseType(response)
    });
  }

  const parsed = schemaResult.data;
  collectCoachTextFitFailures(parsed, failureCodes);
  collectKnownStateFailures(parsed, context, failureCodes);
  collectBettingAdviceFailures(parsed, failureCodes);
  collectNextMoveFailures(parsed, context, failureCodes);

  if (failureCodes.length > 0) {
    throw new DailyCoachValidationError(uniqueFailureCodes(failureCodes), {
      parsedFieldsPresent: parsedFieldsPresent(parsed),
      ...responseLengthDetails(parsed),
      rawResponseType: "json_object"
    });
  }

  return parsed;
}

export function selectedDailyCoachActionTitle(context: DailyBriefContext): string | undefined {
  return context.scoredPriorities[0]?.title;
}

export function deterministicDailyCoachWarning(context: DailyBriefContext): string | null {
  const risk = context.risksOrWatchouts[0];

  if (!risk) {
    return null;
  }

  const riskGoal = context.activeGoals.find(
    (goal) =>
      goal.guardrailActivityToday.length > 0 ||
      /\b(betting|trading|gambling|impulse|risk)\b/i.test(`${goal.title} ${goal.statusToday}`)
  );

  if (riskGoal && /\b(bet|betting|trade|trading|gambling|impulse|guardrail|cooldown)\b/i.test(risk)) {
    return `Keep the ${riskGoal.title} guardrail locked today.`;
  }

  if (/\b(bet|betting|trade|trading|gambling|impulse|guardrail|cooldown)\b/i.test(risk)) {
    return "Keep the betting/trading guardrail locked today.";
  }

  return risk;
}

function collectCoachTextFitFailures(
  response: DailyCoachResponse,
  failureCodes: DailyCoachValidationFailureCode[]
) {
  const sentenceLimits: Array<[keyof DailyCoachResponse, number]> = [
    ["diagnosis", 2],
    ["nextMove", 1],
    ["warning", 1],
    ["encouragement", 1]
  ];
  const charLimits: Array<[keyof DailyCoachResponse, number]> = [
    ["diagnosis", 240],
    ["nextMove", 140],
    ["warning", 160],
    ["encouragement", 160]
  ];

  for (const [key, maxSentences] of sentenceLimits) {
    const value = response[key];

    if (typeof value === "string" && countSentences(value) > maxSentences) {
      failureCodes.push("too_long");
    }
  }

  for (const [key, maxChars] of charLimits) {
    const value = response[key];

    if (typeof value === "string" && value.length > maxChars) {
      failureCodes.push("too_long");
    }
  }

  if (totalCoachTextLength(response) > 700) {
    failureCodes.push("too_long");
  }
}

function collectKnownStateFailures(
  response: DailyCoachResponse,
  context: DailyBriefContext,
  failureCodes: DailyCoachValidationFailureCode[]
) {
  const knownPhrases = new Set<string>();

  for (const action of context.scoredPriorities) {
    knownPhrases.add(normalizePhrase(action.title));
    if (action.linkedGoalTitle) {
      knownPhrases.add(normalizePhrase(action.linkedGoalTitle));
    }
  }

  for (const goal of context.activeGoals) {
    knownPhrases.add(normalizePhrase(goal.title));
    goal.openLinkedActions.forEach((action) => knownPhrases.add(normalizePhrase(action)));
    goal.completedLinkedActionsToday.forEach((action) => knownPhrases.add(normalizePhrase(action)));
  }

  const knownText = [
    context.nextMove,
    ...context.recentWins,
    ...context.risksOrWatchouts,
    ...Array.from(knownPhrases)
  ]
    .map(normalizePhrase)
    .join(" ");
  const responseText = normalizePhrase(Object.values(response).filter(Boolean).join(" "));

  for (const phrase of extractCapitalizedUnknownPhrases(responseText)) {
    if (phrase.length > 3 && !knownText.includes(phrase)) {
      failureCodes.push("unknown_action_or_goal");
    }
  }
}

function collectBettingAdviceFailures(
  response: DailyCoachResponse,
  failureCodes: DailyCoachValidationFailureCode[]
) {
  const text = Object.values(response).filter(Boolean).join(" ");

  if (hasUnsafeBettingOrTradingAdvice(text)) {
    failureCodes.push("unsafe_guardrail_advice");
  }
}

function collectNextMoveFailures(
  response: DailyCoachResponse,
  context: DailyBriefContext,
  failureCodes: DailyCoachValidationFailureCode[]
) {
  const selectedTitle = selectedDailyCoachActionTitle(context);

  if (!selectedTitle) {
    if (normalizePhrase(response.nextMove) !== normalizePhrase(context.nextMove)) {
      failureCodes.push("next_move_mismatch");
    }

    return;
  }

  if (!textMentionsTitle(response.nextMove, selectedTitle)) {
    failureCodes.push("next_move_mismatch");
  }

  for (const otherPriority of context.scoredPriorities.slice(1)) {
    if (textMentionsTitle(response.nextMove, otherPriority.title)) {
      failureCodes.push("priority_reordered");
    }
  }
}

function countSentences(text: string): number {
  return text.split(/[.!?]+/).map((part) => part.trim()).filter(Boolean).length;
}

function hasUnsafeBettingOrTradingAdvice(text: string): boolean {
  const lower = text.toLowerCase();
  const unsafePatterns = [
    /\b(?:you\s+)?(?:can|could|may|might)\s+(?:still\s+)?(?:bet|trade|open|enter|take)\b/,
    /\b(?:bet|trade)\s+(?:if|when|only if)\b/,
    /\b(?:only\s+)?(?:bet|trade)\s+small\b/,
    /\bsmall\s+(?:bet|trade|position)\s+(?:is|would be|seems)\s+(?:ok|okay|fine|safe)\b/,
    /\blook\s+for\s+(?:a\s+)?(?:better\s+)?(?:entry|setup)\b/,
    /\b(?:use|set|place)\s+(?:a\s+)?stop\s*loss\b/,
    /\b(?:size|sizing|size down|size up|position size)\b/,
    /\bwait\s+for\s+confirmation\s+before\s+(?:betting|trading|entering|opening)\b/,
    /\b(?:open|enter|take|place)\s+(?:the\s+|a\s+)?(?:long|short|bet|trade|position)\b/,
    /\b(?:optimi[sz]e|justify|time)\s+(?:the\s+|a\s+)?(?:bet|trade|entry|position)\b/,
    /\b(?:thesis|odds|entry|setup)\b.{0,40}\b(?:bet|trade|position)\b/,
    /\b(?:bet|trade|position)\b.{0,40}\b(?:thesis|odds|entry|setup)\b/
  ];

  return unsafePatterns.some((pattern) => pattern.test(lower));
}

function normalizePhrase(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function textMentionsTitle(text: string, title: string): boolean {
  const normalizedText = normalizePhrase(text);
  const normalizedTitle = normalizePhrase(title);

  if (normalizedText.includes(normalizedTitle)) {
    return true;
  }

  const titleWords = normalizedTitle.split(" ").filter((word) => word.length > 1);

  if (titleWords.length === 0) {
    return false;
  }

  return titleWords.every((word) => normalizedText.includes(word));
}

function hasMissingRequiredField(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return ["diagnosis", "nextMove", "warning", "encouragement"].some((field) => !(field in record));
}

function uniqueFailureCodes(codes: DailyCoachValidationFailureCode[]): DailyCoachValidationFailureCode[] {
  return Array.from(new Set(codes));
}

function parsedFieldsPresent(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  return ["diagnosis", "nextMove", "warning", "encouragement"].filter((field) => field in record);
}

function responseLengthDetails(value: unknown): Pick<
  DailyCoachValidationDetails,
  "responseLength" | "diagnosisLength" | "nextMoveLength" | "warningLength" | "encouragementLength"
> {
  const base = {
    responseLength: approximateResponseLength(value),
    diagnosisLength: undefined,
    nextMoveLength: undefined,
    warningLength: undefined,
    encouragementLength: undefined
  };

  if (!value || typeof value !== "object") {
    return base;
  }

  const record = value as Record<string, unknown>;

  return {
    ...base,
    diagnosisLength: typeof record.diagnosis === "string" ? record.diagnosis.length : undefined,
    nextMoveLength: typeof record.nextMove === "string" ? record.nextMove.length : undefined,
    warningLength: typeof record.warning === "string" ? record.warning.length : undefined,
    encouragementLength: typeof record.encouragement === "string" ? record.encouragement.length : undefined
  };
}

function approximateResponseLength(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }

  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function totalCoachTextLength(response: DailyCoachResponse): number {
  return Object.values(response).filter((value): value is string => typeof value === "string").join("").length;
}

function rawResponseType(value: unknown): "json_object" | "text" | "empty" | "unknown" {
  if (value === undefined || value === null || value === "") {
    return "empty";
  }

  if (typeof value === "string") {
    return "text";
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return "json_object";
  }

  return "unknown";
}

function extractCapitalizedUnknownPhrases(normalizedText: string): string[] {
  const banned = [
    "call investor",
    "pitch deck",
    "market analysis",
    "crypto trade",
    "new workout plan",
    "client proposal"
  ];

  return banned.filter((phrase) => normalizedText.includes(phrase));
}
