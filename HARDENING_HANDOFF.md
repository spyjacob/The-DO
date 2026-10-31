# Hardening handoff — 31 October 2026

## Scope and status

**This is a substantial contained hardening pass, not completion of the full
implementation mandate.** In particular, durable jobs and conflict-preserving
partition reconciliation have not been implemented. Their absence is not a
physical-host testing limitation: substantial source changes are still required.
Do not describe this branch as having solved distributed data preservation.

Baseline/current HEAD and independently queried remote `main`:
`14a81b24c7b8ef28bb4a0594fd08705839cb76f6`. All changes from this pass are
uncommitted in `harness/tab-fcd336ff44dd8d125b0f37b2`. No other worktree was edited,
no source commits were made, and no changes were published. The only Git pushes
performed by tests targeted disposable local bare repositories.

The running laptop independently reported the baseline SHA with a busy process.
Machine/Windows was unreachable, so its source, runtime, disk and installation
remain unknown. Neither running host loaded these changes. Live activity was read
through supported diagnostics/status endpoints, not private data files. No
production migration, pairing/authentication change or restart was attempted.

The original suite passed 3/3 before editing. Node is v26.8.1; lockfile v3;
Claude Agent SDK 0.3.280, Anthropic SDK 0.124.0, OpenAI SDK 7.10.0 and
cross-spawn 7.0.6. No runtime dependency was added. Session reasoning effort was
not reconfigured; a prompt cannot change its runtime setting.

## Implemented changes

See [the engineering ledger](HARDENING_LEDGER.md) for each issue's evidence,
invariant, regression and disposition. Main changes:

- Preserve configured launcher authentication. Empty-token access requires both a
  loopback socket and localhost/loopback Host; arbitrary LAN clients and DNS
  rebinding no longer get the host-control API. Authenticated Tailscale Serve and
  cluster-key paths remain. Browser cross-origin mutations are refused; cookies
  become HttpOnly.
- Quote-safe rendering and safe navigation URLs. File contents require a project,
  worktree, explicit read grant or exact saved attachment reference. Private data
  is denied. Existing ancestor symlinks are resolved for reads and new writes.
  HTML/SVG responses receive an opaque sandbox and nosniff; legacy proxy forwards
  those protections. Session/project PATCH cannot overwrite identity or history.
- App lifecycle/registry and monitor mutations serialize within one process;
  unique fsynced replacements preserve partial-write safety. Corruption raises a
  recoverable error and leaves original bytes in place. Standalone session files
  now use file/directory sync. This does not serialize a peer's registry mirror.
- Anthropic honors no-tools; the common API loop refuses unexpected tools.
  Responses incomplete preserves partial output and reason. Its budgeting uses
  actual Responses output items, retaining call/result identity and all user text.
  Provider options cannot override the canonical model/tool policy.
- Early failed validation does not register a live session. Notification failures
  no longer save an old transcript over newer work. Repair receives the native
  interaction callback; Claude resume fingerprints include additional semantics.
- Shell abort/timeout targets only the process group created for the run; a delayed
  write regression demonstrates cancellation. Unsupported external side effects
  are neither fenced nor rolled back.
- Refresh generations and queue-response guards reduce stale UI replacement;
  discovery no longer blocks local metadata painting. Browser storage failures are
  guarded. Informational notices no longer trace as errors.
- Publication to an existing remote has a durable receipt before attempting push,
  then an acknowledged-publication/local-checkout status. Local update failure is
  reported as partial success. HTTP status includes the latest receipt. Recognizing
  a descendant remote tip avoids mistaking later advancement for failed publication.
- Clean previously tracked source can boot when fetching fails; dirty/divergent
  source still refuses. Dependency-changing restart refuses before stopping the
  old server instead of starting code against an unprepared environment.
- Diagnostic maintenance is amortized without removing rotation, admission bounds,
  privacy filtering, drop counters or low-disk protections.

## Contracts actually offered

**Authentication:** trusted personal host automation, not multi-user authorization.
Loopback processes are trusted in empty-token mode. Tailscale Serve must strip
incoming identity headers and supply authenticated identity on a loopback socket;
an arbitrary local reverse proxy must not forward attacker-supplied identity.
Configured tokens continue to work for remote clients. Cluster peers remain fully
trusted. Pairing/health discovery still have their existing public protocol.

