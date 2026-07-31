import { z } from "zod";
import { extractManualAction } from "./action-intake.js";
import { evaluateGoalGuardrails } from "./goal-guardrails.js";
import { extractEvents, routeIntent } from "./message-processing.js";

export const InboundChannelSchema = z.enum(["telegram", "whatsapp", "web", "api"]);
export const InboundMessageTypeSchema = z.enum(["text", "voice", "image", "file", "button", "unknown"]);

export const NormalizedInboundAttachmentSchema = z.object({
  id: z.string().optional(),
  type: z.string(),
  url: z.string().optional(),
  mimeType: z.string().optional(),
  filename: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

export const NormalizedInboundCommandSchema = z.object({
  name: z.string(),
  args: z.string().default(""),
  raw: z.string()
});

export const NormalizedInboundMessageSchema = z.object({
  channel: InboundChannelSchema,
  userId: z.string().min(1),
  externalUserId: z.string().min(1),
  text: z.string().default(""),
  command: NormalizedInboundCommandSchema.optional(),
  messageType: InboundMessageTypeSchema,
  timestamp: z.coerce.date(),
  timezone: z.string().optional(),
  attachments: z.array(NormalizedInboundAttachmentSchema).default([]),
  metadata: z.record(z.unknown()).optional()
});

export const InboundRouteSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command"),
    command: NormalizedInboundCommandSchema
  }),
  z.object({
    kind: z.literal("process_message")
  }),
  z.object({
    kind: z.literal("daily_checkin")
  }),
  z.object({
    kind: z.literal("ingest_text"),
    source: InboundChannelSchema,
    domainHint: z.string().optional()
  })
]);

export const RouteSideEffectsSchema = z.object({
  createEvent: z.boolean(),
  createAction: z.boolean(),
  createMemory: z.boolean(),
  sendNotification: z.boolean(),
  callLLM: z.boolean()
});

export const InboundRouteDebugSchema = z.object({
  intentType: z.string(),
  confidence: z.number().min(0).max(1),
  handlerName: z.string(),
  shouldRunGenericChat: z.boolean(),
  allowedSideEffects: RouteSideEffectsSchema,
  reason: z.string(),
  routeKind: z.string(),
  commandName: z.string().optional(),
  goal: z.string().optional(),
  severity: z.string().optional(),
  isReferenceOnly: z.boolean().optional()
});

export const InboundMessageSegmentResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("single_command"),
    commands: z.array(z.string()).length(1),
    reason: z.string()
  }),
  z.object({
    kind: z.literal("command_batch"),
    commands: z.array(z.string()).min(2),
    reason: z.string()
  }),
  z.object({
    kind: z.literal("reference_text"),
    text: z.string(),
    reason: z.string()
  }),
  z.object({
    kind: z.literal("normal_text"),
    text: z.string(),
    reason: z.string()
  })
]);

export type InboundChannel = z.infer<typeof InboundChannelSchema>;
export type InboundMessageType = z.infer<typeof InboundMessageTypeSchema>;
export type NormalizedInboundAttachment = z.infer<typeof NormalizedInboundAttachmentSchema>;
export type NormalizedInboundCommand = z.infer<typeof NormalizedInboundCommandSchema>;
export type NormalizedInboundMessage = z.infer<typeof NormalizedInboundMessageSchema>;
export type InboundRoute = z.infer<typeof InboundRouteSchema>;
export type RouteSideEffects = z.infer<typeof RouteSideEffectsSchema>;
export type InboundRouteDebug = z.infer<typeof InboundRouteDebugSchema>;
export type InboundMessageSegmentResult = z.infer<typeof InboundMessageSegmentResultSchema>;

export interface PendingDecisionReplyWithCommands {
  replyText: string;
  commands: string[];
}

export interface BuildNormalizedInboundMessageInput {
  channel: InboundChannel;
  userId: string;
  externalUserId: string;
  text?: string;
  messageType?: InboundMessageType;
  timestamp?: Date;
  timezone?: string;
  attachments?: NormalizedInboundAttachment[];
  metadata?: Record<string, unknown>;
}

