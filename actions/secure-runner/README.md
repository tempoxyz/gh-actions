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

`dev` also selects the Socket STS endpoint. Both services use production by
default; set `dev: true` to use their development endpoints.

The caller must grant `id-token: write` for both STS exchanges. Harden Runner
policies must allow the network access needed to install and use Socket Firewall.

`shims` defaults to `true`, preserving automatic package-manager protection.
Set it to `false` when dependency acquisition is a separate phase and invoke
`firewall-path-binary` explicitly. Both `firewall-path-binary` and
`firewall-path-report` are forwarded from Socket Firewall.

## Usage

Pin this action to a full commit SHA in production:

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - name: Secure runner
    uses: tempoxyz/gh-actions/actions/secure-runner@<commit-sha>

  - uses: actions/checkout@<commit-sha>

  # Supported package-manager commands now run through Socket Firewall.
  - run: pnpm install --frozen-lockfile
```

An explicit download-only phase can use:

```yaml
  - name: Secure runner
    id: security
    uses: tempoxyz/gh-actions/actions/secure-runner@<commit-sha>
    with:
      shims: false

  - uses: actions/checkout@<commit-sha>

  - name: Fetch approved dependencies
    env:
      SFW: ${{ steps.security.outputs.firewall-path-binary }}
    run: '"$SFW" cargo fetch --locked'
```

Only commands explicitly run through that binary receive Socket protection in
this mode. The caller must enforce the boundary afterwards (for example with
verified source artifacts, Cargo `--frozen`, and runner egress restrictions).
Disabling shims does not change Harden Runner's policy or cleanup.
