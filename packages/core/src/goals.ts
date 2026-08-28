import { z } from "zod";

export const GoalStatusSchema = z.enum(["active", "paused", "archived"]);
export const GoalPrioritySchema = z.enum(["low", "medium", "high", "critical"]);
export const MetricAggregationSchema = z.enum(["count", "sum", "average", "latest"]);
export const MetricWindowSchema = z.enum(["daily", "weekly"]);
export const CheckInAnswerTypeSchema = z.enum(["text", "number", "scale_1_10", "yes_no"]);

export const GoalMetricSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  /** Singular form of `label`, e.g. label "CVs sent" -> labelSingular "CV sent" — used whenever a
   * count of exactly 1 is shown ("1 CV sent" instead of the grammatically wrong "1 CVs sent"). No
   * general pluralization heuristic can reliably guess this from `label` alone (the countable noun
   * isn't always the first or last word — "recruiter replies" vs "CVs sent"), so it's supplied
   * directly at proposal time instead. Optional and additive (stored as JSON, no migration needed)
   * — a goal created before this field existed just falls back to `label` at count 1, unchanged
   * prior behavior. */
  labelSingular: z.string().optional(),
  eventType: z.string().optional(),
  /** Adaptive Goal Creation MVP (docs/10-v3-readiness-audit.md §21): a free-form per-goal signal
   * discriminator (e.g. "tea_cups_drunk", "called_grandmother") for a metric that ISN'T backed by
   * a registered EventType. When set, evidence for this metric is logged as a generic
   * "custom.goal_progress_logged" event with `data.signalKey` set to this value — targetMetrics
   * is stored as JSON, so this needed no schema migration, only this additive Zod field. A metric
   * sets either `eventType` (a real registry type, e.g. career.application_sent) or `signalKey`
   * (a custom one), never neither — see goal-evidence.ts's countEvidenceForMetric. */
  signalKey: z.string().optional(),
  aggregation: MetricAggregationSchema,
  window: MetricWindowSchema,
  unit: z.string().optional()
});

export const GoalCheckInQuestionSchema = z.object({
  key: z.string().min(1),
  question: z.string().min(1),
  answerType: CheckInAnswerTypeSchema,
  /** Free-text cadence as the plan proposed it (e.g. "weekly", "evening") — additive field, kept
   * loose (not MetricWindowSchema) since a check-in cadence like "morning"/"evening" isn't a
   * metric aggregation window. Optional so pre-existing stored rows without it still parse. */
  cadence: z.string().optional()
});

export const GoalSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string().min(1),
  category: z.string().min(1),
  status: GoalStatusSchema.default("active"),
  priority: GoalPrioritySchema.default("medium"),
  importanceScore: z.number().nullable().optional(),
  priorityReason: z.string().optional(),
  why: z.string().optional(),
  templateId: z.string().optional(),
  targetMetrics: z.array(GoalMetricSchema).optional(),
  checkInConfig: z.array(GoalCheckInQuestionSchema).optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  /**
   * fix/private-alpha-goal-restore-ambiguity-resolution: when this goal was archived — set fresh
   * by setGoalStatus whenever status transitions TO "archived", cleared whenever it transitions
   * AWAY from "archived" (restored or paused). A dedicated column rather than reusing `updatedAt`
   * (which any other field write would also bump, making it an unreliable proxy for "archived
   * at") — mirrors the same real, explicit archivedAt column the Event model already has for the
   * identical reason. Undefined for a goal that's never been archived.
   */
  archivedAt: z.coerce.date().nullable().optional()
});

export const CreateGoalInputSchema = z.object({
  title: z.string().min(1),
  category: z.string().min(1),
  why: z.string().optional(),
  templateId: z.string().optional(),
  priority: GoalPrioritySchema.optional(),
  importanceScore: z.number().nullable().optional(),
  priorityReason: z.string().optional(),
  targetMetrics: z.array(GoalMetricSchema).optional(),
  checkInConfig: z.array(GoalCheckInQuestionSchema).optional(),
  allowDuplicate: z.boolean().optional()
});

export const CreateGoalFromTemplateInputSchema = z.object({
  templateId: z.string().min(1),
  title: z.string().min(1),
  why: z.string().optional(),
  targetMetrics: z.array(GoalMetricSchema).optional(),
  priority: GoalPrioritySchema.optional(),
  importanceScore: z.number().nullable().optional(),
  priorityReason: z.string().optional(),
  allowDuplicate: z.boolean().optional()
});

