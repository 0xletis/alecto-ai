import type { FastifyInstance } from "fastify";
import {
  buildDailyCheckinPrompt,
  EventTypeSchema,
  IngestTextBodySchema,
  routeIngestion,
  type IngestTextBody
} from "@operator-agent/core";
import { createEvents, getActiveGoals, getOrCreateUserOperatingProfile, getRecentEvents } from "@operator-agent/db";
import { isRecord } from "../utils/records.js";

/**
 * Daily check-in prompt and free-text ingestion routes, extracted from
 * apps/api/src/server.ts's buildServer() as-is (pure move, no behavior
 * change). ingestText and composeIngestionReply were only ever called from
 * these three routes, so they moved here too rather than staying behind as
 * a circular import back into server.ts.
 */
export function registerCheckinsIngestRoutes(server: FastifyInstance): void {
  server.get<{ Params: { userId: string } }>("/users/:userId/checkins/daily/prompt", async (request) => ({
    prompt: buildDailyCheckinPrompt({
      activeGoals: await getActiveGoals(request.params.userId),
      userOperatingProfile: await getOrCreateUserOperatingProfile(request.params.userId),
      recentEvents: await getRecentEvents(request.params.userId, 20)
    })
  }));

  server.post<{ Params: { userId: string } }>("/users/:userId/ingest/text", async (request, reply) => {
    const parsed = IngestTextBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

    return ingestText(request.params.userId, parsed.data);
  });

  server.post<{ Params: { userId: string } }>("/users/:userId/ingest/job-search-text", async (request, reply) => {
    const parsed = IngestTextBodySchema.safeParse({
      ...(isRecord(request.body) ? request.body : {}),
      domainHint: "career"
    });

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

    return ingestText(request.params.userId, parsed.data);
  });
}

async function ingestText(userId: string, input: IngestTextBody) {
  const result = routeIngestion({
    userId,
    text: input.text,
    source: input.source,
    metadata: {
      domainHint: input.domainHint
    }
  });
  const validCandidates = result.eventCandidates.filter((candidate) => EventTypeSchema.safeParse(candidate.type).success);
  const events =
    validCandidates.length > 0
      ? await createEvents(
          userId,
          validCandidates.map((candidate) => ({
            type: EventTypeSchema.parse(candidate.type),
            source: "manual",
            data: {
              ...candidate.data,
              adapterId: result.adapterId,
              classification: result.classification,
              extracted: result.extracted ?? {},
              originalText: input.text.slice(0, 1000)
            },
            confidence: candidate.confidence,
            evidence: candidate.evidence
          }))
        )
      : [];

  return {
    result,
    events,
    reply: composeIngestionReply(result.classification, events.length)
  };
}

function composeIngestionReply(classification: string, eventCount: number): string {
  if (eventCount === 0 || classification === "unknown") {
    return "I could not classify this clearly. Paste more context or log it manually.";
  }

  return `Logged career event: ${classification.replace(/_/g, " ")}.`;
}
