"""Bounded Rust dependency repair using tools installed on an ephemeral runner."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import signal
import subprocess
import tempfile
import time
import tomllib


SHA = re.compile(r"[0-9a-f]{40}")
DENIED_ROOTS = {".git", ".github", ".cargo", "scripts"}
SOURCE_KEYS = ("git", "rev", "tag", "branch", "path", "registry", "workspace", "package")


def run(args, *, cwd=None, env=None, timeout=120, check=True):
    return subprocess.run(args, cwd=cwd, env=env, text=True, check=check,
                          capture_output=True, timeout=timeout)


def git(root, *args, env=None, check=True):
    # No hooks, global config, credential helpers, filters or user aliases.
    clean = {k: v for k, v in os.environ.items()
             if not k.startswith("GIT_") and k not in ("GH_TOKEN", "GITHUB_TOKEN")}
    clean.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                 GIT_TERMINAL_PROMPT="0")
    clean.update(env or {})
    return run(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
                "-c", "credential.helper=", "-c", "core.autocrlf=false", *args],
               cwd=root, env=clean, check=check)


def safe_path(value):
    path = PurePosixPath(value)
    if (not value or path.is_absolute() or str(path) != value or
            any(p in ("..", ".git") for p in path.parts) or "\x00" in value):
        raise ValueError("expected a normalized relative path")
    return value


def allowed(path, patterns):
    safe_path(path)
    if path.split("/", 1)[0] in DENIED_ROOTS:
        return False
    if not (path.endswith(".rs") or PurePosixPath(path).name in ("Cargo.toml", "Cargo.lock")):
        return False
    # ** matches zero or more complete directories; * never crosses a directory.
    for pattern in patterns:
        safe_path(pattern)
        expression = re.escape(pattern).replace(r"\*\*/", "(?:.*/)?")
        expression = expression.replace(r"\*\*", ".*").replace(r"\*", "[^/]*")
        if re.fullmatch(expression, path):
            return True
    return False


def snapshot(root):
    """Inspect all files, including ignored/untracked ones, without following links."""
    result = {}
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(directory) / name
            relative = path.relative_to(root).as_posix()
            safe_path(relative)
            if path.is_symlink():
                raise ValueError(f"symlink is not supported: {relative}")
            if not path.is_dir():
                if not path.is_file():
                    raise ValueError(f"special file is not supported: {relative}")
                result[relative] = (path.stat().st_mode & 0o777,
                                    hashlib.sha256(path.read_bytes()).hexdigest())
    return result


def frozen_links(repository, ref):
    """Tracked gitlinks and symlinks: never exported, initialized or followed."""
    entries = git(repository, "ls-tree", "-r", "-z", "--full-tree", ref).stdout.split("\0")
    return {entry.split("\t", 1)[1]: tuple(entry.split("\t", 1)[0].split()[::2])
            for entry in entries if entry.startswith(("160000 ", "120000 "))}


def export_tree(repository, ref, destination, *, frozen_base=None):
    """Export tracked content without .git, Git credentials, or runner files."""
    entries = []
    for entry in git(repository, "ls-tree", "-r", "-z", "--full-tree", ref).stdout.split("\0"):
        if not entry:
            continue
        metadata, name = entry.split("\t", 1)
        mode, kind, oid = metadata.split()
        safe_path(name)
        if mode in ("160000", "120000"):
            continue
        if mode not in ("100644", "100755") or kind != "blob":
            raise ValueError("special Git tree entries are unsupported")
        entries.append((name, mode, oid))
    links = frozen_links(repository, ref)
    if links and frozen_base is None:
        raise ValueError("gitlinks and symlinks require a trusted baseline")
    if frozen_base is not None and links != frozen_links(repository, frozen_base):
        raise ValueError("frozen gitlinks or symlinks changed")
    # Read every committed blob directly: archive attributes and filters must not
    # hide forbidden changes or transform the content being checked/published.
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryFile() as blobs:
        result = subprocess.run(["git", "cat-file", "--batch"], cwd=repository,
                                input="".join(oid + "\n" for _, _, oid in entries).encode(),
                                stdout=blobs, stderr=subprocess.PIPE)
        if result.returncode:
            raise RuntimeError("cannot export complete candidate Git tree")
        blobs.seek(0)
        for name, mode, oid in entries:
            header = blobs.readline().decode().split()
            if len(header) != 3 or header[:2] != [oid, "blob"]:
                raise ValueError("invalid Git blob response")
            content = blobs.read(int(header[2]))
            if len(content) != int(header[2]) or blobs.read(1) != b"\n":
                raise ValueError("incomplete Git blob response")
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            target.chmod(0o755 if mode == "100755" else 0o644)
    snapshot(destination)


def dependencies(document, table=()):
    for key, value in document.items():
        if not isinstance(value, dict):
            continue
        if key in ("dependencies", "dev-dependencies", "build-dependencies"):
            for name, spec in value.items():
                if isinstance(spec, dict):
                    yield table + (key, name), spec
        else:
            yield from dependencies(value, table + (key,))


def canonical_url(url):
    return url.removesuffix(".git").rstrip("/")


def guarded(document):
    """Manifest settings a dependency migration must not change."""
    package, workspace = document.get("package", {}), document.get("workspace", {})
    return {"patch": document.get("patch", {}), "replace": document.get("replace", {}),
            "profile": document.get("profile", {}), "lints": document.get("lints", {}),
            "package.build": package.get("build"), "workspace.lints": workspace.get("lints", {}),
            "workspace.members": workspace.get("members"), "workspace.exclude": workspace.get("exclude")}


class Policy:
    """Freeze dependency identities after the trusted adapter applies its plan."""

    def __init__(self, baseline, patterns, pins):
        self.baseline = baseline
        self.patterns = patterns
        self.pins = {canonical_url(url): sha for url, sha in pins.items()}
        if not self.pins or not all(SHA.fullmatch(sha) for sha in self.pins.values()):
            raise ValueError("pins must map selected Git URLs to full commit SHAs")
        if not all(re.fullmatch(r"https://github\.com/[\w.-]+/[\w.-]+(?:\.git)?", url)
                   for url in self.pins):
            raise ValueError("selected sources must be GitHub HTTPS repositories")
        if not patterns:
            raise ValueError("allowed-paths must not be empty")
        for pattern in patterns:
            safe_path(pattern)
        self.frozen = None
        self.overrides = None
        self.gitlinks = set()
        # Existing update-branch changes outside the repair scope, pushed by
        # people with write access; kept byte-for-byte but never editable here.
        self.inherited = {}

    def scope(self, root):
        current = snapshot(root)
        changed = [path for path in self.baseline.keys() | current.keys()
                   if self.baseline.get(path) != current.get(path)]
        for path in changed:
            if any(path == link or path.startswith(link + "/") for link in self.gitlinks):
                raise ValueError("changes inside frozen gitlinks or symlinks are unsupported")
            if path in self.inherited and current.get(path) == self.inherited[path]:
                continue
            if not allowed(path, self.patterns):
                raise ValueError(f"change outside repair scope: {path}")
            if path in current and current[path][0] != self.baseline.get(path, (0o644,))[0]:
                raise ValueError(f"file mode changed: {path}")
            if path in current and path not in self.baseline and PurePosixPath(path).name == "build.rs":
                raise ValueError(f"new build scripts are not allowed: {path}")
            if path in current:
                content = (root / path).read_bytes()
                for key in ("CODEX_API_KEY", "OPENAI_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"):
                    secret = os.environ.get(key, "")
                    if secret and secret.encode() in content:
                        raise ValueError("candidate contains a runner credential")
        return changed

    def sources(self, root):
        identities, overrides, found = {}, {}, set()
        for path in sorted(snapshot(root)):
            if PurePosixPath(path).name != "Cargo.toml":
                continue
            document = tomllib.loads((root / path).read_text())
            overrides[path] = guarded(document)
            for table, spec in dependencies(document):
                if "path" in spec:
                    # The runner fetches dependencies; local paths stay inside the export.
                    target = os.path.normpath(PurePosixPath(path).parent / str(spec["path"]))
                    if PurePosixPath(spec["path"]).is_absolute() or target == ".." or target.startswith("../"):
                        raise ValueError(f"path dependency escapes the repository: {path}")
                url = spec.get("git", "")
                if url and canonical_url(url) in self.pins:
                    canonical = canonical_url(url)
                    if spec.get("rev") != self.pins[canonical] or any(
                            key in spec for key in ("branch", "tag", "path", "registry", "workspace")):
                        raise ValueError("selected dependency revision/source changed")
                    identities[(path, table)] = {key: spec[key] for key in SOURCE_KEYS if key in spec}
                    found.add(canonical)
        if found != self.pins.keys():
            raise ValueError("a selected dependency source is missing")
        return identities, overrides

    def freeze(self, root):
        self.scope(root)
        self.frozen, self.overrides = self.sources(root)

    def validate(self, root, *, lockfile=True):
        self.scope(root)
        identities, overrides = self.sources(root)
        if identities != self.frozen or overrides != self.overrides:
            raise ValueError("frozen dependency identity or Cargo override changed")
        if lockfile:
            found = set()
            for path in snapshot(root):
                if PurePosixPath(path).name != "Cargo.lock":
                    continue
                for package in tomllib.loads((root / path).read_text()).get("package", []):
                    source = package.get("source", "")
                    if source.startswith("git+"):
                        url = canonical_url(source[4:].split("?", 1)[0].split("#", 1)[0])
                        if url in self.pins:
                            if source.rsplit("#", 1)[-1] != self.pins[url]:
                                raise ValueError("lockfile resolves a selected source to another commit")
                            found.add(url)
            if found != self.pins.keys():
                raise ValueError("lockfile is missing selected dependency revisions")


class Worker:
    """Run processes with explicit environments; this is not a security sandbox."""

    def __init__(self, root, deadline, cache, *, seed=None):
        self.root, self.deadline, self.cache = root, deadline, cache
        self.seed = seed or cache.with_name(cache.name + "-seed")
        # Capture installed tools before any candidate code runs. Never search the
        # candidate directory or agent cache for executables.
        self.path = os.pathsep.join(path for path in os.get_exec_path() if Path(path).is_absolute())
        self.rustup_home = os.environ.get("RUSTUP_HOME", str(Path.home() / ".rustup"))
        self.toolchain = os.environ.get("RUSTUP_TOOLCHAIN")

    def environment(self, cache, *, agent=False, offline=False):
        env = {key: os.environ[key] for key in ("LANG", "LC_ALL") if key in os.environ}
        for directory in ("home", "cargo", "target", "config", "tmp", "codex"):
            (cache / directory).mkdir(parents=True, exist_ok=True)
        env.update(PATH=self.path, HOME=str(cache / "home"), CARGO_HOME=str(cache / "cargo"),
                   CARGO_TARGET_DIR=str(cache / "target"), XDG_CONFIG_HOME=str(cache / "config"),
                   TMPDIR=str(cache / "tmp"), RUSTUP_HOME=self.rustup_home, CI="true",
                   CARGO_HTTP_TIMEOUT="180", CARGO_NET_RETRY="10", GIT_CONFIG_NOSYSTEM="1",
                   GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT="0")
        if self.toolchain:
            env["RUSTUP_TOOLCHAIN"] = self.toolchain
        if offline:
            env["CARGO_NET_OFFLINE"] = "true"
        if agent:
            key = os.environ.get("CODEX_API_KEY", "")
            if not key.strip():
                raise ValueError("CODEX_API_KEY is required when a repair is needed")
            env["CODEX_API_KEY"] = key
            env["CODEX_HOME"] = str(cache / "codex")
        return env

    def execute(self, args, *, agent=False, lockfile=False, fetch=False):
        if lockfile and (agent or fetch or args != ["cargo", "update", "--workspace"]):
            raise ValueError("only dedicated lockfile resolution may write verification source")
        if fetch and (agent or args != ["cargo", "fetch", "--locked"]):
            raise ValueError("only dedicated dependency fetch may populate the download cache")
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("dependency repair budget exhausted")
        executable = shutil.which(args[0], path=self.path)
        if not executable:
            raise FileNotFoundError(f"required runner tool is not installed: {args[0]}")
        with tempfile.TemporaryDirectory(prefix="codex-check-cache-", dir=self.cache.parent) as directory:
            cache = self.cache if agent else Path(directory)
            if not (agent or lockfile or fetch) and self.seed.exists():
                # Each check gets downloads but none of the agent's Cargo config,
                # installed subcommands, build output or HOME state.
                shutil.copytree(self.seed, cache / "cargo")
            env = self.environment(cache, agent=agent, offline=not (agent or lockfile or fetch))
            if fetch:
                self.seed.mkdir(parents=True, exist_ok=True)
                env["CARGO_HOME"] = str(self.seed)
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("dependency repair budget exhausted")
            with tempfile.TemporaryFile() as log:
                process = subprocess.Popen([executable, *args[1:]], cwd=self.root, env=env,
                                           stdin=subprocess.DEVNULL, stdout=log,
                                           stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    process.wait(timeout=min(2700, remaining))
                finally:
                    # Also stop background children after normal exit, cancellation
                    # or timeout, before checking the tree or minting an STS token.
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait(timeout=30)
                log.seek(0, 2)
                length = log.tell()
                log.seek(0)
                beginning = log.read(min(length, 4096))
                log.seek(max(len(beginning), length - 60000))
                return process.returncode, (beginning + log.read()).decode(errors="replace")

    def resolve_lockfile(self):
        original = snapshot(self.root)
        with tempfile.TemporaryDirectory(prefix="codex-lockfile-", dir=self.cache.parent) as directory:
            source = Path(directory) / "source"
            shutil.copytree(self.root, source)
            resolver = Worker(source, self.deadline, self.cache)
            status, log = resolver.execute(["cargo", "update", "--workspace"], lockfile=True)
            current = snapshot(source)
            if any(original.get(path) != current.get(path)
                   for path in original.keys() | current.keys() if path != "Cargo.lock"):
                raise ValueError("lockfile resolution changed source outside Cargo.lock")
            if snapshot(self.root) != original:
                raise ValueError("candidate changed during lockfile resolution")
            if not status:
                shutil.copy2(source / "Cargo.lock", self.root / "Cargo.lock")
            return status, log

    def fetch_dependencies(self):
        """Fetch locked dependencies on the runner through its package firewall."""
        # Rebuild the seed after every repair, independently of the agent cache.
        if self.seed.exists():
            shutil.rmtree(self.seed)
        return self.execute(["cargo", "fetch", "--locked"], fetch=True)


def checks(worker, commands):
    if not commands:
        raise ValueError("local-checks must not be empty")
    expected = snapshot(worker.root)
    for command in commands:
        args = shlex.split(command)
        if not args:
            raise ValueError("empty check command")
        if snapshot(worker.root) != expected:
            raise ValueError("candidate changed between verification commands")
        status, log = worker.execute(args)
        if snapshot(worker.root) != expected:
            raise ValueError("verification command changed candidate source")
        if status:
            return "Command: " + shlex.join(args) + "\n" + log[-16000:]
    return None


def repair(worker, error, instructions):
    prompt = (instructions + "\n\nFix this failure:\n" + error[-24000:] +
              "\nKeep frozen Git dependencies unchanged. Only edit allowed Rust/manifests/lockfiles. "
              "Do not weaken invariants, remove tests, suppress warnings, edit configuration, "
              "commit, push, merge, or repair infrastructure/credential problems.")
    args = ["codex", "--ask-for-approval", "never", "exec", "--json", "--ephemeral",
            "--skip-git-repo-check", "--ignore-user-config", "--sandbox", "danger-full-access",
            "-c", 'shell_environment_policy.exclude=["CODEX_API_KEY"]']
    if model := os.environ.get("CODEX_MODEL", "").strip():
        args += ["--model", model]
    if effort := os.environ.get("CODEX_EFFORT", "").strip():
        args += ["-c", "model_reasoning_effort=" + json.dumps(effort)]
    status, log = worker.execute([*args, prompt], agent=True)
    threads = []
    for line in log.splitlines():
        try:
            message = json.loads(line)
        except (ValueError, TypeError):
            continue
        thread = (message.get("thread_id", "") if isinstance(message, dict) and
                  message.get("type") == "thread.started" else "")
        if isinstance(thread, str) and re.fullmatch(r"[A-Za-z0-9_-]+", thread) and thread not in threads:
            threads.append(thread)
            print("Codex thread ID: " + thread)
    if status:
        print(f"::warning::Codex exited with status {status}; validating the resulting source tree.")


def repair_local(worker, policy, commands, instructions, max_repairs, *, resolve_lockfile=False):
    for attempt in range(max_repairs + 1):
        # Validate before executing any candidate code and after each agent invocation.
        policy.validate(worker.root, lockfile=False)
        error = None
        if resolve_lockfile:
            status, log = worker.resolve_lockfile()
            if status:
                error = "Command: cargo update --workspace\n" + log[-16000:]
            policy.validate(worker.root, lockfile=False)
        if error is None:
            policy.validate(worker.root)
            status, log = worker.fetch_dependencies()
            if status:
                error = "Command: cargo fetch --locked (runner package firewall)\n" + log
        if error is None:
            error = checks(worker, commands)
        if error is None:
            policy.validate(worker.root)
            return None, attempt
        if attempt == max_repairs:
            return error, attempt
        repair(worker, error, instructions)
    raise AssertionError("unreachable")


def lines(value):
    return [line.strip() for line in value.splitlines() if line.strip()]


def set_output(name, value):
    if "\n" in str(value) or "\r" in str(value):
        raise ValueError("output must be a single line")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
            stream.write(f"{name}={value}\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--pins", required=True, help="trusted JSON map of selected URL to full SHA")
    parser.add_argument("--checks", required=True)
    parser.add_argument("--allowed-paths", required=True)
    parser.add_argument("--instructions", default="Fix dependency API compatibility.")
    parser.add_argument("--max-repairs", type=int, default=3)
    parser.add_argument("--budget-minutes", type=int, default=60)
    args = parser.parse_args()
    commands = lines(args.checks)
    if not commands:
        raise ValueError("local-checks must not be empty")
    if args.max_repairs < 0 or not 1 <= args.budget_minutes <= 180:
        raise ValueError("invalid repair limits")
    source, baseline = Path(args.source).resolve(), Path(args.baseline).resolve()
    policy = Policy(snapshot(baseline), lines(args.allowed_paths), json.loads(args.pins))
    policy.freeze(source)
    with tempfile.TemporaryDirectory(prefix="codex-worker-cache-") as cache, \
            tempfile.TemporaryDirectory(prefix="codex-cargo-seed-") as seed:
        worker = Worker(source, time.monotonic() + args.budget_minutes * 60,
                        Path(cache), seed=Path(seed))
        error, attempts = repair_local(worker, policy, commands, args.instructions,
                                       args.max_repairs)
    set_output("repair-attempts", attempts)
    set_output("status", "failed" if error else "passed")
    if error:
        raise RuntimeError("local repairs exhausted; candidate source retained for inspection")


if __name__ == "__main__":
    def interrupt(signum, frame):
        raise KeyboardInterrupt("repair cancelled")

    signal.signal(signal.SIGTERM, interrupt)
    main()
