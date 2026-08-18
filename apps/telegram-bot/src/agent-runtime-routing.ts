/**
 * Dev-flag routing helpers for POST /agent/message (Agent Runtime v3).
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

export function isAgentRuntimeV3EnabledForTelegram(): boolean {
  return process.env.TELEGRAM_AGENT_RUNTIME_V3_ENABLED === "true";
}

/**
 * Routes one normal (non-command) Telegram message to Agent Runtime v3.
 * Deliberately takes only ONE backend callback — there is no second/fallback
 * path this function could call, so a failure can only ever produce the
 * dev-safe error reply below, never a silent fallback to the legacy
 * /messages/process pipeline.
 */
export async function routeToAgentRuntimeV3(userId: string, message: string, deps: RouteToAgentRuntimeDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  const startedAt = Date.now();

  log(`[telegram] agent_v3 start user=${userId} text=${JSON.stringify(message)}`);

  try {
    const response = await deps.callAgentRuntime({ userId, message });
    const elapsedMs = Date.now() - startedAt;
    const debug = response.debug;
    log(
      `[telegram] agent_v3 done user=${userId} elapsedMs=${elapsedMs} reply=${JSON.stringify(truncate(response.reply, 80))} ` +
        `topic=${debug?.conversationTopic ?? "?"} pending=${debug?.pendingOperation ?? "?"} mutation=${debug?.mutationExecuted ?? "?"}`
    );
    await deps.reply(response.reply);
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    logError(`[telegram] agent_v3 error user=${userId} elapsedMs=${elapsedMs}`, error);
    await deps.reply(AGENT_RUNTIME_V3_ERROR_REPLY);
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
