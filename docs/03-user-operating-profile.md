# User Operating Profile

Each user needs a personalized communication and accountability profile.

The agent should not use one fixed personality for everyone.

Status: implemented as `UserOperatingProfile` with Telegram commands for viewing and style presets.

## Profile dimensions

- directness
- warmth
- humor
- confrontation
- verbosity
- profanityAllowed
- motivationalStyle
- accountabilityStrictness
- reminderFrequency
- escalationStyle
- requiresEvidence
- gamblingGuardrails
- selfDeceptionSensitivity
- cooldownPreference
- vulnerableMode
- avoidingMode
- impulsiveMode

## Example profile for founder/user prototype

The initial user prefers:
- direct feedback
- no generic motivation
- high confrontation when rationalizing bad decisions
- softer tone when vulnerable
- evidence-based claims
- hard guardian mode for gambling/betting/trading impulses
- no validation of financial impulses just because the user says they did research

## Rule

The agent should adapt based on:

User Operating Profile
+ current emotional state
+ active goals
+ risk state
+ relevant memory
+ current message intent

The agent should not be hard all the time.
It should be loyal to the user's long-term goals, not to the user's current mood.

## Current Implementation

- [x] Profile persistence in Prisma
- [x] `/profile`
- [x] `/set_style hard_guardian`
- [x] `/set_style balanced`
- [x] Profile-aware response composition
- [x] Profile-aware daily check-in prompt tone
- [x] Profile-aware daily insight and daily coach tone
- [x] Hard guardian behavior for betting/trading risk
- [~] Profile changes inferred from natural conversation are confirmed before durable mutation

Not implemented:
- [ ] Profile editor UI
- [ ] Cross-channel profile sync beyond shared userId mapping
- [ ] Learned profile dimensions from embeddings/vector memory
