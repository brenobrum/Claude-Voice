#!/usr/bin/env node
// Connect Claude Voice to T3 Code, so typing /voice (or $voice) in a T3 Code thread opens voice mode on it.
// Pairs with the `t3 pair` command bundled in T3 Code (which must be running) and saves the access token
// (valid 30 days) in ~/.claude-voice/t3.json; a running Claude Voice picks it up by itself.
//   claude-voice t3            pair (run it again when the token expires)
//   claude-voice t3 <link>     pair with a link from T3 Code → Settings → Connections
//   claude-voice t3 --remove   forget the pairing
const fs = require('fs');
const os = require('os');
const path = require('path');
const { autoPair, pairWithLink } = require('../src/t3');

const arg = process.argv[2];
if (arg === '--remove') {
  fs.rmSync(path.join(os.homedir(), '.claude-voice', 't3.json'), { force: true });
  console.log('Claude Voice is no longer connected to T3 Code.');
  process.exit(0);
}

(arg ? pairWithLink(arg) : autoPair())
  .then(() => console.log('Claude Voice is connected to T3 Code. Type /voice (or $voice) in a T3 Code thread to talk to it.'))
  .catch((err) => { console.error(err.message); process.exit(1); });
