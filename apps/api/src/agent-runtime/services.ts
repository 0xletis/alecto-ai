import type { EmailReviewItem } from "@operator-agent/db";
import type { RefetchGmailReviewContentResult } from "../server-types.js";

export interface AgentRuntimeServices {
  syncGmailForUser?: (userId: string) => Promise<string>;
  gmailSyncDebugForUser?: (userId: string) => Promise<string>;
  /** fix/private-alpha-email-review-detail-and-general-mail-understanding: the real, readonly,
   * on-demand Gmail message refetch for one EmailReviewItem — implemented in server.ts (where the
   * OAuth/token/Gmail-API code already lives) and injected here so executor.ts never needs its own
   * copy of that private machinery, the same seam syncGmailForUser above already established. */
  refetchGmailReviewContentForUser?: (userId: string, review: EmailReviewItem) => Promise<RefetchGmailReviewContentResult>;
}

const services: AgentRuntimeServices = {};

export function configureAgentRuntimeServices(nextServices: AgentRuntimeServices): void {
  Object.assign(services, nextServices);
}

export function resetAgentRuntimeServicesForTests(): void {
  delete services.syncGmailForUser;
  delete services.gmailSyncDebugForUser;
  delete services.refetchGmailReviewContentForUser;
}

export async function syncGmailForAgentRuntime(userId: string): Promise<string> {
  if (!services.syncGmailForUser) {
    return "Gmail sync is not available in this runtime.";
  }

  return services.syncGmailForUser(userId);
}

export async function gmailSyncDebugForAgentRuntime(userId: string): Promise<string> {
  if (!services.gmailSyncDebugForUser) {
    return "Gmail sync debug is not available in this runtime.";
  }

  return services.gmailSyncDebugForUser(userId);
}

export async function refetchGmailReviewContentForAgentRuntime(userId: string, review: EmailReviewItem): Promise<RefetchGmailReviewContentResult> {
  if (!services.refetchGmailReviewContentForUser) {
    return { status: "error", message: "Email content refetch is not available in this runtime." };
  }

  return services.refetchGmailReviewContentForUser(userId, review);
}
