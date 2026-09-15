# Secure Runner

Start Harden Runner with authenticated StepSecurity policy-store access, then
install Socket Firewall Enterprise with a short-lived Socket token. Use this
action as the first step in a job. The nested remote actions retain their pre-job
initialization and post-job cleanup, including token revocation.

## Inputs

Accepts all inputs and defaults from [Harden Runner](../harden-runner/action.yml)
and forwards them unchanged: `dev`, `egress-policy`, `allowed-endpoints`,
`denied-endpoints`, `disable-telemetry`, `disable-sudo-and-containers`,
`disable-file-monitoring`, `deploy-on-self-hosted-vm`, and `token`.

`disable-socket-firewall: true` skips Socket Firewall with a warning annotation.
It is intended for Aegis's own installation tests, where a preinstalled Aegis
service would conflict with the version under test.

`dev` also selects the Socket STS endpoint. Both services use production by
default; set `dev: true` to use their development endpoints.

The caller must grant `id-token: write` for both STS exchanges. Harden Runner
policies must allow the network access needed to install and use Socket Firewall.

Harden Runner does not support Windows ARM64. On that runner, this action emits a
warning annotation, skips Harden Runner, and continues to install Socket Firewall.

GitHub never issues an OIDC token to `pull_request` runs from forks, whatever
permissions the workflow declares. On a `pull_request` run without an OIDC token,
Harden Runner emits a warning annotation and runs with the inline policy from the
`egress-policy`, `allowed-endpoints`, and `denied-endpoints` inputs instead of the
StepSecurity policy store, and Socket Firewall installs its Free edition instead of
Enterprise, since the Enterprise token is minted from the job's OIDC identity. Any
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
    #   disable-socket-firewall: true

  - uses: actions/checkout@<commit-sha>

  # Supported package-manager commands now run through Socket Firewall.
  - run: pnpm install --frozen-lockfile
```
