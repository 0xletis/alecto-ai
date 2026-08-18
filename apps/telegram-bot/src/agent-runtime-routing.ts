/**
 * Telegram routing helpers for normal (non-command) chat: Agent Runtime v3
 * (the default) and the explicit legacy opt-out.
 *
 * Kept in its own module, separate from index.ts, specifically so it can be
 * imported by tests without side effects: index.ts constructs a real grammy
 * Bot and calls bot.start() unconditionally at module load, which would try
 * to open a real Telegram long-polling connection if imported directly.
 */

export interface AgentRuntimeCallInput {
  userId: string;
  message: string;
}

export interface AgentRuntimeCallResult {
  reply: string;
  debug?: {
    conversationTopic?: unknown;
    pendingOperation?: unknown;
    mutationExecuted?: unknown;
    [key: string]: unknown;
  };
}

export interface RouteToAgentRuntimeDeps {
  callAgentRuntime: (input: AgentRuntimeCallInput) => Promise<AgentRuntimeCallResult>;
  reply: (text: string) => Promise<void>;
  log?: (message: string, ...args: unknown[]) => void;
  logError?: (message: string, ...args: unknown[]) => void;
}

export const AGENT_RUNTIME_V3_ERROR_REPLY = "Agent v3 hit an error while handling that. Nothing was changed.";

/**
 * Agent Runtime v3 is the DEFAULT for normal Telegram text: unset, "true", or
 * any value other than the literal string "false" all route to v3. Only an
 * explicit TELEGRAM_AGENT_RUNTIME_V3_ENABLED=false opts back into the legacy
 * /messages/process pipeline (routeToLegacyMessageProcessor in index.ts).
 */
export function isLegacyTelegramChatEnabled(): boolean {
  return process.env.TELEGRAM_AGENT_RUNTIME_V3_ENABLED === "false";
}

export function logLegacyTelegramRouting(userId: string, log: (message: string) => void = console.log): void {
  log(`[telegram] runtime=legacy_messages reason=flag_disabled user=${userId}`);
}

/**
 * Routes one normal (non-command) Telegram message to Agent Runtime v3.
 * Deliberately takes only ONE backend callback — there is no second/fallback
 * path this function could call, so a failure can only ever produce the
 * dev-safe error reply below, never a silent fallback to the legacy
 * /messages/process pipeline. There are exactly two exit points (the try
 * body and the catch body) and each calls deps.reply exactly once — this is
 * what guarantees one incoming message can never produce two Telegram
 * replies from this function. See the "exactly once" test in
 * tests/telegram-agent-runtime-routing.test.ts.
 */
export async function routeToAgentRuntimeV3(
  userId: string,
  message: string,
  deps: RouteToAgentRuntimeDeps,
  updateId?: number
): Promise<void> {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  const startedAt = Date.now();
  const updateTag = updateId !== undefined ? ` update=${updateId}` : "";

  log(`[telegram] runtime=agent_v3${updateTag} user=${userId} start text=${JSON.stringify(message)}`);

  try {
    const response = await deps.callAgentRuntime({ userId, message });
    const elapsedMs = Date.now() - startedAt;
    const debug = response.debug;
    log(
      `[telegram] runtime=agent_v3${updateTag} user=${userId} done elapsedMs=${elapsedMs} reply=${JSON.stringify(truncate(response.reply, 80))} ` +
        `topic=${debug?.conversationTopic ?? "?"} pending=${debug?.pendingOperation ?? "?"} mutation=${debug?.mutationExecuted ?? "?"}`
    );
    await deps.reply(response.reply);
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    logError(`[telegram] runtime=agent_v3${updateTag} user=${userId} error elapsedMs=${elapsedMs}`, error);
    await deps.reply(AGENT_RUNTIME_V3_ERROR_REPLY);
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
