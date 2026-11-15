"""Real truncated HTTP responses never publish a private media source."""
import hashlib
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from liming_analyzer.api_client import AnalyzerApiClient, AnalyzerApiError, ClaimedJob


@pytest.mark.parametrize("checkpoint", [False, True])
@pytest.mark.parametrize("truncated", [False, True])
def test_private_source_download_verifies_real_http_eof(tmp_path, checkpoint, truncated):
    data = b"synthetic media payload"
    received = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            received.append((self.path, self.headers.get("X-Worker-Attempt")))
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data[:5] if truncated else data)
            self.close_connection = True

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        asset = {"id": "saved-source", "sha256": hashlib.sha256(data).hexdigest(), "size_bytes": len(data)}
        job = ClaimedJob("job", "org", "project", "video", "upload", "transcribing", 35, 10,
                         source=asset, attempt_count=2)
        client = AnalyzerApiClient(f"http://127.0.0.1:{server.server_port}", "synthetic-token", "worker")
        destination = tmp_path / "source"
        destination.write_bytes(b"previous verified source")
        download = (lambda: client.download_checkpoint_source(job, destination, asset)) if checkpoint else (
            lambda: client.download_upload_source(job, destination))
        if truncated:
            with pytest.raises(AnalyzerApiError, match="SOURCE_INCOMPLETE"):
                download()
            assert destination.read_bytes() == b"previous verified source"
        else:
            assert download().read_bytes() == data
        assert not destination.with_suffix(".part").exists()
        assert received == [("/api/internal/analysis-jobs/job/source" + ("?assetId=saved-source" if checkpoint else ""), "2")]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)
