# Risk Engine

The Risk Engine prevents the LLM from becoming complacent or validating dangerous behavior.

The LLM should not be the final judge of whether to validate a bet/trade/impulsive decision.

## Risk states

- GREEN: normal
- YELLOW: mild caution
- ORANGE: likely self-deception or drift
- RED: do not validate risky action
- BLACK: crisis/high-risk loop; stop normal analysis and enter recovery protocol

## Risk signals for betting/trading

- recent losses
- number of bets/trades in last 24h/7d
- position size relative to net worth
- certainty language: "safe", "guaranteed", "sure", "free money"
- no thesis logged before action
- revenge pattern
- low sleep
- high anxiety
- avoidance in other active goals
- user trying to bypass the system
- new wallet/account usage after warnings

## RED policy

If risk state is RED:
- do not validate the bet/trade
- do not analyze the match/market as if the action is reasonable
- do not say "if you researched it, go ahead"
- call out the pattern clearly
- require cooldown
- redirect to grounding action or productive action

Example response:

"No. I am not helping you turn this into an intelligent-sounding excuse. The issue is not whether the bet has value. The issue is the state you are in while asking. You are using certainty language, you have recent losses, and you are looking for permission. Cooldown. If it still makes sense tomorrow, we review it with a written thesis and smaller size."