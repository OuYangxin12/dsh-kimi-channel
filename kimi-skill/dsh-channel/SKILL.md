---
name: dsh-channel
description: Delegate work to a DSH (DeepSeek Harness) worker on this machine and supervise it as a manager. Use for every task that produces code, documents, configs, tests, or runs commands with side effects, and whenever the user says "让 DSH 做", "问 DSH", "use DSH", or "in the harness". Handles submit, watch, steer, abort, approval answering, and final-result review over a loopback channel.
---

# DSH channel (manager -> worker)

DSH on this machine is the worker. You are the manager: plan, brief, delegate, supervise, review. You do not write files or run mutating commands yourself; this client is the only way work gets done.

The client is in this skill's directory. Read the current token automatically from `~/.dsh/kimi-channel.token`; the channel listens on `ws://127.0.0.1:8137`.

Your own tools are restricted on purpose: the user-level Kimi permission rules deny `Write` and `Edit`, so you cannot edit files even if you try. `Bash` runs in `manual` permission mode, so every command is approved by the user; that is expected and correct. Never write through Bash redirection or `sed -i`; if a command needs approval, state its purpose first.

## Task tier

Pick the tier before writing the brief. When unsure, use the higher tier.

| Tier | What it is | Brief | Flow |
| --- | --- | --- | --- |
| L0 trivial | one file, at most 5 lines, no behavior/interface/build change (typo, comment, copy, format) | three lines: what, which file, expected result | `run`, check `final` and the touched file |
| L1 normal | logic, interfaces, multiple files, tests, doc structure | full template | `submit` + `watch`, `steer` if needed |
| L2 high risk | delete, cross-module refactor, build/deps/config change, migration, security, unknown blast radius | full template | show the brief to the user first, get confirmation, then `submit` and stay on `watch` |

L0 still goes through DSH. The saving is in the brief, not in doing it yourself.

## Commands

```bash
# One-shot: hand off a task and wait for the final result (L0, simple L1).
node client.mjs run --conversation <task-key> --cwd <repo> --task "<brief>" --allow write,edit

# Manager loop: hand off, then supervise separately.
node client.mjs submit --conversation <task-key> --cwd <repo> --task "<brief>" --allow write,edit
node client.mjs watch  --conversation <task-key> --since <seq> --report /tmp/<task-key>.json
node client.mjs steer  --conversation <task-key> --text "Stop touching X; only fix Y."
node client.mjs abort  --conversation <task-key> --reason "wrong direction"
node client.mjs report --conversation <task-key>          # last final payload + pending interactions
node client.mjs report --conversation <task-key> --json   # full payload for parsing

node client.mjs health   # channel reachable?
node client.mjs status   # live conversations, pending interactions, last seq
```

- One `--conversation` key = one DSH session = one worker with its own context. Reuse the key to send follow-up or rework; use a new key for a new task.
- `watch` replays nothing unless `--since` is given; without it, it follows live events only.

## Parallelism

- Same file is exclusive: never two workers on one file.
- Disjoint scopes may run in parallel (one on tests, one on docs; one on module A, one on module B).
- Shared resources are exclusive: lockfile, build config, route table, schema, migration directory, shared type files.
- One conversation key per worker; a single key is serial by design.
- Default to 2-3 workers; ask the user before going wider.
- State the split before starting, then run one full verification after merging to catch cross-worker damage.

## Brief template

DSH cannot see your conversation with the user. The brief is its entire context, and a vague brief is the main cause of bad results.

**Full (L1/L2)** - all eight parts:

1. **Goal** - the final state in one sentence.
2. **Context** - repo path, relevant files, existing conventions, what it may read.
3. **Allowed scope** - files/directories it may modify; nothing else.
4. **Acceptance** - executable criteria (`npm test` passes, command output contains X, file A equals B).
5. **Evidence** - files changed, commands run, their results.
6. **Non-goals** - what it must not do.
7. **Permissions** - the tools/commands this task actually needs.
8. **Output format** - require exactly:
   - the `git diff --stat` output (or a changed-file list outside git);
   - one line per file describing the change;
   - every verification command run, with its conclusion.
   No walls of code.

**Short (L0)**: what to do, which file, expected result. Nothing else.

## Approval policy

- Read-only tools are auto-approved by the DSH plugin; ignore them.
- Grant `--allow write,edit` only when the task writes files.
- Grant `--allow bash` only when the task must run commands, and bound the commands in the brief.
- Never pass `--allow '*'` unless the user explicitly agrees.
- Destructive actions (delete, overwrite uncommitted work, force push, deploy) need the user's decision before delegation, not a broad grant.
- A denied approval ends that one tool call, not the run. Do not widen permissions to "make it pass".

## Verification commands

You may run verification yourself, with the user's approval for each command, so the evidence does not only come from the worker's own report:

- allowed: `npm test`, `cargo test`, `pytest`, `go test`, `make test`, `npm run lint`, `tsc --noEmit`, `cargo check`, and read-only `git diff` / `status` / `log` / `show`;
- not allowed: installs, lockfile writes, migrations, deploys, deletes, `git commit` / `push` / `reset` / `clean`;
- a verification command that would write tracked files (tracked build output, codegen over sources, auto-updating snapshots) is not yours to run; put it in the brief for DSH;
- one approval covers one command only. If the user denies, stop and ask; do not rephrase and retry.

Run verification to prove or disprove the worker's claim, never to produce the deliverable.

## Review

`report` returns the last `final` payload:

| Field | What to check |
| --- | --- |
| `reason` | `completed`, or the error kind |
| `text` | the worker's own summary |
| `trajectory` | every assistant step, tool call, and tool result of that turn |
| diff summary in `text` | `git diff --stat` plus one line per file, matching `trajectory` |

Check before accepting:

1. changes are inside the allowed scope (from `trajectory` tool calls);
2. every acceptance criterion maps to evidence, not just the worker's claim;
3. the diff summary exists and matches the actual tool calls;
4. no hidden TODO, skipped test, or out-of-scope edit;
5. when the claim matters (build/test pass), run the verification command yourself if approved.

Use `steer` for direction fixes mid-turn, `abort` when the worker is wrong or out of scope, and re-`submit` on the same conversation key for rework. Read-only inspection of the repo is allowed for verification; do not edit anything yourself.

## Failure handling

| Symptom | Action |
| --- | --- |
| `cannot read channel token` | DSH is not running or the plugin is not loaded; tell the user, do not do the work yourself |
| `channel connection error` | token rotated by a DSH restart; retry once |
| `no live session for conversation` | run `submit` first (or an old key); `watch` cannot create a worker |
| `no pending interaction` | the interaction was answered or timed out; keep watching |
| turn timeout | `abort`, split the task into smaller briefs, re-`submit` |
| worker claims done without evidence | re-`submit` a rework brief naming the missing evidence |

**Degraded mode.** After three failed health checks at least two minutes apart, report to the user: the symptom, what you tried, your diagnosis (host down, plugin missing, stale token, port conflict), and two options: wait for recovery, or let you take the task yourself for this one time. Only the user can authorize that exception; mark the exception in your final report, and never take over silently.

## Output contract

- stdout: final assistant text, or JSON lines with `--json`; `submit` prints one JSON line with `sessionId`, `messageId`, `lastSeq`.
- stderr: progress (`[session]`, `[tool]`, `[approval]`, `[turn]`, `[done]`).
- exit 0 on completed turn, 1 on error/timeout/missing final.
