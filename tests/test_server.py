import tempfile
import threading
import unittest
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

from serve import NotebookHandler


class LocalServerTests(unittest.TestCase):
    def test_changed_files_are_not_served_as_stale_304_responses(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'app.js'
            path.write_text('old code')
            server = ThreadingHTTPServer(
                ('127.0.0.1', 0),
                partial(NotebookHandler, directory=folder)
            )
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = f'http://127.0.0.1:{server.server_port}/app.js?v=test'
                with urlopen(url) as response:
                    self.assertEqual(response.read(), b'old code')
                    modified = response.headers['Last-Modified']
                    self.assertEqual(response.headers['Cache-Control'], 'no-store')
                path.write_text('new code')
                request = Request(url, headers={'If-Modified-Since': modified})
                with urlopen(request) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.read(), b'new code')
                    self.assertEqual(response.headers['Cache-Control'], 'no-store')
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == '__main__':
    unittest.main()
