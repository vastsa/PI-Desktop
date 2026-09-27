"""Shared transport and credentials for the standalone AI聚合平台 commands (stdlib only)."""
import argparse
import base64
import json
import http.client
import ipaddress
import math
import mimetypes
import os
from pathlib import Path
import re
import ssl
import socket
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

DEFAULT_BASE = 'https://ai.yykkj.com/v1'
PLATFORM_ONBOARDING = ('请打开 https://ai.yykkj.com，注册账号并登录 → 在平台充值 → '
                       '进入「API 密钥 / 令牌」新建并复制本平台 Key。'
                       '已有账号或可用余额可跳过对应步骤。安装 Skill 不收费，实际生成消耗平台余额。')
AUTH_HELP = ('AUTH_REQUIRED：尚未配置 AI聚合平台 API Key。' + PLATFORM_ONBOARDING +
             '可以直接把 Key 提供给 AI，由 AI 写入；'
             '也可运行 python3 scripts/auth.py set（Windows: py -3 scripts/auth.py set）。')


class ClientError(Exception):
    pass


def config_path():
    if os.name == 'nt':
        root = Path(os.environ.get('APPDATA', str(Path.home() / 'AppData' / 'Roaming')))
    else:
        root = Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config')))
    return Path(os.environ.get('AI_AGG_CONFIG_DIR', str(root / 'ai-aggregation-platform'))) / 'credentials'


def credentials():
    # Desktop supplies both values and must never consult independent credentials.
    env_key = os.environ.get('AI_AGG_API_KEY')
    env_base = os.environ.get('AI_AGG_BASE_URL')
    if os.environ.get('AI_AGG_DESKTOP') == '1':
        return env_key or '', DEFAULT_BASE
    if env_key and env_base:
        return env_key, env_base.rstrip('/')
    values = {}
    path = config_path()
    if path.is_file():
        for line in path.read_text(encoding='utf-8-sig').splitlines():
            if '=' in line and not line.startswith('#'):
                k, v = line.split('=', 1)
                values[k.strip()] = v.strip()
    key = os.environ.get('AI_AGG_API_KEY') or values.get('API_KEY', '')
    base = (env_base or values.get('BASE_URL', DEFAULT_BASE)).rstrip('/')
    return key, base


def number(value, low=1, high=3600):
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError('需要有效数字') from exc
    if not math.isfinite(result) or not low <= result <= high:
        raise argparse.ArgumentTypeError(f'数值必须在 {low}–{high} 之间')
    return result


def http_url(value):
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise ClientError('URL 必须是可访问的 HTTP(S) 地址，不能包含用户名或密码')
    return value


def desktop_download_url(value):
    """Desktop artifacts may redirect only to public HTTPS destinations."""
    http_url(value)
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != 'https':
        raise ClientError('Desktop media downloads require HTTPS')
    try:
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise ClientError('Media download host could not be resolved') from exc
    if not addresses or any(not ipaddress.ip_address(info[4][0]).is_global for info in addresses):
        raise ClientError('Desktop media downloads cannot access private or local network addresses')


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        http_url(newurl)
        if os.environ.get('AI_AGG_DESKTOP') == '1':
            desktop_download_url(newurl)
        if req.get_method() != 'GET':
            raise ClientError('生成请求发生重定向，未自动重发；请检查平台地址')
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected:
            redirected.remove_header('Authorization')
        return redirected


