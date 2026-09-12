# Shared by the startup hook and the command launcher. Compatible with Bash 3.2.
# The caller supplies _tempo_sfw_root and _tempo_sfw_upstream in its local scope.
# shellcheck disable=SC2154

_tempo_sfw_clean_path() {
  local remaining="${PATH-}" entry candidate result="" separator=""
  while :; do
    entry="${remaining%%:*}"
    candidate="${entry:-.}"
    # File identity also covers symlinks, junctions, and Windows short paths.
    if [[ "${entry%/}" != "${_tempo_sfw_root}/bin" && "${entry%/}" != "${_tempo_sfw_upstream%/}" &&
          ! "$candidate" -ef "${_tempo_sfw_root}/bin" && ! "$candidate" -ef "$_tempo_sfw_upstream" ]]; then
      result="${result}${separator}${entry}"
      separator=:
    fi
    [[ "$remaining" == *:* ]] || break
    remaining="${remaining#*:}"
  done
  printf '%s' "$result"
}

_tempo_sfw_real_command() {
  local resolved
  resolved="$(type -P "$1")" || return 1
  [[ "$resolved" == /* ]] || resolved="$PWD/$resolved"
  printf '%s' "$resolved"
}
