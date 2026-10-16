"""Runner coordinator; source exports exclude .git and child environments omit GitHub credentials."""

import argparse
import contextlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import tomllib

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "codex-repair"))
from repair import (Policy, SHA, Worker, export_tree, frozen_links, git, lines,
                    repair, repair_local, run, safe_path, set_output, snapshot)

JOB_MINUTES = 180  # dependency-update.yml timeout-minutes
BRANCH = re.compile(r"[A-Za-z0-9][A-Za-z0-9_./-]{0,199}")
PULL_REQUEST_EVENTS = ("pull_request", "pull_request_target")
PASSING = ("success", "skipped", "neutral")  # Matches GitHub required-check semantics.


def valid_branch(branch):
    return bool(BRANCH.fullmatch(branch) and ".." not in branch and not branch.endswith((".", "/")) and
                not any(part in ("", ".") or part.endswith(".lock") for part in branch.split("/")))


class GitHub:
    def __init__(self, repository, base="main"):
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", repository):
            raise ValueError("invalid caller repository")
        self.repository, self.base = repository, base

    def command(self, *args, token=None, check=True):
        env = dict(os.environ)
        if token:
            env["GH_TOKEN"] = token
        return run(["gh", *args], env=env, check=check)

    def api(self, path):
        return json.loads(self.command("api", path).stdout)

    def pulls(self, branch):
        # Explicit repo selection; never infer it from a worker checkout.
        return json.loads(self.command("pr", "list", "--repo", self.repository,
                                       "--head", branch, "--base", self.base, "--state", "all",
                                       "--limit", "100", "--json", "number,state,url,headRefOid").stdout)

    def runs(self, head):
        return self.api(f"repos/{self.repository}/actions/runs?head_sha={head}&per_page=100")["workflow_runs"]

    def failed_logs(self, failures):
        logs = []
        for workflow in failures:
            result = self.command("run", "view", str(workflow["id"]), "--repo", self.repository,
                                  "--attempt", str(workflow.get("run_attempt", 1)), "--log-failed")
            logs.append(result.stdout[-16000:])
        if not logs:
            raise RuntimeError("failed checks have no Actions diagnostics; human intervention required")
        return "\n".join(logs)[-24000:]

    def require_head(self, number, expected):
        pull = self.api(f"repos/{self.repository}/pulls/{number}")
        if pull["state"] != "open" or pull["head"]["sha"] != expected:
            raise RuntimeError("update PR was closed or changed by another actor; retry required")



class Sts:
    """Mint just-in-time publishing credentials and revoke them before more repair."""

    def __init__(self, action, policy, repository):
        self.action, self.policy, self.repository = action, policy, repository
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", policy):
            raise ValueError("invalid STS policy name")

    @contextlib.contextmanager
    def publishing_token(self):
        token = None
        with tempfile.TemporaryDirectory(prefix="dependency-sts-") as directory:
            outputs, state = Path(directory) / "outputs", Path(directory) / "state"
            env = dict(os.environ, INPUT_SCOPE=self.repository, INPUT_POLICY=self.policy,
                       INPUT_TTL="15m", INPUT_HOST="gh-sts.tempoxyz.net", INPUT_RETRY_TIMEOUT="90",
                       GITHUB_OUTPUT=str(outputs), GITHUB_STATE=str(state))
            try:
                # The reviewed STS implementation comes from this workflow's own revision.
                subprocess.run(["node", str(self.action / "main.js")], env=env, check=True, timeout=120)
                values = dict(line.split("=", 1) for line in outputs.read_text().splitlines())
                token = values["token"]
                if not token or "\n" in token or "\r" in token:
                    raise ValueError("STS returned an invalid publishing token")
                yield token
            finally:
                # Recover a minted credential even when exchange/output parsing failed.
                if token is None and state.exists():
                    values = dict(line.split("=", 1) for line in state.read_text().splitlines() if "=" in line)
                    token = values.get("token")
                if token is None and outputs.exists():
                    values = dict(line.split("=", 1) for line in outputs.read_text().splitlines() if "=" in line)
                    token = values.get("token")
                if token:
                    cleanup = dict(os.environ, STATE_token=token, STATE_sts_host="gh-sts.tempoxyz.net")
                    try:
                        subprocess.run(["node", str(self.action / "post.js")], env=cleanup,
                                       check=False, timeout=90)
                    except (OSError, subprocess.TimeoutExpired):
                        print("::warning::STS cleanup could not finish; credential expires within 15 minutes.")


