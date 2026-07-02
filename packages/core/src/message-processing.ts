import { z } from "zod";
import { EventTypeSchema } from "./event-registry.js";
import { RiskStateSchema } from "./risk.js";

export const MessageIntentSchema = z.enum([
  "general_chat",
  "emotional_reflection",
  "goal_creation",
  "goal_update",
  "event_logging",
  "betting_intent",
  "trading_intent",
  "financial_impulse",
  "coding_help",
  "research_request",
  "daily_checkin",
  "weekly_review",
  "integration_setup",
  "memory_correction"
]);

export const AgentModeSchema = z.enum([
  "mirror",
  "support",
  "guardian",
  "builder",
  "research",
  "review",
  "fiscal"
]);

export const ProcessMessageInputSchema = z.object({
  userId: z.string().min(1),
  message: z.string().min(1)
});

export const ExtractedEventSchema = z.object({
  type: EventTypeSchema,
  data: z.record(z.unknown()).default({}),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).optional()
});

export const ProcessMessageResultSchema = z.object({
  userId: z.string(),
  message: z.string(),
  intent: MessageIntentSchema,
  mode: AgentModeSchema,
  riskState: RiskStateSchema,
  extractedEvents: z.array(ExtractedEventSchema),
  reply: z.string()
});

export type MessageIntent = z.infer<typeof MessageIntentSchema>;
export type AgentMode = z.infer<typeof AgentModeSchema>;
export type ProcessMessageInput = z.infer<typeof ProcessMessageInputSchema>;
export type ExtractedEvent = z.infer<typeof ExtractedEventSchema>;
export type ProcessMessageResult = z.infer<typeof ProcessMessageResultSchema>;

const certaintyPattern = /\b(safe|sure|guaranteed|seguro|casi seguro|free money)\b/i;

export function processMessage(input: ProcessMessageInput): ProcessMessageResult {
  const parsedInput = ProcessMessageInputSchema.parse(input);
  const intent = routeIntent(parsedInput.message);
  const extractedEvents = extractEvents(parsedInput.message);
  const finalIntent = intent === "general_chat" && extractedEvents.length > 0 ? "event_logging" : intent;
  const riskState = assessRisk(finalIntent, parsedInput.message);
  const mode = selectMode(finalIntent, riskState);
  const reply = composeReply(finalIntent, mode, riskState, extractedEvents);

  return ProcessMessageResultSchema.parse({
    userId: parsedInput.userId,
    message: parsedInput.message,
    intent: finalIntent,
    mode,
    riskState,
    extractedEvents,
    reply
  });
}

export function routeIntent(message: string): MessageIntent {
  const text = message.toLowerCase();

  if (/\b(bet|betting|gamble|apuesta|apostar|polymarket)\b/i.test(message)) {
    return "betting_intent";
  }

  if (/\b(trade|trading|long|short|leverage)\b/i.test(message)) {
    return "trading_intent";
  }

  if (/\b(code|bug|repo|typescript|next|react)\b/i.test(message)) {
    return "coding_help";
  }

  if (/\b(research|investigate|find info)\b/i.test(message)) {
    return "research_request";
  }

  if (/\b(cv|job|application|applied|recruiter|interview)\b/i.test(message)) {
    if (/\b(want|need|goal|plan|going to|quiero|necesito|objetivo)\b/i.test(message)) {
      return "goal_creation";
    }

    return "event_logging";
  }

  if (/\b(trained|gym|workout|steps|sleep)\b/i.test(message)) {
    return "event_logging";
  }

  if (text.includes("daily checkin")) {
    return "daily_checkin";
  }

  if (text.includes("weekly review")) {
    return "weekly_review";
  }

  return "general_chat";
}

export function extractEvents(message: string): ExtractedEvent[] {
  const events: ExtractedEvent[] = [];

  const applicationMatch =
    message.match(/\b(?:sent|mandado)\s+(\d+)\s+(?:cvs?|applications?)\b/i) ??
    message.match(/\b(\d+)\s+applications?\b/i);

  if (applicationMatch?.[1]) {
    events.push({
      type: "career.application_sent",
      data: { count: Number(applicationMatch[1]) },
      confidence: 0.9,
      evidence: [applicationMatch[0]]
    });
  }

  const workoutMatch = message.match(/\b(?:trained|entrenado|gym)\s+(\d+)\s*(?:minutes?|mins?|min)\b/i);

  if (workoutMatch?.[1]) {
    events.push({
      type: "health.workout_completed",
      data: { duration_minutes: Number(workoutMatch[1]) },
      confidence: 0.9,
      evidence: [workoutMatch[0]]
    });
  }

  const sleepMatch = message.match(/\b(?:slept|dormido)\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|horas?)\b/i);

  if (sleepMatch?.[1]) {
    events.push({
      type: "health.sleep_logged",
      data: { duration_hours: Number(sleepMatch[1]) },
      confidence: 0.9,
      evidence: [sleepMatch[0]]
    });
  }

  const readingMatch = message.match(/\b(?:read|le[ií]do)\s+(\d+)\s*(?:minutes?|mins?|min)\b/i);

  if (readingMatch?.[1]) {
    events.push({
      type: "learning.reading_session_completed",
      data: { duration_minutes: Number(readingMatch[1]) },
      confidence: 0.9,
      evidence: [readingMatch[0]]
    });
  }

  return events;
}

export function assessRisk(intent: MessageIntent, message: string): z.infer<typeof RiskStateSchema> {
  const isFinancialRiskIntent = intent === "betting_intent" || intent === "trading_intent";

  if (!isFinancialRiskIntent) {
    return "GREEN";
  }

  return certaintyPattern.test(message) ? "RED" : "ORANGE";
}

function selectMode(intent: MessageIntent, riskState: z.infer<typeof RiskStateSchema>): AgentMode {
  if (riskState === "RED" || riskState === "ORANGE" || intent === "financial_impulse") {
    return "guardian";
  }

  if (intent === "coding_help") {
    return "builder";
  }

  if (intent === "research_request") {
    return "research";
  }

  if (intent === "daily_checkin" || intent === "weekly_review") {
    return "review";
  }

  if (intent === "event_logging" || intent === "goal_creation" || intent === "goal_update") {
    return "fiscal";
  }

  if (intent === "emotional_reflection") {
    return "support";
  }

  return "mirror";
}

function composeReply(
  intent: MessageIntent,
  _mode: AgentMode,
  riskState: z.infer<typeof RiskStateSchema>,
  extractedEvents: ExtractedEvent[]
): string {
  if ((intent === "betting_intent" || intent === "trading_intent") && riskState === "RED") {
    return "No. I am not validating this while you are using certainty language. Cooldown first. If it still makes sense later, bring a written thesis, position size, invalidation point, and your current emotional state.";
  }

  if ((intent === "betting_intent" || intent === "trading_intent") && riskState === "ORANGE") {
    return "Guardian mode. Before any action, write the thesis, size, invalidation point, and emotional state. If you cannot do that clearly, it is not ready.";
  }

  if (intent === "event_logging" && extractedEvents.length > 0) {
    const eventList = extractedEvents.map((event) => event.type).join(", ");
    return `Logged ${extractedEvents.length} event(s): ${eventList}.`;
  }

  if (intent === "coding_help") {
    return "Builder mode. Send the code, error, repo context, or the smallest failing example and I will help you work through it.";
  }

  if (intent === "general_chat") {
    return "I hear you. No structured event needed from that message.";
  }

  return "Got it. I routed this message and did not create any events.";
}
