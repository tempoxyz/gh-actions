import copy
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import main
from routing import DOMAINS, KINDS, SCOPES, route, validate_response, receipt_valid

POLICY = json.loads(Path(__file__).with_name('policy.json').read_text())
def answer(kind='implementation', **values):
    a = {k: {'type':'noul', 'noul': values.get(k, 0)} for k in DOMAINS}
    a['change_kind'] = {'type':'choice','choice':kind,'confidence':1,'probabilities':{k: int(k == kind) for k in KINDS}}
    a['scope'] = {'type':'choice','choice':'local','confidence':1,'probabilities':{k: int(k == 'local') for k in SCOPES}}
    return {'model':'typesafe/jev-1.13-20260917','answers':a}
def file(path='README.md', patch='@@ -1 +1 @@\n-old spelling\n+new spelling', **extra):
    return dict(filename=path, patch=patch, status='modified', **extra)

class RoutingTests(unittest.TestCase):
    def route(self, f, a, complete=True):
        return route(f, a, complete, POLICY)
    def test_editorial_skip_requires_jev(self):
        self.assertEqual(self.route([file()], [answer('editorial')])['mode'], 'skip')
        self.assertEqual(self.route([file()], [])['mode'], 'deep')
    def test_missing_patch_never_skip(self):
        self.assertNotEqual(self.route([file(patch='')], [answer('editorial')])['mode'], 'skip')
    def test_runtime_not_skipped_by_editorial_claim(self):
        self.assertEqual(self.route([file('crates/faucet/src/lib.rs')], [answer('editorial')])['mode'], 'standard')
    def test_normative_tip_not_docs_skip(self):
        self.assertEqual(self.route([file('tips/tip-1095.md')], [answer('editorial')])['mode'], 'deep')
    def test_auth_change_is_critical(self):
        p = self.route([file('crates/primitives/src/signature.rs')], [answer(authorization=.2)])
        self.assertEqual((p['mode'],len(p['profile']['workers']),p['profile']['iterations']), ('critical',3,3))
    def test_mixed_pr_keeps_maximum(self):
        self.assertEqual(self.route([file(),file('crates/evm/src/lib.rs')], [answer('editorial'),answer(funds=.8)])['mode'], 'critical')
    def test_renamed_critical_source_still_protected(self):
        self.assertEqual(self.route([file(previous_filename='crates/revm/src/lib.rs')], [answer('editorial')])['mode'], 'deep')
    def test_tests_medium_quick(self):
        p=self.route([file('crates/foo/tests/isolated.rs')], [answer('tests')])
        self.assertEqual(p['mode'],'quick')
        self.assertEqual(p['profile']['workers'][0]['thinking'],'medium')
    def test_weakened_tests_escalate(self):
        self.assertEqual(self.route([file('crates/foo/tests/test.rs')], [answer('tests', reduced_coverage=.3)])['mode'],'deep')
    def test_perf_sets_four_passes_and_minimum_deep(self):
        p=self.route([file('crates/node/src/rpc.rs')], [answer(performance_critical=.8)])
        self.assertEqual((p['mode'],p['perf'],p['profile']['iterations']), ('deep',True,4))
    def test_critical_perf_has_only_three_workers(self):
        p=self.route([file('crates/evm/src/lib.rs')], [answer(consensus=.8,performance_critical=.9)])
        self.assertEqual((p['mode'],p['perf'],len(p['profile']['workers'])), ('critical',True,3))
    def test_incomplete_critical_context_falls_back(self):
        p=self.route([file('crates/evm/src/lib.rs')], [answer()], False)
        self.assertEqual((p['mode'],p['perf']), ('critical',False))
    def test_funds_uncertainty_does_not_invent_perf(self):
        p=self.route([file('crates/precompiles/src/lib.rs')], [answer(funds=.96,context_missing=.44,performance_critical=.06)])
        self.assertEqual((p['mode'],p['perf']), ('critical',False))
    def test_runtime_scope_ambiguity_does_not_override_validated_prose(self):
        a=answer('editorial',context_missing=.17)
        a['answers']['scope'].update(confidence=.4,probabilities=dict(local=.55,unknown=.45,shared=0,system=0))
        self.assertEqual(self.route([file()], [a])['mode'],'skip')
    def test_missing_essential_evidence_still_prevents_prose_skip(self):
        self.assertEqual(self.route([file()], [answer('editorial',context_missing=.3)])['mode'],'deep')
        self.assertEqual(self.route([file()], [answer('editorial')],False)['mode'],'deep')
    def test_normative_prose_in_docs_is_not_skipped(self):
        self.assertEqual(self.route([file('docs/protocol.md')], [answer('editorial',normative_spec=.8)])['mode'],'deep')
    def test_executable_markdown_is_not_skipped(self):
        for text in ('+```sh', '+<script>alert(1)</script>', '+Run `release.sh`'):
            self.assertNotEqual(self.route([file(patch=text)], [answer('editorial')])['mode'],'skip')
    def test_unknown_source_scope_remains_conservative(self):
        a=answer(); a['answers']['scope'].update(choice='unknown',probabilities=dict(local=0,unknown=1,shared=0,system=0))
        self.assertEqual(self.route([file('src/helper.py')],[a])['mode'],'deep')
    def test_no_gemini_grok_fable(self):
        self.assertNotRegex(json.dumps(POLICY), '(?i)gemini|grok|fable')
    def test_invalid_probabilities_fail_closed(self):
        for value in (float('nan'),-1,1.2,True,'0.5'):
            a=answer(); a['answers']['funds']['noul']=value
            with self.assertRaises(ValueError): validate_response(a)
    def test_missing_answer_fails_closed(self):
        a=answer(); del a['answers']['funds']
        self.assertEqual(self.route([file()], [a])['mode'],'deep')
    def test_choice_options_and_sum_checked(self):
        a=answer(); a['answers']['scope']['probabilities']['unknown']=.5
        with self.assertRaises(ValueError): validate_response(a)

