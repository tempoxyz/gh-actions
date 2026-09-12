# Sourced via BASH_ENV before non-interactive Bash steps, including Git Bash.
# Do not change the caller's shell options, traps, working directory, or arguments.

# A pre-existing startup file may start another Bash while it is being sourced.
[[ "${_TEMPO_SFW_STARTING:-}" != 1 ]] || return 0

_tempo_sfw_start() {
  local _TEMPO_SFW_STARTING=1
  export _TEMPO_SFW_STARTING
  local _tempo_sfw_root="${BASH_SOURCE[0]%/*}"
  local _tempo_sfw_binary _tempo_sfw_upstream _tempo_sfw_previous _tempo_sfw_node _tempo_sfw_bash
  local -a _tempo_sfw_commands
  local command shim
  # Generated configuration and caller-owned startup file are runtime inputs.
  # shellcheck source=/dev/null
  source "$_tempo_sfw_root/config.sh" || return 1
  # shellcheck source=actions/secure-runner/bash-common.sh
  source "$_tempo_sfw_root/bash-common.sh" || return 1

  # Keep the user's startup file ahead of our PATH repair. It is sourced once
  # per shell; commands it executes are outside the refreshed-shim contract.
  if [[ -n "$_tempo_sfw_previous" ]]; then
    # shellcheck source=/dev/null
    source "$_tempo_sfw_previous" || return 1
  fi
  PATH="$(_tempo_sfw_clean_path)" || return 1
  export PATH
  # Socket owns the environment of its descendants. Re-adding shims there
  # would wrap nested cargo/npm invocations and start a second Socket proxy.
  [[ "${_TEMPO_SFW_ACTIVE:-}" != 1 ]] || return 0
  [[ -x "$_tempo_sfw_binary" ]] || return 1

  for command in "${_tempo_sfw_commands[@]}"; do
    shim="$_tempo_sfw_root/bin/$command"
    if _tempo_sfw_real_command "$command" >/dev/null; then
      # Hard links activate complete, prewritten launchers atomically. Concurrent
      # Bash startups never truncate a launcher that another process is executing.
      if [[ ! -e "$shim" ]]; then
        ln "$_tempo_sfw_root/bash-launcher.sh" "$shim" 2>/dev/null || [[ -f "$shim" ]] || return 1
      fi
    else
      # Do not make an absent/uninstalled manager look installed to setup tools.
      rm -f -- "$shim" || return 1
    fi
  done
  export PATH="$_tempo_sfw_root/bin:$PATH"
  hash -r
  for command in "${_tempo_sfw_commands[@]}"; do
    if [[ -e "$_tempo_sfw_root/bin/$command" ]]; then
      [[ "$(command -v "$command")" == "$_tempo_sfw_root/bin/$command" ]] || {
        printf '::error::Socket cannot intercept %s; a shell alias or function takes precedence\n' "$command" >&2
        return 1
      }
    fi
  done
  # Shell-local: a later step must actually execute this hook to set the marker.
  # shellcheck disable=SC2034
  TEMPO_SFW_BASH_READY=true
}

if ! _tempo_sfw_start; then
  printf '::error::Socket Bash interception could not be activated\n' >&2
  exit 1
fi
unset -f _tempo_sfw_start _tempo_sfw_clean_path _tempo_sfw_real_command