def selected_runs(runs, head):
    latest = {}
    for workflow in runs:
        if workflow.get("head_sha") != head or workflow.get("event") not in PULL_REQUEST_EVENTS:
            continue
        path = workflow.get("path", "").split("@", 1)[0]
        key = (workflow["id"], workflow.get("run_attempt", 1))
        previous = latest.get(path)
        if previous is None or key > (previous["id"], previous.get("run_attempt", 1)):
            latest[path] = workflow
    return latest


def workflow_state(runs, head, required):
    if not required:
        raise ValueError("configured-workflows requires a nonempty workflow list")
    latest = selected_runs(runs, head)
    selected = [latest[path] for path in required if path in latest]
    failed = [workflow for workflow in selected if workflow.get("status") == "completed" and
              workflow.get("conclusion") not in PASSING]
    green = len(selected) == len(required) and all(workflow.get("status") == "completed" and
                                                 workflow.get("conclusion") in PASSING
                                                 for workflow in selected)
    return green, failed


def validate_plan(plan, base="main"):
    if plan.get("schema_version") != 1:
        raise ValueError("adapter must return update-plan schema version 1")
    if plan.get("skip") is True:
        return
    branch = plan.get("branch", "")
    if not valid_branch(branch) or branch == base:
        raise ValueError("invalid automation branch")
    for key in ("title", "update_id"):
        if not isinstance(plan.get(key), str) or not plan[key] or any(c in plan[key] for c in "\r\n\x00"):
            raise ValueError(f"invalid plan field: {key}")
    if plan.get("closed_pr_policy") not in ("skip", "new-pr"):
        raise ValueError("closed_pr_policy must be skip or new-pr")
    if not isinstance(plan.get("pins"), dict) or not plan["pins"]:
        raise ValueError("plan must freeze selected dependency revisions")


def exact_requirements(root):
    """Exact (`=x.y.z`) dependency requirements, which usually encode a deliberate pin."""
    found = {}

    def walk(path, table, prefix):
        for key, value in table.items():
            if not isinstance(value, dict):
                continue
            if key not in ("dependencies", "dev-dependencies", "build-dependencies"):
                walk(path, value, prefix + (key,))
                continue
            for name, spec in value.items():
                version = spec.get("version") if isinstance(spec, dict) else spec
                if isinstance(version, str) and version.strip().startswith("="):
                    found[path + ": " + ".".join(prefix + (key, name))] = version.strip()

    for path in sorted(snapshot(root)):
        if PurePosixPath(path).name == "Cargo.toml":
            walk(path, tomllib.loads((root / path).read_text()), ())
    return found


def review_notes(before, after):
    """Allowed changes that still deserve explicit reviewer attention."""
    notes = []
    old, new = exact_requirements(before), exact_requirements(after)
    for key in sorted(old.keys() | new.keys()):
        if old.get(key) != new.get(key):
            notes.append(f"- Exact requirement changed: `{key}` `{old.get(key, 'none')}` → `{new.get(key, 'removed')}`")
    previous, current = snapshot(before), snapshot(after)
    for path in sorted(previous.keys() | current.keys()):
        if path not in current:
            notes.append(f"- File deleted: `{path}`")
        elif PurePosixPath(path).name == "build.rs" and previous.get(path) != current[path]:
            notes.append(f"- Build script changed: `{path}`")
    return notes


