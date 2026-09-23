# Secure Runner

Start Harden Runner with authenticated StepSecurity policy-store access, then
install Aegis through Socket Firewall with a short-lived Socket token. Use this
action as the first step in a job. The nested remote actions retain their pre-job
initialization and post-job cleanup, including token revocation.

No Node installation is required before or inside this action: Socket Firewall
reuses the runner's bundled Node executable for its setup scripts, even when
`node` is absent from `PATH`. Harden Runner starts first; Socket Firewall then
checks GitHub CLI attestation support and bootstraps a verified CLI on Linux if
needed, before verifying and installing Aegis.

The Socket Firewall pin selects the latest stable Aegis release on each run,
excluding drafts and prereleases, and supports the Intel macOS CLI artifacts
restored in Aegis v0.4.0. The release's checksum and provenance are
verified against its release-tag source commit and `refs/heads/main`; see
[Socket Firewall](../socket-firewall) for policy behavior and supported runners.

## Inputs

Accepts all inputs and defaults from [Harden Runner](../harden-runner/action.yml)
and forwards them unchanged: `step-security-sts-host`, `egress-policy`, `allowed-endpoints`,
`denied-endpoints`, `disable-telemetry`, `disable-sudo-and-containers`,
`disable-file-monitoring`, `deploy-on-self-hosted-vm`, and `token`.

`disable-enforcement: true` skips both Harden Runner and Socket Firewall with a
warning annotation. It is intended for Aegis's own installation tests, where a
preinstalled Aegis service would conflict with the version under test and a large
test matrix would otherwise request a separate StepSecurity credential per job.

Both services use production by default. For a development deployment, set
`step-security-sts-host: ss-sts.tempoxyz.dev` and/or
`socket-sts-host: socket-sts.tempoxyz.dev`.

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
