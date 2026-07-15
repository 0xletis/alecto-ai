import { z } from "zod";
import { EventTypeSchema } from "./event-registry.js";

export const IntegrationDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.enum(["available", "planned"]),
  authType: z.enum(["none", "api_key", "oauth", "manual"]),
  producesEventTypes: z.array(EventTypeSchema)
});

export const GithubPublicConnectionInputSchema = z.object({
  repos: z
    .array(
      z.object({
        owner: z.string().min(1),
        repo: z.string().min(1)
      })
    )
    .min(1),
  authorLogin: z.string().min(1).optional(),
  includeRepoActivity: z.boolean().optional()
});

export const UpdateIntegrationConnectionInputSchema = z.object({
  status: z.enum(["active", "paused"])
});

export type IntegrationDefinition = z.infer<typeof IntegrationDefinitionSchema>;
export type GithubPublicConnectionInput = z.infer<typeof GithubPublicConnectionInputSchema>;
export type UpdateIntegrationConnectionInput = z.infer<typeof UpdateIntegrationConnectionInputSchema>;

export const integrationRegistry: IntegrationDefinition[] = [
  {
    id: "github_public",
    name: "GitHub Public Repo",
    description: "Fetches recent public commits from configured GitHub repositories.",
    status: "available",
    authType: "none",
    producesEventTypes: ["coding.commit_created", "coding.repo_activity_detected"]
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "Planned OAuth integration for job-search email signals.",
    status: "planned",
    authType: "oauth",
    producesEventTypes: [
      "career.application_confirmation_received",
      "career.recruiter_reply_received",
      "career.interview_scheduled",
      "career.rejection_received",
      "career.offer_received"
    ]
  },
  {
    id: "wallet_public",
    name: "Wallet Public Address",
    description: "Planned manual public-address wallet signal integration.",
    status: "planned",
    authType: "manual",
    producesEventTypes: [
      "finance.wallet.balance_changed",
      "finance.wallet.transfer_received",
      "finance.wallet.transfer_sent",
      "finance.wallet.large_transfer_detected"
    ]
  }
];
