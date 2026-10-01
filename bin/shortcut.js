#!/usr/bin/env node
// Install a background helper so Ctrl+Option+Cmd+Space opens Claude Voice from anywhere, even when the
// app isn't running. Compiles launcher/hotkey.swift and runs it as a LaunchAgent (starts at login).
//   claude-voice shortcut           install (idempotent)
//   claude-voice shortcut --remove  uninstall
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LABEL = 'dev.local.claude-voice.hotkey';
const binFile = path.join(os.homedir(), '.claude-voice', 'hotkey');
const plistFile = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const domain = `gui/${process.getuid()}`;
const remove = process.argv[2] === '--remove';

const launchctl = (...args) => {
  try { execFileSync('launchctl', args, { stdio: 'ignore' }); } catch {}
};

launchctl('bootout', `${domain}/${LABEL}`);

if (remove) {
  fs.rmSync(plistFile, { force: true });
  fs.rmSync(binFile, { force: true });
  console.log('Claude Voice shortcut removed.');
  process.exit(0);
}

fs.mkdirSync(path.dirname(binFile), { recursive: true });
try {
  execFileSync('swiftc', ['-O', path.join(__dirname, '..', 'launcher', 'hotkey.swift'), '-o', binFile], { stdio: 'inherit' });
} catch {
  console.error("Couldn't compile the shortcut helper. Install the Xcode command line tools (xcode-select --install) and try again.");
  process.exit(1);
}

fs.mkdirSync(path.dirname(plistFile), { recursive: true });
fs.writeFileSync(plistFile, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${binFile}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`);
launchctl('bootstrap', domain, plistFile);
console.log('Claude Voice shortcut installed: press Ctrl+Option+Cmd+Space to open the app.');
