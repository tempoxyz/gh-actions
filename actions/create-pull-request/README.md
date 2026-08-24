# Create Pull Request

Commit working-tree changes to a branch and open a pull request using only
`git`, `gh`, and the GitHub API — a bare-minimum replacement for
`peter-evans/create-pull-request` so no third-party action handles a
write-scoped (possibly branch-protection-bypassing) token.

## How it works

The caller checks out the repository at the commit the branch should start
from (normally the tip of `base`) and edits the working tree in place. The
action then:

1. Creates the head `branch` at the checked-out commit — force-resetting a
   stale branch left by an earlier failed run (callers are expected to delete
   the branch on merge).
2. Stages `add-paths` and commits the staged changes via the GraphQL
   `createCommitOnBranch` mutation. Nothing is pushed from the runner: GitHub
   creates the commit server-side, authored by the token's actor and signed
   by GitHub, so commits never show as "Unverified" and no signing key is
   handled.
3. Opens a pull request for the branch — or reuses the branch's existing open
   PR (refreshing its title and body) if one survived an earlier failed run.

## Limitations (by design)

- Additions, modifications, and deletions are supported; renames become
  delete + add. Anything else (e.g. a type change) fails the action.
- File modes are not preserved: created files are regular, non-executable
  files.
- The action **fails when there is nothing to commit** — it is built for
  callers that just generated changes, so an empty diff means something
  upstream went wrong.
- `labels` must already exist in the repository.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `token` | Token for all API calls; needs `contents: write` and `pull-requests: write`. Commits are authored by this token's actor, so pass a GitHub App installation token (e.g. from [`github-sts`](../github-sts)) to avoid `github-actions[bot]` | Yes | |
| `branch` | Head branch to create (force-reset if it exists) | Yes | |
| `base` | Base branch the pull request targets | No | `main` |
| `commit-message` | Commit message headline | Yes | |
| `title` | Pull request title | Yes | |
| `body` | Pull request body (Markdown) | No | `""` |
| `add-paths` | Newline-separated git pathspecs to stage | No | `.` |
| `labels` | Newline- or comma-separated labels to add | No | `""` |

## Outputs

| Name | Description |
|------|-------------|
| `pull-request-number` | Number of the created (or reused) pull request |
| `head-sha` | OID of the commit created on the head branch |

## Usage

```yaml
permissions:
  contents: write
  id-token: write
  pull-requests: write

steps:
  - name: Fetch GitHub token via STS
    id: app-token
    uses: tempoxyz/gh-actions/actions/github-sts@main
    with:
      policy: bump-formula

  - uses: actions/checkout@v5
    with:
      ref: main
      persist-credentials: false

  - name: Edit files
    run: ./scripts/bump-version.sh

  - name: Open pull request
    id: pr
    uses: tempoxyz/gh-actions/actions/create-pull-request@main
    with:
      token: ${{ steps.app-token.outputs.token }}
      branch: bot/bump-version
      base: main
      commit-message: "chore: bump version"
      title: "chore: bump version"
      body: |
        Automated version bump.
      add-paths: |
        Casks
      labels: automated

  - name: Merge pull request
    env:
      GH_TOKEN: ${{ steps.app-token.outputs.token }}
      PR_NUMBER: ${{ steps.pr.outputs.pull-request-number }}
    run: gh pr merge --squash --admin --delete-branch "$PR_NUMBER"
```
