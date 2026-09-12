#!/bin/bash
# Linked into bin/<package-manager>; resolve the real command at invocation time.
_tempo_sfw_launch() {
  local _tempo_sfw_root="${BASH_SOURCE[0]%/*}"
  # Keep the startup hook's spelling (including Windows short paths/junctions).
  # Resolving /bin/.. physically can otherwise make our own shim look distinct.
  _tempo_sfw_root="${_tempo_sfw_root%/bin}"
  local _tempo_sfw_binary _tempo_sfw_upstream _tempo_sfw_previous _tempo_sfw_node _tempo_sfw_bash
  local -a _tempo_sfw_commands
  local command="${0##*/}" real
  # shellcheck source=/dev/null
  source "$_tempo_sfw_root/config.sh" || return 1
  # shellcheck source=actions/secure-runner/bash-common.sh
  source "$_tempo_sfw_root/bash-common.sh" || return 1
  PATH="$(_tempo_sfw_clean_path)" || return 1
  export PATH
  real="$(_tempo_sfw_real_command "$command")" || {
    printf '::error::Socket cannot find the real %s executable\n' "$command" >&2
    return 127
  }
  export _TEMPO_SFW_ACTIVE=1
  # Cargo's libgit2 does not use Socket's Git certificate environment. Preserve
  # an explicit caller override and leave TLS/registry policy settings unchanged.
  if [[ "$command" == cargo ]]; then
    export CARGO_NET_GIT_FETCH_WITH_CLI="${CARGO_NET_GIT_FETCH_WITH_CLI-true}"
  fi
  exec "$_tempo_sfw_node" "$_tempo_sfw_root/socket-guard.cjs" "$_tempo_sfw_bash" "$_tempo_sfw_binary" "$real" "$@"
}

_tempo_sfw_launch "$@"
exit $?
