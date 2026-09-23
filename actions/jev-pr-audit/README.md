# Jev PR audit pilot

Enabled only for `tempoxyz/cyclops-canary`. Uses Jev 1.13 through OpenRouter's
Decisions API, a trusted path floor, and fixed worker profiles. Quick uses Sol
medium; standard uses Sol/Opus high; deep and critical add Astra. No fourth worker.
Performance-critical changes enable the existing four-pass `perf` mode.

Set `classification-only: 'true'` to test real Jev decisions without dispatching
audits. Non-skip statuses remain pending and comments explicitly identify the
test. Enabling dispatch changes decision identity so test results cannot be
reused as completed audits.

The independent required status is **Cyclops / Jev audit**. A skip decision passes;
audit decisions stay pending until the configured Cyclops bot posts a validated
completion receipt covering the exact head/base, decision, worker models/thinking,
all passes, performance pass when selected, and published GitHub review. A normal
Cyclops review, stale receipt or partial worker success cannot pass this gate.
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
