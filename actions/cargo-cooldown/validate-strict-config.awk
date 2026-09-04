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
