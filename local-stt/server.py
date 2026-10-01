"""Local speech-to-text for Claude Voice: Whisper large-v3-turbo (mlx-audio) on Apple Silicon.

Started by the app (src/main.js) with the Python in ~/.claude-voice/local-tts/.venv (shared with the local voice).
Prints "READY <port>" once the model is loaded, then serves:
  POST /transcribe?language=pt  body: raw 24 kHz mono PCM16  ->  {"text": "..."}
One request at a time.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np
from mlx_audio.stt.utils import load_model

MODEL = 'mlx-community/whisper-large-v3-turbo-asr-fp16'
model = load_model(MODEL)

# Whisper's usual inventions on near-silent clips.
HALLUCINATIONS = {
    'obrigado.', 'obrigada.', 'obrigado', 'tchau.', 'thank you.', 'thanks for watching!', 'you',
    'legendas pela comunidade amara.org', 'legenda adriana zanotto', 'sous-titres réalisés par la communauté d\'amara.org',
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != '/transcribe':
            self.send_error(404)
            return
        language = (parse_qs(url.query).get('language') or [''])[0][:2].lower() or None
        pcm = np.frombuffer(self.rfile.read(int(self.headers.get('Content-Length') or 0)), dtype='<i2')
        text = ''
        wav = pcm.astype(np.float32) / 32768
        # At least 0.1 s, and not near-silence (Whisper makes up words for silence).
        if len(wav) >= 2400 and np.abs(wav).max() > 0.02:
            wav = np.interp(np.arange(0, len(wav), 1.5), np.arange(len(wav)), wav).astype(np.float32)  # 24 -> 16 kHz
            text = model.generate(wav, language=language, verbose=False).text.strip()
            if text.lower().strip(' .!') in {h.strip(' .!') for h in HALLUCINATIONS}:
                text = ''
        body = json.dumps({'text': text}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


# Single-threaded on purpose: MLX must run on the thread that loaded the model.
server = HTTPServer(('127.0.0.1', 0), Handler)
print(f'READY {server.server_address[1]}', flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    sys.exit(0)
