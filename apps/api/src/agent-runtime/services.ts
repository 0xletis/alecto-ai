export interface AgentRuntimeServices {
  syncGmailForUser?: (userId: string) => Promise<string>;
  gmailSyncDebugForUser?: (userId: string) => Promise<string>;
}

const services: AgentRuntimeServices = {};

export function configureAgentRuntimeServices(nextServices: AgentRuntimeServices): void {
  Object.assign(services, nextServices);
}

export function resetAgentRuntimeServicesForTests(): void {
  delete services.syncGmailForUser;
  delete services.gmailSyncDebugForUser;
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
