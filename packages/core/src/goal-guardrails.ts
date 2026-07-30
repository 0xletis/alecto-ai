import { z } from "zod";
import type { Goal } from "./goals.js";

export const GoalGuardrailPolicySchema = z.object({
  id: z.string(),
  goalId: z.string().optional(),
  goalTemplateSlug: z.string().optional(),
  name: z.string(),
  status: z.enum(["active", "archived"]),
  category: z.enum([
    "impulse_control",
    "avoidance_control",
    "consistency_control",
    "financial_risk",
    "self_sabotage",
    "custom"
  ]),
  severity: z.enum(["soft", "medium", "hard"]),
  responseMode: z.enum(["coach", "guardian", "fiscal", "planner"]),
  blockedActionCreation: z.boolean(),
  cooldownRequired: z.boolean(),
  triggerConfig: z.record(z.unknown()).optional(),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional()
});

export const GuardrailEvaluationResultSchema = z.object({
  triggered: z.boolean(),
  confidence: z.number().min(0).max(1),
  guardrailCategory: GoalGuardrailPolicySchema.shape.category.optional(),
  severity: GoalGuardrailPolicySchema.shape.severity.optional(),
  responseMode: GoalGuardrailPolicySchema.shape.responseMode.optional(),
  goalId: z.string().optional(),
  goalTitle: z.string().optional(),
  blockedActionCreation: z.boolean(),
  cooldownRequired: z.boolean(),
  reason: z.string(),
  evidence: z.string().optional(),
  isReferenceOnly: z.boolean()
});

export type GoalGuardrailPolicy = z.infer<typeof GoalGuardrailPolicySchema>;
export type GuardrailEvaluationResult = z.infer<typeof GuardrailEvaluationResultSchema>;

export interface EvaluateGoalGuardrailsInput {
  text: string;
  activeGoals?: Goal[];
}

const directFinancialRiskPattern =
  /\b(quiero apostar|voy a apostar|i want to bet|i'?m going to bet|place bet|make a bet|remind me to bet|bet\s+\d+|apuesta\s+\d+|apostar\s+\d+|quiero tradear|voy a tradear|i want to trade|open\s+\d+x\s+(?:long|short)|\d+x\s+(?:long|short)|long|short|leverage)\b/i;
const financialRiskKeywordPattern = /\b(bet|betting|gamble|gambling|apuesta|apostar|polymarket|trade|trading|long|short|leverage)\b/i;
const certaintyRiskPattern = /\b(safe|sure|guaranteed|seguro|casi seguro|free money)\b/i;

export function evaluateGoalGuardrails(input: EvaluateGoalGuardrailsInput): GuardrailEvaluationResult {
  const text = input.text.trim();
  const referenceOnly = isReferenceOrExampleText(text);

  if (referenceOnly) {
    return noGuardrail("risky text appears in reference/example context", true);
  }

  if (isLowImpulseStatusLog(text)) {
    return noGuardrail("message describes impulse state instead of requesting risky action", false);
  }

  if (isFinancialGuardrailText(text)) {
    const goal = findFinancialGuardrailGoal(input.activeGoals ?? []);

    return GuardrailEvaluationResultSchema.parse({
      triggered: true,
      confidence: 0.95,
      guardrailCategory: "impulse_control",
      severity: "hard",
      responseMode: "guardian",
      goalId: goal?.id,
      goalTitle: goal?.title ?? "Control impulsive betting",
      blockedActionCreation: true,
      cooldownRequired: true,
      reason: "direct impulse-control violation",
      evidence: text,
      isReferenceOnly: false
    });
  }

  return noGuardrail("no goal guardrail matched", false);
}

export function isGoalGuardrailText(text: string): boolean {
  return evaluateGoalGuardrails({ text }).triggered;
}

export function isReferenceOrExampleText(text: string): boolean {
  const trimmed = text.trim();

  if (!financialRiskKeywordPattern.test(trimmed)) {
    return false;
  }

  if (/```[\s\S]*```/.test(trimmed)) {
    return true;
  }

  if (/\b(you are working in|do not redesign|requirements:|expected:|tests:|examples?:|observed:|actual:|problem observed|debug output|stack trace|telegram bot error)\b/i.test(trimmed)) {
    return true;
  }

  return trimmed
    .split(/\n+/)
    .some((line) => /^(expected|tests?|examples?|observed|actual|problem|requirements?)\s*:/i.test(line.trim()));
}

function isFinancialGuardrailText(text: string): boolean {
  return directFinancialRiskPattern.test(text) || (financialRiskKeywordPattern.test(text) && certaintyRiskPattern.test(text));
}

function isLowImpulseStatusLog(text: string): boolean {
  return /\b(no|sin)\s+(?:gambling|betting|trading|apuesta|apuestas)?\s*impulse\b/i.test(text);
}

function findFinancialGuardrailGoal(activeGoals: Goal[]): Goal | undefined {
  return activeGoals.find((goal) => {
    if (goal.status !== "active") {
      return false;
    }

    const text = `${goal.templateId ?? ""} ${goal.category} ${goal.title}`.toLowerCase();
    return /\b(finance\.control_betting_trading|betting|trading|gambling|impulse|apuesta|apostar)\b/.test(text);
  });
}

function noGuardrail(reason: string, isReferenceOnly: boolean): GuardrailEvaluationResult {
  return GuardrailEvaluationResultSchema.parse({
    triggered: false,
    confidence: isReferenceOnly ? 0.9 : 0,
    blockedActionCreation: false,
    cooldownRequired: false,
    reason,
    isReferenceOnly
  });
}
