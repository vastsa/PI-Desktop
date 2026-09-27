"""Private desktop transport: bounded JSON over stdin, never a shell command.

The standalone image/video entry points keep their original CLI contract.
"""
import io
import json
import os
import sys

import image
import video
from platform_client import ClientError, DEFAULT_BASE, entry


def run(_argv):
    os.environ['AI_AGG_BASE_URL'] = DEFAULT_BASE
    os.environ['AI_AGG_DESKTOP'] = '1'
    if not os.environ.get('AI_AGG_API_KEY'):
        raise ClientError('Desktop media requires the selected platform provider API key from the host.')
    raw = sys.stdin.read(256 * 1024 * 1024 + 1)
    if len(raw) > 256 * 1024 * 1024:
        raise ClientError('Desktop media input exceeds 256 MiB')
    request = json.loads(raw)
    module = {'image': image, 'video': video}.get(request.get('script'))
    args = request.get('args')
    prompt = request.get('prompt', '')
    if module is None or not isinstance(args, list) or not all(isinstance(arg, str) for arg in args) or not isinstance(prompt, str):
        raise ClientError('Invalid desktop media request')
    # The existing CLI reads prompts from stdin. Arguments are built by the
    # host; large data URLs and prompts never hit the OS command-line limit.
    sys.stdin = io.StringIO(prompt)
    return module.run(args)


if __name__ == '__main__':
    entry(run)
