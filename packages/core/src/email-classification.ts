import { z } from "zod";
import { routeIngestion } from "./ingestion.js";

export const EmailClassificationSchema = z.object({
  decision: z.enum(["log_event", "needs_review", "ignore"]),
  eventType: z.string().optional(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  evidence: z.string(),
  extracted: z
    .object({
      company: z.string().optional(),
      role: z.string().optional(),
      deadline: z.string().optional(),
      actionRequired: z.boolean().optional()
    })
    .passthrough()
    .default({}),
  metadata: z.object({
    classifierMode: z.enum(["rules", "llm", "hybrid"]),
    adapterId: z.string(),
    source: z.literal("gmail"),
    classifier: z.enum(["rules", "llm"]).optional()
  })
});

export type EmailClassification = z.infer<typeof EmailClassificationSchema>;

export interface ClassifyJobSearchEmailInput {
  text: string;
  classifierMode?: "rules" | "llm" | "hybrid";
  llmAvailable?: boolean;
}

export type ClassifyWorkActionEmailInput = ClassifyJobSearchEmailInput;

export function classifyJobSearchEmail(input: ClassifyJobSearchEmailInput): EmailClassification {
  const classifierMode = input.classifierMode ?? "rules";

  if (classifierMode === "llm" && !input.llmAvailable) {
    return EmailClassificationSchema.parse({
      decision: "needs_review",
      confidence: 0.65,
      reason: "LLM classifier unavailable",
      evidence: input.text.slice(0, 300),
      extracted: {},
      metadata: {
        classifierMode,
        adapterId: "job_search_email",
        source: "gmail",
        classifier: "llm"
      }
    });
  }

  const result = routeIngestion({
    userId: "email-classifier",
    text: input.text,
    source: "gmail",
    metadata: {
      domainHint: "career",
      emailAdapterId: "job_search_email"
    }
  });
  const candidate = result.eventCandidates[0];
  const actionRequired = result.classification === "application_action_required";
  const decision =
    result.classification === "filtered_marketing" || result.classification === "unknown"
      ? "ignore"
      : actionRequired
        ? "needs_review"
        : candidate
          ? "log_event"
          : "ignore";

  return EmailClassificationSchema.parse({
    decision,
    eventType: candidate?.type,
    confidence: result.confidence,
    reason: result.classification,
    evidence: input.text.slice(0, 300),
    extracted: {
      ...result.extracted,
      ...(actionRequired ? { actionRequired: true } : {})
    },
    metadata: {
      classifierMode: classifierMode === "hybrid" ? "rules" : classifierMode,
      adapterId: "job_search_email",
      source: "gmail",
      classifier: "rules"
    }
  });
}

export function classifyWorkActionEmail(input: ClassifyWorkActionEmailInput): EmailClassification {
  const classifierMode = input.classifierMode ?? "rules";
  const text = normalizeEmailText(input.text);

  if (isIgnoredWorkEmail(text)) {
    return EmailClassificationSchema.parse({
      decision: "ignore",
      confidence: 0.1,
      reason: "filtered_non_action_email",
      evidence: input.text.slice(0, 300),
      extracted: {},
      metadata: {
        classifierMode: classifierMode === "hybrid" ? "rules" : classifierMode,
        adapterId: "work_action_email",
        source: "gmail",
        classifier: "rules"
      }
    });
  }

  if (classifierMode === "llm" && !input.llmAvailable) {
    return EmailClassificationSchema.parse({
      decision: "needs_review",
      confidence: 0.7,
      reason: "LLM classifier unavailable",
      evidence: input.text.slice(0, 300),
      extracted: {},
      metadata: {
        classifierMode,
        adapterId: "work_action_email",
        source: "gmail",
        classifier: "llm"
      }
    });
  }

  const extracted = extractWorkActionFields(input.text);
  const classification = classifyWorkActionText(text);
  const eventType = eventTypeForWorkActionClassification(classification);
  const confidence = confidenceForWorkActionClassification(classification);
  const decision = classification === "unknown" ? "ignore" : eventType ? "log_event" : "needs_review";

  return EmailClassificationSchema.parse({
    decision,
    eventType: eventType ?? (classification === "unknown" ? undefined : classification),
    confidence,
    reason: classification,
    evidence: input.text.slice(0, 300),
    extracted,
    metadata: {
      classifierMode: classifierMode === "hybrid" ? "rules" : classifierMode,
      adapterId: "work_action_email",
      source: "gmail",
      classifier: "rules"
    }
  });
}

function classifyWorkActionText(text: string): string {
  if (hasAnyEmailPhrase(text, ["feedback", "comments on", "review notes", "my notes", "suggested changes"])) {
    return "work.feedback_received";
  }

  if (hasAnyEmailPhrase(text, ["blocked", "blocker", "waiting on", "dependency", "depends on", "stuck because"])) {
    return "work.blocker_reported";
  }

  if (hasAnyEmailPhrase(text, ["completed", "done", "shipped", "finished"]) && hasAnyEmailPhrase(text, ["task", "todo", "to do", "item"])) {
    return "work.task_completed";
  }

  if (hasAnyEmailPhrase(text, ["milestone", "launched", "release is live", "project update", "status update"])) {
    return "work.project_milestone_completed";
  }

  if (hasAnyEmailPhrase(text, ["deadline", "due", "due date", "by tomorrow", "by friday", "eod", "end of day"])) {
    return "work_deadline_detected";
  }

  if (hasAnyEmailPhrase(text, ["follow up", "following up", "circle back", "can you", "could you", "please review", "please send", "action required"])) {
    return "work_follow_up_requested";
  }

  if (hasAnyEmailPhrase(text, ["please", "todo", "to do", "need you to", "assigned to you"])) {
    return "work_action_required";
  }

  return "unknown";
}

function eventTypeForWorkActionClassification(classification: string): string | undefined {
  return [
    "work.feedback_received",
    "work.blocker_reported",
    "work.task_completed",
    "work.project_milestone_completed"
  ].includes(classification)
    ? classification
    : undefined;
}

function confidenceForWorkActionClassification(classification: string): number {
  if (classification === "unknown" || classification === "filtered_non_action_email") {
    return 0.2;
  }

  return classification.startsWith("work.") ? 0.82 : 0.75;
}

function isIgnoredWorkEmail(text: string): boolean {
  const authOrSecurity = hasAnyEmailPhrase(text, [
    "confirm this login",
    "confirm login",
    "login attempt",
    "verification code",
    "security code",
    "password reset",
    "2fa",
    "two-factor",
    "access code",
    "login code",
    "new sign-in"
  ]);

  const marketingOrPromo = hasAnyEmailPhrase(text, [
    "newsletter",
    "unsubscribe",
    "sale",
    "rebajas",
    "best sellers",
    "los mas vendidos",
    "promotion",
    "promo",
    "discount",
    "cashback",
    "points",
    "revpoints",
    "privilege",
    "birthday gift",
    "webinar",
    "event invitation",
    "reinvent promo",
    "re:invent",
    "aws re:invent",
    "product announcement",
    "boost your",
    "get up to",
    "stays with revpoints"
  ]);

  const accountAdmin = hasAnyEmailPhrase(text, [
    "privacy notice",
    "privacy notices",
    "terms update",
    "account update",
    "confirm your occupation",
    "confirm your identity",
    "occupation confirmation",
    "kyc",
    "know your customer",
    "bank compliance",
    "finance compliance",
    "payment notice",
    "card notice",
    "crypto deposit",
    "deposit notice",
    "receipt",
    "invoice paid",
    "we need to confirm your occupation",
    "we're updating our privacy",
    "we are updating our privacy"
  ]);

  if (authOrSecurity || marketingOrPromo || accountAdmin) {
    return true;
  }

  const noisySender = hasAnyEmailPhrase(text, [
    "from: noreply",
    "from: no-reply",
    "from: donotreply",
    "from: do-not-reply",
    "noreply@",
    "no-reply@",
    "donotreply@",
    "do-not-reply@",
    "marketing@"
  ]);

  const clearWorkTool = hasAnyEmailPhrase(text, [
    "jira",
    "linear",
    "asana",
    "notion",
    "github",
    "gitlab",
    "slack",
    "monday.com",
    "trello"
  ]);
  const explicitWorkAction = hasAnyEmailPhrase(text, [
    "can you review",
    "please review",
    "please send",
    "deadline",
    "due by",
    "blocked by",
    "waiting on you",
    "feedback requested"
  ]);

  if (noisySender && !(clearWorkTool && explicitWorkAction)) {
    return true;
  }

  return hasAnyEmailPhrase(text, [
    "social notification",
    "liked your post",
    "product update",
    "release notes",
    "no-reply announcement"
  ]);
}

function extractWorkActionFields(text: string): Record<string, unknown> {
  const project = matchFirstEmail(text, [/\b(?:project|client|repo)\s*[:\-]\s*([A-Za-z0-9&.\- /]{2,60})/i]);
  const deadline = matchFirstEmail(text, [
    /\b(?:due|deadline)\s*(?:date)?\s*[:\-]?\s*([A-Za-z0-9, ]{2,40})/i,
    /\bby\s+((?:tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|eod|end of day)\b)/i
  ]);

  return {
    ...(project ? { project: cleanEmailText(project) } : {}),
    ...(deadline ? { deadline: cleanEmailText(deadline) } : {}),
    ...(hasAnyEmailPhrase(normalizeEmailText(text), ["can you", "could you", "please", "action required", "deadline", "due"])
      ? { actionRequired: true }
      : {}),
    ...(hasAnyEmailPhrase(normalizeEmailText(text), ["feedback", "blocked", "follow up", "deadline"])
      ? { senderIntent: classifyWorkActionText(normalizeEmailText(text)) }
      : {})
  };
}

function normalizeEmailText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAnyEmailPhrase(text: string, phrases: string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

function matchFirstEmail(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}

function cleanEmailText(text: string): string {
  return text.replace(/[,.!?;:]+$/g, "").trim();
}
