# Aegis Report

Register a post-job handler that uploads Aegis's final service audit log as a
seven-day GitHub Actions artifact. Invoke this action after Aegis has been
installed. Upload failures are warnings, so they do not hide the original job
result. At job end, warning verdicts in that log are also summarized in one
GitHub Actions warning annotation and the step summary. Known availability
fail-open reasons (such as no internet connection) are named; other policy
warning reasons are counted without quoting potentially sensitive upstream text.

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
runners after the job; unset or unknown values retain cleanup. Other callers retain
report-only behavior.
Post cleanup checks the token-provider identity before touching installed state.
Incomplete recovery state is left intact for investigation. Concurrent jobs must
not share the same host-wide Aegis installation; abrupt runner termination still
requires recovery at the next job's startup.
