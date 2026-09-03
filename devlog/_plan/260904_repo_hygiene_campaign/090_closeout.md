# 090 — Campaign closeout

## Result

| Surface | Before | After | Change |
|---|---|---|---|
| Local branches | 241 | 171 | −70 |
| Remote branches | 61 | 59 | −2 |
| Open issues | 45 | 32 | −13 |
| Open PRs | 53 | 56 | +3 |

Local branch deletion: 71 refs, each with a recorded proof and a tip SHA
re-checked immediately before removal. Zero open-PR heads lost, zero
worktree-backing refs lost, zero preserved branches removed.

Issues: 14 closed (3 implemented, 11 consolidated), 5 consolidated issues opened
(#3375–#3379), 7 stale reports given a specific unblocking request instead of a
silent close.

PRs: 1 closed (#3312, superseded by the same author's #3348). The open-PR count
rose because unrelated work opened carry and stacked PRs while this ran.

## What this campaign was actually about

The instruction was to clean up merged branches and close superseded work. The
branch half was real: 71 of 241 local refs were duplicates of PR heads or
content already on `dev`. The PR half was not — 0 of 35 contributor PRs had
landed. The backlog is unreviewed, not stale, and the correct action was to
leave it open and say so.

## The recurring defect

Four separate times, a check reported success because a command had failed:

1. zsh did not word-split an unquoted path list, so `git diff` matched nothing
   and `feat/macos-app` — 57 unlanded files including an entire `app/` tree —
   scored "landed".
2. `git fetch` and `git diff` return codes were ignored, so a stale ref or a
   failed diff could authorize a deletion.
3. Cached proofs were never rechecked, so a branch that moved after
   classification would still be deleted on a stale verdict.
4. Orphan `assets/*` branches have no merge base, so the diff exited 128 and
   printed nothing; five evidence branches holding 36 unique images scored
   "landed".

Every one produced *empty output*, and empty output was read as "no
difference." The rule this campaign ends with: **a test whose safe answer is
silence must first prove the command spoke.**

Three of the four were caught by an independent auditor that failed the plan
three times before passing. The fourth was caught by re-checking a result that
looked too convenient. None were caught by the plan document, which had
explicitly warned against this class of error on its own line 46.

## Attribution

Carry PRs #3371–#3373 credit their authors correctly. #3374 named a git identity
not linked to any GitHub account, which credits nobody; the trailer now names
`blackjune67 <46661504+blackjune67@users.noreply.github.com>` and the PR carries
an instruction to preserve it through the squash. Every issue closure names its
reporter and states what shipped and what did not.

## Follow-ups worth doing

- `missing_coauthor_credit` verifies a trailer exists but not that it resolves
  to a real account. An unlinked-email check would have caught #3374.
- The 24 LIVE issues and 55 unreviewed PRs are the actual backlog. That is a
  review campaign, not a hygiene one.