export interface InboundRoutingContext {
  recentDailyCheckInReminder?: boolean;
}

export function buildNormalizedInboundMessage(input: BuildNormalizedInboundMessageInput): NormalizedInboundMessage {
  const text = input.text ?? "";

  return NormalizedInboundMessageSchema.parse({
    channel: input.channel,
    userId: input.userId,
    externalUserId: input.externalUserId,
    text,
    command: parseInboundCommand(text),
    messageType: input.messageType ?? (text ? "text" : "unknown"),
    timestamp: input.timestamp ?? new Date(),
    timezone: input.timezone,
    attachments: input.attachments ?? [],
    metadata: input.metadata
  });
}

export function parseInboundCommand(text: string): NormalizedInboundCommand | undefined {
  const match = text.trim().match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);

  if (!match) {
    return undefined;
  }

  return {
    name: match[1].toLowerCase(),
    args: (match[2] ?? "").trim(),
    raw: text.trim()
  };
}

export function segmentInboundMessage(text: string): InboundMessageSegmentResult {
  const trimmed = text.trim();

  if (!trimmed) {
    return InboundMessageSegmentResultSchema.parse({
      kind: "normal_text",
      text: "",
      reason: "Empty text."
    });
  }

  const nonEmptyLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const commandLines = nonEmptyLines.filter((line) => line.startsWith("/"));

  if (looksLikeCommandReference(trimmed, nonEmptyLines)) {
    return InboundMessageSegmentResultSchema.parse({
      kind: "reference_text",
      text: trimmed,
      reason: "Message looks like pasted command reference text, so commands should not execute."
    });
  }

  if (nonEmptyLines.length === 1 && commandLines.length === 1) {
    return InboundMessageSegmentResultSchema.parse({
      kind: "single_command",
      commands: [commandLines[0]],
      reason: "Single slash command."
    });
  }

  if (nonEmptyLines.length > 1 && commandLines.length === nonEmptyLines.length) {
    return InboundMessageSegmentResultSchema.parse({
      kind: "command_batch",
      commands: commandLines,
      reason: "Multiple command lines detected."
    });
  }

  if (nonEmptyLines[0]?.startsWith("/") && commandLines.length > 0) {
    return InboundMessageSegmentResultSchema.parse({
      kind: "reference_text",
      text: trimmed,
      reason: "command_plus_extra_text"
    });
  }

  if (nonEmptyLines.length > 1 && commandLines.length > 0) {
    return InboundMessageSegmentResultSchema.parse({
      kind: "reference_text",
      text: trimmed,
      reason: "mixed_text_and_command"
    });
  }

  return InboundMessageSegmentResultSchema.parse({
    kind: "normal_text",
    text: trimmed,
    reason: "No command batch or reference pattern detected."
  });
}

export function splitPendingDecisionReplyWithCommands(text: string): PendingDecisionReplyWithCommands | undefined {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2 || !isPendingDecisionReplyLine(lines[0])) {
    return undefined;
  }

  const commands = lines.slice(1);

  if (commands.length === 0 || commands.some((line) => !line.startsWith("/"))) {
    return undefined;
  }

  return {
    replyText: lines[0],
    commands
  };
}

export function routeNormalizedInboundMessage(
  message: NormalizedInboundMessage,
  context: InboundRoutingContext = {}
): InboundRoute {
  const parsed = NormalizedInboundMessageSchema.parse(message);

  if (parsed.command) {
    return { kind: "command", command: parsed.command };
  }

  if (parsed.messageType !== "text") {
    return { kind: "process_message" };
  }

  if (
    isExplicitMemoryRequest(parsed.text) ||
    isDirectBettingTradingIntent(parsed.text) ||
    isStandaloneNowText(parsed.text)
  ) {
    return { kind: "process_message" };
  }

  if (looksLikeNaturalCheckIn(parsed.text, context)) {
    return { kind: "daily_checkin" };
  }

  if (looksLikeJobSearchPaste(parsed.text)) {
    return {
      kind: "ingest_text",
      source: parsed.channel,
      domainHint: "career"
    };
  }

  return { kind: "process_message" };
}