class Client:
    def __init__(self, require_auth=True, key=None, base=None):
        saved_key, saved_base = credentials()
        self.key = saved_key if key is None else key
        self.base = http_url(DEFAULT_BASE if os.environ.get('AI_AGG_DESKTOP') == '1' else (base or saved_base)).rstrip('/')
        self.root = self.base[:-3] if self.base.endswith('/v1') else self.base
        self.timeout = number(os.environ.get('AI_AGG_TIMEOUT', '600'))
        if require_auth and not self.key:
            raise ClientError(AUTH_HELP)
        context = ssl.create_default_context()
        if sys.platform == 'darwin' and Path('/etc/ssl/cert.pem').is_file():
            context.load_verify_locations('/etc/ssl/cert.pem')
        self.http = urllib.request.build_opener(SafeRedirect(), urllib.request.HTTPSHandler(context=context))

    def request(self, path, payload=None, files=None, public=False, task_status=False, timeout=None):
        url = (self.root if path.startswith('/api/') else self.base) + path
        headers = {'Accept': 'application/json', 'User-Agent': 'AI-Aggregation-Skill/2'}
        if not public:
            headers['Authorization'] = 'Bearer ' + self.key
        data = None
        if payload is not None:
            if files:
                data, content_type = multipart(payload, files)
            else:
                data = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode('utf-8')
                content_type = 'application/json'
            headers['Content-Type'] = content_type
        attempts = 1 if payload is not None else 3
        deadline = time.monotonic() + (timeout if timeout is not None else self.timeout)
        for attempt in range(attempts):
            try:
                with self.http.open(urllib.request.Request(url, data=data, headers=headers),
                                    timeout=max(.1, deadline-time.monotonic())) as response:
                    raw = response.read(72*1024*1024+1)
                    if len(raw) > 72*1024*1024:
                        raise ClientError('Platform response exceeds 72 MiB; request was not retried')
                    request_id = response.headers.get('X-Oneapi-Request-Id') or response.headers.get('X-Request-Id', '')
                try:
                    result = json.loads(raw)
                except (ValueError, UnicodeDecodeError) as exc:
                    raise ClientError('服务端返回非 JSON；生成请求未重试，不能确认是否已受理') from exc
                if not isinstance(result, dict):
                    raise ClientError('服务端响应不是 JSON 对象')
                terminal_error = task_status and task_info(result)['status'] in FAILED
                if result.get('success') is False or (result.get('error') and not terminal_error):
                    raise ClientError(f'request_id={request_id}: ' + json.dumps(result, ensure_ascii=False))
                return result, request_id
            except urllib.error.HTTPError as exc:
                detail = exc.read(8192).decode('utf-8', errors='replace')
                rid = exc.headers.get('X-Oneapi-Request-Id') or exc.headers.get('X-Request-Id', '')
                if payload is None and exc.code in (429, 502, 503, 504) and attempt+1 < attempts and deadline-time.monotonic() > 1:
                    time.sleep(.5)
                    continue
                hint = ' 请检查平台 API Key / 令牌权限。' if exc.code in (401, 403) else ''
                raise ClientError(f'HTTP {exc.code} request_id={rid}: {detail}{hint}') from exc
            except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException) as exc:
                if attempt+1 < attempts and deadline-time.monotonic() > 1:
                    time.sleep(.5)
                    continue
                hint = '生成请求未重试；可能已受理，请勿直接重复生成。' if payload is not None else '可重新查询同一任务。'
                raise ClientError(f'网络请求失败：{exc}；{hint}') from exc

    def binary(self, url, authenticated=False, limit=512*1024*1024):
        http_url(url)
        if os.environ.get('AI_AGG_DESKTOP') == '1' and not url.startswith(DEFAULT_BASE + '/'):
            desktop_download_url(url)
        headers = {'User-Agent': 'AI-Aggregation-Skill/2'}
        if authenticated:
            if not url.startswith(self.base + '/'):
                raise ClientError('只向平台接口发送认证')
            headers['Authorization'] = 'Bearer ' + self.key
        try:
            with self.http.open(urllib.request.Request(url, headers=headers), timeout=self.timeout) as response:
                data = response.read(limit+1)
        except urllib.error.HTTPError as exc:
            raise ClientError(f'下载 HTTP {exc.code}: {exc.read(1024).decode("utf-8", errors="replace")}；请重新下载，不要重新生成') from exc
        except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
            raise ClientError(f'下载失败：{exc}；请重新下载，不要重新生成') from exc
        if not data or len(data) > limit:
            raise ClientError('下载为空或超出大小上限')
        return data


def multipart(payload, files):
    boundary = 'aiagg' + uuid.uuid4().hex
    chunks = []
    for key, value in payload.items():
        value = json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)
        chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode('utf-8'))
    for field, path, mime in files:
        # Unicode filesystem paths stay local; multipart names are portable ASCII.
        chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="upload{path.suffix.lower()}"\r\nContent-Type: {mime}\r\n\r\n'.encode('ascii'))
        chunks.extend((path.read_bytes(), b'\r\n'))
    chunks.append(f'--{boundary}--\r\n'.encode('ascii'))
    return b''.join(chunks), 'multipart/form-data; boundary=' + boundary


def media_source(value, kind):
    if value.startswith(('http://', 'https://')):
        return http_url(value), None
    if value.startswith('data:'):
        header, sep, encoded = value.partition(',')
        if not sep or not header.startswith('data:' + kind + '/') or ';base64' not in header:
            raise ClientError(f'{kind} data URL 格式无效')
        try:
            raw = base64.b64decode(encoded, validate=True)
        except ValueError as exc:
            raise ClientError('data URL base64 无效') from exc
        limit = {'image': 30, 'video': 50, 'audio': 15}[kind] * 1024*1024
        if not raw or len(raw) > limit:
            raise ClientError('data URL 为空或超过素材上限')
        if kind == 'image':
            image_format(raw)
        return value, None
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise ClientError(f'素材文件不存在：{path}')
    limit = {'image': 30, 'video': 50, 'audio': 15}[kind] * 1024*1024
    if not 0 < path.stat().st_size <= limit:
        raise ClientError(f'{kind} 文件为空或超过 {limit//1024//1024} MiB')
    mime = mimetypes.guess_type(path.name)[0] or ''
    if kind == 'image':
        fmt = image_format(path.read_bytes())
        mime = 'image/' + ('jpeg' if fmt == 'jpg' else fmt)
    if not mime.startswith(kind + '/'):
        raise ClientError(f'文件类型不是 {kind}：{path.name}')
    return None, (path, mime)


