#!/usr/bin/env bash

set -euo pipefail

validate_strict_config() {
  local config_path="${1:?config path is required}"

  awk '
    function reject(message) {
      failed = 1
      printf "::error file=cooldown.toml,line=%d::%s\n", NR, message > "/dev/stderr"
      exit 1
    }

    function finish_rule(    key) {
      if (!in_rule) {
        return
      }
      if (!seen_crate || !seen_version) {
        reject("each [[allow.exact]] rule must contain exactly one crate and one version")
      }
      key = crate SUBSEP version
      if (seen_rules[key]) {
        reject("duplicate [[allow.exact]] rule for " crate "@" version)
      }
      seen_rules[key] = 1
    }

    {
      sub(/\r$/, "")

      if ($0 ~ /^[[:space:]]*($|#)/) {
        next
      }

      if ($0 ~ /^[[:space:]]*\[\[allow\.exact\]\][[:space:]]*$/) {
        finish_rule()
        in_rule = 1
        seen_crate = 0
        seen_version = 0
        crate = ""
        version = ""
        next
      }

      if (!in_rule) {
        reject("strict project config permits only [[allow.exact]] rules")
      }

      if ($0 ~ /^[[:space:]]*crate[[:space:]]*=[[:space:]]*"[A-Za-z0-9_-]+"[[:space:]]*$/) {
        if (seen_crate) {
          reject("duplicate crate field in [[allow.exact]] rule")
        }
        crate = $0
        sub(/^[^=]*=[[:space:]]*"/, "", crate)
        sub(/"[[:space:]]*$/, "", crate)
        seen_crate = 1
        next
      }

      if ($0 ~ /^[[:space:]]*version[[:space:]]*=[[:space:]]*"[A-Za-z0-9.+_-]+"[[:space:]]*$/) {
        if (seen_version) {
          reject("duplicate version field in [[allow.exact]] rule")
        }
        version = $0
        sub(/^[^=]*=[[:space:]]*"/, "", version)
        sub(/"[[:space:]]*$/, "", version)
        seen_version = 1
        next
      }

      reject("strict project config permits only crate and version fields")
    }

    END {
      if (!failed) {
        finish_rule()
      }
    }
  ' "$config_path"
}

main() {
  local verifier verifier_exec actual_sha256 user_cargo_home variable

  verifier="${CARGO_COOLDOWN_BIN:?cargo-cooldown verifier path is required}"
  if [[ "$RUNNER_OS" == "Windows" ]]; then
    if ! command -v cygpath >/dev/null 2>&1; then
      echo "::error::cargo-cooldown requires cygpath on Windows"
      exit 1
    fi
    verifier_exec="$(cygpath -u "$verifier")"
  else
    verifier_exec="$verifier"
  fi
  if [[ ! -x "$verifier_exec" ]]; then
    echo "::error::cargo-cooldown verifier is not executable: $verifier"
    exit 1
  fi
  if command -v sha256sum >/dev/null; then
    actual_sha256="$(sha256sum "$verifier_exec" | awk '{print $1}')"
  else
    actual_sha256="$(shasum -a 256 "$verifier_exec" | awk '{print $1}')"
  fi
  if [[ "$actual_sha256" != "$CARGO_COOLDOWN_SHA256" ]]; then
    echo "::error::cargo-cooldown verifier checksum mismatch"
    exit 1
  fi
  if [[ ! "$COOLDOWN_DAYS" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::cooldown-days must be a positive whole number"
    exit 1
  fi
  if [[ "$ALLOW_USER_POLICY" != "false" && "$ALLOW_USER_POLICY" != "true" ]]; then
    echo "::error::allow-user-policy must be 'true' or 'false'"
    exit 1
  fi
  if [[ "$STRICT_PROJECT_CONFIG" != "false" && "$STRICT_PROJECT_CONFIG" != "true" ]]; then
    echo "::error::strict-project-config must be 'true' or 'false'"
    exit 1
  fi
  if [[ "$STRICT_PROJECT_CONFIG" == "true" && "$ALLOW_USER_POLICY" == "true" ]]; then
    echo "::error::strict-project-config cannot be combined with allow-user-policy"
    exit 1
  fi
  if [[ ! -f Cargo.lock ]] || ! git ls-files --error-unmatch Cargo.lock >/dev/null 2>&1; then
    echo "::error::Cargo.lock must exist and be committed"
    exit 1
  fi
  if ! git diff --quiet HEAD -- Cargo.lock; then
    echo "::error::Cargo.lock must match the committed version"
    exit 1
  fi

  if [[ "$STRICT_PROJECT_CONFIG" == "true" ]]; then
    if [[ -L cooldown.toml || ! -f cooldown.toml ]]; then
      echo "::error::strict project config requires a regular cooldown.toml file"
      exit 1
    fi
    if ! git ls-files --error-unmatch cooldown.toml >/dev/null 2>&1; then
      echo "::error::cooldown.toml must be tracked in strict project config mode"
      exit 1
    fi
    if ! git diff --quiet HEAD -- cooldown.toml; then
      echo "::error::cooldown.toml must match the committed version in strict project config mode"
      exit 1
    fi
    validate_strict_config cooldown.toml
  fi

  user_cargo_home="${CARGO_HOME:-${HOME:?HOME is required}/.cargo}"
  if [[ "$RUNNER_OS" == "Windows" ]]; then
    user_cargo_home="$(cygpath -u "$user_cargo_home")"
  fi
  if [[ "$ALLOW_USER_POLICY" != "true" && -f "$user_cargo_home/cooldown.toml" ]]; then
    echo "::error::user cargo-cooldown policy is not allowed: $user_cargo_home/cooldown.toml"
    exit 1
  fi

  unset COOLDOWN_CACHE_DIR COOLDOWN_FALLBACK_ACCEPT COOLDOWN_NOW \
    COOLDOWN_SKIP_REGISTRIES COOLDOWN_TTL_SECONDS CARGO_REGISTRY_MIN_PUBLISH_AGE
  while IFS= read -r variable; do
    case "$variable" in
      CARGO_REGISTRIES_*_MIN_PUBLISH_AGE) unset "$variable" ;;
    esac
  done < <(compgen -e)

  LOCKFILE_SNAPSHOT="$(mktemp)"
  cp -p Cargo.lock "$LOCKFILE_SNAPSHOT"
  restore_lockfile() {
    if ! cmp -s "$LOCKFILE_SNAPSHOT" Cargo.lock; then
      cp -p "$LOCKFILE_SNAPSHOT" Cargo.lock
    fi
    rm -f "$LOCKFILE_SNAPSHOT"
  }
  trap restore_lockfile EXIT

  export CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE="${COOLDOWN_DAYS} days"
  case "$COOLDOWN_MODE" in
    verify)
      "$verifier_exec" cooldown --workspace --all-features tree \
        --locked --depth 0 >/dev/null
      ;;
    check)
      "$verifier_exec" cooldown --workspace --all-features check --locked
      ;;
    *)
      echo "::error::mode must be 'verify' or 'check'"
      exit 1
      ;;
  esac
  git diff --exit-code HEAD -- Cargo.lock
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
