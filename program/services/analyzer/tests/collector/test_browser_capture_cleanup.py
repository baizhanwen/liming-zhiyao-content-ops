"""Injected pipe failures and real Node cleanup protocol, entirely offline."""
import io
import json
import logging
import queue
import shutil
import subprocess
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest

import liming_analyzer.douyin_collector.python.browser_capture as capture
from liming_analyzer.douyin_collector.python.security import AppError
from liming_analyzer.processing_health import processor_retirement_reasons, reset_processor_health

VIDEO = '1234567890123456789'
PAGE = 'https://www.douyin.com/video/' + VIDEO
SHORT = 'https://v.douyin.com/cleanup-fixture/'
PRIVATE = 'PRIVATE_QUERY_AND_COOKIE_MUST_NOT_BE_LOGGED'


@pytest.fixture(autouse=True)
def health():
    reset_processor_health()
    yield
    reset_processor_health()


class Pipe(io.StringIO):
    def __init__(self, initial='', *, fail=False):
        super().__init__(initial)
        self.fail = fail
        self.close_calls = 0
        self.write_attempts = []

    def write(self, value):
        self.write_attempts.append(value)
        return super().write(value)

    def close(self):
        self.close_calls += 1
        if self.fail:
            raise OSError(22, PRIVATE)
        # Keep the synthetic pipe inspectable; production streams are real.


class Guard:
    server_address = ('127.0.0.1', 12345)

    def __init__(self, *_args):
        self.shutdown = Mock()
        self.server_close = Mock()
        self.serve_forever = Mock()
        self.stop_tunnels = Mock()


def run_capture(tmp_path, monkeypatch, *, stream=None, outcome='success', cleanup=None, cancelled=None, executor=None, capture_options=None):
    ok = outcome != 'business'
    result = {'type': 'result', 'ok': ok, 'code': 'douyin_not_found', 'page_url': PAGE,
              'observed_video_id': VIDEO, 'title': 'fixture', 'observations': [{'duration': 1}]}
    if cleanup is not None:
        result['cleanup'] = cleanup
    if outcome == 'resolve':
        result.update(redirect_chain=[SHORT, PAGE], resolved_url=PAGE, video_id=VIDEO)
    messages = ([{'type': 'fetch', 'id': 7}] if executor else []) + [result]
    stdin = Pipe(fail=stream == 'stdin')
    stdout = Pipe(''.join(json.dumps(row) + '\n' for row in messages), fail=stream == 'stdout')
    driver = SimpleNamespace(pid=999999999, stdin=stdin, stdout=stdout,
        poll=Mock(return_value=None), wait=Mock(return_value=0))
    guard = Guard()
    close_broker = Mock()
    original_close = capture._Broker.close
    def broker_close(broker):
        close_broker()
        original_close(broker)
    def finish(broker, *_args):
        path = broker.folder / 'validated.mp4'
        path.write_bytes(b'OFFLINE_VALIDATED_MEDIA_FIXTURE')
        (broker.folder / 'unused.part').write_bytes(b'unused')
        return [{'path': str(path), 'complete': True, 'video_id': VIDEO}]
    monkeypatch.setattr(capture.subprocess, 'Popen', lambda *_a, **_k: driver)
    monkeypatch.setattr(capture, '_Guard', lambda *_args: guard)
    monkeypatch.setattr(capture, '_kill', Mock())
    monkeypatch.setattr(capture._Broker, 'close', broker_close)
    monkeypatch.setattr(capture._Broker, 'finish', finish)
    if executor:
        monkeypatch.setattr(capture, 'ThreadPoolExecutor', lambda **_kwargs: executor)
    kwargs = {'video_id': VIDEO, 'transport_factory': lambda: httpx.MockTransport(lambda _r: pytest.fail('No HTTP requests')),
              'cancelled': cancelled}
    if outcome == 'resolve':
        kwargs.update(video_id='0', _resolve_only=True)
    kwargs.update(capture_options or {})
    return lambda: capture.capture_douyin(SHORT if outcome == 'resolve' else PAGE, tmp_path, **kwargs), driver, guard, close_broker


@pytest.mark.parametrize('options,expected_timeout', [({}, 900000), ({'timeout': 10000, 'max_bytes': 2 * 1024 ** 3}, 900000), ({'timeout': 600}, 600000)])
def test_capture_default_and_clamped_limits_reach_renderer(tmp_path, monkeypatch, options, expected_timeout):
    invoke, driver, _, _ = run_capture(tmp_path, monkeypatch, capture_options=options)
    invoke()
    start = next(message for value in driver.stdin.write_attempts if (message := json.loads(value)).get('type') == 'start')
    assert start['timeout_ms'] == expected_timeout
    assert start['max_bytes'] == 1024 ** 3
    assert start['max_total_bytes'] == 4 * 1024 ** 3
    assert start['max_requests'] == 1536


