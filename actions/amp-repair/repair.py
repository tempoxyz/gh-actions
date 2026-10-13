"""Bounded Rust dependency repair in disposable, credential-isolated workers."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import signal
import subprocess
import tarfile
import tempfile
import time
import tomllib
import uuid


SHA = re.compile(r"[0-9a-f]{40}")
IMAGE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[0-9a-f]{64}")
TOOL_PATH = "/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin"
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


def gitlinks(repository, ref):
    entries = git(repository, "ls-tree", "-r", "-z", "--full-tree", ref).stdout.split("\0")
    return {entry.split("\t", 1)[1]: entry.split("\t", 1)[0].split()[2]
            for entry in entries if entry.startswith("160000 ")}


def export_tree(repository, ref, destination, *, gitlink_base=None):
    """Export tracked content without .git, Git credentials, or runner files."""
    entries = git(repository, "ls-tree", "-r", "--full-tree", ref).stdout.splitlines()
    if any(entry.startswith("120000 ") for entry in entries):
        raise ValueError("symlinks are unsupported")
    links = gitlinks(repository, ref)
    if links and gitlink_base is None:
        raise ValueError("gitlinks require a trusted baseline")
    if gitlink_base is not None and links != gitlinks(repository, gitlink_base):
        raise ValueError("gitlink revisions changed")
    with tempfile.TemporaryFile() as archive:
        result = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "archive", ref],
                                cwd=repository, stdout=archive, stderr=subprocess.PIPE)
        if result.returncode:
            raise RuntimeError("cannot export candidate source tree")
        archive.seek(0)
        with tarfile.open(fileobj=archive) as source:
            members = source.getmembers()
            for member in members:
                safe_path(member.name.rstrip("/"))
                if not (member.isfile() or member.isdir()):
                    raise ValueError("gitlinks, symlinks and special files are unsupported")
            # Members are individually checked above, including .git and traversal.
            source.extractall(destination, members=members, filter="data")
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

    def scope(self, root):
        current = snapshot(root)
        changed = [path for path in self.baseline.keys() | current.keys()
                   if self.baseline.get(path) != current.get(path)]
        for path in changed:
            if any(path == link or path.startswith(link + "/") for link in self.gitlinks):
                raise ValueError("changes inside frozen gitlinks are unsupported")
            if not allowed(path, self.patterns):
                raise ValueError(f"change outside repair scope: {path}")
            if path in current and current[path][0] != self.baseline.get(path, (0o644,))[0]:
                raise ValueError(f"file mode changed: {path}")
            if path in current:
                content = (root / path).read_bytes()
                for key in ("AMP_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"):
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
            overrides[path] = {key: document.get(key, {}) for key in ("patch", "replace")}
            for table, spec in dependencies(document):
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
    """Only source and an expendable cache are writable inside the container."""

    def __init__(self, root, image, deadline, cache, *, memory="4g"):
        if not IMAGE.fullmatch(image):
            raise ValueError("worker-image must be pinned by sha256 digest")
        if not re.fullmatch(r"[1-9][0-9]*[mg]", memory):
            raise ValueError("worker-memory must be an explicit positive limit")
        self.root, self.image, self.deadline, self.cache = root, image, deadline, cache
        self.memory = memory

    def arguments(self, name, args, *, agent=False, cache=None):
        cache = self.cache if cache is None else cache
        for path in (self.root, cache):
            if "," in str(path):
                raise ValueError("Docker mount paths must not contain commas")
        command = ["docker", "run", "--name", name, "--rm", "--init", "--read-only",
                   "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
                   "--pids-limit=512", "--memory", self.memory,
                   "--user", f"{os.getuid()}:{os.getgid()}",
                   "--mount", f"type=bind,src={self.root},dst=/workspace",
                   "--mount", f"type=bind,src={cache},dst=/cache",
                   "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g", "--workdir", "/workspace",
                   "--env", "HOME=/cache/home", "--env", "CARGO_HOME=/cache/cargo",
                   "--env", "CARGO_TARGET_DIR=/cache/target",
                   "--env", "XDG_CONFIG_HOME=/cache/config", "--env", "CI=true",
                   "--env", f"PATH={TOOL_PATH}", "--env", "RUSTUP_HOME=/usr/local/rustup",
                   "--env", "CARGO_HTTP_TIMEOUT=180", "--env", "CARGO_NET_RETRY=10"]
        if agent:
            command += ["--env", "AMP_API_KEY"]
        return command + ["--entrypoint", args[0], self.image, *args[1:]]

    def execute(self, args, *, agent=False):
        remaining = int(self.deadline - time.monotonic())
        if remaining <= 0:
            raise TimeoutError("dependency repair budget exhausted")
        name = "amp-repair-" + uuid.uuid4().hex
        # Never copy the runner environment into the Docker client/worker.
        env = {key: os.environ[key] for key in ("PATH", "LANG") if key in os.environ}
        if agent:
            key = os.environ.get("AMP_API_KEY", "")
            if not key.strip():
                raise ValueError("AMP_API_KEY is required when a repair is needed")
            env["AMP_API_KEY"] = key
        with tempfile.TemporaryFile() as log, tempfile.TemporaryDirectory(
                prefix="amp-docker-client-") as client:
            env.update(HOME=client, DOCKER_CONFIG=client)
            # Agent state and prior build scripts are untrusted. Each verification
            # command starts with empty HOME/Cargo/target state, outside agent mounts.
            with tempfile.TemporaryDirectory(prefix="amp-check-cache-",
                                             dir=self.cache.parent) as clean_cache:
                cache = self.cache if agent else Path(clean_cache)
                return self._execute(name, args, agent, cache, env, log, remaining)

    def _execute(self, name, args, agent, cache, env, log, remaining):
        try:
            result = subprocess.run(self.arguments(name, args, agent=agent, cache=cache), env=env,
                                    stdout=log, stderr=subprocess.STDOUT,
                                    timeout=min(1200, remaining))
            log.seek(0, 2)
            length = log.tell()
            log.seek(0)
            beginning = log.read(min(length, 4096))
            log.seek(max(len(beginning), length - 60000))
            return result.returncode, (beginning + log.read()).decode(errors="replace")
        finally:
            # Killing the CLI alone does not stop a detached container's processes.
            cleanup = subprocess.run(["docker", "rm", "--force", name], env=env,
                                     capture_output=True, text=True, timeout=30, check=False)
            if cleanup.returncode and "No such container" not in cleanup.stderr:
                raise RuntimeError("cannot confirm worker cleanup; refusing further repair/publication")


def checks(worker, commands):
    if not commands:
        raise ValueError("local-checks must not be empty")
    for command in commands:
        args = shlex.split(command)
        if not args:
            raise ValueError("empty check command")
        status, log = worker.execute(args)
        if status:
            return "Command: " + shlex.join(args) + "\n" + log[-16000:]
    return None


def repair(worker, error, instructions):
    prompt = (instructions + "\n\nFix this failure:\n" + error[-24000:] +
              "\nKeep frozen Git dependencies unchanged. Only edit allowed Rust/manifests/lockfiles. "
              "Do not weaken invariants, remove tests, suppress warnings, edit configuration, "
              "commit, push, merge, or repair infrastructure/credential problems.")
    status, log = worker.execute(["amp", "--stream-json", "--dangerously-allow-all", "-x", prompt],
                                 agent=True)
    for line in log.splitlines():
        try:
            message = json.loads(line)
        except (ValueError, TypeError):
            continue
        thread = message.get("session_id", "") if isinstance(message, dict) else ""
        if re.fullmatch(r"[A-Za-z0-9_-]+", thread):
            print("Amp thread: https://ampcode.com/threads/" + thread)
    if status:
        print(f"::warning::Amp exited with status {status}; validating the resulting source tree.")


def repair_local(worker, policy, commands, instructions, max_repairs):
    for attempt in range(max_repairs + 1):
        # Validate before executing any candidate code and after each agent invocation.
        policy.validate(worker.root, lockfile=False)
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
    parser.add_argument("--worker-image", required=True)
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
    with tempfile.TemporaryDirectory(prefix="amp-worker-cache-") as cache:
        worker = Worker(source, args.worker_image, time.monotonic() + args.budget_minutes * 60,
                        Path(cache))
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
