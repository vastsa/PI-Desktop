#!/usr/bin/env python3
"""Standalone text/vision chat; image inputs require a vision-capable selected model."""
import argparse
from platform_client import Client, ClientError, entry, image_reference, prompt_args, read_prompt


def run(argv):
    parser = argparse.ArgumentParser(description='文字对话；--image 可重复，需选择支持视觉的模型')
    prompt_args(parser)
    parser.add_argument('--model', default='deepseek-v4.1-flash')
    parser.add_argument('--system')
    parser.add_argument('--image', action='append', default=[])
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    client = None if args.dry_run else Client()
    prompt = read_prompt(args)
    content = prompt
    if args.image:
        content = [{'type': 'text', 'text': prompt}] + [{'type': 'image_url', 'image_url': {'url': image_reference(p)}} for p in args.image]
    messages = ([{'role': 'system', 'content': args.system}] if args.system else []) + [{'role': 'user', 'content': content}]
    if args.dry_run:
        return {'dry_run': True, 'model': args.model, 'prompt': prompt, 'image_count': len(args.image)}
    raw, rid = client.request('/chat/completions', {'model': args.model, 'messages': messages})
    if not raw.get('choices'):
        raise ClientError('服务端未返回 choices：'+str(raw))
    return {'text': raw['choices'][0].get('message', {}).get('content'), 'model': raw.get('model'), 'usage': raw.get('usage'), 'request_id': rid}


if __name__ == '__main__':
    entry(run)