export type GoalStatus = z.infer<typeof GoalStatusSchema>;
export type GoalPriority = z.infer<typeof GoalPrioritySchema>;
export type GoalMetric = z.infer<typeof GoalMetricSchema>;
export type GoalCheckInQuestion = z.infer<typeof GoalCheckInQuestionSchema>;
export type Goal = z.infer<typeof GoalSchema>;
export type CreateGoalInput = z.infer<typeof CreateGoalInputSchema>;
export type CreateGoalFromTemplateInput = z.infer<typeof CreateGoalFromTemplateInputSchema>;

export const goalPriorityScores: Record<GoalPriority, number> = {
  low: 10,
  medium: 25,
  high: 45,
  critical: 70
};

export function scoreForGoalPriority(priority: GoalPriority): number {
  return goalPriorityScores[priority];
}

export function normalizeGoalPriority(priority: unknown): GoalPriority {
  return GoalPrioritySchema.safeParse(priority).success ? (priority as GoalPriority) : "medium";
}

export function defaultGoalPriority(input: Pick<Goal, "title" | "category"> & { templateId?: string }): GoalPriority {
  const templateId = input.templateId ?? "";
  const text = normalizeGoalTitle(`${input.title} ${input.category} ${templateId}`);

  if (
    templateId === "career.job_search" ||
    /\b(find )?(a )?(new )?(developer )?job\b/.test(text) ||
    /\bjob search\b/.test(text) ||
    /\bnew developer job\b/.test(text)
  ) {
    return "critical";
  }

  if (
    templateId === "finance.control_betting_trading" ||
    /\b(control betting|control impulsive betting|control betting trading|finance control betting trading)\b/.test(text) ||
    /\b(betting|trading|gambling|impulsive betting|risk control)\b/.test(text)
  ) {
    return "critical";
  }

  if (
    templateId === "health.strength_energy" ||
    templateId === "health.sleep_better" ||
    /\b(improve strength and energy|strength|gym|sleep better)\b/.test(text)
  ) {
    return "high";
  }

  if (templateId === "work.deep_work") {
    return "high";
  }

  if (templateId === "creative.build_project" || /\b(youtube|channel|video|script|build project|creative)\b/.test(text)) {
    return "medium";
  }

  if (/\b(cheap car|buy car|car|vehicle)\b/.test(text)) {
    return "low";
  }

  if (templateId === "learning.reading_more" || /\b(read more|reading)\b/.test(text)) {
    return "low";
  }

  return "medium";
}

export interface GoalDuplicateWarning {
  goalId: string;
  similarGoalId: string;
  similarGoalTitle: string;
}

export function normalizeGoalTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
}

export function findDuplicateActiveGoal(
  input: Pick<CreateGoalInput, "title" | "category" | "templateId">,
  activeGoals: Goal[]
): Goal | undefined {
  const inputTitle = normalizeGoalTitle(input.title);

  return activeGoals.find((goal) => {
    const goalTitle = normalizeGoalTitle(goal.title);

    return (
      goalTitle === inputTitle ||
      Boolean(input.templateId && goal.templateId === input.templateId) ||
      (goal.category === input.category && areSimilarGoalTitles(goalTitle, inputTitle))
    );
  });
}

export function findGoalDuplicateWarnings(goals: Goal[]): GoalDuplicateWarning[] {
  const warnings: GoalDuplicateWarning[] = [];
  const activeGoals = goals.filter((goal) => goal.status === "active");

  for (let index = 0; index < activeGoals.length; index += 1) {
    const goal = activeGoals[index];
    const duplicate = findDuplicateActiveGoal(
      {
        title: goal.title,
        category: goal.category,
        templateId: goal.templateId
      },
      activeGoals.slice(index + 1)
    );

    if (duplicate) {
      warnings.push({
        goalId: goal.id,
        similarGoalId: duplicate.id,
        similarGoalTitle: duplicate.title
      });
    }
  }

  return warnings;
}

function areSimilarGoalTitles(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }

  if (left.includes(right) || right.includes(left)) {
    return true;
  }

  const leftWords = meaningfulWords(left);
  const rightWords = meaningfulWords(right);
  const sharedWords = leftWords.filter((word) => rightWords.includes(word));
  const shortestLength = Math.min(leftWords.length, rightWords.length);

  return shortestLength > 0 && sharedWords.length / shortestLength >= 0.75;
}

function meaningfulWords(title: string): string[] {
  const stopWords = new Set(["a", "an", "and", "de", "el", "en", "la", "more", "my", "on", "the", "to", "un", "una", "y"]);
  return title.split(" ").filter((word) => word.length > 2 && !stopWords.has(word));
}
