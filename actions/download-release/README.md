# Shell release downloads

Shared transport for pinact, actionlint and mold. Composite actions source the helper
from their own `GITHUB_ACTION_PATH`, never from the checked-out consumer repository.
Reusable workflows embed the same function because they check out the consumer, not
this repository. After editing the helper, regenerate and check those copies:

```sh
node actions/download-release/sync.js
node actions/download-release/sync.js --check
node --test actions/download-release/download.test.js
bash -n actions/download-release/download-release.sh
shellcheck actions/download-release/download-release.sh
```

The primary release URL uses HTTPS-only redirects, a 10-second connect timeout,
a 1 KiB/s low-speed threshold over 60 seconds, and three retries with a 180-second
retry window. That window does not cut off an in-flight, progressing transfer.
Only recoverable transport errors, HTTP 408/429 and selected 5xx responses can use
the official GitHub release asset API. Authentication, proxy denials, missing
assets, certificate failures and integrity/provenance failures never trigger it.

Fallback metadata must identify exactly one positive numeric asset ID at the exact
non-draft tag and asset name, in one of the three allowed repositories. Metadata
has a 30-second timeout with five seconds to kill a stuck process. The asset is
streamed to a unique temporary file next to its destination. It has a 60-second
inactivity deadline, not a total-duration cap. Cancellation or failure terminates
and reaps the asset process and removes partial data. A progressing trickle can
continue until the enclosing job times out. A successful transport atomically
renames the file; it does **not** establish trust in its contents.

Every installer retains its existing checksum check, and pinact also requires its
GitHub attestation, source tag and signer workflow, before extracting or publishing
a binary. Fallback uses the job's existing token through `gh`, with an explicit
`github.com` host; no extra permissions, mirrors or unverified downloads are added.

The tests stub network and host-install boundaries, execute the extracted installer
blocks, and run real Bash, filesystem, tar and checksum operations. Fixture archives
substitute their digest into the digest-pinned installer copies only in tests;
separate contracts pin all production version/digest literals and provenance options.
No test extracts mold into the host or runs sudo. Watchdog tests shorten only the
inactivity interval and kill grace in a disposable helper copy.
