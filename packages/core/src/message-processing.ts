import { z } from "zod";
import { EventTypeSchema } from "./event-registry.js";
import { RiskStateSchema } from "./risk.js";
import type { StoredEvent } from "./events.js";

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
  message: z.string().min(1),
  recentEvents: z.array(z.custom<StoredEvent>()).optional()
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

export const ProcessMessageAnalysisSchema = z.object({
  intent: MessageIntentSchema,
  mode: AgentModeSchema,
  extractedEvents: z.array(ExtractedEventSchema).default([])
});

export type MessageIntent = z.infer<typeof MessageIntentSchema>;
export type AgentMode = z.infer<typeof AgentModeSchema>;
export type ProcessMessageInput = z.infer<typeof ProcessMessageInputSchema>;
export type ExtractedEvent = z.infer<typeof ExtractedEventSchema>;
export type ProcessMessageResult = z.infer<typeof ProcessMessageResultSchema>;
export type ProcessMessageAnalysis = z.infer<typeof ProcessMessageAnalysisSchema>;

const certaintyPattern = /\b(safe|sure|guaranteed|seguro|casi seguro|free money)\b/i;
const oneDayMs = 24 * 60 * 60 * 1000;

export function processMessage(input: ProcessMessageInput): ProcessMessageResult {
  const parsedInput = ProcessMessageInputSchema.parse(input);
  const intent = routeIntent(parsedInput.message);
  const extractedEvents = extractEvents(parsedInput.message);
  const finalIntent = intent === "general_chat" && extractedEvents.length > 0 ? "event_logging" : intent;

  return processMessageFromAnalysis(parsedInput, {
    intent: finalIntent,
    mode: selectMode(finalIntent, "GREEN"),
    extractedEvents
  });
}

export function processMessageFromAnalysis(
  input: ProcessMessageInput,
  analysis: ProcessMessageAnalysis
): ProcessMessageResult {
  const parsedInput = ProcessMessageInputSchema.parse(input);
  const parsedAnalysis = ProcessMessageAnalysisSchema.parse(analysis);
  const deterministicIntent = routeIntent(parsedInput.message);
  const deterministicRiskIntent =
    deterministicIntent === "betting_intent" ||
    deterministicIntent === "trading_intent" ||
    deterministicIntent === "financial_impulse"
      ? deterministicIntent
      : undefined;
  const extractedEvents = deterministicRiskIntent ? [] : parsedAnalysis.extractedEvents;
  const finalIntent =
    deterministicRiskIntent ??
    (deterministicIntent === "emotional_reflection" && parsedAnalysis.intent === "general_chat"
      ? "emotional_reflection"
      : undefined) ??
    (parsedAnalysis.intent === "general_chat" && extractedEvents.length > 0
      ? "event_logging"
      : parsedAnalysis.intent);
  const riskSignals = getRiskSignals(finalIntent, parsedInput.message, parsedInput.recentEvents ?? []);
  const riskState = assessRisk(finalIntent, parsedInput.message, parsedInput.recentEvents ?? []);
  const mode = selectMode(finalIntent, riskState, parsedAnalysis.mode);
  const reply = composeReply(finalIntent, mode, riskState, extractedEvents, riskSignals);

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

  if (/\b(me siento|i feel|feel weird|sad|anxious|ansioso|raro|perdido)\b/i.test(message)) {
    return "emotional_reflection";
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

export function assessRisk(
  intent: MessageIntent,
  message: string,
  recentEvents: StoredEvent[] = []
): z.infer<typeof RiskStateSchema> {
  const isFinancialRiskIntent = intent === "betting_intent" || intent === "trading_intent";

  if (!isFinancialRiskIntent) {
    return "GREEN";
  }

  return getRiskSignals(intent, message, recentEvents).length > 0 ? "RED" : "ORANGE";
}

export function getRiskSignals(intent: MessageIntent, message: string, recentEvents: StoredEvent[] = []): string[] {
  const isFinancialRiskIntent = intent === "betting_intent" || intent === "trading_intent";

  if (!isFinancialRiskIntent) {
    return [];
  }

  const since = new Date(Date.now() - oneDayMs);
  const eventsInLast24h = recentEvents.filter((event) => event.timestamp >= since);
  const signals: string[] = [];

  if (certaintyPattern.test(message)) {
    signals.push("certainty language");
  }

  if (eventsInLast24h.some((event) => event.type === "finance.betting.cooldown_triggered")) {
    signals.push("recent cooldown");
  }

  const recentRiskEvents = eventsInLast24h.filter(
    (event) => event.type.startsWith("finance.betting.") || event.type.startsWith("finance.trading.")
  );

  if (recentRiskEvents.length >= 2) {
    signals.push("repeated risk behavior");
  }

  return signals;
}

function selectMode(
  intent: MessageIntent,
  riskState: z.infer<typeof RiskStateSchema>,
  preferredMode?: AgentMode
): AgentMode {
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

  return preferredMode ?? "mirror";
}

function composeReply(
  intent: MessageIntent,
  _mode: AgentMode,
  riskState: z.infer<typeof RiskStateSchema>,
  extractedEvents: ExtractedEvent[],
  riskSignals: string[] = []
): string {
  if ((intent === "betting_intent" || intent === "trading_intent") && riskState === "RED") {
    const signalText = riskSignals.length > 0 ? ` Signals: ${riskSignals.join(", ")}.` : "";
    return `No. I am not validating this right now.${signalText} Cooldown first. If it still makes sense later, bring a written thesis, position size, invalidation point, and your current emotional state.`;
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
