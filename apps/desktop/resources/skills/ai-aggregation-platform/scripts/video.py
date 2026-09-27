#!/usr/bin/env python3
"""Standalone MiniMax-H3 video lifecycle; JSON URLs and local multipart media."""
import argparse
import base64
import json
import math
import os
import tempfile
from pathlib import Path
import shutil
import subprocess
import sys
import time
from platform_client import Client, ClientError, FAILED, PENDING, SUCCESS, atomic_write, entry, media_source, number, prompt_args, read_prompt, reserve_receipt, save_receipt, task_info, task_path

MODEL = 'MiniMax-H3'
RATIOS = ('adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16')


def probe_media(path, kind='video'):
    if not shutil.which('ffprobe'):
        return {'verified': False, 'reason': 'ffprobe 未安装，仅验证文件类型/视频容器；可正常提交和下载'}
    try:
        proc = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
                               'format=duration:stream=codec_type,codec_name,width,height,duration',
                               '-of', 'json', str(path)], capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired as exc:
        raise ClientError('媒体探测超时') from exc
    if proc.returncode:
        raise ClientError('ffprobe 检测到损坏素材：' + proc.stderr[:500])
    data = json.loads(proc.stdout)
    if not any(s.get('codec_type') == kind for s in data.get('streams', [])):
        raise ClientError(f'文件没有 {kind} 流')
    duration = float(data.get('format', {}).get('duration', '0'))
    if not math.isfinite(duration) or duration <= 0:
        raise ClientError('媒体时长无效')
    return {**data, 'verified': True}


def billing(client, task_id, raw=None):
    task_path(task_id)
    if raw is None:
        raw, _ = client.request(task_path(task_id), task_status=True)
    state = task_info(raw)['status']
    result = {'task_id': task_id, 'status': state, 'verified': False, 'source': '/api/log/token', 'records': []}
    logs, _ = client.request('/api/log/token')
    for row in logs.get('data') or []:
        other = row.get('other') or {}
        if isinstance(other, str):
            try:
                other = json.loads(other)
            except ValueError:
                continue
        if not isinstance(other, dict) or other.get('task_id') != task_id or row.get('type') not in (2, 6):
            continue
        clean = {k: row.get(k) for k in ('created_at', 'type', 'quota', 'model_name', 'group', 'request_id')}
        clean['other'] = {k: other[k] for k in ('billing_mode', 'usage_facts', 'group_ratio', 'user_group_ratio', 'matched_tier', 'pre_consumed_quota', 'actual_quota', 'reason') if k in other}
        if other.get('expr_b64'):
            clean['other']['expression'] = base64.b64decode(other['expr_b64']).decode('utf-8')
        result['records'].append(clean)
    records = result['records']
    initial = [r for r in records if r['type'] == 2 and 'pre_consumed_quota' not in r['other']]
    if len(initial) != 1:
        result['reason'] = '最近令牌日志缺失/重复初始扣费，不能判断免费或最终金额'
        return result
    if any(not isinstance(r['quota'], int) or r['quota'] < 0 for r in records):
        raise ClientError('计费日志 quota 无效')
    net = sum(r['quota'] * (1 if r['type'] == 2 else -1) for r in records)
    result['net_quota'] = net
    status, _ = client.request('/api/status', public=True)
    unit = status.get('data', {}).get('quota_per_unit')
    if not isinstance(unit, (int, float)) or not math.isfinite(unit) or unit <= 0:
        result['reason'] = '无法取得 quota_per_unit，不能换算美元'
        return result
    result.update(quota_per_unit=unit, net_usd=net/unit)
    actual = next((r['other']['actual_quota'] for r in records if 'actual_quota' in r['other']), None)
    result['verified'] = (state in SUCCESS and net >= 0 and (actual is None or actual == net)) or (state in FAILED and net == 0)
    result['reason'] = '终态与最近扣费/退款日志一致（非完整钱包审计）' if result['verified'] else '结算/退款未完成或日志不完整'
    return result


