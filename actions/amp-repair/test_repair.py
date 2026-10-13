import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import repair


URL = "https://github.com/example/sdk"
SHA = "1" * 40
IMAGE = "ghcr.io/example/repair@sha256:" + "a" * 64


def manifest(revision=SHA):
    return f'''[package]
name = "example"
version = "0.1.0"
[dependencies]
sdk-node = {{ git = "{URL}", rev = "{revision}" }}
sdk-types = {{ git = "{URL}", rev = "{revision}" }}
'''


def lockfile(revision=SHA):
    return f'''version = 4
[[package]]
name = "sdk-node"
version = "0.1.0"
source = "git+{URL}?rev={revision}#{revision}"
'''


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.baseline = Path(self.directory.name) / "baseline"
        self.baseline.mkdir()
        (self.baseline / "src").mkdir()
        (self.baseline / "src/lib.rs").write_text("pub fn check() {}\n")
        (self.baseline / "Cargo.toml").write_text(manifest("2" * 40))
        (self.baseline / "Cargo.lock").write_text(lockfile("2" * 40))
        self.work = Path(self.directory.name) / "source"
        shutil.copytree(self.baseline, self.work)
        (self.work / "Cargo.toml").write_text(manifest())
        (self.work / "Cargo.lock").write_text(lockfile())
        self.policy = repair.Policy(repair.snapshot(self.baseline),
                                    ["Cargo.toml", "Cargo.lock", "src/**/*.rs"], {URL: SHA})
        self.policy.freeze(self.work)

    def test_valid_update(self):
        self.policy.validate(self.work)

    def test_url_alias_cannot_escape_frozen_identity(self):
        text = manifest().replace(f'git = "{URL}", rev = "{SHA}"',
                                  f'git = "{URL}.git", rev = "' + "3" * 40 + '"', 1)
        (self.work / "Cargo.toml").write_text(text)
        with self.assertRaises(ValueError):
            self.policy.validate(self.work)

    def test_registry_replacement_or_removed_dependency_cannot_escape_identity(self):
        for replacement in ('sdk-node = "0.1"', ''):
            text = manifest().replace(f'sdk-node = {{ git = "{URL}", rev = "{SHA}" }}', replacement)
            (self.work / "Cargo.toml").write_text(text)
            with self.assertRaises(ValueError):
                self.policy.validate(self.work)

    def test_added_override_is_rejected(self):
        (self.work / "Cargo.toml").write_text(manifest() +
                                              f'\n[patch."{URL}"]\nsdk-node = {{ path = "src" }}\n')
        with self.assertRaisesRegex(ValueError, "override"):
            self.policy.validate(self.work)

    def test_development_build_and_target_dependencies_are_frozen(self):
        text = manifest() + f'''[dev-dependencies]
sdk-test = {{ git = "{URL}", rev = "{SHA}" }}
[target.'cfg(unix)'.build-dependencies]
sdk-build = {{ git = "{URL}", rev = "{SHA}" }}
'''
        (self.work / "Cargo.toml").write_text(text)
        self.policy.freeze(self.work)
        (self.work / "Cargo.toml").write_text(text.replace('sdk-build = { git', 'renamed = { git'))
        with self.assertRaises(ValueError):
            self.policy.validate(self.work)

    def test_lockfile_full_commit_must_match(self):
        (self.work / "Cargo.lock").write_text(lockfile("3" * 40))
        with self.assertRaisesRegex(ValueError, "another commit"):
            self.policy.validate(self.work)

    def test_lockfile_must_exist_but_can_be_unresolved_before_build(self):
        (self.work / "Cargo.lock").unlink()
        self.policy.validate(self.work, lockfile=False)
        with self.assertRaisesRegex(ValueError, "missing"):
            self.policy.validate(self.work)

    def test_untracked_and_ignored_configuration_is_rejected(self):
        (self.work / ".github").mkdir()
        (self.work / ".github/workflow.yml").write_text("changed")
        with self.assertRaisesRegex(ValueError, "outside repair scope"):
            self.policy.validate(self.work)

    def test_unstaged_symlink_and_executable_changes_are_rejected(self):
        (self.work / "src/new.rs").symlink_to("/tmp/elsewhere")
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.policy.validate(self.work)
        (self.work / "src/new.rs").unlink()
        (self.work / "src/lib.rs").chmod(0o755)
        with self.assertRaisesRegex(ValueError, "mode"):
            self.policy.validate(self.work)

    def test_source_containing_raw_credentials_is_rejected(self):
        with patch.dict(os.environ, {"AMP_API_KEY": "test-only-secret"}):
            (self.work / "src/lib.rs").write_text('const KEY: &str = "test-only-secret";')
            with self.assertRaisesRegex(ValueError, "credential"):
                self.policy.validate(self.work)

    def test_frozen_gitlink_content_cannot_be_added_or_changed(self):
        self.policy.gitlinks = {"src/native"}
        (self.work / "src/native").mkdir()
        (self.work / "src/native/lib.rs").write_text("changed")
        with self.assertRaisesRegex(ValueError, "frozen gitlinks"):
            self.policy.validate(self.work)

    def test_path_globs_are_anchored_and_do_not_cross_directories(self):
        self.assertTrue(repair.allowed("src/lib.rs", ["src/**/*.rs"]))
        self.assertTrue(repair.allowed("src/deep/mod.rs", ["src/**/*.rs"]))
        self.assertFalse(repair.allowed("src/deep/mod.rs", ["src/*.rs"]))
        self.assertFalse(repair.allowed("scripts/build.rs", ["**/*.rs"]))
        self.assertFalse(repair.allowed(".github/Cargo.toml", ["**/Cargo.toml"]))
        with self.assertRaises(ValueError):
            repair.allowed("src/../scripts/build.rs", ["**/*.rs"])


