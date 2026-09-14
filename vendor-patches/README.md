# Vendor patches

These patches are applied by `vendor/sync.mjs` after exclusions and before nested
action references are rewritten. They are part of the reproducible vendor input;
`node vendor/sync.mjs --check` validates the resulting tree.

## Socket Firewall v1.15.1

`socket-firewall-1.15.1.patch` changes only the firewall release and its twelve
SHA256 pins in the bundled installer from `SocketDev/action@be1f253a41351d59095f8d7f1425985097dd1054`.
The hashes are the GitHub release asset `digest` values for the six supported
platforms in each edition:

- [Enterprise v1.15.1](https://github.com/SocketDev/firewall-release/releases/tag/v1.15.1)
- [Free v1.15.1](https://github.com/SocketDev/sfw-free/releases/tag/v1.15.1)

The release fixes interrupted upstream fetches terminating the package manager.
The installer still verifies each download before caching or execution, and its
cache key includes the new version. Remove this patch when re-vendoring an
upstream installer with the same or a newer supported release and checksum table.
