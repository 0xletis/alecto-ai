import type { ConversationExecutionResult } from "@operator-agent/core";

export function composeConversationResponse(result: ConversationExecutionResult): string {
  if (result.reply?.trim()) {
    return result.reply.trim();
  }

  const sections = [
    result.succeeded.length > 0 ? ["Done:", ...result.succeeded.map((item) => `- ${item}`)].join("\n") : undefined,
    result.needsConfirmation.length > 0
      ? ["Confirm:", ...result.needsConfirmation.map((item) => `- ${item}`)].join("\n")
      : undefined,
    result.needsClarification.length > 0
      ? ["I still need:", ...result.needsClarification.map((item) => `- ${item}`)].join("\n")
      : undefined,
    result.skipped.length > 0 ? ["Skipped:", ...result.skipped.map((item) => `- ${item}`)].join("\n") : undefined,
    result.errorsSafe.length > 0 ? ["Could not complete:", ...result.errorsSafe.map((item) => `- ${item}`)].join("\n") : undefined
  ].filter((section): section is string => Boolean(section));

  return sections.length > 0 ? sections.join("\n\n") : "I did not change anything.";
}
