"""Black-box CLI contracts. Uses local HTTP only; never spends user quota."""
import base64
from email import policy
from email.parser import BytesParser
import http.server
import json
import os
from pathlib import Path
import socket
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import zlib

SCRIPTS = Path(os.environ.get('AI_AGG_TEST_SCRIPTS', str(Path(__file__).resolve().parents[1] / 'scripts')))


def png():
    def chunk(kind, data):
        return struct.pack('!I', len(data))+kind+data+struct.pack('!I', zlib.crc32(kind+data))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR', struct.pack('!2I5B', 2, 2, 8, 2, 0, 0, 0))+chunk(b'IDAT', zlib.compress(b'\x00'+b'\x00\x80\xff'*2+b'\x00'+b'\x00\x80\xff'*2))+chunk(b'IEND', b'')


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, data, status=200, content_type='application/json'):
        body = json.dumps(data).encode() if isinstance(data, dict) else data
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Request-Id', 'test-request-id')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.server.seen.append(('GET', self.path, dict(self.headers), None))
        if self.path == '/v1/models':
            if self.headers.get('Authorization') != 'Bearer test-key':
                return self.reply({'error': {'message': 'bad key'}}, 401)
            return self.reply({'data': [{'id': 'text'}]})
        if self.path == '/v1/videos/task_test/content':
            if self.server.mode == 'bad_video':
                return self.reply(b'<html>bad</html>', content_type='video/mp4')
            self.send_response(302)
            self.send_header('Location', '/artifact.mp4')
            self.end_headers()
            return
        if self.path == '/artifact.mp4':
            return self.reply(self.server.mp4, content_type='video/mp4')
        if self.path in ('/image.png', '/reference.png'):
            return self.reply(png(), content_type='image/png')
        if self.path == '/v1/videos/task_test':
            state = 'failed' if self.server.mode == 'failed' else ('in_progress' if self.server.mode == 'pending' else 'completed')
            return self.reply({'id': 'task_test', 'status': state, 'error': {'message': 'upstream denied'} if state == 'failed' else None})
        if self.path == '/api/log/token':
            log = {'type': 2, 'quota': 100000, 'other': json.dumps({'task_id': 'task_test', 'usage_facts': {'seconds': 4, 'resolution': '768P'}})}
            rows = [log]
            if self.server.mode == 'failed':
                rows.append({'type': 6, 'quota': 100000, 'other': '{"task_id":"task_test"}'})
            return self.reply({'success': True, 'data': rows})
        if self.path == '/api/status':
            return self.reply({'data': {'quota_per_unit': 500000}})
        return self.reply({'error': 'not found'}, 404)

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        with self.server.lock:
            self.server.post_count += 1
            post_number = self.server.post_count
            self.server.seen.append(('POST', self.path, dict(self.headers), body))
        mode = self.server.mode
        if mode == 'drop':
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        if mode == 'html':
            return self.reply(b'<html>bad gateway</html>', content_type='text/html')
        if mode == 'bad_request':
            return self.reply({'error': {'message': 'unknown model'}}, 400)
        if self.path == '/v1/videos':
            return self.reply({'id': 'task_test', 'status': 'queued'})
        payload = json.loads(body)
        if self.path.startswith('/v1/images/'):
            if self.server.barrier is not None:
                try:
                    self.server.barrier.wait(timeout=5)
                except threading.BrokenBarrierError:
                    return self.reply({'error': 'requests were not concurrent'}, 500)
            if mode == 'partial' and post_number == 1:
                return self.reply({'error': 'first item rejected'}, 400)
            item = {'b64_json': base64.b64encode(png()).decode()}
            if mode == 'url':
                item = {'url': self.server.base+'/image.png'}
            elif mode == 'bad_image':
                item = {'b64_json': base64.b64encode(b'<html>oops</html>').decode()}
            count = 2 if mode == 'extra_image' else payload['n']
            return self.reply({'data': [item for _ in range(count)]})
        if self.path == '/v1/chat/completions':
            return self.reply({'choices': [{'message': {'content': '测试回复'}}]})
        return self.reply({'error': 'not found'}, 404)


class CLIContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.server.base = f'http://127.0.0.1:{cls.server.server_port}'
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.server.mp4 = (Path(__file__).resolve().parent/'fixtures'/'clip.mp4').read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='中文 space ')
        self.root = Path(self.temp.name)
        self.env = {**os.environ, 'AI_AGG_CONFIG_DIR': str(self.root/'config'), 'AI_AGG_API_KEY': '', 'AI_AGG_TIMEOUT': '3', 'PYTHONDONTWRITEBYTECODE': '1'}
        self.server.mode = ''
        self.server.seen = []
        self.server.barrier = None
        self.server.lock = threading.Lock()
        self.server.post_count = 0
        self.out = self.root/'输出 file.png'
        self.ref = self.root/'参考 image.png'
        self.ref.write_bytes(png())
        self.invoke('auth', 'set', '--key', 'test-key', '--base-url', self.server.base+'/v1')

    def tearDown(self):
        self.temp.cleanup()

    def invoke(self, script, *args, success=True, stdin=None):
        proc = subprocess.run([sys.executable, str(SCRIPTS/(script+'.py')), *map(str, args)], input=stdin, text=True,
                              encoding='utf-8', capture_output=True, env=self.env, timeout=20)
        if success:
            self.assertEqual(proc.returncode, 0, proc.stderr)
            return json.loads(proc.stdout)
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertNotIn('Traceback', proc.stderr)
        return proc

    def test_missing_auth_every_entry(self):
        self.invoke('auth', 'clear')
        self.env['OPENAI_API_KEY'] = 'do-not-read'
        for cmd in ('image', 'video', 'text'):
            with self.subTest(cmd=cmd):
                proc = self.invoke(cmd, '测试', success=False)
                self.assertEqual(proc.returncode, 3)
                self.assertIn('AUTH_REQUIRED', proc.stderr)
                self.assertIn('https://ai.yykkj.com', proc.stderr)
                self.assertIn('注册', proc.stderr)
                self.assertIn('充值', proc.stderr)
        self.assertEqual(len(self.server.seen), 0)

    def test_auth_write_without_network_and_check(self):
        self.assertEqual(len(self.server.seen), 0)
        self.assertTrue(self.invoke('auth', 'check')['verified'])
        self.invoke('auth', 'set', '--base-url', self.server.base+'/v1', stdin='new-test-key\n')
        self.assertIn('API_KEY=new-test-key', (self.root/'config'/'credentials').read_text())
        failed = self.invoke('auth', 'check', success=False)
        self.assertIn('HTTP 401', failed.stderr)
        self.assertNotIn('new-test-key', failed.stderr)

    def test_explicit_environment_bypasses_standalone_file_and_desktop_pins_origin(self):
        # Invalid UTF-8 makes accidental credential-file reads fail while the
        # explicit environment must remain authoritative.
        credentials = self.root/'config'/'credentials'
        credentials.write_bytes(b'\xff\xff')
        self.env.update(AI_AGG_API_KEY='test-key', AI_AGG_BASE_URL=self.server.base+'/v1')
        result = self.invoke('image', 'environment auth', '--out', self.out)
        self.assertEqual(result['status'], 'completed')
        count = len(self.server.seen)
        env = {**self.env, 'AI_AGG_DESKTOP': '1'}
        probe = 'import platform_client as p; assert p.credentials() == ("test-key", p.DEFAULT_BASE); assert p.Client(base="http://invalid.example/v1").base == p.DEFAULT_BASE'
        proc = subprocess.run([sys.executable, '-B', '-c', probe], cwd=SCRIPTS,
                              env=env, text=True, capture_output=True, timeout=5)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(len(self.server.seen), count)

    def test_generation_batch_and_unicode_path(self):
        self.server.barrier = threading.Barrier(2)
        result = self.invoke('image', '一个 "蓝色" 小船\n第二行', '--n', '2', '--out', self.out)
        self.assertEqual(len(result['images']), 2)
        self.assertTrue(all(Path(i['file']).read_bytes() == png() for i in result['images']))
        posts = [r for r in self.server.seen if r[0] == 'POST']
        self.assertEqual(len(posts), 2)
        self.assertTrue(all(json.loads(p[3])['n'] == 1 for p in posts))
        self.assertIn('第二行', json.loads(posts[0][3])['prompt'])

    def test_edit_multiple_sources_mask_and_url_download(self):
        self.server.mode = 'url'
        result = self.invoke('image', 'edit', '修改颜色', '--ref', self.ref, '--ref', self.server.base+'/reference.png', '--mask', self.ref, '--out', self.out)
        post = next(r for r in self.server.seen if r[0] == 'POST')
        self.assertEqual(post[1], '/v1/images/edits')
        body = json.loads(post[3])
        self.assertEqual(len(body['images']), 2)
        self.assertTrue(body['images'][0]['image_url'].startswith('data:image/png;base64,'))
        self.assertIn('mask', body)
        get = next(r for r in self.server.seen if r[1] == '/image.png')
        self.assertNotIn('Authorization', get[2])
        self.assertEqual(Path(result['images'][0]['file']).read_bytes(), png())

    def test_invalid_inputs_never_submit(self):
        cases = [('image', 'x', '--n', '0'), ('image', 'x', '--n', '999999999'), ('image', 'edit', 'x'),
                 ('image', 'x', '--ref', str(self.root/'missing.png')), ('image', 'x', '--ratio', 'wrong'),
                 ('video', 'x', '--seconds', '3'), ('video', 'x', '--seconds', '16'), ('video', 'x', '--seconds', '4.2'),
                 ('video', 'x', '--timeout', 'nan'), ('video', 'x', '--resolution', '4K'), ('image', '', '--out', str(self.out))]
        for case in cases:
            with self.subTest(case=case):
                self.invoke(*case, success=False, stdin='')
        self.assertEqual(len(self.server.seen), 0)

    def test_post_errors_never_retry_and_save_receipt(self):
        for i, mode in enumerate(('drop', 'html', 'bad_request')):
            with self.subTest(mode=mode):
                self.server.mode = mode
                out = self.root/f'failed-{i}.png'
                self.invoke('image', '测试', '--out', out, success=False)
                receipt = json.loads(Path(str(out)+'.request.json').read_text())
                self.assertEqual(receipt['state'], 'error_or_unknown')
                self.assertFalse(out.exists())
        self.assertEqual(len([r for r in self.server.seen if r[0] == 'POST']), 3)

    def test_receipt_and_existing_file_prevent_double_charge(self):
        self.invoke('image', '测试', '--out', self.out)
        self.invoke('image', '测试', '--out', self.out, success=False)
        another = self.root/'another.png'
        another.write_bytes(b'existing')
        self.invoke('image', '测试', '--out', another, success=False)
        self.assertEqual(another.read_bytes(), b'existing')
        self.assertEqual(len([r for r in self.server.seen if r[0] == 'POST']), 1)

    def test_bad_image_and_partial_batch_do_not_claim_success(self):
        for i, mode in enumerate(('bad_image', 'extra_image')):
            self.server.mode = mode
            out = self.root/f'{i}.png'
            self.invoke('image', '测试', '--out', out, '--n', '2', success=False)
            self.assertFalse(out.exists())

    def test_prompt_file_and_stdin(self):
        prompt = self.root/'提示词.txt'
        prompt.write_text('蓝色船\n多行提示词', encoding='utf-8')
        result = self.invoke('text', '--prompt-file', prompt)
        self.assertEqual(result['text'], '测试回复')
        self.invoke('text', stdin='来自 stdin 的提示词')
        prompts = [json.loads(r[3])['messages'][-1]['content'] for r in self.server.seen if r[0] == 'POST']
        self.assertEqual(prompts, ['蓝色船\n多行提示词', '来自 stdin 的提示词'])

    def test_video_local_multipart_and_reference_url(self):
        local_video = self.root/'参考 video.mp4'
        local_video.write_bytes(self.server.mp4)
        import wave
        audio = self.root/'参考 audio.wav'
        with wave.open(str(audio), 'wb') as dest:
            dest.setnchannels(1); dest.setsampwidth(2); dest.setframerate(16000); dest.writeframes(b'\0\0'*16000)
        result = self.invoke('video', 'create', '保持主体', '--image', self.ref, '--image', self.server.base+'/reference.png', '--video', local_video, '--audio', audio, '--out', self.root/'视频.mp4')
        self.assertEqual(result['task_id'], 'task_test')
        post = next(r for r in self.server.seen if r[0] == 'POST')
        message = BytesParser(policy=policy.default).parsebytes(('Content-Type: '+post[2]['Content-Type']+'\r\n\r\n').encode()+post[3])
        parts = list(message.iter_parts())
        fields = [part.get_param('name', header='content-disposition') for part in parts]
        self.assertIn('reference_image', fields); self.assertIn('reference_video', fields); self.assertIn('reference_audio', fields)
        metadata = json.loads(parts[fields.index('metadata')].get_payload(decode=True))
        self.assertEqual(metadata['metaso_content'][1]['image_url']['url'], self.server.base+'/reference.png')

    def test_video_lifecycle_content_redirect_and_billing(self):
        out = self.root/'视频.mp4'
        result = self.invoke('video', '测试', '--out', out, '--poll-interval', '1')
        self.assertEqual(result['media']['verified'], bool(shutil.which('ffprobe')))
        self.assertTrue(result['billing']['verified'])
        self.assertEqual(result['billing']['net_usd'], .2)
        self.assertEqual(out.read_bytes(), self.server.mp4)
        artifact = next(r for r in self.server.seen if r[1] == '/artifact.mp4')
        self.assertNotIn('Authorization', artifact[2])
        content = next(r for r in self.server.seen if r[1].endswith('/content'))
        self.assertEqual(content[2]['Authorization'], 'Bearer test-key')

    def test_timeout_resume_never_recreates(self):
        out = self.root/'resume.mp4'
        self.server.mode = 'pending'
        self.invoke('video', '测试', '--out', out, '--timeout', '1', success=False)
        receipt = Path(str(out)+'.task.json')
        self.assertEqual(json.loads(receipt.read_text())['task_id'], 'task_test')
        self.server.mode = ''
        result = self.invoke('video', 'wait', 'task_test', '--receipt', receipt)
        self.assertEqual(result['file'], str(out.resolve()))
        self.assertEqual(len([r for r in self.server.seen if r[0] == 'POST']), 1)

    def test_failed_task_receipt_and_refund(self):
        self.server.mode = 'failed'
        out = self.root/'failure.mp4'
        proc = self.invoke('video', '测试', '--out', out, success=False)
        self.assertIn('upstream denied', proc.stderr)
        receipt = json.loads(Path(str(out)+'.task.json').read_text())
        self.assertEqual(receipt['status'], 'failed')
        self.assertEqual(receipt['billing']['net_usd'], 0)
        self.assertTrue(receipt['billing']['verified'])
        self.assertFalse(out.exists())

    def test_corrupt_video_never_written(self):
        self.server.mode = 'bad_video'
        out = self.root/'failure.mp4'
        self.invoke('video', '测试', '--out', out, success=False)
        self.assertFalse(out.exists())


    def test_bash_wrapper_when_available(self):
        if os.name == 'nt' or not shutil.which('bash'):
            self.skipTest('Bash not applicable')
        proc = subprocess.run(['bash', str(SCRIPTS/'newapi.sh'), 'image', '中文路径测试', '--out', str(self.out)],
                              capture_output=True, text=True, encoding='utf-8', env=self.env, timeout=20)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(Path(json.loads(proc.stdout)['images'][0]['file']).read_bytes(), png())

    def test_powershell_wrapper_when_available(self):
        pwsh = os.environ.get('AI_AGG_PWSH') or shutil.which('pwsh') or shutil.which('powershell')
        if not pwsh:
            self.skipTest('PowerShell runtime not installed')
        prompt = self.root/'提示词 UTF8.txt'
        prompt.write_text('中文与 "quote"\n多行', encoding='utf-8')
        proc = subprocess.run([pwsh, '-NoLogo', '-NoProfile', '-File', str(SCRIPTS/'newapi.ps1'), 'image',
                               '--prompt-file', str(prompt), '--out', str(self.out)],
                              capture_output=True, text=True, encoding='utf-8', env=self.env, timeout=25)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(Path(json.loads(proc.stdout)['images'][0]['file']).read_bytes(), png())
        self.invoke('auth', 'clear')
        proc = subprocess.run([pwsh, '-NoLogo', '-NoProfile', '-File', str(SCRIPTS/'newapi.ps1'), 'video', 'test'],
                              capture_output=True, text=True, encoding='utf-8', env=self.env, timeout=25)
        self.assertEqual(proc.returncode, 3, proc.stderr)
        self.assertIn('AUTH_REQUIRED', proc.stderr)

    def test_dry_run_no_auth_no_network(self):
        self.invoke('auth', 'clear')
        self.invoke('image', '测试', '--ref', self.ref, '--dry-run')
        result = self.invoke('video', '测试', '--image', self.ref, '--dry-run')
        self.assertEqual(result['encoding'], 'multipart')
        self.assertEqual(self.server.seen, [])

    def test_download_saved_image_response_without_resubmitting(self):
        self.server.mode = 'bad_image'
        self.invoke('image', 'test', '--out', self.out, success=False)
        receipt = Path(str(self.out)+'.request.json')
        journal = json.loads(receipt.read_text())
        journal['response']['data'] = [{'url': self.server.base+'/image.png'}]
        receipt.write_text(json.dumps(journal), encoding='utf-8')
        self.invoke('image', 'download', receipt)
        self.assertEqual(len([r for r in self.server.seen if r[0] == 'POST']), 1)
        self.assertEqual(self.out.read_bytes(), png())

    def test_data_url_and_reject_malformed_media(self):
        url = 'data:image/png;base64,'+base64.b64encode(png()).decode()
        self.invoke('image', 'test', '--ref', url, '--out', self.out)
        self.invoke('video', 'create', 'test', '--image', url, '--out', self.root/'data.mp4')
        self.invoke('video', 'test', '--image', 'data:image/png;base64,not-real!', success=False)
        bad = self.root/'empty.mp4'
        bad.write_bytes(b'')
        self.invoke('video', 'test', '--video', bad, success=False)
        self.assertEqual(len([r for r in self.server.seen if r[0] == 'POST']), 2)

    def test_poll_receipt_mismatch_and_output_collision(self):
        out = self.root/'clip.mp4'
        self.invoke('video', 'create', 'test', '--out', out)
        receipt = Path(str(out)+'.task.json')
        self.invoke('video', 'wait', 'different_task', '--receipt', receipt, success=False)
        self.invoke('video', 'wait', 'task_test', '--receipt', receipt, '--out', receipt, success=False)
        self.assertEqual(len(self.server.seen), 1)

    def test_duplicate_batch_output_blocks_submission(self):
        first = self.out.with_name(self.out.stem+'-1'+self.out.suffix)
        first.write_bytes(b'keep')
        self.invoke('image', 'test', '--n', '2', '--out', self.out, success=False)
        self.assertEqual(first.read_bytes(), b'keep')
        self.assertEqual(self.server.seen, [])


    def test_batch_partial_failure_preserves_success_and_resume_does_not_post(self):
        self.server.mode = 'partial'
        proc = self.invoke('image', 'test', '--n', '2', '--out', self.out, success=False)
        result = json.loads(proc.stdout)
        self.assertEqual(result['status'], 'partial_failed')
        self.assertEqual(result['completed'], 1)
        success = Path(result['images'][0]['file'])
        self.assertEqual(success.read_bytes(), png())
        receipt = Path(str(self.out)+'.request.json')
        batch = json.loads(receipt.read_text())
        failed = next(item for item in batch['items'] if item.get('error'))
        self.assertEqual(json.loads(Path(failed['receipt']).read_text())['state'], 'error_or_unknown')
        self.invoke('image', 'download', receipt, success=False)
        self.assertEqual(self.server.post_count, 2)
        self.assertEqual(success.read_bytes(), png())

    def test_batch_serial_mode_and_collision_avoid_duplicate_requests(self):
        result = self.invoke('image', 'test', '--n', '3', '--concurrency', '1', '--out', self.out)
        self.assertEqual(result['completed'], 3)
        self.assertEqual(self.server.post_count, 3)
        self.invoke('image', 'test', '--n', '3', '--out', self.out, success=False)
        self.invoke('image', 'download', result['receipt'])
        self.assertEqual(self.server.post_count, 3)
        self.assertTrue(all(json.loads(row[3])['n'] == 1 for row in self.server.seen if row[0] == 'POST'))

    def test_recover_old_single_image_from_n2_response_without_new_charge(self):
        receipt = self.root/'legacy.json'
        receipt.write_text(json.dumps({'kind': 'image', 'count': 2, 'model': 'legacy', 'state': 'received',
            'out': str(self.out), 'response': {'data': [{'b64_json': base64.b64encode(png()).decode()}]}}))
        result = self.invoke('image', 'download', receipt)
        self.assertIn('warning', result)
        self.assertEqual(len(result['images']), 1)
        self.assertEqual(self.server.post_count, 0)


    def test_video_resume_after_download_before_receipt_result(self):
        out = self.root/'resume-saved.mp4'
        self.invoke('video', 'create', 'test', '--out', out)
        out.write_bytes(self.server.mp4)
        result = self.invoke('video', 'wait', 'task_test', '--receipt', str(out)+'.task.json')
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(self.server.post_count, 1)

    def test_image_batch_billing_does_not_claim_missing_logs_are_free(self):
        result = self.invoke('image', 'test', '--n', '2', '--out', self.out)
        charge = self.invoke('image', 'billing', result['receipt'])
        self.assertFalse(charge['verified'])
        self.assertIsNone(charge['net_usd'])
        self.assertEqual(self.server.post_count, 2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
