# Exemption link capacity

Run `node actions/aegis-report/measure-link-sizes.cjs` from the repository root.
The experiment compares repeated percent-encoded `purl` parameters with JSON
encoded as base64url, gzip plus base64url, and deflate plus base64url. All sizes
below are URL characters including the prefix and policy scope. The 10- and
50-package datasets are synthetic; they do not assert real package releases.

| Dataset | Original | Base64url | Gzip + base64url | Deflate + base64url |
| --- | ---: | ---: | ---: | ---: |
| Two Codex versions from the reported failure | 186 | 193 | 183 | 167 |
| 10 synthetic npm coordinates | 559 | 568 | 377 | 361 |
| 50 synthetic npm coordinates | 2,519 | 2,552 | 719 | 703 |
| 50 distinct 512-character names and 255-character versions | 39,486 | 52,028 | 28,007 | 27,991 |

Deflate has less framing overhead than gzip; base64 alone increases size. The
formatter chooses the shorter of the original and deflate encodings, retaining
plain URLs for very small inputs. Compression is encoding, not encryption or
authorization. The policies page still requires confirmation, and policy writes
still require engineering identity and VK approval.

## Practical limits

- The [Actions runner](https://github.com/actions/runner/blob/main/src/Runner.Worker/ExecutionContext.cs)
  truncates each annotation message at 4,096 UTF-16 code units. The formatter
  budgets the escaped message to 4,000, emits whole URLs first, previews at most
  five packages if space remains, and points to the summary for overflow. Only
  one error annotation is emitted, avoiding the runner's ten-per-type limit.
- Each generated URL is at most 3,500 ASCII characters. This leaves annotation
  space for instructions and is below Cloudflare Workers'
  [16 KB URL limit](https://developers.cloudflare.com/workers/platform/limits/).
  Limits on the internal `go` redirect and browser behavior were not live-tested.
- Aegis accepts at most **50 package entries per approval** and a **64 KiB JSON
  request body**. Compressed links decode to at most **32 KiB**, with at most 50
  strings. They retain all package coordinates; oversized inputs split into
  smaller links. A single coordinate that cannot fit gets a manual-policy
  fallback instead of a truncated URL.
- The 50-package synthetic npm batch uses a 703-character URL and a
  1,138-character escaped annotation. All **50 fit in one link and approval**.
  The deliberately long, distinct dataset fits **six packages** in the first
  URL and a 3,622-character escaped annotation. Larger jobs use additional
  summary links and approvals; package count alone cannot predict capacity.
- VK reasons stay below **500 characters**, independently of URL size. The
  server preserves a readable preview and includes a SHA-256 digest of all
  normalized creation details when they do not fit. Full details remain in
  the confirmation dialog. Compression does not raise the 50-entry approval cap.

The server decoder must be deployed before this action is released. These are
local formatter, browser-script, and policy-handler measurements, not a live
GitHub rendering or VK approval test.
