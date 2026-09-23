import os
import tempfile
import unittest
from unittest.mock import patch
import evaluate


class HistoricalEvaluationTests(unittest.TestCase):
    def test_read_only_boundary_rejects_github_mutations(self):
        def assessment(number):
            with self.assertRaises(ValueError):
                evaluate.main.gh('repos/tempoxyz/tempo/issues/1/comments', 'POST', {'body':'bad'})
            with self.assertRaises(ValueError):
                evaluate.main.gh('repos/tempoxyz/cyclops-canary/pulls/1')
            return {'pr':number,'plan':{'mode':'deep','perf':False}}
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {
            'GITHUB_REPOSITORY':'tempoxyz/cyclops-canary','RUNNER_TEMP':tmp,'JEV_EVALUATION_PRS':'1'
        }), patch.object(evaluate.main,'gh') as github, patch.object(evaluate,'evaluate_pr',side_effect=assessment):
            evaluate.main_evaluation()
            github.assert_not_called()

    def test_only_merged_small_prs_are_evaluated(self):
        for fields in ({'merged_at':None,'changed_files':1}, {'merged_at':'now','changed_files':4}):
            with patch.object(evaluate.main,'gh',return_value=dict(fields,head={'sha':'a'*40},base={'sha':'b'*40})), patch.object(evaluate.main.Controller,'assess') as assess:
                with self.assertRaises(ValueError): evaluate.evaluate_pr(1)
                assess.assert_not_called()
