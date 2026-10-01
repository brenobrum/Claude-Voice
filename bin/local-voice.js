#!/usr/bin/env node
// Set up the free local models ("On this Mac" in Settings), running on Apple Silicon:
//   voice:     Chatterbox Multilingual (~2.6 GB), plus a female starter voice
//   listening: Whisper large-v3-turbo (~1.5 GB)
// Creates the Python environment the app uses (~/.claude-voice/local-tts/.venv) and downloads the models so the
// first use doesn't wait for them. Needs uv (brew install uv).
//   claude-voice local-voice           install or update (idempotent)
//   claude-voice local-voice --remove  delete the environment and the downloaded models (cloned voices stay)
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODEL = 'mlx-community/chatterbox-multilingual-v3';
const STT_MODEL = 'mlx-community/whisper-large-v3-turbo-asr-fp16';
const PACKAGES = ['mlx-audio==0.5.7', 'mlx==0.32.3', 'soundfile==0.14.0'];
const root = path.join(os.homedir(), '.claude-voice');
const dir = path.join(root, 'local-tts');
const python = path.join(dir, '.venv', 'bin', 'python');
const voices = path.join(root, 'voices');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error('The local voice needs a Mac with Apple Silicon.');
  process.exit(1);
}

if (process.argv[2] === '--remove') {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const m of [MODEL, STT_MODEL]) {
    fs.rmSync(path.join(os.homedir(), '.cache', 'huggingface', 'hub', `models--${m.replace('/', '--')}`), { recursive: true, force: true });
  }
  console.log('Local models removed. Pick the OpenAI options in Settings.');
  process.exit(0);
}

try { execFileSync('uv', ['--version'], { stdio: 'ignore' }); } catch {
  console.error('uv is missing. Install it with `brew install uv` and run this again.');
  process.exit(1);
}

fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(python)) run('uv', ['venv', '--python', '3.12', path.join(dir, '.venv')]);
run('uv', ['pip', 'install', '--python', python, ...PACKAGES]);

console.log(`Downloading ${MODEL} (~2.6 GB) and ${STT_MODEL} (~1.5 GB)…`);
run(python, ['-c', `
import os, shutil
from huggingface_hub import hf_hub_download, snapshot_download
d = snapshot_download('${MODEL}')
if not os.path.exists(os.path.join(d, 'conds.safetensors')):
    shutil.copy(hf_hub_download('mlx-community/chatterbox-4bit', 'conds.safetensors'), os.path.join(d, 'conds.safetensors'))
snapshot_download('mlx-community/S3TokenizerV2')
snapshot_download('${STT_MODEL}')
`]);

// A female starter voice, cloned from the macOS Brazilian Portuguese voice.
const female = path.join(voices, 'Female.wav');
if (!fs.existsSync(female)) {
  fs.mkdirSync(voices, { recursive: true });
  const aiff = path.join(os.tmpdir(), 'claude-voice-female.aiff');
  try {
    run('say', ['-v', 'Luciana', '-r', '175', '-o', aiff,
      'Olá, tudo bem? Meu nome é Luciana, e eu vou ler este pequeno texto para servir de referência de voz. Hoje o dia está bonito e calmo.']);
    run('afconvert', ['-f', 'WAVE', '-d', 'LEI16@24000', '-c', '1', aiff, female]);
  } catch {
    console.warn('Skipped the female starter voice (the macOS voice Luciana is not available).');
  } finally {
    fs.rmSync(aiff, { force: true });
  }
}

console.log('Local models ready. In Claude Voice → Settings, pick "On this Mac" for Claude\'s voice and/or for listening, Save.');
