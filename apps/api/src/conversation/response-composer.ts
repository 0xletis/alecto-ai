import type { ConversationExecutionResult } from "@operator-agent/core";

export function composeConversationResponse(result: ConversationExecutionResult): string {
  if (result.reply?.trim()) {
    return normalizeRepeatedDoneSections(result.reply.trim());
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

function normalizeRepeatedDoneSections(reply: string): string {
  const blocks = reply.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const doneItems: string[] = [];
  const normalizedBlocks: string[] = [];
  let donePlaceholderAdded = false;

  for (const block of blocks) {
    const blockDoneItems = extractDoneItems(block);

    if (blockDoneItems) {
      doneItems.push(...blockDoneItems);

      if (!donePlaceholderAdded) {
        normalizedBlocks.push("__DONE_SECTION__");
        donePlaceholderAdded = true;
      }

      continue;
    }

    normalizedBlocks.push(block);
  }

  if (doneItems.length === 0) {
    return reply;
  }

  const doneSection = ["Done:", ...doneItems.map((item) => `- ${item}`)].join("\n");
  return normalizedBlocks
    .map((block) => (block === "__DONE_SECTION__" ? doneSection : block))
    .join("\n\n");
}

function extractDoneItems(block: string): string[] | undefined {
  const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);

  if (lines[0] !== "Done:") {
    return undefined;
  }

  const items = lines.slice(1).map((line) => line.replace(/^-\s*/, "").trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}
