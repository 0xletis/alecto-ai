/**
 * fix/private-alpha-proactive-worker-delivery-and-gmail-log-noise: re-exported from
 * @operator-agent/core so apps/api's proactive delivery-status diagnosis (proactive-eligibility.ts)
 * derives the exact same fallback chat id as every worker sender — see the doc comment on
 * telegramChatIdFromUserId in packages/core/src/notifications.ts for the full root-cause writeup.
 */
export { telegramChatIdFromUserId } from "@operator-agent/core";
