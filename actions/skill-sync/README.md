# Skill Sync

Copy agent skills from the repositories that own them into generated
directories, and fail CI when a generated copy is edited by hand.

A distribution repository lists each skill once in a registry. On a schedule,
`sync` resolves each source, rewrites only copies whose content changed, and
records each copy's source commit and digest in a lock file. `check` runs
offline in CI and fails if a copy no longer matches its lock entry, so fixes go
to the source instead of the copy. Nothing is required in a public source
repository.

## Registry

```json
{
  "skills": [
    { "name": "docs", "plugin": "docs", "repo": "tempoxyz/docs", "path": "SKILL.md" },
    { "name": "wallet", "plugin": "wallet", "repo": "tempoxyz/wallet-cli", "path": "SKILL.md", "ref": "release" },
    { "name": "mercator", "plugin": "mercator", "repo": "tempoxyz/mercator", "path": "skills/mercator" }
  ]
}
```

| Key | Description | Default |
|-----|-------------|---------|
| `name` | Skill name; the copy's frontmatter `name` is rewritten to it | |
| `plugin` | Plugin that ships the skill, available to `dest` as `{plugin}` | `name` |
| `repo` | Source repository (`owner/name`) | |
| `path` | A file, copied as `SKILL.md`, or a directory, copied whole. Symlinks and submodules are rejected | |
| `ref` | Branch or tag, or `release` for the latest GitHub release | `main` |

The frontmatter `name` is the only transform: the rest of a copy is
byte-identical to its source. A source commit that does not change a skill's
content does not change its lock entry, so busy source branches do not
produce pull requests.

## Private sources

A source the job's token cannot read is retried with a read token minted by
the GitHub STS. Add a trust policy to the private source repository that
allows the syncing workflow, and grant the job `id-token: write`:

```yaml
# .github/sts/skill-sync-read.sts.yaml in the private source repository
subject: repo:tempoxyz@<org-id>/plugins@<repo-id>:ref:refs/heads/main
claim_pattern:
  job_workflow_ref: tempoxyz/plugins/\.github/workflows/sync-skills\.yml@refs/heads/main
permissions:
  contents: read
```

Minted tokens are revoked when the step finishes.

## Catalog mode

`catalog: owner/repo` mirrors another repository's lock file instead of a
registry, so a website can serve exactly the copies a distribution repository
has validated. Lock entries keep the original source as `upstream`, and
`check` points hand edits there. With `index`, the action also writes an
[Agent Skills discovery](https://schemas.agentskills.io/discovery/0.2.0/schema.json)
index with each skill at `<base-url>/<name>/SKILL.md`.

## Inputs

| Name | Description | Default |
|------|-------------|---------|
| `mode` | `sync` or `check` | `sync` |
| `config` | Registry file | `skills.json` |
| `lock` | Lock file | `skills.lock.json` |
| `dest` | Destination template with `{name}` and `{plugin}` | `plugins/{plugin}/skills/{name}` |
| `catalog` | Mirror this repository's lock file instead of `config` | `""` |
| `index` | Path for a discovery `index.json` | `""` |
| `base-url` | URL prefix for skills in the index | `""` |
| `only` | Comma- or space-separated skill or plugin names to sync | `""` (all) |
| `token` | Token for public sources | `github.token` |
| `sts-policy` | Trust policy name in private sources | `skill-sync-read` |
| `sts-host` | GitHub STS hostname | `gh-sts.tempoxyz.net` |
| `working-directory` | Root for the paths above | `.` |

## Outputs

| Name | Description |
|------|-------------|
| `changed` | `true` when a copy, the lock, or the index changed |
| `summary` | Markdown table of changed skills with source and compare links |

## Usage

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@v5
    with:
      persist-credentials: false

  - id: sync
    uses: tempoxyz/gh-actions/actions/skill-sync@<sha>

  - if: steps.sync.outputs.changed == 'true'
    id: token
    uses: tempoxyz/gh-actions/actions/github-sts@<sha>
    with:
      policy: skill-sync

  - if: steps.sync.outputs.changed == 'true'
    uses: tempoxyz/gh-actions/actions/create-pull-request@<sha>
    with:
      token: ${{ steps.token.outputs.token }}
      branch: automation/sync-skills
      commit-message: "chore: sync skills"
      title: "chore: sync skills"
      body: ${{ steps.sync.outputs.summary }}
      auto-merge: squash
```

In CI:

```yaml
  - uses: tempoxyz/gh-actions/actions/skill-sync@<sha>
    with:
      mode: check
```

Locally, `sync` reads `GH_TOKEN`:

```sh
GH_TOKEN="$(gh auth token)" INPUT_MODE=sync node path/to/gh-actions/actions/skill-sync/main.js
```
