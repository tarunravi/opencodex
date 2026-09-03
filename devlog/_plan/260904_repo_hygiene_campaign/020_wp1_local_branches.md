# 020 — wp1: local branch deletion

Delete the 71 branches in the verified deletion set, in batches, re-reading the
guard sets before each batch. Each entry carries a named proof; a branch with no
proof is preserved rather than deleted.

## Procedure

1. Snapshot every local ref to scratch: `git for-each-ref refs/heads` with SHAs,
   so any deletion is recoverable by SHA for as long as the objects survive gc.
2. Re-read open-PR head refs from `gh` and worktree refs from
   `git worktree list --porcelain`. Intersect with the deletion set; a non-empty
   intersection aborts the phase.
3. Delete with `git branch -D` in batches of ~20, capturing the reported SHA for
   each deletion.
4. Verify: the local branch count drops by exactly 71, and every
   protected / open-PR / worktree ref still resolves. Counts are measured live
   at execution rather than asserted here — the branch total moves as other
   sessions work in this repository, and a stale expected number is a false
   alarm, not a safety property.

`-D` rather than `-d` is required because squash-landed branches are not
ancestors of `dev` and `-d` refuses them; that is exactly the case T3 exists to
decide, and the decision has already been made with evidence.

## Exit criteria

- Exactly the 71 approved refs are gone; nothing else was removed.
- Every open-PR head ref present locally still resolves.
- Every worktree-backing ref still resolves.
- `dev`, `main`, `preview` resolve to their pre-phase SHAs.
- `cursor-call-prerebase-260818` and the other 32 preserved branches still
  resolve.
