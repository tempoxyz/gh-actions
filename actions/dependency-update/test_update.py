import contextlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import update
from repair import Policy, export_tree, git, snapshot


URL = "https://github.com/example/sdk"
SHA = "1" * 40


class CiTests(unittest.TestCase):
    def workflow(self, **changes):
        return dict(id=1, run_attempt=1, path=".github/workflows/ci.yml", event="pull_request",
                    head_sha=SHA, status="completed", conclusion="success") | changes

    def test_empty_stale_and_push_runs_do_not_pass(self):
        required = [".github/workflows/ci.yml"]
        for runs in ([], [self.workflow(head_sha="2" * 40)], [self.workflow(event="push")]):
            self.assertEqual(update.workflow_state(runs, SHA, required), (False, []))

    def test_every_configured_workflow_must_finish_successfully(self):
        required = [".github/workflows/ci.yml", ".github/workflows/rules.yml"]
        first = self.workflow()
        second = self.workflow(id=2, path=required[1], status="in_progress", conclusion=None)
        self.assertFalse(update.workflow_state([first, second], SHA, required)[0])
        second.update(status="completed", conclusion="success")
        self.assertTrue(update.workflow_state([first, second], SHA, required)[0])

    def test_latest_attempt_overrides_older_success(self):
        old = self.workflow()
        new = self.workflow(run_attempt=2, conclusion="failure")
        self.assertEqual(update.workflow_state([old, new], SHA, [old["path"]]), (False, [new]))

    def test_newer_run_overrides_previous_attempt(self):
        old = self.workflow(run_attempt=8, conclusion="failure")
        new = self.workflow(id=2)
        self.assertEqual(update.workflow_state([new, old], SHA, [new["path"]]), (True, []))

    def test_no_configured_gate_is_rejected(self):
        with self.assertRaises(ValueError):
            update.workflow_state([], SHA, [])


