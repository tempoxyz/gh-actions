# Aegis Report

Register a post-job handler that uploads Aegis's final service audit log as a
seven-day GitHub Actions artifact. Invoke this action after Aegis has been
installed. Upload failures are warnings, so they do not hide the original job
result.

This is the lifecycle companion for `socket-firewall`; it does not mint or
revoke Socket API tokens.
