"""Install the shared updater's tools on an ephemeral Ubuntu runner."""

import os
from pathlib import Path
import re
import shlex
import subprocess


def configuration(env):
    toolchains = env.get("RUST_TOOLCHAINS", "").split()
    if not toolchains or any(not re.fullmatch(r"(?:\d+\.\d+\.\d+|nightly-\d{4}-\d{2}-\d{2})", item)
                             for item in toolchains):
        raise ValueError("rust-toolchains must contain explicit releases or dated nightlies")
    packages = env.get("NATIVE_PACKAGES", "").split()
    if any(not re.fullmatch(r"[a-z0-9][a-z0-9+.-]*", item) for item in packages):
        raise ValueError("native-packages must contain apt package names without options")
    nextest = env.get("NEXTEST_VERSION", "")
    amp = env.get("AMP_VERSION", "")
    if not re.fullmatch(r"\d+\.\d+\.\d+", nextest):
        raise ValueError("nextest-version must be an explicit release")
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", amp):
        raise ValueError("amp-version must be an explicit npm version")
    return toolchains, packages, amp


def command(args):
    print(shlex.join(args), flush=True)
    subprocess.run(args, check=True, timeout=1200)


def main():
    toolchains, packages, amp = configuration(os.environ)
    tools = Path(os.environ["RUNNER_TEMP"]) / "dependency-update-tools"
    if not tools.is_absolute():
        raise ValueError("RUNNER_TEMP must be absolute")
    tools.mkdir(parents=True, exist_ok=True)
    if packages:
        prefix = [] if os.geteuid() == 0 else ["sudo"]
        command([*prefix, "apt-get", "update"])
        command([*prefix, "apt-get", "install", "-y", "--no-install-recommends", *packages])
    for toolchain in toolchains:
        command(["rustup", "toolchain", "install", toolchain, "--profile", "minimal",
                 "--component", "rustfmt", "--component", "clippy"])
    command(["npm", "install", "--prefix", str(tools), "--no-audit", "--no-fund",
             "--", "@sourcegraph/amp@" + amp])
    command([str(tools / "node_modules/.bin/amp"), "--version"])
    with open(os.environ["GITHUB_PATH"], "a") as stream:
        stream.write(str(tools / "node_modules/.bin") + "\n")
    with open(os.environ["GITHUB_ENV"], "a") as stream:
        stream.write("RUSTUP_TOOLCHAIN=" + toolchains[0] + "\n")


if __name__ == "__main__":
    main()