**File policy:** project/worktree roots and session read grants allow file reads;
`confineToProjectDir:false` remains an explicit broad host-read scope excluding
private Harness data. A browser without a session can read registered project
roots. The folder chooser still exposes non-private directory metadata so an owner
can select a project. Tools deny static symlink escapes and private data even with
outside access. Concurrent adversarial link replacement is not prevented by these
path checks. Native tools and shell capabilities retain their own OS/provider
boundaries; this is not a universal sandbox. Sandbox HTML cannot execute scripts or
use DO's origin; run an application on its own app origin for interactive previews.

**Persistence/ownership:** existing owner/epoch behavior and per-tab unpublished
worktrees remain. Two-host quorum-one can still diverge and replace active histories.
There are no new record tombstones or causal conflict views. Existing archives are
retained; the historical missing project was not searched or restored.

**Queue/replay:** queues remain process-local. A refresh reconnects to live queue
state; a process crash can lose it. Saved immediate text is not a durable executable
job. No uncertain dispatched work or legacy `queueTurn` fields are replayed. Native
approvals remain live requests; no restart approval is inferred.

**Publication:** version-1 receipts for existing-remote integration live under
`<git-common-dir>/harness-publications/<tab-key>/<timestamp>-<uuid>.json`.
States are `remote-outcome-unknown` and `published`, with local checkout status.
An unknown receipt is deliberately not evidence of no effect. Inspect the recorded
candidate against the remote before retrying. Receipts never contain tokens or
remote credential URLs. They are supplemental evidence, not a job/consensus store.
New-repository creation/publication still uses the older path and needs equivalent
receipts. There is no exactly-once external-side-effect guarantee.

## Validation and measurements

Commands run against disposable stores/processes/repositories:

- `npm test > hardening-baseline.log 2>&1`: original 3/3 passed.
- `npm test > hardening-tests.log 2>&1`: expanded 7/7 passed on the reviewed tree.
  Runner now executes the existing top-level chat-label and HTTP-rollout checks,
  in addition to distributed/network/restart and the two new workflows.
- `test/e2e/hardening.test.mjs`: real SDK streaming HTTP fixtures, no-tools write
  sentinel, incomplete response preservation, budget integrity, concurrent registry
  and monitor writes, corrupt registry preservation, symlink grants/refusals,
  owned-shell cancellation, local/LAN/host/origin HTTP policy, internal PATCH
  rejection and sandbox file response. Browser-renderer check uses served source.
- `test/e2e/publication-startup.test.mjs`: real bare Git remote and primary-checkout
  failure after publication, receipt read in a new process, offline clean boot,
  dirty checkout refusal, actual desktop launcher preserving a synthetic token,
  and changed-lockfile restart refusal.
- `node scripts/hardening-browser-check.mjs > hardening-browser.log 2>&1`:
  isolated server and installed Chrome via the existing local Playwright helper.
  Simultaneous attachment/permission/expanded queue/input at 390x900 and 1280x900:
  no overlap with input, no horizontal overflow, no page errors. Screenshots are
  `.launcher/hardening-panels-390.png` and `...-1280.png`. An initial assertion
  incorrectly compared nested panels with their enclosing footer; it was corrected
  to compare with the input, matching the current DOM. No UI workaround was made
  to hide that test failure. This is viewport emulation, not physical Safari.
- `git diff --check` and syntax checks passed during implementation.

The browser script imports the existing `.launcher/browser-tools/node_modules/playwright`
helper, which is intentionally not a runtime dependency. Set `HARNESS_BROWSER_BIN`
for a different installed Chrome path. Missing browser tooling is not a passing
browser result; the normal npm suite does not install or run Chrome.

Synthetic tracing measurement (same host, sequential 2,000 metadata events):

| Version | Total time | p99 event time | Stored bytes | Dropped / failed |
|---|---:|---:|---:|---:|
| Baseline | 567 ms | 0.559 ms | 346,890 | 0 / 0 |
| Changed | 155 ms | 0.128 ms | 346,890 | 0 / 0 |

This is one filesystem microbenchmark, not a production throughput guarantee.
Free-space sampling can lag up to one second; per-append byte accounting and
explicit settings/status operations still enforce retention. No large transcript,
asset-replication or archive-scale performance claim is made.

