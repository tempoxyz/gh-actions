import unittest
from unittest.mock import patch
import detect


class DetectionTests(unittest.TestCase):
    def test_manifest_revision_and_alias(self):
        before = '[workspace.dependencies]\nengine = {package="reth-provider", git="https://github.com/paradigmxyz/reth", rev="aaa"}'
        self.assertNotEqual(detect.dependencies(before, "reth"), detect.dependencies(before.replace('aaa', 'bbb'), "reth"))
        self.assertEqual(detect.dependencies(before, "reth"), detect.dependencies(before + '\nserde="2"', "reth"))

    def test_features_and_comments_are_not_bumps(self):
        before = '[dependencies]\nreth = {version="1", features=["a"]}'
        self.assertEqual(detect.dependencies(before, "reth"), detect.dependencies(before.replace('"a"', '"b"') + '\n# comment', "reth"))

    def test_target_and_patch_dependencies(self):
        for table in ['target.\'cfg(unix)\'.dependencies', 'patch.crates-io']:
            text = f'[{table}]\nreth-db = {{version="1"}}'
            self.assertNotEqual(detect.dependencies(text, "reth"), detect.dependencies(text.replace('"1"', '"2"'), "reth"))

    def test_lock_revision_and_unrelated_changes(self):
        text = '[[package]]\nname="reth-db"\nversion="1"\nsource="git+https://example.com#aaa"\n[[package]]\nname="serde"\nversion="1"'
        self.assertNotEqual(detect.dependencies(text, "reth", True), detect.dependencies(text.replace('#aaa', '#bbb'), "reth", True))
        self.assertEqual(detect.dependencies(text, "reth", True), detect.dependencies(text.replace('name="serde"\nversion="1"', 'name="serde"\nversion="2"'), "reth", True))

    def test_malformed_toml_fails(self):
        with self.assertRaises(Exception):
            detect.dependencies('[invalid', 'reth')

    def test_truncated_comparison_runs(self):
        with patch.object(detect, 'api', return_value={'files': [{}] * 300}):
            self.assertTrue(detect.detect('tempoxyz/tempo', 'a'*40, 'b'*40, 'reth'))

    def test_full_pr_diff_uses_merge_base_and_removed_files(self):
        import base64
        requests = []
        def api(path):
            requests.append(path)
            if '/compare/' in path:
                return {'files': [{'filename':'nested/Cargo.toml', 'status':'removed'}], 'merge_base_commit': {'sha':'c'*40}}
            return {'encoding':'base64', 'content':base64.b64encode(b'[dependencies]\nreth="1"').decode()}
        with patch.object(detect, 'api', side_effect=api):
            self.assertTrue(detect.detect('tempoxyz/tempo', 'a'*40, 'b'*40, 'reth'))
        self.assertTrue(requests[1].endswith('ref=' + 'c'*40))

    def test_api_failure_is_not_a_skip(self):
        with patch.object(detect, 'api', side_effect=RuntimeError('API down')):
            with self.assertRaises(RuntimeError):
                detect.detect('tempoxyz/tempo', 'a'*40, 'b'*40, 'reth')


if __name__ == '__main__':
    unittest.main()
