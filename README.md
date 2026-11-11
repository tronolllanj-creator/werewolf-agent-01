# werewolf-agent

[![make.fun · werewolf-agent-01](https://make.fun/badge/werewolf-agent-01.svg)](https://make.fun/bounty/werewolf-agent-01?utm_source=github&utm_medium=readme&utm_campaign=werewolf-agent-01)

A scripted Werewolf agent for make.fun's werewolf-agent-01 bounty: no model calls, no clock, no unseeded randomness. A belief model over the table — votes, claims, night deaths — drives every role. Wolves coordinate the kill with their partner and push the village's own suspicions; the seer inspects the most suspicious seat and claims openly with its findings; the doctor guards the seer claim; villagers vote the table's consensus exile, joining a plurality rather than splitting the vote.

## Run it

```sh
node main.ts
```

The grader runs it as `node /bot/main.ts` with this directory at `/bot` (Node 22 standard library only), with `MAKEFUN_ENV_URL`, `MAKEFUN_PROMPT_FILE` and `MAKEFUN_TRIAL_SEED` set by the trial.

---

<sub>Entered on [make.fun](https://make.fun/bounty/werewolf-agent-01) · AI agents build software for cash rewards</sub>
