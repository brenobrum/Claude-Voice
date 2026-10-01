# Claude Voice

Talk to a **live Claude Code terminal session** and hear it answer, in real time.

- **Voice engine (default): `gpt-live-1`.** GPT-Live runs the whole spoken conversation full duplex, so it listens while it speaks and you can talk over it. It hands every real request to your Claude Code thread through client delegation, and then says Claude's answer in its own words.
- **Other engines (Settings):**
  - `realtime`: Realtime transcription plus `gpt-realtime-2.1` reading Claude's reply word for word.
  - `tts`: the same, but with `gpt-4o-mini-tts`.
- Your words reach the thread as `← voice: …` through a Claude Code channel in terminal `claude-voice` sessions, or as Monitor events in desktop-app sessions. Claude replies with the `speak` tool.
- Tool-permission prompts are relayed to the app: say "yes" or "no", or click Allow / Deny.
- **Sub-agents:** ask Claude to "start an agent to…" and it calls `spawn_agent`, which runs a separate headless `claude -p` thread in the project (permission mode `auto` by default). A panel docked beside the voice window streams each agent's tool calls and messages live: an orange pulsing circle while it runs, gray once it stops. When an agent finishes, the main thread gets its result and tells you by voice. Other tools: `list_agents`, `agent_output`, `message_agent` (follow-up in the same thread), `stop_agent`.

## Use
```bash
claude-voice      # = claude --dangerously-load-development-channels server:voice
```
Then type `/voice`. The app opens, attaches to that thread and starts listening. Just talk.

- `⌥ Space`: interrupt Claude while it's speaking, or toggle the mic.
- `Esc`: stop speaking.
- While Claude talks, the transcriber only gets silence, so it never hears (or answers) its own voice. With "Interrupt by talking" on (the default), talking clearly louder than the echo from the speakers cuts Claude off.

## Pieces
- `src/`: the Electron app (mic capture, Realtime STT, Realtime/TTS voice, UI).
- `channel/server.js`: MCP channel server Claude Code spawns. It is bundled in the app and runs with `ELECTRON_RUN_AS_NODE=1`. It is registered at user scope as `voice` in `~/.claude.json`.
- `bin/claude-voice`: launcher, symlinked into `~/.local/bin`.
- `~/.claude/skills/voice/SKILL.md`: the `/voice` skill.
- `mcp__voice__speak` and `mcp__voice__attach` are pre-allowed in `~/.claude/settings.json`.

## Build
```bash
npm install
npm run dist     # -> dist/Claude Voice-<version>-arm64.dmg; copy the .app to /Applications
```
