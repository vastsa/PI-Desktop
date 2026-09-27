#!/usr/bin/env python3
"""One-time platform API key setup; no Codex credentials and no extra packages."""
import argparse
import getpass
import os
import sys
from platform_client import AUTH_HELP, PLATFORM_ONBOARDING, Client, ClientError, DEFAULT_BASE, atomic_write, config_path, credentials, entry, http_url


def run(argv):
    parser = argparse.ArgumentParser(description='AI聚合平台 API Key 配置：' + PLATFORM_ONBOARDING)
    parser.add_argument('action', nargs='?', choices=('status', 'set', 'check', 'path', 'clear'), default='status')
    parser.add_argument('--key', help='直接保存用户提供的 API Key；也支持交互输入或 stdin')
    parser.add_argument('--base-url', default=DEFAULT_BASE)
    args = parser.parse_args(argv)
    path = config_path()
    if args.action == 'path':
        return {'credentials_file': str(path)}
    if args.action == 'clear':
        path.unlink(missing_ok=True)
        return {'cleared': True}
    if args.action == 'set':
        print(PLATFORM_ONBOARDING, file=sys.stderr)
        key = args.key
        if key is None:
            key = getpass.getpass('AI聚合平台 API Key: ') if sys.stdin.isatty() else sys.stdin.read()
        key = key.strip()
        if not key or any(c.isspace() for c in key):
            raise ClientError('API Key 不能为空或包含空白字符')
        base = http_url(args.base_url).rstrip('/')
        atomic_write(path, f'BASE_URL={base}\nAPI_KEY={key}\n'.encode('utf-8'))
        if os.name != 'nt':
            path.chmod(0o600)
        return {'configured': True, 'credentials_file': str(path), 'base_url': base, 'verified': False,
                'next': '已写入。直接运行生图/视频脚本即可；auth.py check 可选检查，不产生生成费用。'}
    key, base = credentials()
    if args.action == 'check':
        data, _ = Client().request('/models')
        if not isinstance(data.get('data'), list):
            raise ClientError('认证检查未返回模型列表')
        return {'configured': True, 'verified': True, 'model_count': len(data['data']),
                'note': '任务插件模型不一定列在 /v1/models 中；H3 可用性以实际视频请求为准。'}
    result = {'configured': bool(key), 'base_url': base, 'credentials_file': str(path)}
    if not key:
        result['next'] = AUTH_HELP
        print(AUTH_HELP, file=sys.stderr)
    return result


if __name__ == '__main__':
    entry(run)
