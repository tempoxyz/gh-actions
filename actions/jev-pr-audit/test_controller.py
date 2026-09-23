import os
import tempfile
import unittest
from unittest.mock import Mock, patch
import main
from test_routing import answer, file


class ClassificationOnlyTests(unittest.TestCase):
    def controller(self):
        controller = object.__new__(main.Controller)
        controller.repo, controller.number = 'tempoxyz/cyclops-canary', 10
        controller.head, controller.base = 'a' * 40, 'b' * 40
        controller.root = 'repos/' + controller.repo
        controller.pull = {'state': 'open', 'draft': False}
        controller.existing = Mock(return_value=(None, None))
        controller.status = Mock()
        controller.current = Mock(return_value=True)
        controller.write_decision = Mock(return_value={'html_url': 'https://github.com/tempoxyz/cyclops-canary/pull/10'})
        return controller

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

    def test_second_pass_resolves_ambiguity_but_preserves_detected_risk(self):
        for risk, expected in ((0, 'standard'), (.8, 'critical')):
            controller = self.controller()
            unit = {'file':'src/helper.py', 'context':{'head':'def helper(): pass'}}
            controller.evidence = Mock(return_value=([file('src/helper.py')], [unit], True))
            controller.expand_context = Mock(return_value=dict(unit, related_context=[{'path':'src/__init__.py'}], context_search={'tree_truncated':False}))
            with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {
                'JEV_CLASSIFICATION_ONLY':'true', 'RUNNER_TEMP':tmp, 'OPENROUTER_API_KEY':'test'
            }), patch.object(main, 'request', side_effect=[answer(context_missing=.3,funds=risk), answer()]) as request, patch.object(main, 'dispatch') as dispatch:
                controller.classify()
            self.assertEqual(request.call_count,2)
            dispatch.assert_not_called()
            self.assertEqual(controller.write_decision.call_args.args[0]['plan']['mode'],expected)

    def test_second_pass_is_not_retried_without_new_evidence(self):
        controller=self.controller()
        controller.evidence=Mock(return_value=([file('src/helper.py')],[{}],True))
        controller.expand_context=Mock(return_value={'related_context':[], 'context_search':{'tree_truncated':False}})
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {
            'JEV_CLASSIFICATION_ONLY':'true','RUNNER_TEMP':tmp,'OPENROUTER_API_KEY':'test'
        }), patch.object(main,'request',return_value=answer(context_missing=.3)) as request:
            controller.classify()
        self.assertEqual(request.call_count,1)
        self.assertEqual(controller.write_decision.call_args.args[0]['plan']['mode'],'deep')

    def test_context_lookup_is_bounded_and_revision_pinned(self):
        controller=self.controller()
        tree={'truncated':False,'tree':[{'type':'blob','path':f'src/near{i}.py','size':10} for i in range(20)]}
        tree['tree'].append({'type':'blob','path':'src/link.py','mode':'120000','size':3})
        content={'encoding':'base64','content':'eD0x','size':3}
        with patch.object(main,'gh',side_effect=lambda path: tree if '/git/trees/' in path else content) as gh:
            result=controller.expand_context({'file':'src/helper.py','context':{'head':'def helper(): pass'}})
        self.assertEqual(len(result['related_context']),4)
        self.assertEqual(gh.call_count,9)
        self.assertTrue(all('ref='+controller.base in c.args[0] or 'ref='+controller.head in c.args[0] for c in gh.call_args_list[1:]))