@pytest.mark.parametrize('stream', ['stdin', 'stdout'])
@pytest.mark.parametrize('outcome', ['success', 'business', 'resolve'])
def test_errno22_close_preserves_result_or_business_error_and_continues_cleanup(tmp_path, monkeypatch, caplog, stream, outcome):
    invoke, driver, guard, closed = run_capture(tmp_path, monkeypatch, stream=stream, outcome=outcome)
    with caplog.at_level(logging.WARNING):
        if outcome == 'business':
            with pytest.raises(AppError) as error:
                invoke()
            assert error.value.code == 'douyin_not_found'
        else:
            result = invoke()
            if outcome == 'success':
                assert Path(result['media_paths'][0]).read_bytes() == b'OFFLINE_VALIDATED_MEDIA_FIXTURE'
                assert not list(tmp_path.rglob('unused.part'))
            else:
                assert result['video_id'] == VIDEO and result['resolved_url'] == PAGE
    assert driver.stdin.close_calls == driver.stdout.close_calls == 1
    closed.assert_called_once()
    guard.shutdown.assert_called_once()
    guard.server_close.assert_called_once()
    assert processor_retirement_reasons() == ('collector_cleanup_close_stream',)
    assert PRIVATE not in caplog.text
    assert f'"stream": "{stream}"' in caplog.text and '"errno": 22' in caplog.text


def test_cancelled_business_error_survives_cleanup_pipe_error(tmp_path, monkeypatch):
    invoke, _, guard, closed = run_capture(tmp_path, monkeypatch, stream='stdin', cancelled=lambda: True)
    with pytest.raises(AppError) as error:
        invoke()
    assert error.value.code == 'cancelled'
    closed.assert_called_once()
    guard.server_close.assert_called_once()


def test_capture_deadline_error_survives_cleanup_pipe_error(tmp_path, monkeypatch):
    invoke, _, guard, closed = run_capture(tmp_path, monkeypatch, stream='stdout')
    def expired(_broker):
        raise AppError('douyin_browser_timeout', 'synthetic deadline', True)
    monkeypatch.setattr(capture._Broker, '_check', expired)
    with pytest.raises(AppError) as error:
        invoke()
    assert error.value.code == 'douyin_browser_timeout'
    closed.assert_called_once()
    guard.server_close.assert_called_once()


def cleanup_fixture(tmp_path, *, process=None, reader=None, write_lock=None):
    guard = Guard()
    resources = {'process': process, 'reader': reader, 'stop_reader': threading.Event(), 'stop_writes': threading.Event(),
        'write_lock': write_lock or threading.Lock(), 'send': Mock(), 'messages': queue.Queue(), 'guard': guard,
        'guard_thread': SimpleNamespace(join=Mock(), is_alive=lambda: False), 'native_proxy': True,
        'executor': SimpleNamespace(shutdown=Mock()), 'broker': SimpleNamespace(close=Mock()), 'work': tmp_path, 'keep': {tmp_path / 'kept'}}
    return resources


def test_live_reader_is_not_closed_after_join_timeout_and_other_cleanup_continues(tmp_path):
    release = threading.Event()
    reader = threading.Thread(target=release.wait, daemon=True)
    reader.start()
    process = SimpleNamespace(stdin=Pipe(), stdout=Pipe(), wait=Mock(return_value=0))
    resources = cleanup_fixture(tmp_path, process=process, reader=reader)
    try:
        began = time.monotonic()
        capture._cleanup_capture(**resources)
        assert time.monotonic() - began < 3
        assert process.stdout.close_calls == 0
        assert 'collector_cleanup_reader_still_running' in processor_retirement_reasons()
        resources['broker'].close.assert_called_once()
        resources['guard'].server_close.assert_called_once()
    finally:
        release.set()
        reader.join(1)


def test_writer_in_flight_cannot_make_cleanup_wait_indefinitely(tmp_path):
    lock = threading.Lock()
    lock.acquire()
    process = SimpleNamespace(stdin=Pipe(), stdout=Pipe(), wait=Mock(return_value=0))
    resources = cleanup_fixture(tmp_path, process=process, write_lock=lock)
    try:
        began = time.monotonic()
        capture._cleanup_capture(**resources)
        assert time.monotonic() - began < 3
        assert process.stdin.close_calls == 0
        assert 'collector_cleanup_close_stream' in processor_retirement_reasons()
        resources['broker'].close.assert_called_once()
    finally:
        lock.release()