export function explainNormalizedInboundRoute(
  message: NormalizedInboundMessage,
  context: InboundRoutingContext = {}
): InboundRouteDebug {
  const parsed = NormalizedInboundMessageSchema.parse(message);
  const route = routeNormalizedInboundMessage(parsed, context);

  if (route.kind === "command") {
    const commandText = route.command.args.trim();

    const guardrail = commandText ? evaluateGoalGuardrails({ text: commandText }) : undefined;

    if (guardrail?.triggered) {
      return debugResult({
        intentType: "command_with_guardrail",
        confidence: guardrail.confidence,
        handlerName: route.command.name,
        shouldRunGenericChat: false,
        allowedSideEffects: noSideEffects(),
        reason: `${guardrail.reason}. Debug does not execute the command.`,
        routeKind: route.kind,
        commandName: route.command.name,
        goal: guardrail.goalTitle,
        severity: guardrail.severity,
        isReferenceOnly: guardrail.isReferenceOnly
      });
    }

    return debugResult({
      intentType: "command",
      confidence: 1,
      handlerName: route.command.name,
      shouldRunGenericChat: false,
      allowedSideEffects: noSideEffects(),
      reason: "Slash command parsed as a channel-neutral command. Debug does not execute commands.",
      routeKind: route.kind,
      commandName: route.command.name
    });
  }

  if (route.kind === "daily_checkin") {
    return debugResult({
      intentType: "daily_checkin",
      confidence: 0.9,
      handlerName: "daily_checkin_text",
      shouldRunGenericChat: false,
      allowedSideEffects: {
        createEvent: true,
        createAction: false,
        createMemory: false,
        sendNotification: false,
        callLLM: false
      },
      reason: "Message contains enough state/progress signals for natural daily check-in routing.",
      routeKind: route.kind
    });
  }

  if (route.kind === "ingest_text") {
    return debugResult({
      intentType: "ingest_text",
      confidence: 0.9,
      handlerName: "ingest_text",
      shouldRunGenericChat: false,
      allowedSideEffects: {
        createEvent: true,
        createAction: false,
        createMemory: false,
        sendNotification: false,
        callLLM: false
      },
      reason: `Message looks like pasted ${route.domainHint ?? "domain"} text and should go through ingestion.`,
      routeKind: route.kind
    });
  }

  return explainProcessMessageRoute(parsed);
}

export function shouldCheckRecentDailyCheckInReminder(message: NormalizedInboundMessage): boolean {
  if (
    message.command ||
    message.messageType !== "text" ||
    isExplicitMemoryRequest(message.text) ||
    isDirectBettingTradingIntent(message.text)
  ) {
    return false;
  }

  const signalCounts = countNaturalCheckInSignals(message.text);
  return (
    signalCounts.state < 1 &&
    signalCounts.progress < 2 &&
    signalCounts.state + signalCounts.progress + signalCounts.reminderOnlyImpulse >= 1
  );
}

