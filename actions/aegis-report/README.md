# Aegis Report

Register a post-job handler that uploads Aegis's final service audit log as a
seven-day GitHub Actions artifact. Invoke this action after Aegis has been
installed. Upload failures are warnings, so they do not hide the original job
result.

This is the lifecycle companion for `socket-firewall`; it does not mint or
revoke Socket API tokens.

On dedicated Linux CI runners, pass `linux-installation-config` with the new
job's generated Aegis configuration and invoke this action **before** installing
the package. It uninstalls an existing managed installation with the incumbent
binary, then registers log upload followed by uninstall at job shutdown, before
the earlier Socket STS handler revokes credentials. Restoration errors abort
setup. Cleanup errors fail the job on self-hosted runners, where a leftover
installation would affect the next job; on GitHub-hosted runners, which are
discarded after the job, they are reported as warnings. Other callers retain
report-only behavior.
Post cleanup checks the token-provider identity before touching installed state.
Incomplete recovery state is left intact for investigation. Concurrent jobs must
not share the same host-wide Aegis installation; abrupt runner termination still
requires recovery at the next job's startup.