Transient failures found and corrected: the pending-panel VM fixture initially
omitted its newly used version map; Node fetch did not transmit the hostile Host
header in the DNS-rebinding test, so that test now uses real `http.get` with the
header. No production assertion was removed to obtain green tests.

## Migration, rollout and rollback

No session/replica schema migration is activated. Existing queues, conflict archives,
credentials, attachment stores and worktrees are untouched. The only new persistent
format is the additive publication receipt v1. Old executables ignore it; retain it
when rolling back because it may be the only convenient record of an uncertain push.

After ordinary reviewed Push, an operator should:

1. Let active turns finish. Retain normal backups of data and unpublished worktrees;
   this assignment did not read or make private backups.
2. Review the authentication behavior above. Keep local console access available.
   Explicit existing tokens are no longer discarded by the desktop launcher.
   Use the token-bearing URL when configured, or local `http://127.0.0.1:<port>`
   in empty-token mode. Phone access uses authenticated Tailscale Serve. A custom
   proxy lacking that identity must use configured authentication.
3. Start through the desktop launcher if dependencies are not stamped for the
   current lockfile. In-app restart now intentionally refuses an unprepared
   dependency change while leaving the old process running. Fully isolated
   automatic candidate preparation remains unfinished.
4. Update one host, verify its independent running revision, authenticated phone
   access and project reads, then update the other when reachable. Coordination
   protocol is unchanged, so mixed peers still communicate, but an old peer still
   exposes its old vulnerabilities and data-loss semantics. Refresh loaded pages.
5. Check safe file download, an explicit read grant, no-tools chat, a normal native
   approval and a disposable publication before relying on the changed paths.

Claude resume metadata now includes `context`. The first turn with older metadata
starts a fresh native session using canonical history; old native stores are not
removed. Subsequent unchanged-context resumes retain identity. Older code does not
understand the stronger eligibility policy, so rollback weakens that guarantee.

Corruption recovery is deliberately manual: the invalid original remains at its
path, not silently moved/deleted or replaced with an empty registry. Copy it for
recovery using an authorized operator workflow, validate a known-good registry in a
disposable installation, then restore while the affected service is stopped. No
live restore was attempted and no automatic destructive migration is offered.

## Remaining high-impact implementation work

These are source gaps, not merely requests for more testing:

1. **DS-01–05,08–09; MQ-01–04:** design and implement the common per-origin durable
   admission/history contract before adding a queue disk dump. Entry points:
   `cluster/raft.js` apply/install/truncate, `cluster/index.js` changeSession and
   join, `message-queue.js`, dispatch/schedule/send routes, `project-import.js` and
   `project-recovery.js`. Reproduce with two independent stores partitioned after
   common state, write distinct records on both, reconnect/restart. Current archives
   do not satisfy active preservation. Same-record versions, durable tombstones,
   sticky ownership, stale-revision rejection, resumable import and protocol-version
   negotiation are still required. The three-host snapshot invariant is not solved.
2. **MQ-03, UX remainder:** persist unresolved send IDs/drafts and query status;
   compare retry payloads. Browser retries can still create a new logical ID.
   Queue edits still lack a durable record revision. Add delayed HTTP/SSE permutations,
   denied-storage tests and a complete kill-at-each-admission-phase matrix.