function explainProcessMessageRoute(message: NormalizedInboundMessage): InboundRouteDebug {
  if (isStandaloneNowText(message.text)) {
    return debugResult({
      intentType: "unknown",
      confidence: 0.95,
      handlerName: "process_message",
      shouldRunGenericChat: false,
      allowedSideEffects: noSideEffects(),
      reason: "Standalone 'now' is not a concrete action. It should ask what to schedule instead of creating anything.",
      routeKind: "process_message"
    });
  }

  if (isExplicitMemoryRequest(message.text)) {
    return debugResult({
      intentType: "memory_create",
      confidence: 0.9,
      handlerName: "process_message",
      shouldRunGenericChat: false,
      allowedSideEffects: {
        createEvent: false,
        createAction: false,
        createMemory: true,
        sendNotification: false,
        callLLM: false
      },
      reason: "Explicit memory request should be handled by message processing, not check-in routing.",
      routeKind: "process_message"
    });
  }

  const guardrail = evaluateGoalGuardrails({ text: message.text });

  if (guardrail.isReferenceOnly) {
    return debugResult({
      intentType: "generic_chat",
      confidence: guardrail.confidence,
      handlerName: "process_message",
      shouldRunGenericChat: false,
      allowedSideEffects: noSideEffects(),
      reason: guardrail.reason,
      routeKind: "process_message",
      isReferenceOnly: true
    });
  }

  if (guardrail.triggered) {
    return debugResult({
      intentType: "goal_guardrail",
      confidence: guardrail.confidence,
      handlerName: "goal_guardrail_engine",
      shouldRunGenericChat: false,
      allowedSideEffects: {
        createEvent: true,
        createAction: false,
        createMemory: false,
        sendNotification: false,
        callLLM: false
      },
      reason: guardrail.reason,
      routeKind: "process_message",
      goal: guardrail.goalTitle,
      severity: guardrail.severity,
      isReferenceOnly: false
    });
  }

  const manualAction = extractManualAction({ text: message.text });

  if (manualAction.shouldCreateAction) {
    return debugResult({
      intentType: "action_create",
      confidence: manualAction.confidence,
      handlerName: "manual_action_intake",
      shouldRunGenericChat: false,
      allowedSideEffects: {
        createEvent: false,
        createAction: true,
        createMemory: false,
        sendNotification: false,
        callLLM: false
      },
      reason: manualAction.reason,
      routeKind: "process_message"
    });
  }

  const extractedEvents = extractEvents(message.text);

  if (extractedEvents.length > 0) {
    return debugResult({
      intentType: "event_log",
      confidence: Math.max(...extractedEvents.map((event) => event.confidence)),
      handlerName: "process_message",
      shouldRunGenericChat: false,
      allowedSideEffects: {
        createEvent: true,
        createAction: false,
        createMemory: false,
        sendNotification: false,
        callLLM: false
      },
      reason: `Detected ${extractedEvents.length} event candidate${extractedEvents.length === 1 ? "" : "s"}.`,
      routeKind: "process_message"
    });
  }

  const intent = routeIntent(message.text);

  return debugResult({
    intentType: intent === "general_chat" ? "generic_chat" : intent,
    confidence: intent === "general_chat" ? 0.5 : 0.8,
    handlerName: "process_message",
    shouldRunGenericChat: intent === "general_chat",
    allowedSideEffects: {
      createEvent: false,
      createAction: false,
      createMemory: false,
      sendNotification: false,
      callLLM: false
    },
    reason: intent === "general_chat" ? "No command, action, event, check-in, ingestion, memory, or risk route matched." : `Rule-based intent matched ${intent}.`,
    routeKind: "process_message"
  });
}

function isRiskText(text: string): boolean {
  return evaluateGoalGuardrails({ text }).triggered;
}

function noSideEffects(): RouteSideEffects {
  return {
    createEvent: false,
    createAction: false,
    createMemory: false,
    sendNotification: false,
    callLLM: false
  };
}

function debugResult(input: InboundRouteDebug): InboundRouteDebug {
  return InboundRouteDebugSchema.parse(input);
}

