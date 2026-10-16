"""Exercise installed updater tools without Codex API calls or GitHub writes."""

import os
from pathlib import Path
import tempfile
import time

from repair import Worker, checks


with tempfile.TemporaryDirectory(prefix="dependency-runner-smoke-") as directory:
    root = Path(directory)
    source, cache = root / "source", root / "cache"
    source.mkdir()
    cache.mkdir()
    (source / "Cargo.toml").write_text('[package]\nname="runner-smoke"\nversion="0.1.0"\nedition="2024"\n')
    (source / "src").mkdir()
    (source / "src/lib.rs").write_text('pub fn answer() -> u32 {\n    42\n}\n')
    worker = Worker(source, time.monotonic() + 120, cache)
    # --version does not contact Codex or consume credits; no actual key is needed.
    os.environ["CODEX_API_KEY"] = "smoke-version-only"
    status, log = worker.execute(["codex", "--version"], agent=True)
    print(log, flush=True)
    if status:
        raise RuntimeError("installed tool smoke failed")
    for operation in (worker.resolve_lockfile, worker.fetch_dependencies):
        status, log = operation()
        print(log, flush=True)
        if status:
            raise RuntimeError("Cargo dependency preparation failed")
    error = checks(worker, ["cargo fmt --all --check", "cargo clippy --locked -- -D warnings",
                            "cargo +nightly-2026-08-21 fmt --all --check",
                            "cargo nextest run --locked --no-tests=warn"])
    if error:
        raise RuntimeError(error)
    print("Runner tool setup, Codex startup and Cargo checks passed.")