3. **AG-01,07:** replace the Codex noninteractive execution adapter with a verified
   native app-server bridge. Installed CLI 0.153.4 was queried only for version and
   generated protocol types under an isolated empty CODEX_HOME. Official
   [app-server documentation](https://developers.openai.com/codex/app-server)
   describes thread start/resume, turn lifecycle, approvals and questions. No bridge
   was implemented here. **The existing Codex default bypass remains a high-impact
   unresolved issue**, as does enforcing no-tools for that native adapter. Do not
   advertise native parity or a changed Codex permission policy.
4. **AG-04–06:** repair now receives callbacks, but test actual permission/question
   during repair, richer structured choices, changed-attachment/model resume, and
   native subprocess cancellation. The API shell cancellation test does not prove
   native subprocess trees terminate. Real accounts were not invoked.
5. **OPS-02–05:** full durable publication UI/recovery for receipt-save failures,
   new repositories and lost replies followed by remote advancement; isolated
   dependency preparation; per-host rollout; conservative stale-lock diagnosis.
   No active-lock stealing was added. Repair check-definition rejection needs a
   targeted malicious-repair fixture and a clear explicit-review UX.
6. **DS-06, APP-01–02, PERF-01:** local registry locks do not cover replicated mirror
   replacement or multiple processes. Move the authoritative mutation boundary into
   the chosen record model. Owner-directed app lifecycle, observational status
   collectors and whole-transcript/asset costs remain. Do not delete archive/native
   history or sole asset copies to enforce a storage budget.
7. **Security follow-through:** exercise actual Tailscale phone proxies, Windows
   canonical paths/cancellation, concurrent symlink swaps, session permission UX,
   same-origin hostile-preview behavior in a real browser, and all supplied URL
   fields. Current socket policy is personal-tool trust, not tenant authorization.

## Native capability evidence

| Adapter | Preserved/changed | Evidence in this pass | Not established |
|---|---|---|---|
| Claude SDK | Existing native stream/resume/permission callback; stronger resume fingerprint; repair callback added | Existing deterministic SDK protocol workflow passes | Paid account behavior, every context-change case, repair approval scenario |
| Codex exec | Existing behavior unchanged | Installed version/types and official protocol inspected | Interactive/resume bridge, safer default permission migration, native no-tools |
| Anthropic API | No-tools definitions and execution guard | Real SDK against deterministic local HTTP | Live account/model entitlement |
| OpenAI-compatible API | Canonical request policy, denied unexpected tools | Local HTTP streaming fixture | Vendor-specific extras across all providers |
| Responses API | Partial/incomplete outcome and correct output budgeting | Real SDK against deterministic local SSE | Paid model behavior, exact token budget |

The tree is suitable for review of these contained changes. It is **not acceptance
of the full hardening mandate**. Preserve this ledger and continue the central
persistence/reconciliation work rather than marking it complete from seven suite
filenames.

## Follow-up: model-specific effort controls

The generic effort dropdown is replaced with model capability data. Codex discovery
retains `supportedReasoningEfforts` and `defaultReasoningEffort`; Claude discovery
retains `supportsEffort` and `supportedEffortLevels`. Refreshing supported levels in
session settings updates existing source rows on the execution host without changing
their configured effort. Source capabilities persist in the ordinary model config.
The official OpenAI API has a documented fallback for exact `gpt-6-astra`:
low, medium, high, xhigh, max, per
https://developers.openai.com/api/docs/models/gpt-6-astra (checked 2026-10-31).
This fallback does not apply to custom endpoints or Codex's native catalog.

Unknown capability lists permit an explicitly unverified text override rather than
inventing a maximum. Known unsupported values are rejected on settings updates and
turn execution; switching models cannot silently retain a known-invalid override.
An empty override leaves provider/configured defaults intact. Values are passed
through without translating max into a different level or retrying at lower effort.
The header shows the selected wire model ID and requested effort, or the reported
provider default/unknown state. It does not claim provider-confirmed effective effort.
The header wraps instead of truncating, including during local runtime status updates.
Existing native sources should use “refresh supported levels” once to acquire their
catalog metadata; unavailable peers cannot supply current capabilities.

This follow-up addresses the effort selector portion of AG-07. Native permission,
execution bridge, and durable history work listed above remains outstanding.


## Follow-up: source-first model selection and login recovery

Session settings now open a source → model picker for the owning computer.
Selecting Claude Code or Codex discovers its native catalog and registers every
reported model, reusing existing provider/model aliases. Discovery failure blocks
selection from that source and exposes the error, the correct computer, a copyable
native login command and retry. Login still requires Terminal and browser
interaction on that computer; this is not an embedded OAuth broker and no live
account login was performed. Available catalog entries are not a guarantee of
subscription entitlement or successful inference.

Unknown effort capabilities use a default/saved-value dropdown instead of free
text. Native capability refresh goes through the same source discovery/recovery
screen. Selecting a model explicitly resets the old session effort override to
that model's default, as stated in the picker. The header names the adapter as
well as model and requested/default effort. New-chat creation separates configured
sources from their models; source onboarding preselects all discovered models.
Metadata traces distinguish picker loading, content, empty and error states;
no login output or account credentials are collected.
