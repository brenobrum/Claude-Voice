"""Local text-to-speech for Claude Voice: Chatterbox Multilingual (mlx-audio) on Apple Silicon.

Started by the app (src/main.js) with the Python in ~/.claude-voice/local-tts/.venv.
Prints "READY <port>" once the model is loaded, then serves:
  POST /speak {"text": "...", "voice": "default" | "<name>", "language": "pt"}
    -> raw 24 kHz mono PCM16, streamed sentence by sentence.
Voices are the built-in one ("default") plus cloned ones: ~/.claude-voice/voices/<name>.wav.
Closing the request stops generation. One request at a time.
"""
import json
import os
import re
import shutil
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

import mlx.core as mx
import numpy as np
import soundfile as sf
from huggingface_hub import hf_hub_download, snapshot_download
from mlx_audio.tts.utils import load_model

MODEL = 'mlx-community/chatterbox-multilingual-v3'
VOICES_DIR = os.path.expanduser('~/.claude-voice/voices')
SR = 24000
EXAGGERATION = 0.5

# The multilingual checkpoint ships without a default voice; borrow the base model's.
model_dir = snapshot_download(MODEL)
if not os.path.exists(os.path.join(model_dir, 'conds.safetensors')):
    shutil.copy(hf_hub_download('mlx-community/chatterbox-4bit', 'conds.safetensors'), os.path.join(model_dir, 'conds.safetensors'))
model = load_model(MODEL)
cache = {}  # voice name -> (wav mtime, Conditionals)


def conds_for(voice):
    path = os.path.join(VOICES_DIR, f'{voice}.wav')
    if voice == 'default' or not os.path.exists(path):
        return None  # the model's built-in voice
    mtime = os.path.getmtime(path)
    if voice not in cache or cache[voice][0] != mtime:
        wav, sr = sf.read(path, dtype='float32', always_2d=True)
        wav = wav.mean(axis=1)
        if sr != SR:
            wav = np.interp(np.arange(0, len(wav), sr / SR), np.arange(len(wav)), wav).astype(np.float32)
        cache[voice] = (mtime, model.prepare_conditionals(mx.array(wav), SR, EXAGGERATION))
    return cache[voice][1]


def sentences(text):
    parts = re.findall(r'[^.!?…]+[.!?…]+["\')\]]*\s*|[^.!?…]+$', text) or [text]
    out = []
    for p in parts:
        if out and len(out[-1]) < 40:
            out[-1] += p
        else:
            out.append(p)
    return [s.strip() for s in out if s.strip()]


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def do_POST(self):
        if self.path != '/speak':
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
        text = (body.get('text') or '').strip()
        lang = (body.get('language') or 'pt').lower()[:2]
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Transfer-Encoding', 'chunked')
        self.end_headers()
        try:
            conds = conds_for(body.get('voice') or 'default')
            for sentence in sentences(text):
                for r in model.generate(text=sentence, conds=conds, lang_code=lang, exaggeration=EXAGGERATION, verbose=False):
                    pcm = (np.clip(np.array(r.audio, dtype=np.float32), -1, 1) * 32767).astype('<i2').tobytes()
                    if pcm:
                        self.wfile.write(b'%x\r\n%s\r\n' % (len(pcm), pcm))
                        self.wfile.flush()
            self.wfile.write(b'0\r\n\r\n')
        except (BrokenPipeError, ConnectionResetError):
            pass  # the app stopped listening (interrupted): stop generating


# Single-threaded on purpose: MLX must run on the thread that loaded the model.
server = HTTPServer(('127.0.0.1', 0), Handler)
print(f'READY {server.server_address[1]}', flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    sys.exit(0)
