# Hardening engineering ledger

Baseline and current HEAD: `14a81b24c7b8ef28bb4a0594fd08705839cb76f6`.
Initially clean isolated branch `harness/tab-fcd336ff44dd8d125b0f37b2`;
publication target `origin/main`, independently queried at that same SHA.
Node v26.8.1; lockfile v3; installed/locked Claude SDK 0.3.280,
Anthropic SDK 0.124.0, OpenAI SDK 7.10.0, cross-spawn 7.0.6.
The supplied conversation is the implementation assignment: no separate
implementation-prompt file was present. The dossier is supporting evidence.
The live laptop reported this SHA; Windows host was unreachable. Diagnostics
returned 1,000 laptop events and an unavailable peer, not a complete usage record.

Status is scoped: a mitigation is not closure of the broader dossier item.

| References | Rechecked evidence and invariant | Implementation | Regression / status |
|---|---|---|---|
| TEST-01 | Runner omitted two named top-level tests | Discover explicit `.test.mjs` files in test/ and test/e2e/, never fixtures | Both now execute; fixed |
| SEC-01 | Launcher deleted token; no-token mode accepted all sockets | Preserve configuration; local socket + local hostname required without token; authenticated Serve identity/cluster paths retained | Actual launcher fixture; hostile Host and LAN HTTP; fixed for stated personal trust boundary, live phone unverified |
| SEC-02,03 | HTTP contents had no scope; file tools lexical-only | Canonical existing ancestors/new targets; private data denied; project/worktree/read grants; exact session attachment exception | Real HTTP and file-tool symlink/read/write fixtures; mitigated, concurrent link swaps not an OS sandbox |
| SEC-04 | Native and shell enforcement differ | Document boundaries; retain native behavior | Deferred enforcement parity |
| SEC-05 | Shared HTML escape omitted quotes | Escape both quote forms; HTTP(S) URL policy for supplied navigation URLs; preserve encoded local filenames | Served renderer hostile href fixture; fixed demonstrated injection, no exhaustive browser fuzzing |
| SEC-06 | Downloaded HTML/SVG inherited API origin | CSP sandbox without same-origin/scripts; nosniff; legacy proxy forwards these headers | Real HTML response headers, no live exploit; mitigated |
| SEC-07 | Ordinary PATCH could replace internal records | Allowlisted session/project settings; type checks; reject transcript/identity updates | HTTP event-overwrite rejection; mitigated (settings concurrency still needs revisions) |
| Adjacent browser mutation origin | Browser form could drive localhost API | Origin-host and Sec-Fetch-Site mutation checks; HttpOnly ticket cookie | Cross-origin HTTP rejection; no blanket multi-user authorization claim |
| DS-06,07 | Registry read failures became empty; mutation snapshots raced | Serialize local lifecycle/mutations, unique fsynced replacement, validate registry and preserve corrupt original | 12 concurrent creates/updates; corrupt-file bytes unchanged after refused create; mitigated across-host authority remains open |
| Adjacent monitors | Same read/write pattern | Serialize upsert/remove, unique atomic writes, reject corruption | 12 concurrent persisted monitors; direct external file writers still outside lock |
| DS-10 | Standalone session replacement lacked explicit sync | Shared atomic-file helper fsyncs file and directory (directory sync excluded on Windows) | Normal persistence suite; no power-loss experiment; mitigated |
| MQ-05 | live.set preceded model validation | Register only after validation | Existing validation workflow; full leak fault matrix unverified |
| MQ-06 | Detached notification failure saved captured transcript | No transcript save; trace and delivery-error event instead | Removed stale save path; notification/new-turn timing injection still unverified |
| AG-02 | Anthropic always sent tools; loop trusted tool calls | Honor useTools; common API execution denies unexpected calls and records paired failure results | Real SDK against HTTP fixture + write sentinel; fixed API path |
| AG-03 | Responses incomplete reported normal result | Preserve partial text and explicit reason; stop as error | Real SDK streaming fixture; fixed |
| AG-08 | Chat-shaped budget ignored Responses outputs | Trim only older function outputs, retain call/result IDs, newest output and user text | Pair integrity/nonmutation assertions; soft character heuristic explicitly retained |
| Provider extraBody/cache | Late overrides could select tools/model; cache distinguished only key presence | Canonical request fields win; no-tools removes tools; credential identity hash invalidates client | HTTP request policy assertions; key rotation behavior not live-tested |
| AG-04 | Repair lacked native interaction callback | Same session interaction bridge passed into repair | Existing Claude protocol fixture passes; repair approval flow itself still unverified |
| AG-05 | Tool timeout stopped waiting without cancelling shell | Propagate abort; own process group termination and escalation; bounded capture | Real command cancelled before delayed file write; Windows tree termination unverified |
| AG-06 | Resume omitted attachments and context | Fingerprint attachment metadata, model definition, permission/read roots/system/context | Existing native identity/resume fixture; extended context-change matrix incomplete |
| UX-02,03 | HTTP snapshots could overwrite newer UI state | Refresh generations, session scope, queue SSE version guard | Existing served-source flows pass; exhaustive delayed-order matrix open |
| UX-01 | refreshState awaited discovery before painting local state | Discovery runs separately with freshness guard | Existing startup/disconnected workflows; universal read watchdog not implemented |
| UX-04 | Storage denial could break cluster initialization/navigation | Guard remaining storage calls | Browser ordinary-path check; denied-storage fixture still needed |
| OPS-01 | Failed fetch prevented known local boot | Clean checkout matching cached upstream can boot with warning; dirty/divergent still fail | Disposable remote removed, local clean boot and dirty refusal; fixed narrow failure boundary |
| OPS-04 | Remote success followed by local failure looked unpublished | Versioned durable pre-push/ack receipt; partial success; remote ancestry recognizes later advancement; API exposes receipt | Bare Git remote publication + dirty primary, new-process receipt read; lost reply plus later advancement not fault-injected |
| OPS-05 | Restart skipped dependency preparation | Shared lock hash; helper refuses unprepared dependencies before old process exits | Launcher/dependency delta fixture; mitigated, isolated candidate installation unfinished |
| Adjacent automatic repair | Conflict repair had no check-definition guard | Reject repair changing test/config/lock definitions relative to either parent | Existing conflict/check gates pass; targeted malicious-repair fixture still needed |
| PERF-02 | Retention scans on every trace | Cache segment/accounting; maintenance at most 1s apart or cap/explicit query | Existing disk/rotation/write-failure fixtures; 2,000-event comparison, 567ms → 155ms, same bytes, zero drops |
| OBS-01 | Generic notices labeled errors; legacy proxy lost context | Distinguish notice/error; session/app operation categories; trace/session headers forwarded | Existing trace workflow; semantic audit incomplete |
| DS-01–05,08–09; MQ-01–04 | Coordination can replace acknowledged histories; queues volatile | No new data authority activated | Deferred: central contract remains unsolved; exact next entrypoints in handoff |
| AG-01,07 | Noninteractive Codex; generic efforts | Checked installed Codex 0.153.4 protocol in isolated CODEX_HOME and official docs | Execution bridge and effort capability UI deferred; no live account calls |
| APP-01–02; PERF-01; OPS-02–03 | Owner lifecycle/observational reads, full serialization, all-peer rollout, stale locks | No speculative rewrites | Deferred |
| DOC-01 | Overstated durability and enforcement | Updated local comments and explicit handoff guarantees | Broader historical docs still need reconciliation |

Initial suite: 3/3 passed. Expanded suite includes two existing previously omitted
checks plus two new real-process workflows. See `HARDENING_HANDOFF.md` for final
commands, result, rollout restrictions and remaining work. No live data migration,
publication, host restart or provider-account operation occurred.
