#!/usr/bin/env bash
set -euo pipefail

# Aegis v0.14.0 restricts the Linux service to these address families, but its
# interface check needs AF_NETLINK. The upstream unit includes it after
# tempoxyz/aegis#133; leave newer units alone.
unit=$(systemctl show aegis.service --property=FragmentPath --value)
if [[ ! -f "$unit" ]] || ! grep -qxF 'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX' "$unit"; then
  exit 0
fi

sed -i 's/^RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX$/RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK/' "$unit"
systemctl daemon-reload
if systemctl is-active --quiet aegis.service; then
  systemctl restart aegis.service
fi
