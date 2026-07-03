# pr-audit-comment

Handles PR audit commands posted as issue comments and publishes `pr_audit` events.

Supported default commands:

- `cyclops audit`
- `@decofe cyclops audit`
- `derek audit`

Supported arguments:

- `fast`
- `iterations=N`
- `hours=N`
- `config=PATH`
- `models=...`
- `run-label=LABEL`
- `dry-run`
- `note="..."`
