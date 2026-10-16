import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import signal
import sys
import subprocess
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

import repair


URL = "https://github.com/example/sdk"
SHA = "1" * 40


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
        with patch.dict(os.environ, {"CODEX_API_KEY": "test-only-secret"}):
            (self.work / "src/lib.rs").write_text('const KEY: &str = "test-only-secret";')
            with self.assertRaisesRegex(ValueError, "credential"):
                self.policy.validate(self.work)

    def test_frozen_gitlink_content_cannot_be_added_or_changed(self):
        self.policy.gitlinks = {"src/native"}
        (self.work / "src/native").mkdir()
        (self.work / "src/native/lib.rs").write_text("changed")
        with self.assertRaisesRegex(ValueError, "frozen gitlinks"):
            self.policy.validate(self.work)

    def test_new_build_scripts_and_guarded_manifest_settings_are_rejected(self):
        (self.work / "src/build.rs").write_text("fn main() {}\n")
        with self.assertRaisesRegex(ValueError, "new build scripts"):
            self.policy.validate(self.work)
        (self.work / "src/build.rs").unlink()
        for addition in ('\n[lints.rust]\nwarnings = "allow"\n', '\n[profile.dev]\nopt-level = 3\n'):
            (self.work / "Cargo.toml").write_text(manifest() + addition)
            with self.assertRaisesRegex(ValueError, "override"):
                self.policy.validate(self.work)
        (self.work / "Cargo.toml").write_text(manifest().replace('version = "0.1.0"\n', 'version = "0.1.0"\nbuild = "src/lib.rs"\n'))
        with self.assertRaisesRegex(ValueError, "override"):
            self.policy.validate(self.work)

    def test_path_dependencies_cannot_escape_the_export(self):
        for path in ("../outside", "/etc", "src/../../outside"):
            (self.work / "Cargo.toml").write_text(manifest() + f'local = {{ path = "{path}" }}\n')
            with self.assertRaisesRegex(ValueError, "escapes"):
                self.policy.validate(self.work)
        (self.work / "Cargo.toml").write_text(manifest() + 'local = { path = "src/../vendor/local" }\n')
        self.policy.validate(self.work)

    def test_inherited_branch_changes_are_kept_but_not_editable(self):
        (self.work / "deny.toml").write_text("maintainer license exception\n")
        self.policy.inherited = {"deny.toml": repair.snapshot(self.work)["deny.toml"]}
        self.policy.validate(self.work)
        (self.work / "deny.toml").write_text("agent edit\n")
        with self.assertRaisesRegex(ValueError, "outside repair scope: deny.toml"):
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
    def test_complete_export_ignores_archive_attributes_and_preserves_binary_blobs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repair.git(root, "init")
            (root / ".github").mkdir()
            (root / ".github/workflow.yml").write_text("must remain visible\n")
            (root / ".gitattributes").write_text(".github export-ignore\nversion.txt export-subst\n")
            (root / "version.txt").write_text("$Format:%H$\n")
            (root / "binary.dat").write_bytes(bytes(range(256)))
            repair.git(root, "add", ".")
            repair.git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                       "commit", "-m", "attributes")
            repair.export_tree(root, "HEAD", root / "export")
            self.assertEqual((root / "export/.github/workflow.yml").read_text(), "must remain visible\n")
            self.assertEqual((root / "export/version.txt").read_text(), "$Format:%H$\n")
            self.assertEqual((root / "export/binary.dat").read_bytes(), bytes(range(256)))

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
            (repository / "CLAUDE.md").symlink_to("README.md")
            repair.git(repository, "add", "CLAUDE.md")
            baseline = commit()
            with self.assertRaisesRegex(ValueError, "trusted baseline"):
                repair.export_tree(repository, baseline, root / "unsafe")
            repair.export_tree(repository, baseline, root / "source", frozen_base=baseline)
            self.assertEqual((root / "source/README.md").read_text(), "trusted")
            self.assertFalse((root / "source/CLAUDE.md").exists())
            self.assertFalse((root / "source/vendor/native").exists())
            self.assertEqual(set(repair.frozen_links(repository, baseline)), {"vendor/native", "CLAUDE.md"})
            repair.git(repository, "update-index", "--cacheinfo", f"160000,{baseline},vendor/native")
            changed = commit()
            with self.assertRaisesRegex(ValueError, "frozen gitlinks or symlinks changed"):
                repair.export_tree(repository, changed, root / "changed", frozen_base=baseline)
            repair.git(repository, "reset", "-q", "--hard", baseline)
            (repository / "CLAUDE.md").unlink()
            (repository / "CLAUDE.md").symlink_to("/etc/passwd")
            repair.git(repository, "add", "CLAUDE.md")
            retargeted = commit()
            with self.assertRaisesRegex(ValueError, "frozen gitlinks or symlinks changed"):
                repair.export_tree(repository, retargeted, root / "retargeted", frozen_base=baseline)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "source"
        self.cache = Path(self.directory.name) / "cache"
        self.root.mkdir()
        self.cache.mkdir()
        self.worker = repair.Worker(self.root, time.monotonic() + 60, self.cache)

    def test_direct_process_environment_omits_credentials_except_agent_key(self):
        secrets = {name: "test-secret" for name in ("GH_TOKEN", "GITHUB_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY",
                   "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "GITHUB_OUTPUT",
                   "CARGO_REGISTRY_TOKEN", "LD_PRELOAD")}
        script = "import json,os; print(json.dumps(dict(os.environ)))"
        with patch.dict(os.environ, secrets):
            status, output = self.worker.execute([sys.executable, "-c", script])
            self.assertEqual(status, 0)
            check = json.loads(output)
            self.assertTrue(set(secrets).isdisjoint(check))
            self.assertEqual(check["CARGO_NET_OFFLINE"], "true")
            status, output = self.worker.execute([sys.executable, "-c", script], agent=True)
            agent = json.loads(output)
            self.assertEqual(status, 0)
            self.assertEqual(agent["CODEX_API_KEY"], "test-secret")
            self.assertTrue((set(secrets) - {"CODEX_API_KEY"}).isdisjoint(agent))
            self.assertNotIn("CARGO_NET_OFFLINE", agent)
            self.assertEqual(agent["CODEX_HOME"], str(self.cache / "codex"))
            self.assertFalse(Path(agent["CODEX_HOME"]).is_relative_to(self.root))

    def test_missing_codex_key_fails_only_when_a_repair_is_needed(self):
        with patch.dict(os.environ, {"CODEX_API_KEY": " "}):
            self.worker.environment(self.cache)
            with self.assertRaisesRegex(ValueError, "CODEX_API_KEY is required"):
                self.worker.environment(self.cache, agent=True)

    def test_codex_repairs_export_and_reports_valid_thread_ids(self):
        worker = Mock()
        worker.execute.return_value = (1, '\n'.join([
            'not json', '[]',
            '{"type":"thread.started","thread_id":null}',
            '{"type":"thread.started","thread_id":"thread-123"}',
            '{"type":"thread.started","thread_id":"thread-123"}',
            '{"type":"thread.started","thread_id":"bad\\n::error::injected"}',
            '{"type":"turn.completed","thread_id":"ignored"}',
        ]))
        with patch.dict(os.environ, {"CODEX_MODEL": "test-model", "CODEX_EFFORT": "high"}), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            repair.repair(worker, "compile failure", "- Preserve monitor invariants.")
        args = worker.execute.call_args.args[0]
        self.assertEqual(args[:4], ["codex", "--ask-for-approval", "never", "exec"])
        self.assertIn("--skip-git-repo-check", args)
        self.assertIn("--ephemeral", args)
        self.assertIn("--ignore-user-config", args)
        self.assertEqual(args[args.index("--model") + 1], "test-model")
        self.assertIn('model_reasoning_effort="high"', args)
        self.assertIn('shell_environment_policy.exclude=["CODEX_API_KEY"]', args)
        self.assertEqual(args[-2], "--")
        self.assertTrue(args[-1].startswith("- Preserve monitor invariants."))
        self.assertIn("compile failure", args[-1])
        self.assertIn("Do not weaken invariants", args[-1])
        self.assertEqual(worker.execute.call_args.kwargs, {"agent": True})
        self.assertEqual(output.getvalue(), "Codex thread ID: thread-123\n"
                         "::warning::Codex exited with status 1; validating the resulting source tree.\n")

    def test_checks_use_fresh_state_and_never_agent_installed_subcommands(self):
        self.worker.seed.mkdir()
        (self.worker.seed / "download").write_text("downloaded crate")
        script = ("import os,pathlib; p=pathlib.Path(os.environ['CARGO_HOME']); "
                  "assert (p/'download').read_text()=='downloaded crate'; "
                  "assert not (p/'bin').exists(); (p/'bin').mkdir(); "
                  "print(str(p))")
        (self.cache / "cargo/bin").mkdir(parents=True)
        (self.cache / "cargo/bin/cargo-nextest").write_text("poisoned command")
        caches = []
        for _ in range(2):
            status, output = self.worker.execute([sys.executable, "-c", script])
            self.assertEqual(status, 0, output)
            caches.append(output.strip())
        self.assertNotEqual(*caches)
        self.assertTrue(all(not Path(cache).exists() for cache in caches))
        self.assertFalse((self.worker.seed / "bin").exists())
        self.assertNotIn(str(self.cache), self.worker.path)

    def test_fetch_replaces_download_seed_and_uses_online_scrubbed_process(self):
        self.worker.seed.mkdir()
        (self.worker.seed / "poisoned").touch()
        def execute(args, **kwargs):
            self.assertEqual(args, ["cargo", "fetch", "--locked"])
            self.assertEqual(kwargs, {"fetch": True})
            self.assertFalse(self.worker.seed.exists())
            return 101, "blocked by package firewall"
        with patch.object(self.worker, "execute", side_effect=execute):
            self.assertEqual(self.worker.fetch_dependencies(), (101, "blocked by package firewall"))

    def test_lockfile_resolution_uses_a_copy_and_imports_only_the_lockfile(self):
        (self.root / "Cargo.lock").write_text("original lockfile")
        def resolve(worker, args, **kwargs):
            self.assertNotEqual(worker.root, self.root)
            self.assertTrue(kwargs["lockfile"])
            (worker.root / "Cargo.lock").write_text("resolved lockfile")
            return 0, ""
        with patch.object(repair.Worker, "execute", autospec=True, side_effect=resolve):
            self.worker.resolve_lockfile()
        self.assertEqual((self.root / "Cargo.lock").read_text(), "resolved lockfile")

    def test_lockfile_resolution_cannot_copy_other_source_changes(self):
        (self.root / "Cargo.lock").write_text("original lockfile")
        (self.root / "lib.rs").write_text("original source")
        def resolve(worker, args, **kwargs):
            (worker.root / "lib.rs").write_text("invalid Rust")
            return 0, ""
        with patch.object(repair.Worker, "execute", autospec=True, side_effect=resolve):
            with self.assertRaisesRegex(ValueError, "outside Cargo.lock"):
                self.worker.resolve_lockfile()
        self.assertEqual((self.root / "lib.rs").read_text(), "original source")
        self.assertEqual((self.root / "Cargo.lock").read_text(), "original lockfile")

    def test_timeout_kills_command_and_its_background_child(self):
        marker = Path(self.directory.name) / "leaked-child"
        self.worker.deadline = time.monotonic() + 0.2
        with self.assertRaises(subprocess.TimeoutExpired):
            self.worker.execute(["/bin/sh", "-c", f"(sleep 0.5; touch {marker}) & wait"])
        time.sleep(0.6)
        self.assertFalse(marker.exists())

    def test_successful_command_cannot_leave_background_children(self):
        marker = Path(self.directory.name) / "leaked-child"
        self.assertEqual(self.worker.execute(["/bin/sh", "-c", f"(sleep 0.3; touch {marker}) &"])[0], 0)
        time.sleep(0.4)
        self.assertFalse(marker.exists())

    def test_cancellation_kills_process_group(self):
        from unittest.mock import Mock
        process = Mock(pid=12345)
        process.wait.side_effect = [KeyboardInterrupt(), 0]
        with patch.object(repair.subprocess, "Popen", return_value=process), \
                patch.object(repair.os, "killpg") as kill:
            with self.assertRaises(KeyboardInterrupt):
                self.worker.execute(["/bin/sh", "-c", "sleep 60"])
        kill.assert_called_once_with(12345, signal.SIGKILL)

    def test_cleanup_failure_prevents_success(self):
        from unittest.mock import Mock
        process = Mock(pid=12345)
        with patch.object(repair.subprocess, "Popen", return_value=process), \
                patch.object(repair.os, "killpg", side_effect=PermissionError("cannot stop children")):
            with self.assertRaises(PermissionError):
                self.worker.execute(["/bin/sh", "-c", "true"])

    def test_expired_deadline_does_not_start_process(self):
        self.worker.deadline = time.monotonic() - 1
        with patch.object(repair.subprocess, "Popen") as command:
            with self.assertRaises(TimeoutError):
                self.worker.execute(["cargo", "check"])
            command.assert_not_called()


class LoopTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def test_empty_checks_cannot_pass_without_verification(self):
        from unittest.mock import Mock
        worker = Mock(root=self.root)
        for commands in ([], ["   "]):
            with self.assertRaisesRegex(ValueError, "empty"):
                repair.checks(worker, commands)
        worker.execute.assert_not_called()

    def test_passing_command_that_mutates_source_cannot_pass_verification(self):
        from unittest.mock import Mock
        (self.root / "lib.rs").write_text("pub fn valid() {}\n")
        worker = Mock(root=self.root)
        worker.fetch_dependencies.return_value = (0, "")
        def mutate(args):
            (self.root / "lib.rs").write_text("invalid Rust")
            return 0, "test passed"
        worker.execute.side_effect = mutate
        with self.assertRaisesRegex(ValueError, "changed candidate source"):
            repair.repair_local(worker, Mock(), ["cargo test --lib", "cargo check"], "migrate", 0)
        self.assertEqual(worker.execute.call_count, 1)

    def test_standalone_rejects_empty_input_before_loading_source(self):
        for commands in ("", " \n\t"):
            with patch("sys.argv", ["repair.py", "--source", "/missing", "--baseline", "/missing",
                                    "--pins", "{}", "--checks", commands,
                                    "--allowed-paths", "Cargo.toml"]), patch.object(repair, "Worker") as worker:
                with self.assertRaisesRegex(ValueError, "local-checks must not be empty"):
                    repair.main()
                worker.assert_not_called()

    def test_failed_agent_is_followed_by_independent_checks(self):
        from unittest.mock import Mock
        worker, policy = Mock(root=self.root), Mock()
        worker.fetch_dependencies.return_value = (0, "")
        worker.execute.side_effect = [(1, "compile error"), (1, "agent error"), (0, "success")]
        error, attempts = repair.repair_local(worker, policy, ["cargo check"], "migrate", 3)
        self.assertIsNone(error)
        self.assertEqual(attempts, 1)
        self.assertEqual(worker.execute.call_count, 3)
        self.assertTrue(worker.execute.call_args_list[1].kwargs["agent"])

    def test_exhaustion_is_bounded(self):
        from unittest.mock import Mock
        worker, policy = Mock(root=self.root), Mock()
        worker.fetch_dependencies.return_value = (0, "")
        worker.execute.return_value = (1, "failure")
        error, attempts = repair.repair_local(worker, policy, ["cargo check"], "migrate", 2)
        self.assertIsNotNone(error)
        self.assertEqual(attempts, 2)
        self.assertEqual(worker.execute.call_count, 5)


if __name__ == "__main__":
    unittest.main()