class StsTests(unittest.TestCase):
    def test_exchange_is_just_in_time_and_cleanup_runs_on_publish_failure(self):
        calls = []
        def fake(args, **kwargs):
            calls.append((args, kwargs["env"]))
            if args[-1].endswith("main.js"):
                env = kwargs["env"]
                self.assertEqual(env["INPUT_TTL"], "15m")
                self.assertEqual(env["INPUT_SCOPE"], "example/service")
                self.assertEqual(Path(env["GITHUB_OUTPUT"]).parent.stat().st_mode & 0o777, 0o700)
                Path(env["GITHUB_OUTPUT"]).write_text("token=dummy-token\nexpires-at=future\n")
            return subprocess.CompletedProcess(args, 0)
        sts = update.Sts(Path("/trusted/github-sts"), "dep-update", "example/service")
        with patch.object(update.subprocess, "run", side_effect=fake):
            self.assertEqual(calls, [])
            with self.assertRaises(RuntimeError):
                with sts.publishing_token() as token:
                    self.assertEqual(token, "dummy-token")
                    raise RuntimeError("publish failed")
        self.assertEqual(len(calls), 2)
        self.assertTrue(calls[-1][0][-1].endswith("post.js"))
        self.assertEqual(calls[-1][1]["STATE_token"], "dummy-token")

    def test_failed_exchange_cannot_yield_a_token(self):
        sts = update.Sts(Path("/trusted/github-sts"), "dep-update", "example/service")
        with patch.object(update.subprocess, "run", side_effect=subprocess.CalledProcessError(1, ["node"])):
            with self.assertRaises(subprocess.CalledProcessError):
                with sts.publishing_token():
                    self.fail("must not publish after failed exchange")

    def test_token_is_revoked_when_exchange_fails_after_minting(self):
        calls = []
        def fake(args, **kwargs):
            calls.append(args)
            if args[-1].endswith("main.js"):
                Path(kwargs["env"]["GITHUB_OUTPUT"]).write_text("token=dummy-token\n")
                raise subprocess.CalledProcessError(1, args)
            self.assertEqual(kwargs["env"]["STATE_token"], "dummy-token")
        sts = update.Sts(Path("/trusted/github-sts"), "dep-update", "example/service")
        with patch.object(update.subprocess, "run", side_effect=fake):
            with self.assertRaises(subprocess.CalledProcessError):
                with sts.publishing_token():
                    self.fail("failed exchange must stop publication")
        self.assertTrue(calls[-1][-1].endswith("post.js"))


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.repository = self.root / "repository"
        self.repository.mkdir()
        git(self.repository, "init", "-b", "main")
        (self.repository / "src").mkdir()
        (self.repository / ".github/workflows").mkdir(parents=True)
        (self.repository / ".github/workflows/ci.yml").write_text("original workflow\n")
        (self.repository / "Cargo.toml").write_text(f'[dependencies]\nsdk-node={{git="{URL}",rev="{SHA}"}}\n')
        (self.repository / "Cargo.lock").write_text(f'version=4\n[[package]]\nname="sdk-node"\nversion="0.1.0"\nsource="git+{URL}?rev={SHA}#{SHA}"\n')
        (self.repository / "src/lib.rs").write_text("pub fn original() {}\n")
        git(self.repository, "add", ".")
        git(self.repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
            "commit", "-m", "baseline")
        self.base = git(self.repository, "rev-parse", "HEAD").stdout.strip()
        self.remote = self.root / "remote.git"
        git(self.root, "clone", "--bare", str(self.repository), str(self.remote))
        git(self.repository, "remote", "add", "origin", str(self.remote))
        git(self.repository, "push", "origin", "HEAD:refs/heads/bot/sdk")
        baseline, self.work = self.root / "baseline", self.root / "source"
        baseline.mkdir()
        self.work.mkdir()
        export_tree(self.repository, "HEAD", baseline)
        export_tree(self.repository, "HEAD", self.work)
        self.policy = Policy(snapshot(baseline), ["Cargo.toml", "Cargo.lock", "src/**/*.rs"], {URL: SHA})
        self.policy.freeze(self.work)
        (self.work / "src/lib.rs").write_text("pub fn migrated() {}\n")
        self.github = Mock(repository="example/service")
        self.github.api.return_value = {"object": {"sha": self.base}}
        self.config = {"sts-policy": "dep-update", "repair-budget-minutes": 10,
                       "local-checks": "cargo check", "required-workflows": ".github/workflows/ci.yml"}
        self.coordinator = update.Coordinator(self.repository, self.root, self.config, self.github)
        self.tokens = []
        @contextlib.contextmanager
        def token():
            self.tokens.append("mint")
            try:
                yield "dummy-token"
            finally:
                self.tokens.append("revoke")
        self.coordinator.sts = Mock()
        self.coordinator.sts.publishing_token = token
        self.plan = dict(schema_version=1, branch="bot/sdk", title="deps: migrate SDK", update_id=SHA,
                         closed_pr_policy="skip", pins={URL: SHA})
        self.existing = {"number": 1, "url": "https://github.com/example/service/pull/1"}

    def test_staged_workflow_cannot_enter_published_candidate(self):
        workflow = self.repository / ".github/workflows/ci.yml"
        workflow.write_text("forbidden staged workflow\n")
        git(self.repository, "add", str(workflow))
        workflow.write_text("original workflow\n")
        self.coordinator.publish(self.repository, self.work, self.policy, self.plan, self.existing,
                                 self.base, self.base, self.root)
        self.assertEqual(git(self.remote, "show", "bot/sdk:.github/workflows/ci.yml").stdout, "original workflow\n")
        self.assertIn("migrated", git(self.remote, "show", "bot/sdk:src/lib.rs").stdout)
        self.assertEqual(self.tokens, ["mint", "revoke"])

    def test_explicit_lease_prevents_overwrite_and_revokes_token(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.coordinator.publish(self.repository, self.work, self.policy, self.plan, self.existing,
                                     "f" * 40, self.base, self.root)
        self.assertEqual(git(self.remote, "rev-parse", "bot/sdk").stdout.strip(), self.base)
        self.assertEqual(self.tokens, ["mint", "revoke"])
        self.github.command.assert_not_called()

    def test_advanced_main_stops_before_token_mint(self):
        self.github.api.return_value = {"object": {"sha": "f" * 40}}
        with self.assertRaisesRegex(RuntimeError, "main advanced"):
            self.coordinator.publish(self.repository, self.work, self.policy, self.plan, self.existing,
                                     self.base, self.base, self.root)
        self.assertEqual(self.tokens, [])

    def test_unsafe_source_stops_before_token_mint(self):
        (self.work / ".github/workflows/ci.yml").write_text("forbidden\n")
        with self.assertRaises(ValueError):
            self.coordinator.publish(self.repository, self.work, self.policy, self.plan, self.existing,
                                     self.base, self.base, self.root)
        self.assertEqual(self.tokens, [])

    def test_complete_local_and_ci_repair_flow(self):
        # Real adapter subprocess, Git commits, strict pushes and candidate validation;
        # only Docker/GitHub/STS are replaced with synthetic services.
        scripts = self.repository / "scripts"
        scripts.mkdir()
        adapter = scripts / "prepare.py"
        adapter.write_text('import json,os,sys\nassert "AMP_API_KEY" not in os.environ\n'
                           'assert "ACTIONS_ID_TOKEN_REQUEST_TOKEN" not in os.environ\n'
                           'if sys.argv[1] == "resolve": print(' + repr(json.dumps(self.plan)) + ')\n')
        git(self.repository, "add", "scripts")
        git(self.repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
            "commit", "-m", "trusted adapter")
        self.base = git(self.repository, "rev-parse", "HEAD").stdout.strip()
        git(self.repository, "push", "origin", "main", "HEAD:refs/heads/bot/sdk")
        config = self.config | {"adapter-script": "scripts/prepare.py", "allowed-paths": "Cargo.toml\nCargo.lock\nsrc/**/*.rs",
                                "worker-image": "ghcr.io/example/repair@sha256:" + "a" * 64,
                                "max-local-repairs": 3, "max-ci-repairs": 3, "repair-instructions": "migrate"}
        self.github.pulls.return_value = [self.existing | {"state": "OPEN", "headRefOid": self.base}]
        self.github.api.side_effect = lambda path: {"object": {"sha": self.base}}
        self.github.require_head.side_effect = lambda number, head: self.assertEqual(
            git(self.remote, "rev-parse", "bot/sdk").stdout.strip(), head)
        polls = []
        def runs(head):
            polls.append(head)
            return [dict(id=len(polls), run_attempt=1, path=".github/workflows/ci.yml", event="pull_request",
                         head_sha=head, status="completed", conclusion="failure" if len(polls) == 1 else "success")]
        self.github.runs.side_effect = runs
        self.github.failed_logs.return_value = "CI compatibility failure"
        owner = self
        class FakeWorker:
            def __init__(self, root, *args, **kwargs):
                self.root, self.agents = root, 0
            def resolve_lockfile(self):
                return 0, ""
            def execute(self, args, agent=False):
                owner.assertFalse(owner.tokens and owner.tokens[-1] == "mint")
                if agent:
                    self.agents += 1
                    (self.root / "src/lib.rs").write_text(f"pub fn migration_{self.agents}() {{}}\n")
                    return 0, ""
                if args[:2] == ["cargo", "check"] and self.agents == 0:
                    return 1, "local compatibility failure"
                return 0, ""
        original_git = update.git
        def local_git(root, *args, **kwargs):
            if args[:3] == ("remote", "set-url", "origin"):
                args = ("remote", "set-url", "origin", str(self.remote))
            return original_git(root, *args, **kwargs)
        coordinator = update.Coordinator(self.repository, self.root, config, self.github)
        coordinator.sts = self.coordinator.sts
        with patch.object(update, "git", side_effect=local_git), patch.object(update, "Worker", FakeWorker), \
             patch.dict(os.environ, {"GH_TOKEN": "dummy-read-token", "AMP_API_KEY": "dummy-amp-key"}):
            coordinator.execute()
        self.assertEqual(len(polls), 2)
        self.assertNotEqual(polls[0], polls[1])
        self.assertIn("migration_2", git(self.remote, "show", "bot/sdk:src/lib.rs").stdout)
        self.assertEqual(self.tokens, ["mint", "revoke", "mint", "revoke"])

    def test_resume_inherits_main_readme_change_without_scope_failure(self):
        git(self.repository, "config", "user.name", "Test")
        git(self.repository, "config", "user.email", "test@example.invalid")
        git(self.repository, "checkout", "-b", "update-branch")
        (self.repository / "src/lib.rs").write_text("pub fn migrated() {}\n")
        git(self.repository, "add", ".")
        git(self.repository, "commit", "-m", "migration")
        git(self.repository, "checkout", "main")
        (self.repository / "README.md").write_text("ordinary main change\n")
        git(self.repository, "add", ".")
        git(self.repository, "commit", "-m", "docs")
        current = git(self.repository, "rev-parse", "HEAD").stdout.strip()
        git(self.repository, "checkout", "update-branch")
        self.coordinator.rebase_existing(self.repository, current, self.policy)
        baseline, candidate = self.root / "current-main", self.root / "rebased"
        export_tree(self.repository, current, baseline)
        export_tree(self.repository, "HEAD", candidate)
        policy = Policy(snapshot(baseline), self.policy.patterns, {URL: SHA})
        policy.freeze(candidate)
        policy.validate(candidate)
        self.assertEqual((candidate / "README.md").read_text(), "ordinary main change\n")
        self.assertIn("migrated", (candidate / "src/lib.rs").read_text())

    def test_resume_still_rejects_forbidden_pr_changes_before_rebase(self):
        (self.repository / ".github/workflows/ci.yml").write_text("forbidden PR change\n")
        git(self.repository, "add", ".")
        git(self.repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
            "commit", "-m", "forbidden")
        head = git(self.repository, "rev-parse", "HEAD").stdout.strip()
        with self.assertRaisesRegex(ValueError, "outside repair scope"):
            self.coordinator.rebase_existing(self.repository, self.base, self.policy)
        self.assertEqual(git(self.repository, "rev-parse", "HEAD").stdout.strip(), head)

    def add_archive_ignore(self):
        (self.repository / ".gitattributes").write_text(".github export-ignore\n")
        git(self.repository, "add", ".gitattributes")
        git(self.repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
            "commit", "-m", "trusted archive attributes")
        self.base = git(self.repository, "rev-parse", "HEAD").stdout.strip()
        baseline = self.root / "complete-baseline"
        export_tree(self.repository, "HEAD", baseline)
        (self.work / ".gitattributes").write_text(".github export-ignore\n")
        self.policy.baseline = snapshot(baseline)
        self.github.api.return_value = {"object": {"sha": self.base}}

    def test_archive_ignore_cannot_hide_forbidden_resume_changes(self):
        self.add_archive_ignore()
        (self.repository / ".github/workflows/ci.yml").write_text("forbidden\n")
        git(self.repository, "add", ".")
        git(self.repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
            "commit", "-m", "hidden workflow change")
        with self.assertRaisesRegex(ValueError, "outside repair scope"):
            self.coordinator.rebase_existing(self.repository, self.base, self.policy)

    def test_archive_ignore_cannot_hide_forbidden_final_commit_tree(self):
        self.add_archive_ignore()
        original_git = update.git
        def inject_commit(root, *args, **kwargs):
            result = original_git(root, *args, **kwargs)
            if "commit" in args:
                (root / ".github/workflows/ci.yml").write_text("forbidden committed workflow\n")
                git(root, "add", ".github/workflows/ci.yml")
                git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                    "commit", "-m", "injected forbidden tree")
            return result
        with patch.object(update, "git", side_effect=inject_commit):
            with self.assertRaisesRegex(ValueError, "outside repair scope"):
                self.coordinator.publish(self.repository, self.work, self.policy, self.plan,
                                         self.existing, self.base, self.base, self.root)
        self.assertEqual(self.tokens, [])

    def test_git_attributes_cannot_publish_source_different_from_verified_candidate(self):
        (self.repository / ".gitattributes").write_text("*.rs text eol=lf\n")
        git(self.repository, "add", ".gitattributes")
        git(self.repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
            "commit", "-m", "trusted line-ending attributes")
        self.base = git(self.repository, "rev-parse", "HEAD").stdout.strip()
        baseline = self.root / "normalization-baseline"
        export_tree(self.repository, "HEAD", baseline)
        self.policy.baseline = snapshot(baseline)
        (self.work / ".gitattributes").write_text("*.rs text eol=lf\n")
        (self.work / "src/lib.rs").write_bytes(b"pub fn migrated() {}\r\n")
        with self.assertRaisesRegex(ValueError, "differs from verified candidate"):
            self.coordinator.publish(self.repository, self.work, self.policy, self.plan,
                                     self.existing, self.base, self.base, self.root)
        self.assertEqual(self.tokens, [])


class PlanTests(unittest.TestCase):
    def test_pr_event_is_rejected_before_coordinator_or_credentials(self):
        with patch.object(update.sys, "argv", ["update.py", "--source", "/source", "--shared", "/shared"]), \
             patch.dict(os.environ, {"GITHUB_REF": "refs/pull/1/merge", "GITHUB_EVENT_NAME": "pull_request"}), \
             patch.object(update, "Coordinator") as coordinator:
            with self.assertRaisesRegex(ValueError, "main schedule/manual"):
                update.main()
            coordinator.assert_not_called()

    def test_skip_and_unsafe_branch(self):
        update.validate_plan({"schema_version": 1, "skip": True})
        for branch in ("main", "../main", "bot//sdk", "refs/heads/test.lock", "--all"):
            with self.assertRaises(ValueError):
                update.validate_plan(dict(schema_version=1, branch=branch, title="update", update_id=SHA,
                                          pins={URL: SHA}, closed_pr_policy="skip"))


if __name__ == "__main__":
    unittest.main()
