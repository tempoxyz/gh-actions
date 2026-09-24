#!/usr/bin/env python3
"""Trusted controller: classify immutable PR evidence, dispatch, validate receipts."""
import base64
import copy
import datetime as dt
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from routing import QUESTIONS, DOMAINS, digest, route, receipt_valid, needs_context, validate_response

POLICY = json.loads(Path(__file__).with_name('policy.json').read_text())
DECISION = '<!-- cyclops-jev-decision:'
RECEIPT = '<!-- cyclops-jev-receipt:'
SHA = re.compile(r'^[0-9a-f]{40}$')

def request(url, token='', method='GET', data=None, headers=None):
    h = {'Accept': 'application/vnd.github+json', 'User-Agent': 'cyclops-jev-router'}
    if token:
        h['Authorization'] = 'Bearer ' + token
    if headers:
        h.update(headers)
    payload = None
    if data is not None:
        payload = json.dumps(data).encode()
        h['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=payload, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read(16 * 1024 * 1024 + 1)
            if len(raw) > 16 * 1024 * 1024:
                raise RuntimeError('response exceeds maximum size')
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        # Never log response bodies, authorization headers or private source.
        raise RuntimeError(f'HTTP {e.code} from {urllib.parse.urlsplit(url).hostname}') from None

def gh(path, method='GET', data=None):
    return request('https://api.github.com/' + path, os.environ['GH_TOKEN'], method, data)

def pages(path):
    result = []
    for page in range(1, 101):
        batch = gh(path + ('&' if '?' in path else '?') + f'per_page=100&page={page}')
        if not isinstance(batch, list):
            raise RuntimeError('expected GitHub array')
        result.extend(batch)
        if len(batch) < 100:
            return result
    raise RuntimeError('pagination limit exceeded')

def unpack(body, marker):
    if not body.startswith(marker):
        return None
    try:
        encoded = body[len(marker):].split(' -->', 1)[0]
        if len(encoded) > 40000:
            return None
        value = json.loads(base64.b64decode(encoded, validate=True))
        return value if isinstance(value, dict) else None
    except (ValueError, TypeError):
        return None

def pack(value, marker):
    return marker + base64.b64encode(json.dumps(value, separators=(',', ':')).encode()).decode() + ' -->'

def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()

class Controller:
    def __init__(self, repo, number):
        if repo not in POLICY['repositories'] or type(number) is not int or number < 1:
            raise ValueError('repository/PR outside enabled pilot')
        self.repo, self.number = repo, number
        self.root = f'repos/{repo}'
        self.pull = gh(f'{self.root}/pulls/{number}')
        self.head, self.base = self.pull['head']['sha'], self.pull['base']['sha']
        if not SHA.fullmatch(self.head) or not SHA.fullmatch(self.base):
            raise ValueError('invalid revision')
        self.url = f'https://github.com/{repo}/pull/{number}'

    def current(self):
        p = gh(f'{self.root}/pulls/{self.number}')
        return p['state'] == 'open' and p['head']['sha'] == self.head and p['base']['sha'] == self.base

    def status(self, state, message, url=None):
        if not self.current():
            return
        gh(f'{self.root}/statuses/{self.head}', 'POST', {'state': state, 'context': POLICY['status_context'],
           'description': message[:140], 'target_url': url or self.url})

    def comments(self):
        return pages(f'{self.root}/issues/{self.number}/comments')

    def existing(self):
        for c in reversed(self.comments()):
            if c.get('user', {}).get('id') != POLICY['decision_bot_id']:
                continue
            d = unpack(c.get('body', ''), DECISION)
            if d and (d.get('repository'), d.get('pr'), d.get('head'), d.get('base')) == (self.repo, self.number, self.head, self.base):
                # Old decisions cannot bless a changed policy or implementation.
                if d.get('controller_hash') == controller_hash():
                    return c, d
        return None, None

    def write_decision(self, decision, comment=None):
        plan = decision['plan']
        text = f"**Cyclops / Jev: {plan['mode']}**" + (' + **perf**' if plan['perf'] else '')
        text += f"\n\nCommit `{self.head}` · policy `{POLICY['version']}`\n\n"
        text += 'Reasons: ' + ', '.join(plan['reasons']) + '.\n\n'
        if plan['profile']:
            text += 'Workers: ' + ', '.join(f"{w['model']} ({w['thinking']}) ×{plan['profile']['iterations']}" for w in plan['profile']['workers']) + '.\n\n'
        text += 'State: **' + decision['phase'] + '**. '
        if decision.get('classification_only'):
            text += 'Classification-only test: no audit was dispatched and no merge rule is enforced by this test.'
        else:
            text += 'This gate permits merging; other repository requirements still apply.' if plan['mode'] == 'skip' else 'This status stays pending until the audit ends. Failed audits and worker rejections also satisfy this gate.'
        body = pack(decision, DECISION) + '\n' + text
        if comment:
            return gh(f"{self.root}/issues/comments/{comment['id']}", 'PATCH', {'body': body})
        return gh(f'{self.root}/issues/{self.number}/comments', 'POST', {'body': body})

    def reconcile(self, comment, decision):
        if decision['plan']['mode'] == 'skip':
            self.status('success', 'Jev: skip — policy criteria satisfied', comment['html_url'])
            return
        if decision.get('classification_only'):
            self.status('pending', f"Jev: {decision['plan']['mode']} selected; classification-only test", comment['html_url'])
            return
        for c in reversed(self.comments()):
            if c.get('user', {}).get('id') != POLICY['completion_bot_id']:
                continue
            receipt = unpack(c.get('body', ''), RECEIPT)
            if not receipt or receipt.get('run_label') != decision['run_label']:
                continue
            if receipt_valid(receipt, decision):
                outcome = receipt['workflow_phase']
                self.status('success', f'Cyclops audit ended ({outcome}); terminal-outcome gate satisfied', c['html_url'])
                return
        deadline = dt.datetime.fromisoformat(decision['created_at']).timestamp() + decision['plan']['profile']['budget_seconds'] + 1800
        if time.time() > deadline or decision['phase'] == 'dispatch_failed':
            self.status('error', 'Cyclops: no terminal audit receipt; inspect workflow', comment['html_url'])
        else:
            self.status('pending', 'Cyclops: waiting for audit to end', comment['html_url'])

    def evidence(self):
        files = pages(f'{self.root}/pulls/{self.number}/files')
        complete = bool(files) and len(files) == self.pull['changed_files'] and len(files) < 3000
        manifest = [{'filename': f['filename'], 'status': f['status'], 'previous_filename': f.get('previous_filename')} for f in files]
        units = []
        if len(files) > 30:
            complete = False
        for f in files[:30]:
            patch = f.get('patch', '')
            additions = sum(l.startswith('+') and not l.startswith('+++') for l in patch.splitlines())
            deletions = sum(l.startswith('-') and not l.startswith('---') for l in patch.splitlines())
            if not patch or additions != f.get('additions') or deletions != f.get('deletions') or f['status'] not in ('modified', 'added', 'removed', 'renamed'):
                complete = False
            # Include source for enclosing context where available, never execute it.
            contexts = {}
            for side, sha in [('base', self.base), ('head', self.head)]:
                if (side == 'base' and f['status'] == 'added') or (side == 'head' and f['status'] == 'removed'):
                    continue
                path = f.get('previous_filename', f['filename']) if side == 'base' else f['filename']
                try:
                    content = gh(f"{self.root}/contents/{urllib.parse.quote(path, safe='/')}?ref={sha}")
                    if content.get('encoding') != 'base64' or content.get('size', 0) > 20000:
                        complete = False
                        continue
                    contexts[side] = base64.b64decode(content['content']).decode('utf-8')
                except (RuntimeError, ValueError, UnicodeError):
                    complete = False
            # Large files still get a bounded full patch classification; never skip on omitted evidence.
            for offset in range(0, max(len(patch), 1), 12000):
                unit = {'repository': self.repo, 'base': self.base, 'head': self.head,
                        'manifest': manifest, 'file': f['filename'], 'patch': patch[offset:offset+12000],
                        'partial_patch': len(patch) > 12000, 'context': contexts if len(patch) <= 12000 else {}}
                if len(patch) > 12000:
                    complete = False
                if len(json.dumps(unit).encode()) > 65000:
                    complete = False
                    unit['manifest'] = {'omitted': True, 'file_count': len(manifest)}
                units.append(unit)
        # Bound classifier spend; incomplete coverage conservatively routes upwards.
        if len(units) > 30:
            complete = False
        return files, units[:30], complete

    def expand_context(self, unit):
        """One bounded lookup of nearby source/module/config files, at immutable revisions."""
        if not hasattr(self, '_context_tree'):
            self._context_tree = gh(f'{self.root}/git/trees/{self.head}?recursive=1')
        tree = self._context_tree
        filename = Path(unit['file'])
        parent = filename.parent.as_posix()
        # This is local context retrieval, not an assertion that all callers were found.
        source = '\n'.join(unit['context'].values())
        symbols = set(re.findall(r'\b(?:fn|def|class|struct|function)\s+([A-Za-z_][A-Za-z0-9_]*)', source))
        manifests = {'Cargo.toml', 'pyproject.toml', 'package.json', 'tsconfig.json'}
        modules = {'lib.rs', 'mod.rs', '__init__.py', 'index.ts'}
        ancestors = {p.as_posix() for p in filename.parents}
        candidates = []
        for entry in tree.get('tree', []):
            path = Path(entry['path'])
            if entry.get('type') != 'blob' or entry.get('mode') == '120000' or path.as_posix() == filename.as_posix():
                continue
            directory = path.parent.as_posix()
            score = 0
            if directory in ancestors and path.name in manifests | modules:
                score = 30 + len(path.parts)
            if directory == parent and path.suffix in {'.rs', '.py', '.ts', '.js', '.sol'}:
                score = max(score, 10)
                if any(symbol.lower() in path.stem.lower() for symbol in symbols):
                    score += 10
            if score and entry.get('size', 0) <= 12000:
                candidates.append((-score, path.as_posix()))
        related = []
        for _, path in sorted(candidates)[:4]:
            versions = {}
            for side, sha in [('base', self.base), ('head', self.head)]:
                try:
                    content = gh(f"{self.root}/contents/{urllib.parse.quote(path, safe='/')}?ref={sha}")
                    if content.get('encoding') == 'base64' and content.get('size', 0) <= 12000:
                        versions[side] = base64.b64decode(content['content'], validate=False).decode('utf-8')
                except (RuntimeError, ValueError, UnicodeError):
                    continue
            if versions:
                candidate = {'path': path, 'source': versions}
                if len(json.dumps(dict(unit, related_context=related + [candidate])).encode()) <= 65000:
                    related.append(candidate)
        return dict(unit, related_context=related, context_search={
            'scope': 'At most four nearby source/module/config files. Not exhaustive caller discovery.',
            'tree_truncated': bool(tree.get('truncated'))})

    def assess(self):
        files, units, complete = self.evidence()
        responses = []
        classifier_errors = []
        key = os.environ.get('OPENROUTER_API_KEY', '')
        if key:
            for unit in units:
                try:
                    responses.append(request(POLICY['endpoint'], key, 'POST', {'model': POLICY['model'], 'state': unit, 'questions': QUESTIONS}))
                except RuntimeError as error:
                    classifier_errors.append(str(error))
                    print(f'Classifier unavailable: {error}; requiring an audit', flush=True)
                    complete = False
                    break
        else:
            classifier_errors.append('OPENROUTER_API_KEY unavailable')
            complete = False
        first_responses = copy.deepcopy(responses)
        context_passes = []
        if complete:
            for index, response in enumerate(first_responses):
                try:
                    ambiguous = needs_context(files, response)
                except (ValueError, TypeError, AttributeError):
                    complete = False
                    break
                if not ambiguous or len(context_passes) >= 5:
                    continue
                attempt = {'unit': index, 'files': [], 'outcome': 'no_additional_context'}
                context_passes.append(attempt)
                try:
                    expanded = self.expand_context(units[index])
                    attempt.update(files=[f['path'] for f in expanded['related_context']],
                                   tree_truncated=expanded['context_search']['tree_truncated'])
                    if not expanded['related_context']:
                        continue
                    second = request(POLICY['endpoint'], key, 'POST',
                                     {'model': POLICY['model'], 'state': expanded, 'questions': QUESTIONS})
                    a = validate_response(second)
                    original = validate_response(response)
                    attempt.update(outcome='reclassified', response=second)
                    # Resolve ambiguity with more evidence, without erasing previously detected risk.
                    effective = copy.deepcopy(second)
                    for domain in DOMAINS:
                        if domain != 'context_missing':
                            effective['answers'][domain]['noul'] = max(a[domain]['noul'], original[domain]['noul'])
                    responses[index] = effective
                    units[index] = expanded
                except (RuntimeError, ValueError, TypeError, AttributeError) as error:
                    attempt.update(outcome='context_pass_failed', error=type(error).__name__)
                    # Keep the first, uncertain decision; failed retrieval never permits skip.
        plan = route(files, responses, complete, POLICY)
        return {'plan': plan, 'units': units, 'responses': responses,
                'first_responses': first_responses, 'context_passes': context_passes,
                'evidence_complete': complete, 'classifier_errors': classifier_errors}

    def classify(self, retry=False):
        if self.pull['state'] != 'open':
            return
        comment, previous = self.existing()
        if previous and not retry:
            self.reconcile(comment, previous)
            return
        self.status('pending', 'Jev: classifying this PR revision')
        if self.pull['draft']:
            self.status('pending', 'Jev: audit will start when ready for review')
            return
        assessment = self.assess()
        plan = assessment['plan']
        units = assessment.pop('units')
        responses = assessment['responses']
        identity = {'repository': self.repo, 'pr': self.number, 'head': self.head, 'base': self.base,
                    'controller_hash': controller_hash(), 'evidence_hash': digest(units)}
        decision_id = digest(identity)
        suffix = re.sub('[^0-9]', '', os.environ.get('GITHUB_RUN_ID', '') + os.environ.get('GITHUB_RUN_ATTEMPT', ''))[-20:] if retry else ''
        run_label = 'jev-' + decision_id[:32] + ('-' + suffix if suffix else '')
        classification_only = os.environ.get('JEV_CLASSIFICATION_ONLY') == 'true'
        decision = dict(identity, decision_id=decision_id, run_label=run_label, plan=plan, plan_hash=digest(plan),
                        classification_only=classification_only,
                        created_at=now(), phase='skipped' if plan['mode'] == 'skip' else ('classified' if classification_only else 'dispatching'),
                        classifier_models=sorted(set(r.get('model', '') for r in responses)))
        Path(os.environ.get('RUNNER_TEMP', '/tmp'), 'jev-decision.json').write_text(
            json.dumps(dict(assessment, decision=decision), indent=2))
        if not self.current():
            return
        comment = self.write_decision(decision)
        if plan['mode'] == 'skip':
            self.status('success', 'Jev: skip — policy criteria satisfied', comment['html_url'])
            return
        if classification_only:
            self.reconcile(comment, decision)
            return
        try:
            dispatch(decision)
        except Exception:
            decision['phase'] = 'dispatch_failed'
            self.write_decision(decision, comment)
            self.status('error', 'Cyclops dispatch failed; inspect workflow and retry', comment['html_url'])
            raise
        decision['phase'] = 'queued'
        self.write_decision(decision, comment)
        self.reconcile(comment, decision)

def controller_hash():
    return digest([Path(__file__).read_text(), Path(__file__).with_name('routing.py').read_text(), POLICY,
                   os.environ.get('JEV_CLASSIFICATION_ONLY') == 'true'])

def dispatch(decision):
    mode, perf = decision['plan']['mode'], decision['plan']['perf']
    if mode not in POLICY['profiles']:
        raise ValueError('invalid audit profile')
    config = f"repos/tempoxyz/tempo/config/jev/{mode}{'-perf' if perf else ''}.yaml"
    # A scoped canary image can be configured without promoting any production image.
    image = os.environ.get('CYCLOPS_JEV_IMAGE', '')
    if not re.fullmatch(r'ghcr\.io/tempoxyz/cyclops-internal-worker@sha256:[0-9a-f]{64}', image):
        raise ValueError('CYCLOPS_JEV_IMAGE must be a validated immutable worker image')
    payload = {'repository': decision['repository'], 'event': 'pr_audit', 'data': {
        'pr_number': decision['pr'], 'sha': decision['head'], 'source': 'jev',
        'run_label': decision['run_label'], 'config': config, 'perf': perf, 'image': image,
        'audit_note_b64': base64.b64encode(('JEV_DECISION_V1=' + base64.b64encode(json.dumps(decision).encode()).decode()
                          + '\nReview this exact revision using the configured profile.').encode()).decode()}}
    args = shlex.split(os.environ.get('EVENTS_ARGS', ''))
    # EVENTS_ARGS is trusted configuration, never PR text. Require an HTTPS destination.
    if not any(a.startswith('https://') for a in args):
        raise ValueError('EVENTS_ARGS requires HTTPS')
    with tempfile.TemporaryDirectory() as tmp:
        key, cert, body = [Path(tmp, name) for name in ('key', 'cert', 'body')]
        for p, text in [(key, os.environ.get('EVENTS_KEY', '')), (cert, os.environ.get('EVENTS_CERT', '')), (body, json.dumps(payload))]:
            p.write_text(text)
            p.chmod(0o600)
        if not key.stat().st_size or not cert.stat().st_size:
            raise ValueError('missing event credentials')
        result = subprocess.run(['curl', '--fail', '--silent', '--show-error', '--max-time', '60', '-o', '/dev/null',
                                 '-X', 'POST', *args, '-H', 'Content-Type: application/json', '--key', str(key),
                                 '--cert', str(cert), '--data-binary', '@' + str(body)],
                                env={'PATH': os.environ.get('PATH', '/usr/bin:/bin')}, capture_output=True)
        if result.returncode:
            raise RuntimeError('event delivery failed or uncertain; explicit retry required')

def main():
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    repo = os.environ['GITHUB_REPOSITORY']
    if repo not in POLICY['repositories']:
        raise ValueError('repository outside pilot allowlist')
    kind = os.environ['GITHUB_EVENT_NAME']
    if kind == 'issue_comment':
        c = event.get('comment', {})
        if c.get('user', {}).get('id') != POLICY['completion_bot_id'] or not unpack(c.get('body', ''), RECEIPT) or not event.get('issue', {}).get('pull_request'):
            return
        controller = Controller(repo, event['issue']['number'])
        comment, decision = controller.existing()
        if decision:
            controller.reconcile(comment, decision)
        return
    if kind == 'schedule':
        for pull in pages(f'repos/{repo}/pulls?state=open'):
            controller = Controller(repo, pull['number'])
            c, d = controller.existing()
            if d:
                controller.reconcile(c, d)
        return
    if kind == 'merge_group':
        # This pilot does not yet support merge queues. Never auto-pass a merge-group SHA.
        sha = event['merge_group']['head_sha']
        if not SHA.fullmatch(sha):
            raise ValueError('invalid merge group SHA')
        gh(f'repos/{repo}/statuses/{sha}', 'POST', {'state': 'error', 'context': POLICY['status_context'],
           'description': 'Jev pilot requires a PR audit; merge-group audit is not enabled'})
        return
    number = event.get('pull_request', {}).get('number') or int(event.get('inputs', {}).get('pr_number', 0))
    controller = Controller(repo, number)
    try:
        controller.classify(retry=kind == 'workflow_dispatch' and event.get('inputs', {}).get('retry') == 'true')
    except Exception:
        controller.status('error', 'Jev/Cyclops routing failed; inspect workflow and retry')
        raise

if __name__ == '__main__':
    main()
