# label-pr

Copies eligible labels from the issue linked in a pull request body to the pull request.

The pull request body must reference an issue with a closing keyword, for example `Fixes #123` or `Resolves https://github.com/tempoxyz/repo/issues/123`.

```yaml
steps:
  - uses: tempoxyz/gh-actions/actions/label-pr@main
```

Required permissions:

```yaml
permissions:
  issues: write
  pull-requests: write
```
