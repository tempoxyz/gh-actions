"""Read-only historical Tempo evaluation; never posts statuses/comments or audits."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import main


def evaluate_pr(number):
    repo = 'tempoxyz/tempo'
    controller = object.__new__(main.Controller)
    controller.repo, controller.number = repo, number
    controller.root = f'repos/{repo}'
    controller.pull = main.gh(f'{controller.root}/pulls/{number}')
    controller.head = controller.pull['head']['sha']
    controller.base = controller.pull['base']['sha']
    # Closed historical PRs only; this is not a second route to live PR control.
    if not controller.pull.get('merged_at') or controller.pull['changed_files'] > 3:
        raise ValueError('evaluation requires a merged Tempo PR with at most three changed files')
    result = controller.assess()
    result.pop('units')
    return dict(result, pr=number, repository=repo, head=controller.head, base=controller.base,
                title=controller.pull['title'], url=controller.pull['html_url'])


def main_evaluation():
    if os.environ.get('GITHUB_REPOSITORY') != 'tempoxyz/cyclops-canary':
        raise ValueError('evaluation is restricted to the canary workflow')
    value = os.environ['JEV_EVALUATION_PRS']
    if not re.fullmatch(r'[1-9][0-9]*(?:,[1-9][0-9]*){0,49}', value):
        raise ValueError('provide 1-50 comma-separated PR numbers')
    numbers = [int(n) for n in value.split(',')]
    if len(numbers) != len(set(numbers)):
        raise ValueError('duplicate evaluation PR')
    original_gh = main.gh
    def read_only_gh(path, method='GET', data=None):
        if method != 'GET' or not path.startswith('repos/tempoxyz/tempo/'):
            raise ValueError('historical evaluation permits only Tempo GitHub reads')
        return original_gh(path, method, data)
    main.gh = read_only_gh
    output = Path(os.environ['RUNNER_TEMP'], 'jev-evaluation.json')
    results = []
    def safe_evaluate(number):
        try:
            return evaluate_pr(number)
        except Exception as error:
            return {'pr': number, 'error': type(error).__name__}
    with ThreadPoolExecutor(max_workers=3) as pool:
        for result in pool.map(safe_evaluate, numbers):
            results.append(result)
            output.write_text(json.dumps({'policy': main.POLICY['version'], 'results': results}, indent=2))
            print(json.dumps({'pr': result['pr'], 'mode': result.get('plan', {}).get('mode'),
                              'perf': result.get('plan', {}).get('perf'), 'error': result.get('error')}), flush=True)
    if any('error' in r for r in results):
        raise RuntimeError('some historical evaluations failed; inspect artifact')


if __name__ == '__main__':
    main_evaluation()
