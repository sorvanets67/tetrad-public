#!/usr/bin/env python3
"""Serve the local notebook without caching outdated application files."""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DIST = Path(__file__).resolve().parent / 'dist'


class NotebookHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        # File mtimes have subsecond precision, HTTP Last-Modified does not.
        # Two edits in the same second must still return the new file.
        for header in ('If-Modified-Since', 'If-None-Match'):
            if header in self.headers:
                del self.headers[header]
        return super().send_head()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8000)
    args = parser.parse_args()
    handler = partial(NotebookHandler, directory=str(DIST))
    with ThreadingHTTPServer((args.bind, args.port), handler) as server:
        print(f'vibenotes: http://{args.bind}:{server.server_port}', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
