const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("the Linux compatibility step updates only the affected Aegis service unit", { skip: process.platform !== "linux" }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-netlink-"));
  const unit = path.join(directory, "aegis.service");
  const log = path.join(directory, "systemctl.log");
  const systemctl = path.join(directory, "systemctl");
  fs.writeFileSync(systemctl, `#!/bin/sh
printf '%s\n' "$1" >> "$AEGIS_TEST_LOG"
case "$1" in
  show) printf '%s\n' "$AEGIS_TEST_UNIT" ;;
  is-active) exit 0 ;;
esac
`, { mode: 0o755 });
  const run = () => spawnSync("bash", [path.join(__dirname, "allow-netlink.sh")], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, AEGIS_TEST_UNIT: unit, AEGIS_TEST_LOG: log },
    encoding: "utf8",
  });

  try {
    fs.writeFileSync(unit, "[Service]\nRestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX\n");
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(fs.readFileSync(unit, "utf8"), /RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK/);
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["show", "daemon-reload", "is-active", "restart"]);

    fs.writeFileSync(log, "");
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(log, "utf8"), "show\n", "the upstream-fixed unit needs no override or restart");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
