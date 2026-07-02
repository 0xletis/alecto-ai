# Event Ontology

The event ontology is the shared language of the system.

Rules:
- Keep the core small.
- Do not let the LLM freely invent event type names.
- Specificity belongs in event data, not event names.
- The LLM can create event instances.
- The LLM can propose custom event types.
- Core event types require developer/product approval.

## Initial core event types

### Career

- career.application_sent
- career.recruiter_reply_received
- career.interview_scheduled
- career.interview_completed
- career.offer_received
- career.cv_updated
- career.portfolio_updated
- career.networking_message_sent

### Work / Coding

- work.deep_work_session_completed
- work.task_completed
- work.feedback_received
- work.blocker_reported
- work.project_milestone_completed

- coding.commit_created
- coding.pull_request_opened
- coding.pull_request_merged
- coding.issue_closed
- coding.repo_activity_detected

### Health

- health.workout_completed
- health.steps_logged
- health.sleep_logged
- health.meal_logged
- health.weight_logged
- health.energy_logged
- health.injury_reported
- health.rest_day_logged

### Finance / Wallet

- finance.wallet.balance_changed
- finance.wallet.transfer_received
- finance.wallet.transfer_sent
- finance.wallet.large_transfer_detected
- finance.wallet.net_worth_snapshot_created

### Finance / Trading

- finance.trading.position_opened
- finance.trading.position_closed
- finance.trading.pnl_realized
- finance.trading.large_loss_detected
- finance.trading.thesis_logged

### Finance / Betting

- finance.betting.bet_opened
- finance.betting.bet_closed
- finance.betting.pnl_realized
- finance.betting.large_bet_detected
- finance.betting.bet_thesis_logged
- finance.betting.cooldown_triggered
- finance.betting.revenge_pattern_detected

### Learning

- learning.reading_session_completed
- learning.note_created
- learning.book_started
- learning.book_finished
- learning.course_progressed
- learning.practice_session_completed
- learning.concept_mastered

### Reflection

- reflection.daily_checkin_completed
- reflection.journal_entry_created
- reflection.mood_logged
- reflection.anxiety_logged
- reflection.focus_logged
- reflection.impulse_logged
- reflection.goal_changed
- reflection.decision_logged
- reflection.regret_logged
- reflection.win_logged

### Social

- social.meaningful_conversation_logged
- social.friend_meetup_logged
- social.family_contact_logged
- social.loneliness_logged
- social.conflict_logged
- social.support_received

### System

- system.integration_connected
- system.integration_failed
- system.goal_created
- system.goal_archived
- system.metric_changed
- system.review_generated
- system.alert_sent
- system.user_confirmed_change
- system.user_rejected_change