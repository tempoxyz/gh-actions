# Aegis Report

Register a post-job handler that uploads Aegis's final service audit log as a
seven-day GitHub Actions artifact. Invoke this action after Aegis has been
installed. Upload failures are warnings, so they do not hide the original job
result. At job end, warning verdicts in that log are also summarized in one
GitHub Actions warning annotation and the step summary. Known availability
fail-open reasons (such as no internet connection) are named; other policy
warning reasons are counted without quoting potentially sensitive upstream text.
Blocked downloads are also counted in the step summary. Package versions blocked
as `recentlyPublished` are listed by name and version, with a link to the Aegis
policies page. That page opens one dialog that adds version-specific Warn
exemptions for all of them after a single Voight-Kampff approval, with one link
per 50 packages, with smaller batches when needed to keep URLs under 3,500
characters and decoded payloads under 32 KiB. Links use deflate-compressed JSON
and base64url when shorter than repeated `purl` parameters. Deploy Aegis server
support for the `purls` parameter before releasing this action.

The post-job error annotation puts complete exemption URLs before a preview of
at most five package versions and instructions to rerun failed jobs after
approval. Its escaped message stays at or below 4,000 characters, below the
runner's 4,096-character truncation limit. Links that do not fit remain in the
step summary, which lists up to 50 package versions; the audit-log artifact
retains the full list. This annotation also appears when used through Secure
Runner; it does not change the job's exit status. See [link size measurements](link-limits.md).
When either blocked
downloads or warning verdicts occur, the summary links to the current workflow
run attempt in Aegis, showing all events across its jobs.

This is the lifecycle companion for `aegis`; it does not mint or
revoke Socket API tokens.

On dedicated Linux CI runners, pass `linux-installation-config` with the new
job's generated Aegis configuration and invoke this action **before** installing
the package. It uninstalls an existing managed installation with the incumbent
binary, then registers a log snapshot at job shutdown, followed by concurrent
upload and uninstall, before the earlier Socket STS handler revokes credentials. Restoration errors abort
setup. Cleanup errors fail the job on self-hosted runners, where a leftover
installation would affect the next job. Teardown is skipped only when
`RUNNER_ENVIRONMENT` is exactly `github-hosted`, since GitHub discards those
runners after the job. Hosted Linux runners instead request bounded job-end
quiescing: local scans stop, pending scans cancel, and the existing Worker socket
acknowledges cancellation within a 250 ms client budget. The command has a 500 ms
process timeout including sudo/startup; socket closure runs in the inspector.
Older clients/Workers or a missing acknowledgement warn and continue credential
cleanup immediately. Unset or unknown runner environments retain full uninstall.
Other callers retain
report-only behavior.
Post cleanup checks the token-provider identity before touching installed state.
Incomplete recovery state is left intact for investigation. Concurrent jobs must
not share the same host-wide Aegis installation; abrupt runner termination still
requires recovery at the next job's startup.
