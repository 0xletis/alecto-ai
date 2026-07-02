# System Architecture

## High-level flow

User message
→ channel adapter
→ agent orchestrator
→ intent router
→ context fetch
→ event extractor
→ risk engine
→ response policy
→ LLM response
→ save message/events/memories
→ reply to user

## Main components

### Channel Adapter

Initial channel:
- Telegram

Future channels:
- OpenClaw
- WhatsApp
- Web chat
- mobile app

### Agent Orchestrator

Coordinates all modules for every incoming message.

### Intent Router

Classifies user messages into intents:
- general_chat
- emotional_reflection
- goal_creation
- goal_update
- event_logging
- research_request
- coding_help
- financial_impulse
- betting_intent
- trading_intent
- daily_checkin
- weekly_review
- integration_setup
- memory_correction

### Goal Engine

Manages active, paused and archived goals.

### Event Engine

Creates structured events from:
- connectors
- manual chat messages
- LLM-inferred patterns

### Memory Engine

Stores:
- factual structured memory in Postgres
- narrative memory in long-term memory store

### Integration Registry

Knows which integrations exist, what event types they produce, and how users can connect them.

### Risk Engine

Computes risk state:
- GREEN
- YELLOW
- ORANGE
- RED
- BLACK

### User Operating Profile

Defines how the agent should communicate with each user.

### Evidence Layer

Whenever the agent makes a strong claim, it should support it with evidence.

### Review Engine

Creates daily, weekly and monthly reviews.