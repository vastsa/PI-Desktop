#!/usr/bin/env python3
"""Compatibility dispatcher; auth/image/video/text are also directly executable."""
import argparse
from platform_client import Client, entry


def run(argv):
    parser = argparse.ArgumentParser(description='AI聚合平台；独立入口：auth.py / image.py / video.py / text.py')
    parser.add_argument('command', choices=('auth', 'models', 'text', 'image', 'video'))
    parser.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    if args.command == 'models':
        if args.arguments:
            parser.error('models 不接收其他参数')
        raw, _ = Client().request('/models')
        return raw
    if args.command == 'auth':
        import auth
        return auth.run(args.arguments)
    if args.command == 'image':
        import image
        return image.run(args.arguments)
    if args.command == 'video':
        import video
        return video.run(args.arguments)
    import text
    return text.run(args.arguments)


if __name__ == '__main__':
    entry(run)
