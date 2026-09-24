# Jev PR audit pilot

Enabled only for `tempoxyz/cyclops-canary`. Uses Jev 1.13 through OpenRouter's
Decisions API, a trusted path floor, and fixed worker profiles. Quick uses Sol
medium; standard uses Sol/Opus high; deep and critical add Astra. No fourth worker.
Production performance-critical changes enable deep/critical four-pass `perf` mode.
Low-risk benchmark-only changes can use quick + perf: one Sol medium worker, four passes
ending with the performance pass, 1800 seconds total with 600 reserved for consolidation.

Set `classification-only: 'true'` to test real Jev decisions without dispatching
audits. Non-skip statuses remain pending and comments explicitly identify the
test. Enabling dispatch changes decision identity so test results cannot be
reused as completed audits.

Policy v2 separates missing evidence from performance risk. Uncertainty can
require a deeper audit but cannot itself set `perf`. Strictly validated,
non-normative prose does not need a confident runtime-component scope; essential
missing context still prevents skip. Domain questions have separate criteria.

For up to five ambiguous units with complete initial evidence, the controller
looks up at most four nearby source/module/config files at the classified base
and head revisions. It makes one further Jev call only when new context was
found. This is bounded local retrieval, not exhaustive caller discovery. The
second pass can resolve uncertainty but retains previously detected domain risk.
Failed or unhelpful retrieval leaves the conservative classification in place.
Artifacts retain the first responses, retrieval attempts, raw second responses,
and effective decisions for comparison. Classification-only mode remains the
canary default while calibration is in progress.

V2.1 keeps unresolved semantic context on the standard two-worker audit only
when the initial evidence is complete, the path floor is standard, implementation
and local scope both have probability at least 0.95, and every risk domain is at
most 0.05. It never permits skip or overrides a sensitive path, detected risk,
unknown scope, or missing input evidence. The uncertainty remains visible in the
decision reasons. `evaluation-prs` runs a read-only historical evaluation on up
to 50 merged public Tempo PRs with at most three files each; it writes only a
local artifact and prohibits GitHub mutations.

The independent required status is **Cyclops / Jev audit**. A skip decision passes;
audit decisions stay pending until the configured Cyclops bot posts a validated
Argo exit receipt covering the exact head/base, decision, selected plan, and audit
attempt. Succeeded, Failed, and Error outcomes pass this terminal-outcome gate,
even when workers fail or reject a prompt. Running audits, stale receipts, and
worker-level completion comments cannot pass it. Review publication is not required.
Other repository review/check requirements remain in force.

Run from trusted `pull_request_target` code with no PR checkout. Also invoke on
trusted bot `issue_comment` receipts and periodically to reconcile missed events
and timeouts. `workflow_dispatch` accepts `pr_number` and `retry` for explicit
recovery. The pilot fails closed on merge-group events; use ordinary PR merging.

Required secrets: `OPENROUTER_API_KEY` and the existing Cyclops `EVENTS_KEY`,
`EVENTS_CERT`, `EVENTS_ARGS`. Missing Jev credentials or a failed classifier
conservatively selects an audit, never skip. Dispatch needs `CYCLOPS_JEV_IMAGE`
(repository variable), an immutable worker image containing the completion hooks
and matching profiles from the companion Cyclops change. The Argo sensor must
route `source=jev` events for this pilot to that image; existing deployments do
not yet honor this field automatically.

Policy is shipped with this action, never loaded from PR head. The caller must
pin an immutable action commit. Classifier inputs contain source/diffs but are
never executed. Classifier responses and decision metadata are saved in
`$RUNNER_TEMP/jev-decision.json`; upload that file as a private Actions artifact.
The decision comment carries a compact record for idempotency and callbacks.
Replays do not redispatch; explicit retries create a new run identity. Ambiguous
delivery stays blocked until explicitly retried.

The initial pilot conservatively escalates missing/large context, changed
upstream dependencies and unknown paths. It does not yet fetch the full upstream
dependency delta for Jev; Cyclops must audit it. No production rollout, benchmark
calibration or skip-accuracy claim is implied by unit-test success.

Validate: `python3 -m unittest discover -s actions/jev-pr-audit -p 'test_*.py'`.

The merge gate now requires a trusted Argo exit receipt for the exact audit attempt,
not successful worker passes or review publication. Succeeded, Failed, and Error
outcomes open the gate. Running audits, failed dispatches, stale receipts, and absent
terminal evidence remain blocked. Worker-level receipts are retained as diagnostics.