def test_total_cleanup_deadline_bounds_a_stuck_process_wait(tmp_path):
    release = threading.Event()
    process = SimpleNamespace(stdin=Pipe(), stdout=Pipe(), wait=lambda **_kwargs: release.wait())
    resources = cleanup_fixture(tmp_path, process=process)
    try:
        began = time.monotonic()
        capture._cleanup_capture(**resources, timeout=.05)
        assert time.monotonic() - began < .5
        assert 'collector_cleanup_wait_driver' in processor_retirement_reasons()
        assert resources['stop_reader'].is_set() and resources['stop_writes'].is_set()
    finally:
        release.set()


def test_executor_callback_cannot_write_after_cleanup_starts(tmp_path, monkeypatch):
    class DeferredExecutor:
        def __init__(self):
            self.callbacks = []
            self.calls = 0
        def submit(self, *_args):
            return SimpleNamespace(add_done_callback=self.callbacks.append)
        def shutdown(self, **_kwargs):
            self.calls += 1
            if self.calls == 2:
                for callback in self.callbacks:
                    callback(SimpleNamespace(cancelled=lambda: False, result=lambda: {'type': 'reply', 'id': 7, 'body': PRIVATE}))
    invoke, driver, _, _ = run_capture(tmp_path, monkeypatch, executor=DeferredExecutor())
    assert invoke()['video_id'] == VIDEO
    assert not any(PRIVATE in attempt for attempt in driver.stdin.write_attempts)


def test_logging_failure_never_replaces_the_capture_result(tmp_path, monkeypatch):
    invoke, _, _, _ = run_capture(tmp_path, monkeypatch, stream='stdin')
    original = capture.logging.getLogger
    broken = SimpleNamespace(warning=Mock(side_effect=OSError(22, PRIVATE)))
    monkeypatch.setattr(capture.logging, 'getLogger', lambda name=None: broken if name == capture.__name__ else original(name))
    assert invoke()['video_id'] == VIDEO
    assert processor_retirement_reasons()


@pytest.mark.parametrize('closed', [True, False])
def test_browser_close_acknowledgement_marks_only_unconfirmed_cleanup_for_retirement(tmp_path, monkeypatch, closed):
    invoke, _, _, _ = run_capture(tmp_path, monkeypatch, cleanup={'browser_closed': closed})
    assert invoke()['video_id'] == VIDEO
    assert bool(processor_retirement_reasons()) is not closed


def test_subsequent_capture_has_fresh_pipe_and_business_state(tmp_path, monkeypatch):
    first = tmp_path / 'first'
    second = tmp_path / 'second'
    invoke, _, _, _ = run_capture(first, monkeypatch, stream='stdin')
    assert invoke()['video_id'] == VIDEO
    reset_processor_health()  # The owner retires dirty processors between tasks.
    invoke, driver, _, _ = run_capture(second, monkeypatch)
    assert invoke()['video_id'] == VIDEO
    assert driver.stdin.close_calls == driver.stdout.close_calls == 1
    assert not processor_retirement_reasons()


@pytest.mark.parametrize('scenario,closed', [('none', True), ('success', True), ('reject', False), ('hang', False), ('throw', False)])
def test_real_node_finally_reports_browser_close_without_changing_business_result(scenario, closed):
    if not shutil.which('node'):
        pytest.skip('Node is required for the offline driver protocol test')
    script = r"""import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync('node/capture-douyin.mjs','utf8');
const start=source.lastIndexOf('} finally {');
const end=source.indexOf('  for (const resolve of pending.values())',start);
if(start<0||end<0)throw Error('Production cleanup fragment missing');
const scenario=process.argv[1], delays=[];
const browser=scenario==='none'?null:{close:()=>{
 if(scenario==='throw')throw Error('synthetic close failure');
 if(scenario==='reject')return Promise.reject(Error('synthetic close rejection'));
 if(scenario==='hang')return new Promise(()=>{});
 return Promise.resolve();}};
const context=vm.createContext({browser,result:{type:'result',ok:false,code:'douyin_not_found'},
 sleep:ms=>{delays.push(ms);return new Promise(resolve=>setTimeout(resolve,10));}});
const result=await vm.runInContext('(async()=>{'+source.slice(start+'} finally {'.length,end)+'return result;})()',context);
console.log(JSON.stringify({result,delays}));"""
    completed = subprocess.run([shutil.which('node'), '--input-type=module', '-e', script, scenario],
        cwd=capture.PROJECT, capture_output=True, text=True, encoding='utf-8', timeout=5, check=False)
    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)
    assert result['result'] == {'type': 'result', 'ok': False, 'code': 'douyin_not_found', 'cleanup': {'browser_closed': closed}}
    assert result['delays'] == ([] if scenario == 'none' else [5000])
