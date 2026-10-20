# Released-client Socket renewal check

These fixtures exercise the real Aegis 0.41.0 Go client against a local
WebSocket Worker fixture and the Node token provider. The issuer and clock are
deterministic; no production token is minted or expired. The fixture renews the
provider, expires the credential cached by the client, then verifies that one
scan and 12 concurrent scans refresh once, reconnect, and retain malware blocks.

From this gh-actions checkout, create an isolated Aegis checkout and run:

```sh
actions_checkout="$PWD"
verification_root="$(mktemp -d)"
gh repo clone tempoxyz/aegis "$verification_root/aegis" -- --branch v0.41.0 --depth 1
cp actions/aegis/testdata/socket_lease_integration_test.go "$verification_root/aegis/client/internal/firewall/"
cd "$verification_root/aegis/client"
SOCKET_RENEWAL_PROVIDER_FIXTURE="$actions_checkout/actions/aegis/testdata/socket-lease-provider.cjs" \
  go test -race ./internal/firewall -run '^TestNodeProviderSocketLeaseIntegration$' -count=5 -v
```

For a negative control, set `SOCKET_PROVIDER_MODULE` to the absolute path of
`actions/aegis/token-server.cjs` in an unmodified gh-actions main checkout and
repeat with `-run '^TestNodeProviderSocketLeaseIntegration$/^1$' -count=1`.
The old provider keeps returning the expired token; the scan warns instead of
blocking. The candidate passes with the same released Go client. Raw recovered
401s remain observable at the cached credential's expiry.
