# 020 — wp1: local branch deletion

Delete the 104 branches in the verified deletion set, in batches, re-reading the
guard sets before each batch.

## Procedure

1. Snapshot every local ref to scratch: `git for-each-ref refs/heads` with SHAs,
   so any deletion is recoverable by SHA for as long as the objects survive gc.
2. Re-read open-PR head refs from `gh` and worktree refs from
   `git worktree list --porcelain`. Intersect with the deletion set; a non-empty
   intersection aborts the phase.
3. Delete with `git branch -D` in batches of ~20, capturing the reported SHA for
   each deletion.
4. Verify: `git for-each-ref refs/heads | wc -l` reaches 230 - 104 = 126, and
   every protected/open-PR/worktree ref still resolves.

`-D` rather than `-d` is required because squash-landed branches are not
ancestors of `dev` and `-d` refuses them; that is exactly the case T3 exists to
decide, and the decision has already been made with evidence.

## Exit criteria

- 126 local branches remain.
- All 7 open-PR head refs present locally still resolve.
- All 44 worktree-backing refs still resolve.
- `dev`, `main`, `preview` resolve to their pre-phase SHAs.