function looksLikeCommandReference(text: string, nonEmptyLines: string[]): boolean {
  const hasCommandLookingLine = nonEmptyLines.some((line) => line.startsWith("/") || /:\s*\/[a-zA-Z0-9_]+/.test(line));
  const looksLikeDevPrompt =
    /\bYou are working in the\b/i.test(text) ||
    /\b(Requirements|Tests|Expected|Observed):/i.test(text) ||
    /\b(Codex\/dev prompts|debug outputs):/i.test(text);
  const looksLikeRouteDebugDump = /\b(intentType|handlerName|allowedSideEffects):/i.test(text);

  if (looksLikeDevPrompt || looksLikeRouteDebugDump) {
    return true;
  }

  if (!hasCommandLookingLine) {
    return false;
  }

  return (
    /```/.test(text) ||
    /^\[\d{1,2}\/\d{1,2}\/\d{4}[,\s]+\d{1,2}:\d{2}\]/m.test(text) ||
    /\bAlecto AI:/i.test(text) ||
    /\b(example|expected|actual|observed|log|transcript):/i.test(text)
  );
}

export function isExplicitMemoryRequest(message: string): boolean {
  return /\b(remember that|remember this|note that|recuerda que|acu[eé]rdate de que|guard[ae] que)\b/i.test(message);
}

export function isDirectBettingTradingIntent(message: string): boolean {
  return /\b(quiero apostar|voy a apostar|i want to bet|i'?m going to bet|quiero tradear|voy a tradear|i want to trade|long|short|leverage)\b/i.test(
    message
  );
}

export function isStandaloneNowText(message: string): boolean {
  return /^now$/i.test(message.trim());
}

function isPendingDecisionReplyLine(text: string): boolean {
  return /^(?:yes|confirm|no|cancel|[1-9]|first|second|third|fourth|fifth|the first one|the second one|the third one|the fourth one|the fifth one)$/i.test(
    text.trim()
  );
}

export function looksLikeNaturalCheckIn(message: string, context: InboundRoutingContext = {}): boolean {
  const signalCounts = countNaturalCheckInSignals(message);

  if (signalCounts.state >= 1) {
    return true;
  }

  return Boolean(
    context.recentDailyCheckInReminder &&
      signalCounts.state + signalCounts.progress + signalCounts.reminderOnlyImpulse >= 1
  );
}

export function looksLikeJobSearchPaste(message: string): boolean {
  const normalized = normalizeSignalText(message);
  const jobPastePatterns = [
    /\bunfortunately\b/,
    /\bnot selected\b/,
    /\bmove forward with other candidates\b/,
    /\bnot be proceeding\b/,
    /\bno longer under consideration\b/,
    /\bhemos decidido continuar con otros candidatos\b/,
    /\bthanks for applying\b/,
    /\bwe received your application\b/,
    /\bapplication received\b/,
    /\bgracias por aplicar\b/,
    /\bhemos recibido tu solicitud\b/,
    /\bwe'?d like to schedule an interview\b/,
    /\bwould like to schedule an interview\b/,
    /\bschedule an interview\b/,
    /\bschedule a call\b/,
    /\bare you available\b/,
    /\bavailable next\b/,
    /\bavailable times\b/,
    /\bcalendly\b/,
    /\bentrevista\b/,
    /\bagendar\b/,
    /\bprogramar una llamada\b/,
    /\bwe would like to offer\b/,
    /\bemployment agreement\b/,
    /\boffer\b/,
    /\brecruiter\b/,
    /\btalent acquisition\b/,
    /\bwe'?d like to discuss\b/,
    /\bwe would like to discuss\b/
  ];

  return jobPastePatterns.some((pattern) => pattern.test(normalized));
}

export function countNaturalCheckInSignals(message: string): {
  state: number;
  progress: number;
  reminderOnlyImpulse: number;
} {
  const normalized = normalizeSignalText(message);
  const statePatterns = [
    /\benergy\b|\benergia\b/,
    /\banxiety\b|\bansiedad\b/,
    /\bfocus\b|\bfoco\b/,
    /\bslept\b|\bsleep\b|\bdormi\b|\bdormir\b/
  ];
  const progressPatterns = [
    /\b(?:sent|mande|mandado|envie|enviado)\s+\d*\s*(?:cvs?|applications?)\b|\b\d+\s*(?:cvs?|applications?)\b/,
    /\btrained\b|\bentrene\b|\bentrenado\b|\bgym\b|\bworkout\b/,
    /\bread\b|\blei\b|\breading\b/
  ];
  const reminderOnlyImpulsePatterns = [
    /\bganas de apostar\s*\d+(?:\.\d+)?\b/,
    /\b(?:gambling impulse|trading impulse)\s*(?:is|=|:)?\s*\d+(?:\.\d+)?\b/,
    /\bno (?:gambling impulse|trading impulse|bets?)\b/
  ];

  return {
    state: statePatterns.filter((pattern) => pattern.test(normalized)).length,
    progress: progressPatterns.filter((pattern) => pattern.test(normalized)).length,
    reminderOnlyImpulse: reminderOnlyImpulsePatterns.filter((pattern) => pattern.test(normalized)).length
  };
}

export function normalizeSignalText(message: string): string {
  return message
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
