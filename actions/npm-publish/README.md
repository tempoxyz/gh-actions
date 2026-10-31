# npm publish (trusted publishing)

Publish npm packages from CI with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers):
npm exchanges the job's GitHub OIDC token for a one-time publish token, so no `NPM_TOKEN` exists to
leak.

1. **Pack:** finds the workspace's non-private packages (never the workspace root) (or the `packages` you list), orders them
   so each comes after the packages it depends on at run time, skips versions already on npm, and
   packs each with the repository's package manager (pnpm and bun rewrite `workspace:`
   dependencies). Each tarball is checked: its manifest must hold exactly the planned name and
   version, with no `workspace:`, `link:`, `file:` or `catalog:` dependency left. The plan,
   with each version's CHANGELOG section, goes to `plan.json` beside the tarballs.
2. **Publish:** checks the tarballs against the plan again, then runs
   `npm publish <tarball> --ignore-scripts` for each one in order. No repository code runs here.

Before uploading it fails unless npm is 11.5.1 or newer (Node.js 24 bundles it), the runner is
GitHub-hosted (npm trusts no other), the job has `id-token: write`, and no `.npmrc` holds a stored
token. It also blanks `NODE_AUTH_TOKEN`, because the placeholder `actions/setup-node` writes with
`registry-url` makes npm skip the OIDC exchange. A version that is already published or staged
counts as done, so a rerun after a partial release resumes it. Provenance is added on public
repositories, the only ones npm accepts it from.

## Inputs

| Name | Description | Default |
|------|-------------|---------|
| `packages` | Package directories to publish, relative to `working-directory`. Empty publishes every non-private workspace package | `""` |
| `working-directory` | Root of the package or workspace | `.` |
| `package-manager` | `auto`, `npm`, `pnpm` or `bun` | `auto` |
| `mode` | `pack-and-publish`, `pack` or `publish` (see below) | `pack-and-publish` |
| `pack-directory` | Where tarballs and `plan.json` go, or (for `publish`) come from | `$RUNNER_TEMP/npm-publish` |
| `dist-tag` | Dist-tag to publish under | `latest`; for prereleases the tag in `.changeset/pre.json` |
| `access` | `public` or `restricted`. Empty keeps each package's `publishConfig.access` | `""` |
| `provenance` | `auto`, `true` or `false` | `auto` |
| `skip-published` | Skip versions already on npm | `true` |
| `dry-run` | Pack and run `npm publish --dry-run` without authenticating | `false` |

## Outputs

`packages`, `published` (uploaded by this run) and `released` (every planned version confirmed on npm,
including ones an interrupted earlier run uploaded), as JSON arrays of `{name, version}`; `skipped`
and `pack-directory`. A prerelease version with no dist-tag is refused rather than published as
`latest`.

## Usage

In one job, after installing dependencies and building:

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest # npm trusted publishing needs a GitHub-hosted runner
    environment: npm
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: tempoxyz/gh-actions/actions/secure-runner@<sha> # <tag>
      - uses: actions/checkout@<sha> # <tag>
        with:
          persist-credentials: false
      - uses: actions/setup-node@<sha> # <tag>
        with:
          node-version: 24
      - run: npm ci --ignore-scripts && npm run build
      - uses: tempoxyz/gh-actions/actions/npm-publish@<sha> # <tag>
```

To keep the OIDC token away from the repository's code, pack in one job and publish in another:
`mode: pack` in a job without the `npm` environment, upload `pack-directory` as an artifact, then
download it in a job with the environment and run `mode: publish` with `pack-directory` set to it.
The [changesets release workflow](../../.github/workflows/changesets-release.yml) does exactly
this.

## Setting up npm

For each package, on npmjs.com open **Settings → Trusted publishing** and add GitHub Actions with
the organization or user, repository, the workflow file name of the workflow that runs the job
(for a reusable workflow, the caller's file), and the job's `environment`. Then, under
**Publishing access**, choose **Require two-factor authentication and disallow tokens**, so tokens
can no longer publish the package. A new package needs one manual publish before it can have a
trusted publisher.
