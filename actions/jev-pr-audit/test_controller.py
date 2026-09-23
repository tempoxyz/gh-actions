import os
import tempfile
import unittest
from unittest.mock import Mock, patch
import main


class ClassificationOnlyTests(unittest.TestCase):
    def test_audit_decision_never_dispatches_in_classification_only_mode(self):
        controller = object.__new__(main.Controller)
        controller.repo, controller.number = 'tempoxyz/cyclops-canary', 10
        controller.head, controller.base = 'a' * 40, 'b' * 40
        controller.pull = {'state': 'open', 'draft': False}
        controller.existing = Mock(return_value=(None, None))
        controller.status = Mock()
        controller.evidence = Mock(return_value=([{'filename': 'tests/test.py'}], [], False))
        controller.current = Mock(return_value=True)
        controller.write_decision = Mock(return_value={'html_url': 'https://github.com/tempoxyz/cyclops-canary/pull/10'})
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {
            'JEV_CLASSIFICATION_ONLY': 'true', 'RUNNER_TEMP': tmp, 'OPENROUTER_API_KEY': ''
        }), patch.object(main, 'dispatch') as dispatch:
            controller.classify()
        dispatch.assert_not_called()
        decision = controller.write_decision.call_args.args[0]
        self.assertEqual(decision['phase'], 'classified')
        self.assertEqual(decision['plan']['mode'], 'deep')
        self.assertEqual(controller.status.call_args.args[0], 'pending')

    def test_dispatch_enabled_does_not_reuse_classification_only_identity(self):
        with patch.dict(os.environ, {'JEV_CLASSIFICATION_ONLY': 'true'}):
            classification_hash = main.controller_hash()
        with patch.dict(os.environ, {'JEV_CLASSIFICATION_ONLY': 'false'}):
            self.assertNotEqual(classification_hash, main.controller_hash())