def image_reference(value):
    url, local = media_source(value, 'image')
    if local:
        path, mime = local
        url = 'data:' + mime + ';base64,' + base64.b64encode(path.read_bytes()).decode('ascii')
    return url


def image_format(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n') and len(data) >= 33 and data[12:16] == b'IHDR':
        return 'png'
    if data.startswith(b'\xff\xd8\xff') and len(data) > 16:
        return 'jpg'
    if data.startswith((b'GIF87a', b'GIF89a')) and len(data) > 13:
        return 'gif'
    if data.startswith(b'RIFF') and data[8:12] == b'WEBP' and len(data) > 20:
        return 'webp'
    raise ClientError('内容不是支持的 PNG/JPEG/WebP/GIF 图片（可能是 HTML/JSON 错误页）')


def atomic_write(path, data):
    path = Path(path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.aiagg-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'wb') as dest:
            dest.write(data)
        os.replace(temp, path)
    finally:
        Path(temp).unlink(missing_ok=True)


def redact_secrets(data):
    key = os.environ.get('AI_AGG_API_KEY', '')
    if isinstance(data, str):
        for _ in range(3):
            if not key:
                break
            data = data.replace(key, '[REDACTED]')
            key = json.dumps(key, ensure_ascii=False)[1:-1]
        return data
    if isinstance(data, list):
        return [redact_secrets(value) for value in data]
    if isinstance(data, dict):
        return {name: redact_secrets(value) for name, value in data.items()}
    return data


def save_receipt(path, data):
    atomic_write(path, (json.dumps(redact_secrets(data), ensure_ascii=False, indent=2, allow_nan=False)+'\n').encode('utf-8'))


def reserve_receipt(out, receipt, journal, outputs=None):
    out, receipt = Path(out).resolve(), Path(receipt).resolve()
    paths = [Path(p).resolve() for p in (outputs or [out])]
    if receipt in paths or any(p.exists() for p in paths):
        raise ClientError('输出已存在，或输出与 receipt 重名；请更换路径或恢复已有请求')
    for path in paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp = tempfile.mkstemp(prefix='.aiagg-check-', dir=str(path.parent))
        os.close(fd)
        Path(temp).unlink()
    receipt.parent.mkdir(parents=True, exist_ok=True)
    try:
        with receipt.open('x', encoding='utf-8') as dest:
            json.dump(redact_secrets(journal), dest, ensure_ascii=False, indent=2)
    except FileExistsError as exc:
        raise ClientError(f'任务回执已存在：{receipt}；请恢复，不要重复生成') from exc


SUCCESS = {'completed', 'succeeded', 'success', 'done'}
FAILED = {'failed', 'failure', 'error', 'canceled', 'cancelled'}
PENDING = {'queued', 'pending', 'submitted', 'processing', 'running', 'in_progress', 'not_start'}


def task_path(task_id):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', task_id):
        raise ClientError('无效任务 ID')
    return '/videos/' + task_id


def task_info(raw):
    objects = [raw] + [raw[k] for k in ('data', 'task', 'result') if isinstance(raw.get(k), dict)]
    result = {}
    for name, keys in {'task_id': ('id', 'task_id', 'taskId'), 'status': ('status', 'state', 'task_status'), 'progress': ('progress',)}.items():
        result[name] = next((o[k] for o in objects for k in keys if o.get(k) is not None and o[k] != ''), None)
    result['status'] = str(result['status'] or 'unknown').lower()
    return result


def prompt_args(parser):
    parser.add_argument('prompt', nargs='*')
    parser.add_argument('--prompt-file', help='UTF-8 提示词文件；也可以将提示词管道输入 stdin')


def read_prompt(args):
    if args.prompt_file and args.prompt:
        raise ClientError('提示词与 --prompt-file 不能同时指定')
    if args.prompt_file:
        text = Path(args.prompt_file).read_text(encoding='utf-8-sig')
    elif args.prompt:
        text = ' '.join(args.prompt)
    elif not sys.stdin.isatty():
        text = sys.stdin.read()
    else:
        text = ''
    if not text.strip():
        raise ClientError('提示词不能为空；支持直接参数、--prompt-file 或 stdin')
    return text.strip()


def entry(run):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    try:
        result = run(sys.argv[1:])
        exit_code = result.pop('_exit_code', 0)
        print(json.dumps(redact_secrets(result), ensure_ascii=False, allow_nan=False))
        if exit_code:
            sys.exit(exit_code)
    except (ClientError, OSError, ValueError, argparse.ArgumentTypeError) as exc:
        key, _ = credentials()
        message = str(exc).replace(key, '[REDACTED]') if key else str(exc)
        message = re.sub(r'sk-[A-Za-z0-9_-]{12,}', '[REDACTED]', message)
        print(json.dumps({'error': message}, ensure_ascii=False), file=sys.stderr)
        sys.exit(3 if 'AUTH_REQUIRED' in message else 1)
    except KeyboardInterrupt:
        print('已中断；生成可能已受理，请使用已有回执/任务 ID 恢复，不要重复提交。', file=sys.stderr)
        sys.exit(130)
