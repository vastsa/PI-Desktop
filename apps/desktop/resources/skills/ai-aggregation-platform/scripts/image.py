#!/usr/bin/env python3
"""Standalone image generation/edit. --n fans out bounded concurrent n=1 requests."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import math
from pathlib import Path
import sys
import time
from platform_client import Client, ClientError, atomic_write, entry, image_format, image_reference, prompt_args, read_prompt, reserve_receipt, save_receipt

def billing(client, journal):
    request_id = journal.get('request_id')
    result = {'verified': False, 'request_id': request_id, 'source': '/api/log/token'}
    if not request_id:
        return {**result, 'reason': '缺少平台 request_id，无法准确关联图片扣费'}
    logs, _ = client.request('/api/log/token')
    rows = [r for r in logs.get('data', []) if r.get('request_id') == request_id and r.get('type') in (2, 6)]
    if not rows or len([r for r in rows if r['type'] == 2]) != 1:
        return {**result, 'reason': '最近日志未找到唯一匹配扣费，不能认为免费'}
    quota = sum(r['quota']*(1 if r['type'] == 2 else -1) for r in rows)
    status, _ = client.request('/api/status', public=True)
    unit = status.get('data', {}).get('quota_per_unit')
    result['net_quota'] = quota
    if not isinstance(unit, (int, float)) or not math.isfinite(unit) or unit <= 0:
        return {**result, 'reason': '无法取得 quota_per_unit'}
    records = []
    for row in rows:
        other = row.get('other') or {}
        if isinstance(other, str):
            other = json.loads(other)
        records.append({**{k: row.get(k) for k in ('type', 'quota', 'model_name', 'group', 'request_id')},
                        'other': {k: other[k] for k in ('model_price', 'group_ratio', 'user_group_ratio', 'billing_mode') if k in other}})
    return {**result, 'records': records, 'net_usd': quota/unit, 'quota_per_unit': unit,
            'verified': journal.get('state') == 'completed' and quota >= 0,
            'reason': '匹配图片 request_id 的近期消费日志，非完整钱包审计'}


def output_paths(out, count):
    path = Path(out).resolve()
    return [path] if count == 1 else [path.with_name(f'{path.stem}-{i+1}{path.suffix}') for i in range(count)]


def download_one(client, journal, receipt):
    raw = journal.get('response') or {}
    items = raw.get('data')
    out = Path(journal['out'])
    if not items and journal.get('state') == 'completed':
        # Compatibility with older receipts which removed inline base64 after download.
        result = journal['result']
        for item in result['images']:
            path = Path(item['file'])
            if not path.is_file() or path.stat().st_size != item['bytes']:
                raise ClientError('旧回执未保留原始响应且文件已移除/修改，不能再次下载')
        return result
    if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict):
        raise ClientError('单次请求没有返回恰好一张图片；响应已保留，不自动重发')
    item = items[0]
    encoded, url = item.get('b64_json'), item.get('url') or ''
    if not encoded and url.startswith('data:'):
        encoded = image_reference(url).split(',', 1)[1]
    if encoded:
        try:
            data = base64.b64decode(encoded, validate=True)
        except ValueError as exc:
            raise ClientError('服务端图片 base64 无效，回执已保留') from exc
    elif url:
        data = client.binary(url, limit=50*1024*1024)
    else:
        raise ClientError('图片响应缺少 b64_json 或 URL')
    fmt = image_format(data)
    if out.exists():
        if not out.is_file() or out.read_bytes() != data:
            raise ClientError(f'输出已存在且内容不同，不覆盖：{out}')
    else:
        atomic_write(out, data)
    result = {'images': [{'file': str(out), 'bytes': len(data), 'format': fmt}], 'model': journal['model'],
              'request_id': journal.get('request_id', ''), 'receipt': str(receipt), 'usage': raw.get('usage'), 'status': 'completed'}
    if journal.get('count', 1) != 1:
        result['warning'] = f'恢复旧版请求：请求 {journal["count"]} 张但上游仅返回1张；此处只恢复已返回的1张，不新建请求'
    journal['state'] = 'completed'
    try:
        result['billing'] = billing(client, journal)
    except ClientError as exc:
        result['billing'] = {'verified': False, 'reason': str(exc)}
    journal['result'] = result
    journal.pop('error', None)
    save_receipt(receipt, journal)
    return result


def generate_one(payload, journal, receipt):
    client = Client()
    journal['state'] = 'submitting'
    save_receipt(receipt, journal)
    try:
        raw, request_id = client.request(journal['endpoint'], payload)
    except ClientError as exc:
        journal.update(state='error_or_unknown', error=str(exc).replace(client.key, '[REDACTED]'))
        save_receipt(receipt, journal)
        raise
    journal.update(state='received', response=raw, request_id=request_id)
    save_receipt(receipt, journal)
    try:
        return download_one(client, journal, receipt)
    except ClientError as exc:
        journal.update(state='download_failed', error=str(exc).replace(client.key, '[REDACTED]'))
        save_receipt(receipt, journal)
        raise


def batch_result(journal, receipt):
    results = [item['result'] for item in journal['items'] if item.get('result')]
    errors = [{'receipt': item['receipt'], 'error': item.get('error', '未完成；查询子回执，不重新生成')} for item in journal['items'] if not item.get('result')]
    charges = [result.get('billing', {}) for result in results]
    verified = not errors and len(charges) == journal['count'] and all(b.get('verified') for b in charges)
    bill = {'verified': verified, 'requests': charges}
    if verified:
        bill['net_usd'] = sum(b['net_usd'] for b in charges)
    result = {'status': 'partial_failed' if errors else 'completed', 'model': journal['model'], 'requested': journal['count'],
              'completed': len(results), 'images': [image for result in results for image in result['images']],
              'receipt': str(receipt), 'errors': errors, 'billing': bill}
    journal.update(state=result['status'], result=result)
    save_receipt(receipt, journal)
    if errors:
        result['_exit_code'] = 1
    return result


def run(argv):
    action = argv.pop(0) if argv and argv[0] in ('generate', 'edit', 'download', 'billing') else 'generate'
    parser = argparse.ArgumentParser(description='生图/改图；--n 在本地并发多次请求，每次只生成1张')
    if action in ('download', 'billing'):
        parser.add_argument('receipt')
        args = parser.parse_args(argv)
        client = Client()
        receipt = Path(args.receipt).resolve()
        journal = json.loads(receipt.read_text(encoding='utf-8'))
        if journal.get('kind') != 'image_batch':
            return billing(client, journal) if action == 'billing' else download_one(client, journal, receipt)
        if action == 'billing':
            charges = [billing(client, json.loads(Path(item['receipt']).read_text(encoding='utf-8'))) for item in journal['items']]
            verified = all(c.get('verified') for c in charges)
            return {'verified': verified, 'requests': charges, 'net_usd': sum(c['net_usd'] for c in charges) if verified else None}
        for item in journal['items']:
            child_receipt = Path(item['receipt'])
            child = json.loads(child_receipt.read_text(encoding='utf-8'))
            try:
                item['result'] = download_one(client, child, child_receipt)
                item.pop('error', None)
            except ClientError as exc:
                item.pop('result', None)
                item['error'] = str(exc).replace(client.key, '[REDACTED]')
        return batch_result(journal, receipt)
    prompt_args(parser)
    parser.add_argument('--ref', '--image', action='append', default=[])
    parser.add_argument('--mask')
    parser.add_argument('--quality', choices=('fast', 'high'), default='fast')
    parser.add_argument('--model')
    parser.add_argument('--n', type=int, choices=range(1, 11), default=1, help='本地生成数量1–10，每张单独请求/计费，上游 n 固定1')
    parser.add_argument('--concurrency', type=int, choices=range(1, 5), default=2, help='最大并发1–4，默认2')
    parser.add_argument('--ratio', choices=('1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'))
    parser.add_argument('--out')
    parser.add_argument('--receipt')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    if not args.dry_run:
        Client()  # Gate before reading stdin/materials; workers reuse the same credential contract.
    prompt = read_prompt(args)
    if action == 'edit' and not args.ref:
        raise ClientError('改图至少需要一个 --ref 本地文件/URL')
    if args.mask and not args.ref:
        raise ClientError('--mask 需要至少一个 --ref')
    if len(args.ref) > 16:
        raise ClientError('最多支持 16 张参考图')
    if args.ratio:
        prompt += f'\n画面宽高比 {args.ratio}。'
    model = args.model or ('gpt-image-2.5-flare' if args.quality == 'fast' else 'gpt-image-2.5-sunburst')
    payload = {'model': model, 'prompt': prompt, 'n': 1}
    if args.ref:
        payload['images'] = [{'image_url': image_reference(value)} for value in args.ref]
    if args.mask:
        payload['mask'] = {'image_url': image_reference(args.mask)}
    endpoint = '/images/edits' if args.ref else '/images/generations'
    out = Path(args.out or f'image-{time.time_ns()}.png').resolve()
    receipt = Path(args.receipt or str(out)+'.request.json').resolve()
    if args.dry_run:
        return {'dry_run': True, 'endpoint': endpoint, 'model': model, 'requests': args.n, 'n_per_request': 1,
                'concurrency': min(args.n, args.concurrency), 'prompt': prompt, 'reference_count': len(args.ref), 'mask': bool(args.mask),
                'outputs': [str(p) for p in output_paths(out, args.n)]}
    journal = {'kind': 'image', 'state': 'prepared', 'model': model, 'count': 1,
               'out': str(out), 'endpoint': endpoint, 'prompt': prompt,
               'references': ['(data URL)' if ref.startswith('data:') else ref for ref in args.ref]}
    if args.n == 1:
        reserve_receipt(out, receipt, journal)
        return generate_one(payload, journal, receipt)
    outputs = output_paths(out, args.n)
    child_receipts = [Path(str(path)+'.request.json') for path in outputs]
    if receipt in child_receipts or any(p.exists() for p in child_receipts):
        raise ClientError('批量子回执已存在或与总回执重名；请 download 恢复，不要重复生成')
    batch = {'kind': 'image_batch', 'state': 'prepared', 'model': model, 'count': args.n, 'concurrency': args.concurrency,
             'out': str(out), 'items': [{'receipt': str(p)} for p in child_receipts]}
    reserve_receipt(out, receipt, batch, outputs)
    children = [{**journal, 'out': str(path)} for path in outputs]
    for path, child_receipt, child in zip(outputs, child_receipts, children):
        reserve_receipt(path, child_receipt, child)
    executor = ThreadPoolExecutor(max_workers=min(args.n, args.concurrency))
    futures = {executor.submit(generate_one, payload, child, child_receipt): i for i, (child, child_receipt) in enumerate(zip(children, child_receipts))}
    try:
        for future in as_completed(futures):
            i = futures[future]
            try:
                batch['items'][i]['result'] = future.result()
                print(f'image {i+1}/{args.n}: completed', file=sys.stderr)
            except (ClientError, OSError, ValueError) as exc:
                batch['items'][i]['error'] = str(exc)
                print(f'image {i+1}/{args.n}: failed; receipt={child_receipts[i]}', file=sys.stderr)
            save_receipt(receipt, batch)
    except KeyboardInterrupt:
        for future in futures:
            future.cancel()
        batch['state'] = 'interrupted'
        save_receipt(receipt, batch)
        raise
    finally:
        executor.shutdown(wait=True, cancel_futures=True)
    return batch_result(batch, receipt)


if __name__ == '__main__':
    entry(run)
