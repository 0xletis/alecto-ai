# Operator Agent — Product Vision

Operator Agent is an adaptive personal AI agent with memory, goals, events, risk detection, and conversational guidance.

It is not:
- a generic chatbot
- a habit tracker with chat
- a motivational coach
- a dashboard-only productivity app

It is:
- a conversational agent the user can talk to about anything
- a system that detects when messages imply goals, events, risks, or reflections
- a memory layer that learns the user's patterns
- an accountability layer that uses real data, not just self-reporting
- a guardian layer for high-risk behavior like gambling, trading, impulsive financial decisions, avoidance, or self-deception

Core idea:

Real-world signals + structured events + active goals + memory + personalized attitude = useful guidance.

The agent should feel like a trusted guide, but it must not become blindly validating or emotionally manipulative.

The agent can talk normally about anything. It only creates structured data when appropriate.

## Current Implementation Status

See `docs/07-implementation-status.md` for the current implementation ledger.

As of 2026-08-06, the working product is a Telegram-first operator agent with:
- structured goals, events, memories, check-ins, ActionItems, and user operating profiles
- deterministic risk guardrails for betting/trading behavior
- daily operator brief, daily/weekly insights, daily operating loop, weekly operator review, and confirmed next-week planning
- Gmail and GitHub public integrations through explicit user-approved connections/rules
- worker-based proactive reminders, insights, loop briefs, action reminders, and integration sync

Not currently implemented:
- WhatsApp, OpenClaw, mobile app, web dashboard, private GitHub, vector DB/embeddings, and production-grade OAuth/auth beyond the local Gmail MVP