class ExportTests(unittest.TestCase):
    def test_existing_gitlinks_are_frozen_and_not_executed_or_initialized(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = root / "repo"
            repository.mkdir()
            repair.git(repository, "init")
            (repository / "README.md").write_text("trusted")
            repair.git(repository, "add", ".")
            def commit():
                repair.git(repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                           "commit", "-m", "fixture")
                return repair.git(repository, "rev-parse", "HEAD").stdout.strip()
            target = commit()
            repair.git(repository, "update-index", "--add", "--cacheinfo", f"160000,{target},vendor/native")
            baseline = commit()
            with self.assertRaisesRegex(ValueError, "trusted baseline"):
                repair.export_tree(repository, baseline, root / "unsafe")
            repair.export_tree(repository, baseline, root / "source", gitlink_base=baseline)
            self.assertEqual((root / "source/README.md").read_text(), "trusted")
            self.assertEqual(repair.gitlinks(repository, baseline), {"vendor/native": target})
            repair.git(repository, "update-index", "--cacheinfo", f"160000,{baseline},vendor/native")
            changed = commit()
            with self.assertRaisesRegex(ValueError, "revisions changed"):
                repair.export_tree(repository, changed, root / "changed", gitlink_base=baseline)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "source"
        self.cache = Path(self.directory.name) / "cache"
        self.root.mkdir()
        self.cache.mkdir()
        self.worker = repair.Worker(self.root, IMAGE, time.monotonic() + 60, self.cache)

    def test_worker_has_no_host_namespaces_socket_or_trusted_mounts(self):
        args = self.worker.arguments("test-worker", ["cargo", "check"])
        self.assertIn("--read-only", args)
        self.assertIn("--cap-drop=ALL", args)
        self.assertIn("--security-opt=no-new-privileges:true", args)
        self.assertIn("CARGO_TARGET_DIR=/cache/target", args)
        for forbidden in ("--privileged", "--pid=host", "--network=host", "--env-file",
                          "GH_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "docker.sock", ".git"):
            self.assertFalse(any(forbidden in arg for arg in args), forbidden)
        self.assertNotIn("AMP_API_KEY", args)
        self.assertIn("AMP_API_KEY", self.worker.arguments("test", ["amp"], agent=True))

    def test_mutable_images_are_rejected(self):
        for image in ("ghcr.io/example/repair:latest", "--privileged", "image@sha256:bad"):
            with self.assertRaises(ValueError):
                repair.Worker(self.root, image, time.monotonic() + 60, self.cache)

    def test_poisoned_agent_and_check_state_never_enters_later_checks(self):
        mounts = []
        def fake(args, **kwargs):
            if args[1] == "run":
                mount = next(value for value in args if value.endswith(",dst=/cache"))
                cache = Path(mount.split("src=", 1)[1].split(",dst=", 1)[0])
                mounts.append(cache)
                if "AMP_API_KEY" in args:
                    self.assertEqual(cache, self.cache)
                else:
                    self.assertNotEqual(cache, self.cache)
                    self.assertEqual(list(cache.iterdir()), [])
                (cache / "cargo/bin").mkdir(parents=True, exist_ok=True)
                for tool in ("cargo-clippy", "cargo-fmt", "cargo-nextest"):
                    (cache / "cargo/bin" / tool).write_text("#!/bin/sh\nexit 0\n")
                self.assertIn(f"PATH={repair.TOOL_PATH}", args)
                self.assertIn("RUSTUP_HOME=/usr/local/rustup", args)
            return subprocess.CompletedProcess(args, 0, "", "")
        with patch.dict(os.environ, {"AMP_API_KEY": "test-key"}), \
             patch.object(repair.subprocess, "run", side_effect=fake):
            self.worker.execute(["amp"], agent=True)
            for tool in ("clippy", "fmt", "nextest"):
                self.worker.execute(["cargo", tool])
        self.assertEqual(len(set(mounts)), 4)
        self.assertTrue(all(not path.exists() for path in mounts[1:]))

    def test_client_environment_excludes_runner_credentials(self):
        captured = []
        def fake(args, **kwargs):
            captured.append((args, kwargs["env"]))
            return subprocess.CompletedProcess(args, 0, "", "")
        secrets = {name: "test-secret" for name in ("GH_TOKEN", "GITHUB_TOKEN", "AMP_API_KEY",
                    "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "GITHUB_OUTPUT")}
        with patch.dict(os.environ, secrets), patch.object(repair.subprocess, "run", side_effect=fake):
            self.worker.execute(["cargo", "check"])
            self.worker.execute(["amp"], agent=True)
        self.assertTrue(set(secrets).isdisjoint(captured[0][1]))
        self.assertEqual(captured[2][1]["AMP_API_KEY"], "test-secret")
        self.assertTrue((set(secrets) - {"AMP_API_KEY"}).isdisjoint(captured[2][1]))
        self.assertNotIn("test-secret", " ".join(captured[2][0]))

    def test_timeout_forces_worker_removal(self):
        def fake(args, **kwargs):
            if args[1] == "run":
                raise subprocess.TimeoutExpired(args, 1)
            return subprocess.CompletedProcess(args, 0, "", "")
        with patch.dict(os.environ, {"AMP_API_KEY": "test-key"}), patch.object(repair.subprocess, "run", side_effect=fake) as command:
            with self.assertRaises(subprocess.TimeoutExpired):
                self.worker.execute(["amp"], agent=True)
        self.assertEqual(command.call_args.args[0][1:3], ["rm", "--force"])

    def test_cleanup_failure_prevents_success(self):
        def fake(args, **kwargs):
            return subprocess.CompletedProcess(args, 1 if args[1] == "rm" else 0,
                                               "", "daemon unavailable")
        with patch.object(repair.subprocess, "run", side_effect=fake):
            with self.assertRaisesRegex(RuntimeError, "cleanup"):
                self.worker.execute(["cargo", "check"])

    def test_already_removed_container_is_successful_cleanup(self):
        def fake(args, **kwargs):
            return subprocess.CompletedProcess(args, 1 if args[1] == "rm" else 0,
                                               "", "No such container: already-removed")
        with patch.object(repair.subprocess, "run", side_effect=fake):
            self.assertEqual(self.worker.execute(["cargo", "check"])[0], 0)

    def test_expired_deadline_does_not_start_worker(self):
        self.worker.deadline = time.monotonic() - 1
        with patch.object(repair.subprocess, "run") as command:
            with self.assertRaises(TimeoutError):
                self.worker.execute(["cargo", "check"])
            command.assert_not_called()


class LoopTests(unittest.TestCase):
    def test_empty_checks_cannot_pass_without_verification(self):
        from unittest.mock import Mock
        worker = Mock()
        for commands in ([], ["   "]):
            with self.assertRaisesRegex(ValueError, "empty"):
                repair.checks(worker, commands)
        worker.execute.assert_not_called()

    def test_standalone_rejects_empty_input_before_loading_source(self):
        for commands in ("", " \n\t"):
            with patch("sys.argv", ["repair.py", "--source", "/missing", "--baseline", "/missing",
                                    "--pins", "{}", "--worker-image", IMAGE, "--checks", commands,
                                    "--allowed-paths", "Cargo.toml"]), patch.object(repair, "Worker") as worker:
                with self.assertRaisesRegex(ValueError, "local-checks must not be empty"):
                    repair.main()
                worker.assert_not_called()

    def test_failed_agent_is_followed_by_independent_checks(self):
        from unittest.mock import Mock
        worker, policy = Mock(), Mock()
        worker.execute.side_effect = [(1, "compile error"), (1, "agent error"), (0, "success")]
        error, attempts = repair.repair_local(worker, policy, ["cargo check"], "migrate", 3)
        self.assertIsNone(error)
        self.assertEqual(attempts, 1)
        self.assertEqual(worker.execute.call_count, 3)
        self.assertTrue(worker.execute.call_args_list[1].kwargs["agent"])

    def test_exhaustion_is_bounded(self):
        from unittest.mock import Mock
        worker, policy = Mock(), Mock()
        worker.execute.return_value = (1, "failure")
        error, attempts = repair.repair_local(worker, policy, ["cargo check"], "migrate", 2)
        self.assertIsNotNone(error)
        self.assertEqual(attempts, 2)
        self.assertEqual(worker.execute.call_count, 5)


if __name__ == "__main__":
    unittest.main()
