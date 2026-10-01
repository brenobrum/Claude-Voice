#!/usr/bin/env node
// Pair the Claude Voice iPhone app with this Mac: creates the shared token in ~/.claude-voice/remote.json
// (which also turns on local-network listening + Bonjour for new sessions) and shows it as a QR code.
//   claude-voice pair            show the QR code (creates the token the first time)
//   claude-voice pair --reset    rotate the token (paired phones must scan again)
//   claude-voice pair --off      stop listening on the network (new sessions are local only)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const file = path.join(os.homedir(), '.claude-voice', 'remote.json');
const arg = process.argv[2];

if (arg === '--off') {
  fs.rmSync(file, { force: true });
  console.log('Phone access is off. New Claude Code sessions listen on this Mac only.');
  process.exit(0);
}

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
if (!cfg.token || arg === '--reset') {
  cfg.token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

const scutil = (k) => { try { return execFileSync('scutil', ['--get', k], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const host = `${scutil('LocalHostName') || os.hostname().replace(/\.local$/, '')}.local`;
const name = scutil('ComputerName') || host;
const url = `claudevoice://pair?token=${cfg.token}&host=${encodeURIComponent(host)}&name=${encodeURIComponent(name)}`;

console.log('\nScan this with the Claude Voice iPhone app (or the Camera app):\n');
require('qrcode-terminal').generate(url, { small: true }, (qr) => console.log(qr));
console.log(`Or enter it by hand:  host ${host}   token ${cfg.token}\n`);
console.log('The phone and this Mac must be on the same Wi-Fi.');
console.log('Claude Code sessions started from now on can be reached from the phone; restart running ones.\n');
