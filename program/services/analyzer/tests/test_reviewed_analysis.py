"""Synthetic v12 integration: no external transport or private video fixtures."""
import copy
from dataclasses import replace
from unittest.mock import patch

from test_content_provider_integration import LegacyResponse, inputs
from test_unified_analysis import Ledger, OfflineSdk, payload_of, response_completion

from liming_analyzer.api_client import ClaimedJob
from liming_analyzer.content_analysis import MODULES
from liming_analyzer.providers import InstructorStructureAnalyzer


class ReviewedSdk(OfflineSdk):
    def __init__(self, *, pending=(), length=False, repair=False):
        super().__init__()
        self.pending, self.length, self.repair = set(pending), length, repair

    def create_with_completion(self, **arguments):
        payload = payload_of(arguments)
        model = arguments['response_model']
        if model.__name__ != 'CanonicalReviewResponse':
            return super().create_with_completion(**arguments)
        task = 'canonical_repair' if any('previous_uncertain' in row for row in payload['segments']) else 'canonical_review'
        self.calls.append({'task': task, **arguments})
        if self.length and sum(row['task'].startswith('canonical_') for row in self.calls) == 1:
            from openai import LengthFinishReasonError
            raise LengthFinishReasonError(completion=response_completion(finish_reason='length'))
        # Same synthetic source except explicit uncertain slots. The model must
        # never be allowed to turn these slots into facts by their old index.
        value = {'patches': [], 'uncertain': [{'s': index, 'reason': '需要听原片核对'} for index in self.pending], 'punctuation': []}
        if self.repair:
            value['uncertain'] = []
        return model.model_validate(value), response_completion()


def review_inputs():
    media, transcript, visuals = inputs()
    middle = replace(transcript.segments[0], start_ms=2300, end_ms=2600, text='这部分请看画面。')
    return media, replace(transcript, segments=(transcript.segments[0], middle, transcript.segments[1])), visuals


def run_reviewed(sdk=None, *, checkpoint=None, retry_ids=None, targets=None, source=None, custom_inputs=None):
    sdk = sdk or ReviewedSdk()
    ledger, checkpoints = Ledger(), []
    analyzer = InstructorStructureAnalyzer(api_key='', base_url='https://synthetic.invalid', model='synthetic',
        provider='minimax', client=sdk, report_model=LegacyResponse, generate_content_features=True,
        generate_unified_report=True, generate_reviewed_report=True, call_recorder=ledger)
    analyzer.set_unified_checkpoint(lambda value: checkpoints.append(copy.deepcopy(value)))
    cp = {'unified_progress': checkpoint} if checkpoint else {}
    if retry_ids: cp['retry_review_segment_ids'] = retry_ids
    if targets: cp['retry_module_keys'] = targets
    job = ClaimedJob('reviewed-synthetic', 'org', 'project', 'video', 'upload', 'analyzing', 84, 1,
                     source or {}, analysis_profile='max', checkpoint=cp or None)
    return analyzer.analyze(job, *(custom_inputs or review_inputs())), sdk, ledger, checkpoints


def test_one_uncertain_sentence_retains_full_script_and_all_independent_modules():
    result, sdk, _ledger, checkpoints = run_reviewed(ReviewedSdk(pending={2}))
    doc = result.report['unified_report']
    assert result.schema_version == 'analysis.v12'
    assert doc['canonical']['status'] == 'needs_review'
    assert doc['outcome']['review_segment_count'] == 1
    assert [row['source_segment_id'] for row in doc['canonical']['segments']] == ['transcript:0001', 'transcript:0002', 'transcript:0003']
    assert all(row['status'] == 'completed' for row in doc['sections']), doc['validation']
    assert doc['status'] == 'complete' and doc['validation']['passed']
    assert not doc['canonical']['validation']['passed']
    assert 'transcript:0002' not in {row['id'] for row in result.report['content_analysis']['evidence_registry']}
    assert doc['canonical']['segments'][1]['original_text'] not in result.report['spoken_script']
    assert any('待核对' in row for row in doc['canonical']['paragraphs'])
    assert checkpoints[-1]['canonical'] and set(checkpoints[-1]['modules']) == set(MODULES)
    assert sum(row['task'].startswith('canonical_') for row in sdk.calls) == 1  # Plain uncertainty cannot benefit from an identical repair question.


def test_length_retry_increases_tokens_and_shares_two_call_review_repair_budget():
    result, sdk, _ledger, _cp = run_reviewed(ReviewedSdk(pending={2}, length=True))
    calls = [row for row in sdk.calls if row['task'].startswith('canonical_')]
    assert [row.get('max_completion_tokens', row.get('max_tokens')) for row in calls] == [4500, 6000]
    assert len(calls) == 2
    assert result.report['unified_report']['canonical']['status'] == 'needs_review'
    assert any(row['key'] == 'visual' and row['status'] == 'completed' for row in result.report['unified_report']['sections'])


