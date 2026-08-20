export interface AgentRuntimeServices {
  syncGmailForUser?: (userId: string) => Promise<string>;
}

const services: AgentRuntimeServices = {};

export function configureAgentRuntimeServices(nextServices: AgentRuntimeServices): void {
  Object.assign(services, nextServices);
}

export function resetAgentRuntimeServicesForTests(): void {
  delete services.syncGmailForUser;
}

export async function syncGmailForAgentRuntime(userId: string): Promise<string> {
  if (!services.syncGmailForUser) {
    return "Gmail sync is not available in this runtime.";
  }

  return services.syncGmailForUser(userId);
}
