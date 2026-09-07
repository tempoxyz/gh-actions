# Harden Runner token bootstrap

Internal JavaScript action used by [`harden-runner`](../harden-runner). Its
`pre` entrypoint exchanges the job's GitHub OIDC identity for a short-lived
StepSecurity API token, masks it, and exports it for Harden Runner's subsequent
`pre` entrypoint.

Do not invoke this action directly. Use the public `harden-runner` wrapper,
which consumes and clears the temporary environment variable.