class Coordinator:
    def __init__(self, source, shared, config, github):
        self.source, self.shared, self.config, self.github = source, shared, config, github
        self.sts = Sts(shared / "actions/github-sts", config["sts-policy"], github.repository)
        self.base = github.base
        # Worker time is bounded by the repair budget; CI waiting by the job timeout.
        started = time.monotonic()
        self.deadline = started + config["repair-budget-minutes"] * 60
        self.ci_deadline = started + (JOB_MINUTES - 10) * 60
        self.commands = lines(config["local-checks"])
        if not self.commands:
            raise ValueError("local-checks must not be empty")
        self.required = lines(config.get("required-workflows", ""))
        if not self.required:
            raise ValueError("required-workflows must not be empty")

    def rebase_existing(self, repository, base, policy):
        git(repository, "rebase", base)  # Conflicts fail; never select a side automatically.
        # Keep what the branch already contains, including maintainer fixes outside the
        # repair scope (for example deny.toml). Repairs may not modify those paths further.
        with tempfile.TemporaryDirectory(prefix="dependency-existing-") as directory:
            export_tree(repository, "HEAD", directory, frozen_base=base)
            existing = snapshot(Path(directory))
        policy.inherited = {path: existing.get(path) for path in policy.baseline.keys() | existing.keys()
                            if policy.baseline.get(path) != existing.get(path)}

    def adapter(self, script, operation, plan_file=None, cwd=None):
        # Python isolated mode excludes the candidate working directory/PYTHONPATH.
        args = ["python3", "-I", str(script), operation]
        if plan_file:
            args += ["--plan", str(plan_file)]
        env = {key: os.environ[key] for key in ("PATH", "LANG", "GH_TOKEN", "GITHUB_REPOSITORY")
               if key in os.environ}
        env["UPDATE_REQUESTED_REF"] = self.config.get("requested-ref", "")
        return run(args, cwd=cwd, env=env).stdout

    def git_env(self, directory, token):
        askpass = directory / "askpass"
        askpass.write_text('#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" x-access-token;; '
                           '*) printf "%s\\n" "$DEPENDENCY_GIT_TOKEN";; esac\n')
        askpass.chmod(0o700)
        return {"GIT_ASKPASS": str(askpass), "DEPENDENCY_GIT_TOKEN": token}

    def publish(self, repository, work, policy, plan, existing, expected, base, directory):
        # A newer base is fine: the commit's parent is the base it was validated against,
        # and GitHub tests the pull request against the current base.
        if time.monotonic() >= self.deadline:
            raise TimeoutError("repair budget exhausted; refusing publication")
        policy.validate(work)
        if existing:
            self.github.require_head(existing["number"], expected)
        # Rebuild the index from trusted Git state. Worker .git is never imported.
        git(repository, "reset", "--hard", "HEAD")
        with tempfile.TemporaryDirectory(prefix="dependency-before-") as before:
            export_tree(repository, "HEAD", before, frozen_base=base)
            previous, current = snapshot(Path(before)), snapshot(work)
            for path in previous.keys() | current.keys():
                if previous.get(path) == current.get(path):
                    continue
                target = repository / path
                if path in current:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(work / path, target)
                else:
                    target.unlink()
        git(repository, "add", "--all")
        if git(repository, "diff", "--cached", "--quiet", check=False).returncode:
            git(repository, "-c", "user.name=tempo-github-sts[bot]", "-c",
                "user.email=312736176+tempo-github-sts[bot]@users.noreply.github.com",
                "commit", "-m", plan["title"])
        head = git(repository, "rev-parse", "HEAD").stdout.strip()
        with tempfile.TemporaryDirectory(prefix="dependency-candidate-") as candidate:
            export_tree(repository, head, candidate, frozen_base=base)
            policy.validate(Path(candidate))
            if snapshot(Path(candidate)) != snapshot(work):
                raise ValueError("commit tree differs from verified candidate")
        notes = review_notes(directory / "baseline", work)
        with self.sts.publishing_token() as token:
            env = self.git_env(directory, token)
            git(repository, "push", "--force-with-lease=refs/heads/" + plan["branch"] + ":" + expected,
                "origin", "HEAD:refs/heads/" + plan["branch"], env=env)
            body = directory / "pr-body.md"
            body.write_text(plan.get("body", "") + "\n\nUpdate identity: " + plan["update_id"] +
                            "\nFrozen dependency revisions:\n" +
                            "\n".join(f"- {url}: `{sha}`" for url, sha in plan["pins"].items()) + "\n" +
                            ("\n## Review notes\n\n" + "\n".join(notes) + "\n" if notes else ""))
            if existing:
                self.github.command("pr", "edit", str(existing["number"]), "--repo", self.github.repository,
                                    "--title", plan["title"], "--body-file", str(body), token=token)
            else:
                self.github.command("pr", "create", "--repo", self.github.repository,
                                    "--head", plan["branch"], "--base", self.base, "--title", plan["title"],
                                    "--body-file", str(body), token=token)
                existing = json.loads(self.github.command("pr", "view", plan["branch"], "--repo",
                                                          self.github.repository, "--json", "number,url,headRefOid").stdout)
        set_output("pull-request-number", existing["number"])
        set_output("pull-request-url", existing["url"])
        set_output("head-sha", head)
        return existing, head

    def poll(self, number, head):
        while time.monotonic() < self.ci_deadline:
            self.github.require_head(number, head)
            runs = self.github.runs(head)
            green, failed = workflow_state(runs, head, self.required)
            if green or failed:
                return green, failed
            time.sleep(min(30, max(0, self.ci_deadline - time.monotonic())))
        raise TimeoutError("CI deadline exceeded; update PR retained")

    def execute(self):
        adapter_path = safe_path(self.config["adapter-script"])
        tracked = git(self.source, "ls-files", "--error-unmatch", "--", adapter_path)
        if not tracked.stdout.strip() or (self.source / adapter_path).is_symlink():
            raise ValueError("adapter must be a tracked regular file on the trusted base branch")
        # Keep the standalone adapter outside both the candidate repo and worker mounts.
        with tempfile.TemporaryDirectory(prefix="dependency-update-") as directory:
            directory = Path(directory)
            script = directory / "adapter.py"
            script.write_bytes((self.source / adapter_path).read_bytes())
            plan = json.loads(self.adapter(script, "resolve"))
            validate_plan(plan, self.base)
            if plan.get("skip"):
                set_output("status", "skipped")
                return
            policy = Policy({}, lines(self.config["allowed-paths"]), plan["pins"])
            plan_file = directory / "plan.json"
            plan_file.write_text(json.dumps(plan))
            repository = directory / "repository"
            git(directory, "clone", "--no-hardlinks", str(self.source), str(repository))
            git(repository, "remote", "set-url", "origin", "https://github.com/" + self.github.repository + ".git")
            git(repository, "config", "user.name", "tempo-github-sts[bot]")
            git(repository, "config", "user.email", "312736176+tempo-github-sts[bot]@users.noreply.github.com")
            read_env = self.git_env(directory, os.environ["GH_TOKEN"])
            git(repository, "fetch", "origin", self.base, env=read_env)
            base = git(repository, "rev-parse", "FETCH_HEAD").stdout.strip()
            if base != git(self.source, "rev-parse", "HEAD").stdout.strip():
                raise RuntimeError("base branch advanced after trusted checkout; retry required")
            git(repository, "checkout", "--detach", base)
            baseline = directory / "baseline"
            baseline.mkdir()
            export_tree(repository, base, baseline, frozen_base=base)
            policy.baseline = snapshot(baseline)
            policy.gitlinks = set(frozen_links(repository, base))
            pulls = self.github.pulls(plan["branch"])
            existing = next((pull for pull in pulls if pull["state"] == "OPEN"), None)
            if pulls and not existing and plan["closed_pr_policy"] == "skip":
                set_output("status", "skipped")
                return
            remote = git(repository, "ls-remote", "--exit-code", "--heads", "origin", plan["branch"],
                         env=read_env, check=False)
            if remote.returncode not in (0, 2):
                raise RuntimeError("cannot inspect update branch")
            expected = remote.stdout.split()[0] if remote.returncode == 0 else ""
            if expected and (existing or not pulls):
                if not SHA.fullmatch(expected) or (existing and expected != existing["headRefOid"]):
                    raise RuntimeError("update branch changed while preparing plan")
                git(repository, "fetch", "origin", plan["branch"], env=read_env)
                if git(repository, "rev-parse", "FETCH_HEAD").stdout.strip() != expected:
                    raise RuntimeError("update branch advanced during fetch; retry required")
                git(repository, "checkout", "--detach", "FETCH_HEAD")
                self.rebase_existing(repository, base, policy)
            work, cache = directory / "source", directory / "cache"
            work.mkdir()
            cache.mkdir()
            export_tree(repository, "HEAD", work, frozen_base=base)
            self.adapter(script, "apply", plan_file, cwd=work)
            policy.freeze(work)
            worker = Worker(work, self.deadline, cache)
            error, attempts = repair_local(worker, policy, self.commands,
                                           self.config["repair-instructions"], self.config["max-local-repairs"],
                                           resolve_lockfile=True)
            set_output("local-repair-attempts", attempts)
            policy.validate(work, lockfile=False)
            try:
                policy.validate(work)
            except ValueError as invalid:
                if error:
                    raise RuntimeError("local repairs exhausted before Cargo.lock resolved the selected "
                                       "revisions; nothing published\n" + error[-4000:]) from invalid
                raise
            existing, head = self.publish(repository, work, policy, plan, existing, expected, base, directory)
            if error:
                raise RuntimeError("local repair attempts exhausted; best-effort PR retained")
            for attempt in range(self.config["max-ci-repairs"] + 1):
                green, failed = self.poll(existing["number"], head)
                if green:
                    policy.validate(work)
                    set_output("ci-repair-attempts", attempt)
                    set_output("status", "passed")
                    return
                if attempt == self.config["max-ci-repairs"]:
                    raise RuntimeError("CI repair attempts exhausted; PR retained")
                before = snapshot(work)
                repair(worker, self.github.failed_logs(failed), self.config["repair-instructions"])
                if snapshot(work) == before:
                    raise RuntimeError("agent made no changes while CI failed; PR retained")
                policy.validate(work, lockfile=False)
                error, _ = repair_local(worker, policy, self.commands,
                                        self.config["repair-instructions"], 0, resolve_lockfile=True)
                policy.validate(work)
                if error:
                    raise RuntimeError("CI repair failed local validation; PR retained for next run")
                previous = head
                existing, head = self.publish(repository, work, policy, plan, existing, head, base, directory)
                if head == previous:
                    raise RuntimeError("agent made no changes while CI failed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--shared", required=True)
    args = parser.parse_args()
    # Reject PR/fork execution before any adapter, worker or publishing credential.
    config = json.loads(os.environ["DEPENDENCY_UPDATE_CONFIG"])
    base = config.get("base-branch", "main")
    if not valid_branch(base):
        raise ValueError("invalid base branch")
    if os.environ.get("GITHUB_REF") != "refs/heads/" + base or os.environ.get("GITHUB_EVENT_NAME") not in ("schedule", "workflow_dispatch"):
        raise ValueError("dependency updates must run from the caller base-branch schedule/manual workflow")
    if not config.get("environment", "").strip():
        raise ValueError("a nonempty credential environment is required")
    for name in ("max-local-repairs", "max-ci-repairs", "repair-budget-minutes"):
        value = config[name]
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError("invalid integer repair limit")
    if not 1 <= config["repair-budget-minutes"] <= JOB_MINUTES - 30:
        raise ValueError(f"repair budget must be between 1 and {JOB_MINUTES - 30} minutes")
    coordinator = Coordinator(Path(args.source).resolve(), Path(args.shared).resolve(), config,
                              GitHub(os.environ["GITHUB_REPOSITORY"], base))
    try:
        coordinator.execute()
    except BaseException:
        set_output("status", "failed")
        raise


if __name__ == "__main__":
    def interrupt(signum, frame):
        raise KeyboardInterrupt("dependency update cancelled")

    signal.signal(signal.SIGTERM, interrupt)
    main()
