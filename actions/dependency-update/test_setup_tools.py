import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import setup_tools


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.env = dict(RUST_TOOLCHAINS="1.99.0\nnightly-2026-08-21", NEXTEST_VERSION="0.9.127",
                        CODEX_VERSION="0.162.0", NATIVE_PACKAGES="clang libssl-dev mold")

    def test_rejects_unpinned_versions_and_package_options(self):
        for key, value in (("RUST_TOOLCHAINS", "stable"), ("RUST_TOOLCHAINS", ""),
                           ("RUST_TOOLCHAINS", "1.99.0 --force"), ("CODEX_VERSION", "latest"),
                           ("CODEX_VERSION", "^1.0.0"), ("NEXTEST_VERSION", "0.9"),
                           ("NATIVE_PACKAGES", "clang --allow-unauthenticated")):
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                setup_tools.configuration(self.env | {key: value})

    def test_installation_exports_tools_and_first_toolchain_without_requiring_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = self.env | dict(RUNNER_TEMP=directory, GITHUB_PATH=str(root / "path"),
                                  GITHUB_ENV=str(root / "env"))
            with patch.dict(os.environ, env, clear=True), patch.object(setup_tools, "command") as command:
                setup_tools.main()
            commands = [call.args[0] for call in command.call_args_list]
            self.assertIn(["rustup", "toolchain", "install", "nightly-2026-08-21", "--profile",
                           "minimal", "--component", "rustfmt", "--component", "clippy"], commands)
            self.assertEqual(commands[-2][-1], "@openai/codex@0.162.0")
            self.assertEqual((root / "env").read_text(), "RUSTUP_TOOLCHAIN=1.99.0\n")
            self.assertEqual((root / "path").read_text(), str(root / "dependency-update-tools/node_modules/.bin") + "\n")

    def test_invalid_configuration_stops_before_any_installer(self):
        with patch.dict(os.environ, self.env | {"CODEX_VERSION": "latest"}, clear=True), \
                patch.object(setup_tools, "command") as command:
            with self.assertRaises(ValueError):
                setup_tools.main()
            command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