class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.d=dict(repository='tempoxyz/cyclops-canary',pr=10,head='a'*40,base='b'*40,run_label='jev-123',decision_id='d',plan_hash='h',plan=route([file('tests/test.rs')],[answer('tests')],True,POLICY))
        self.r={k:self.d[k] for k in ('repository','pr','head','base','run_label','decision_id','plan_hash')}
        self.r.update(status='completed',perf=False,review_id=1,workers=[dict(id='pr-10-w1',engine='codex/gpt-6-sol',thinking='medium',passes=1)])
        self.review=dict(id=1,commit_id='a'*40,state='COMMENTED')
    def test_exact_receipt(self):
        self.assertTrue(receipt_valid(self.r,self.d,self.review))
    def test_stale_receipt_rejected(self):
        for key in ('head','base','run_label','plan_hash','decision_id'):
            r=dict(self.r); r[key]='wrong'
            self.assertFalse(receipt_valid(r,self.d,self.review))
    def test_partial_worker_and_wrong_effort_rejected(self):
        for k,v in [('passes',0),('thinking','low'),('engine','codex/other')]:
            r=copy.deepcopy(self.r); r['workers'][0][k]=v
            self.assertFalse(receipt_valid(r,self.d,self.review))
    def test_review_must_be_same_head(self):
        self.assertFalse(receipt_valid(self.r,self.d,dict(self.review,commit_id='c'*40)))
    def test_perf_required(self):
        r=dict(self.r,perf=True)
        self.assertFalse(receipt_valid(r,self.d,self.review))
    def test_dismissed_review_rejected(self):
        self.assertFalse(receipt_valid(self.r,self.d,dict(self.review,state='DISMISSED')))
    def test_machine_records_roundtrip_and_invalid_input(self):
        self.assertEqual(main.unpack(main.pack(self.d,main.DECISION)+'\nsummary',main.DECISION),self.d)
        self.assertIsNone(main.unpack(main.DECISION+'invalid -->',main.DECISION))
    def test_non_bot_callback_ignored(self):
        event={'comment':{'user':{'id':1},'body':main.pack(self.r,main.RECEIPT)},'issue':{'number':10,'pull_request':{}}}
        with patch.dict(main.os.environ, {'GITHUB_EVENT_PATH':'event','GITHUB_REPOSITORY':'tempoxyz/cyclops-canary','GITHUB_EVENT_NAME':'issue_comment'}), patch.object(Path,'read_text',return_value=json.dumps(event)), patch.object(main,'Controller') as controller:
            main.main(); controller.assert_not_called()

if __name__ == '__main__': unittest.main()
