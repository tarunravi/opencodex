# 030 — wp2: origin remote branch deletion

`origin` carries 56 branches. The deletable set is the intersection of:

- not `dev`, `main`, `preview`
- not the head ref of an open pull request whose head repository is
  `lidge-jun/opencodex` (fork-hosted heads are not ours to delete and are not
  reachable as `origin` refs anyway)
- content already on `dev` by the T3 test applied to `origin/<branch>`, or the
  branch is a spent dispatch/promotion artifact

Two families dominate the remote list and need separate judgment:

- `origin/codex/win-dispatch-*` (9 refs) — CI dispatch artifacts pinned to a
  commit SHA. Spent once their run finished.
- `origin/assets/*` and `origin/media/*` — evidence assets referenced from PR
  and issue bodies by raw URL. Deleting these breaks images in published
  descriptions, so they are retained unless the referencing item is closed and
  the image is no longer rendered. Default is keep.

Deletion uses `git push --no-verify origin --delete <exact-branch>`, one ref per
command with a bounded timeout. `--no-verify` is required because the pre-push
hook runs a local suite, which is forbidden for this unit; the safety that hook
would provide is already supplied by the T1–T4 evidence and the guard sets, and
a deletion pushes no code.

## Exit criteria

- `git ls-remote --heads origin` no longer lists any deleted ref.
- Every open PR's head ref still resolves on its own repository.
- Asset branches still referenced by open items remain.