def run(argv):
    action = argv.pop(0) if argv and argv[0] in ('generate', 'create', 'status', 'wait', 'download', 'billing') else 'generate'
    parser = argparse.ArgumentParser(description='MiniMax-H3：生视频、图片/视频/音频参考、查询/恢复/下载/核对扣费')
    creating = action in ('generate', 'create')
    if creating:
        prompt_args(parser)
        parser.add_argument('--model', choices=(MODEL,), default=MODEL)
        parser.add_argument('--seconds', type=int, choices=range(4, 16), default=4)
        parser.add_argument('--resolution', choices=('768P', '2K'), default='768P')
        parser.add_argument('--ratio', choices=RATIOS, default='16:9')
        for kind in ('image', 'video', 'audio'):
            parser.add_argument('--'+kind, action='append', default=[], help='可重复：本地文件 / URL / data URL')
        parser.add_argument('--dry-run', action='store_true')
    else:
        parser.add_argument('task_id')
    parser.add_argument('--out')
    parser.add_argument('--receipt')
    parser.add_argument('--poll-interval', type=lambda v: number(v, 1, 300), default=5)
    parser.add_argument('--timeout', type=lambda v: number(v, 1, 86400), default=1800, help='轮询总秒数；超时用 wait 恢复，不重新提交')
    args = parser.parse_args(argv)
    client = None if creating and args.dry_run else Client()
    payload, files = None, []
    if creating:
        prompt = read_prompt(args)
        content = [{'type': 'text', 'text': prompt}]
        sources = []
        total = 0
        if sum(len(getattr(args, kind)) for kind in ('image', 'video', 'audio')) > 16:
            raise ClientError('最多 16 个参考素材；实际组合还需满足上游限制')
        for kind in ('image', 'video', 'audio'):
            for value in getattr(args, kind):
                url, local = media_source(value, kind)
                item = {'kind': kind, 'source': value if not value.startswith('data:') else '(data URL)'}
                if local:
                    path, mime = local
                    total += path.stat().st_size
                    if kind != 'image':
                        item['media'] = probe_media(path, kind)
                    files.append(('reference_'+kind, path, mime))
                else:
                    content.append({'type': kind+'_url', 'role': 'reference_'+kind, kind+'_url': {'url': url}})
                sources.append(item)
        if total > 180*1024*1024:
            raise ClientError('本地素材总大小不能超过 180 MiB')
        payload = {'model': MODEL, 'prompt': prompt, 'seconds': args.seconds,
                   'metadata': {'metaso_resolution': args.resolution, 'metaso_ratio': args.ratio, 'metaso_content': content}}
        if args.dry_run:
            return {'dry_run': True, 'model': MODEL, 'prompt': prompt, 'seconds': args.seconds,
                    'resolution': args.resolution, 'ratio': args.ratio, 'encoding': 'multipart' if files else 'json', 'sources': sources}
    if action == 'billing':
        return billing(client, args.task_id)
    if action == 'status':
        raw, rid = client.request(task_path(args.task_id), task_status=True)
        return {**task_info(raw), 'response': raw, 'request_id': rid}
    if creating:
        out = Path(args.out or f'video-{time.time_ns()}.mp4').resolve()
        receipt = Path(args.receipt or str(out)+'.task.json').resolve()
        journal = {'kind': 'video', 'model': MODEL, 'out': str(out), 'submission_state': 'submitting',
                   'prompt': prompt, 'seconds': args.seconds, 'resolution': args.resolution, 'ratio': args.ratio, 'sources': sources}
        reserve_receipt(out, receipt, journal)
        try:
            raw, rid = client.request('/videos', payload, files=files)
        except ClientError as exc:
            journal.update(submission_state='error_or_unknown', error=str(exc).replace(client.key, '[REDACTED]'))
            save_receipt(receipt, journal)
            raise
        info = task_info(raw)
        journal.update(create_response=raw, request_id=rid, **info)
        if not info['task_id']:
            journal['submission_state'] = 'unknown'
            save_receipt(receipt, journal)
            raise ClientError('提交响应没有任务 ID，回执已保存；不要自动重试：'+json.dumps(raw, ensure_ascii=False))
        task_id = info['task_id']
        task_path(task_id)
        journal['submission_state'] = 'accepted'
        save_receipt(receipt, journal)
        print(f'task_id={task_id}；回执：{receipt}；恢复：video.py wait {task_id} --receipt "{receipt}"', file=sys.stderr)
        if action == 'create':
            return {**info, 'receipt': str(receipt), 'request_id': rid}
    else:
        task_id = args.task_id
        task_path(task_id)
        # A receipt restores the original destination unless explicitly overridden.
        receipt = Path(args.receipt or (args.out or task_id+'.mp4')+'.task.json').resolve()
        journal = json.loads(receipt.read_text(encoding='utf-8')) if receipt.is_file() else {'kind': 'video', 'model': MODEL}
        if journal.get('task_id', task_id) != task_id:
            raise ClientError('receipt 与任务 ID 不匹配')
        out = Path(args.out or journal.get('out') or task_id+'.mp4').resolve()
        if out == receipt:
            raise ClientError('视频输出不能与 receipt 使用相同路径')
        if out.exists() and (journal.get('task_id') != task_id or Path(journal.get('out', '')).resolve() != out):
            raise ClientError('输出文件已存在，拒绝覆盖')
        journal['out'] = str(out)
        raw, _ = client.request(task_path(task_id), task_status=True, timeout=args.timeout)
    deadline = time.monotonic()+args.timeout
    while True:
        info = task_info(raw)
        journal.update(task_id=task_id, status=info['status'], status_response=raw)
        save_receipt(receipt, journal)
        state = info['status']
        if state in SUCCESS:
            break
        if state in FAILED:
            try:
                journal['billing'] = billing(client, task_id, raw)
            except ClientError as exc:
                journal['billing'] = {'verified': False, 'reason': str(exc)}
            save_receipt(receipt, journal)
            raise ClientError(f'任务 {task_id} 失败：{json.dumps(raw, ensure_ascii=False)}；错误和退款查询已保留于 {receipt}')
        if state not in PENDING:
            raise ClientError(f'未知任务状态 {state}；请 status 查询同一任务，不重新生成')
        if action == 'download':
            raise ClientError(f'任务未完成：{state}；请 video.py wait {task_id}')
        remaining = deadline-time.monotonic()
        if remaining <= 0:
            raise ClientError(f'等待超时但任务仍存在；video.py wait {task_id} --receipt "{receipt}"')
        print(f'{task_id}: {state} {info["progress"] or ""}', file=sys.stderr)
        time.sleep(min(args.poll_interval, remaining))
        remaining = deadline-time.monotonic()
        if remaining <= 0:
            continue
        raw, _ = client.request(task_path(task_id), task_status=True, timeout=remaining)
    data = client.binary(client.base + task_path(task_id)+'/content', authenticated=True)
    if len(data) < 12 or data[4:8] != b'ftyp':
        raise ClientError('服务端下载不是 MP4；未写入文件，请使用 download 重试，不重新生成')
    if out.exists() and out.read_bytes() != data:
        raise ClientError(f'输出已存在且内容不同，拒绝覆盖：{out}')
    out.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.video-', suffix='.mp4', dir=str(out.parent))
    try:
        with os.fdopen(fd, 'wb') as dest:
            dest.write(data)
        media = probe_media(temporary)
        os.replace(temporary, out)
    finally:
        Path(temporary).unlink(missing_ok=True)
    result = {'task_id': task_id, 'status': state, 'model': MODEL, 'file': str(out), 'bytes': len(data), 'media': media,
              'receipt': str(receipt), 'request_id': journal.get('request_id', '')}
    for k in ('seconds', 'resolution', 'ratio'):
        if k in journal:
            result[k] = journal[k]
    try:
        result['billing'] = billing(client, task_id, raw)
    except ClientError as exc:
        result['billing'] = {'verified': False, 'reason': str(exc)}
    journal['result'] = result
    save_receipt(receipt, journal)
    return result


if __name__ == '__main__':
    entry(run)
