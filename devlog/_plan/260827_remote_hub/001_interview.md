# 001 — Interview record (2026-08-28)

Answers captured from the maintainer (session 01a0439a, I-phase round 2):

- **Scope: ALL 6 phases, full implementation including hardening (P6).** Delivery as a
  stacked PR chain grown from this branch (codex/remote-hub-design is the stack base;
  each phase PR targets the previous head; retarget to dev as parents land —
  DEV-STACK / enforce-target child rules).
- Q2 (plain-HTTP pairing): accepted — rung 4 ships in Phase 2 with rung 3.
- Q3 (per-client keys): recommendation accepted BUT see new usage requirement below,
  which pulls toward auto-issuing per-client keys at connect.
- Q4 (URL split): accepted — separate managementUrl allowed, /readyz advertises it.
- Q5 (remote session TTL): accepted — renewable long-lived remote sessions.
- Q6 (hub local integration): accepted — hub does not inject locally by default.
- Q7 (Claude): launcher-scope first confirmed; maintainer notes it is machine-local
  anyway — clean separation is the requirement, not persistent integration.
- Q8 (deployment): **dogfood on clisu-oracle as part of this work**, AND the protocol
  must tolerate release-build peers: a released client against a dev-build hub (and
  the reverse) must interoperate "어느정도" — i.e. protocol-version negotiation in
  /readyz is a hard requirement, not polish (Phase 1 scope).
- **NEW requirement (usage attribution):** the client GUI usage page should reflect
  "my machine's usage" while connected, and after `ocx disconnect` the GUI (back in
  standalone mode) shows the local proxy's own usage again. Feasibility confirmed in
  code: usage attempts already persist `apiKeyId` for configured-key admissions
  (src/server/management/api-key-usage.ts:78-89, admissionFields in
  src/server/auth-cors.ts:369-375), so a per-client filtered usage view is a query
  over existing data — it requires the machine to authenticate with its OWN key,
  which is why connect should default to per-client key issuance.

Open contradiction (to resolve this round): shared-token-allowed (Q3 answer) vs
per-machine usage view (new requirement) — attribution is keyed on apiKeyId, so a
shared token collapses all machines into one bucket.

