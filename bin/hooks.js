#!/usr/bin/env node
// Install the Claude Code hooks that let the voice apps show what Claude is doing (thinking, running a
// tool, agents in the background). Adds one command hook per event to ~/.claude/settings.json.
//   claude-voice hooks           install (idempotent)
//   claude-voice hooks --remove  uninstall
const fs = require('fs');
const os = require('os');
const path = require('path');

const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart',
  'SubagentStop', 'Stop', 'StopFailure', 'SessionEnd'];
const MARK = '.claude-voice/hook.sh';
const COMMAND = `[ -f ~/${MARK} ] && sh ~/${MARK}; exit 0`;
const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
const hookFile = path.join(os.homedir(), MARK);
const remove = process.argv[2] === '--remove';

let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (err) {
  if (err.code !== 'ENOENT') { console.error(`Can't read ${settingsFile}: ${err.message}`); process.exit(1); }
}
settings.hooks ||= {};

const ours = (group) => (group.hooks || []).some((h) => String(h.command || '').includes(MARK));
for (const ev of EVENTS) {
  const groups = (settings.hooks[ev] || []).filter((g) => !ours(g));
  if (!remove) groups.push({ hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] });
  if (groups.length) settings.hooks[ev] = groups; else delete settings.hooks[ev];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
if (remove) {
  console.log('Claude Voice hooks removed.');
} else {
  fs.mkdirSync(path.dirname(hookFile), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'channel', 'hook.sh'), hookFile);
  fs.chmodSync(hookFile, 0o755);
  console.log('Claude Voice hooks installed. Sessions started from now on show their activity in the voice apps.');
}