def test_cached_pending_is_retained_and_module_retry_does_not_pay_for_canonical():
    first, _sdk, _ledger, cp = run_reviewed(ReviewedSdk(pending={2}))
    second, sdk, ledger, _cp = run_reviewed(checkpoint=cp[-1], targets=['visual'])
    assert sdk.calls == [] and ledger.events == []
    assert second.report['unified_report']['canonical']['status'] == 'needs_review'
    assert second.report['unified_report']['status'] == first.report['unified_report']['status']


def test_manual_confirmed_source_skips_paid_review():
    result, sdk, _ledger, _cp = run_reviewed(source={'manual_transcript': {'confirmed': True}})
    assert not any(row['task'].startswith('canonical_') for row in sdk.calls)
    assert result.report['unified_report']['canonical']['status'] == 'completed'


def test_actual_sdk_constructor_enables_v12_while_legacy_injection_is_opt_in():
    sdk = ReviewedSdk()
    with patch('openai.OpenAI', return_value=object()), patch('instructor.from_openai', return_value=sdk):
        analyzer = InstructorStructureAnalyzer(api_key='synthetic', base_url='https://synthetic.invalid',
            model='synthetic', provider='minimax')
    assert analyzer.generate_reviewed_report is True
    result = analyzer.analyze(ClaimedJob('job', 'org', 'project', 'video', 'upload', 'analyzing', 84, 1, {}), *inputs())
    assert result.schema_version == 'analysis.v12'


def test_targeted_sentence_repair_uses_one_review_request_and_reuses_visual_success():
    _first, _sdk, _ledger, checkpoints = run_reviewed(ReviewedSdk(pending={2}))
    result, sdk, _ledger, _cp = run_reviewed(ReviewedSdk(repair=True), checkpoint=checkpoints[-1],
        retry_ids=['transcript:0002'], targets=['canonical'])
    reviews = [row for row in sdk.calls if row['task'].startswith('canonical_')]
    assert len(reviews) == 1 and reviews[0]['task'] == 'canonical_repair'
    assert [row['s'] for row in payload_of(reviews[0])['segments']] == [2]
    assert not any(row['task'] == 'content_classification:visual' for row in sdk.calls)
    assert result.report['unified_report']['canonical']['status'] == 'needs_review'  # No new evidence cannot clear a doubt.
    assert result.report['unified_report']['status'] == 'complete'
    assert next(row for row in result.report['unified_report']['sections'] if row['key'] == 'visual')['diagnostics']['reused'] is True


def test_targeted_historical_v11_module_retry_keeps_its_verified_script_and_modules():
    from test_unified_analysis import run_unified
    _old, _sdk, _ledger, checkpoints, *_rest = run_unified(sdk=OfflineSdk(failures={'content_classification:visual': ['timeout']}))
    sdk = OfflineSdk()
    analyzer = InstructorStructureAnalyzer(api_key='', base_url='https://synthetic.invalid', model='MiniMax-M3.1-Flash',
        provider='minimax', client=sdk, report_model=LegacyResponse, generate_content_features=True,
        generate_unified_report=True, generate_reviewed_report=True)
    job = ClaimedJob('legacy-target', 'org', 'project', 'video', 'upload', 'analyzing', 84, 1, {}, analysis_profile='max',
        checkpoint={'unified_progress': checkpoints[-1], 'retry_module_keys': ['visual']})
    result = analyzer.analyze(job, *inputs())
    assert result.schema_version == 'analysis.v11'
    assert result.report['unified_report']['canonical']['status'] == 'completed'
    assert result.report['unified_report']['status'] == 'complete'
    assert [row['task'] for row in sdk.calls] == ['content_classification:visual', 'content_classification:synthesis']


def test_editor_and_content_requests_use_separate_source_evidence_roles():
    _result, sdk, _ledger, _cp = run_reviewed(ReviewedSdk(pending={2}))
    editor = [row['messages'][0]['content'] for row in sdk.calls if row['task'].startswith('canonical_')]
    content = [row['messages'][0]['content'] for row in sdk.calls if row['task'].startswith('content_classification:')]
    assert editor and content
    assert all('转写校对员' in text and '不要求OCR' in text for text in editor)
    assert all('待核对口播不在可用文字证据内' not in text for text in editor)
    assert all('待核对口播不在可用文字证据内' in text for text in content)
