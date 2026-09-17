# Secure Runner

Start Harden Runner with authenticated StepSecurity policy-store access, then
install Aegis through Socket Firewall with a short-lived Socket token. Use this
action as the first step in a job. The nested remote actions retain their pre-job
initialization and post-job cleanup, including token revocation.

The Socket Firewall pin selects Aegis `20260917T173242Z-f442872beb5d`, including
pnpm block reasons, Socket lookup diagnostics, and effective non-blocking
`pendingScan` policy actions. The release's provenance must match its pinned
source commit and `refs/heads/main`; see [Socket Firewall](../socket-firewall)
for policy behavior and supported runners.

## Inputs

Accepts all inputs and defaults from [Harden Runner](../harden-runner/action.yml)
and forwards them unchanged: `dev`, `egress-policy`, `allowed-endpoints`,
`denied-endpoints`, `disable-telemetry`, `disable-sudo-and-containers`,
`disable-file-monitoring`, `deploy-on-self-hosted-vm`, and `token`.

`disable-enforcement: true` skips both Harden Runner and Socket Firewall with a
warning annotation. It is intended for Aegis's own installation tests, where a
preinstalled Aegis service would conflict with the version under test and a large
test matrix would otherwise request a separate StepSecurity credential per job.

`dev` also selects the Socket STS endpoint. Both services use production by
default; set `dev: true` to use their development endpoints.

The caller must grant `id-token: write` for the STS exchanges. Harden Runner
policies must allow the network access needed to install and use Socket Firewall.

Harden Runner does not support Windows ARM64. On that runner, this action emits a
warning annotation, skips Harden Runner, and continues to install Socket Firewall.

GitHub never issues an OIDC token to `pull_request` runs from forks, whatever
permissions the workflow declares. On a `pull_request` run without an OIDC token,
Harden Runner emits a warning annotation and runs with the inline policy from the
`egress-policy`, `allowed-endpoints`, and `denied-endpoints` inputs instead of the
StepSecurity policy store. Socket Firewall emits a warning and skips package
firewall installation, so package downloads are not inspected or blocked. Any
other event without an OIDC token fails, since that means the job is missing
`id-token: write`.

## Usage

Pin this action to a full commit SHA in production:

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - name: Secure runner
    uses: tempoxyz/gh-actions/actions/secure-runner@<commit-sha>
    # For Aegis's own installation tests only:
    # with:
    #   disable-enforcement: true

  - uses: actions/checkout@<commit-sha>

  # Supported package-manager commands now run through Socket Firewall.
  - run: pnpm install --frozen-lockfile
```
