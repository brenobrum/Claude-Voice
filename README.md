# Claude Voice

Talk to a **live Claude Code terminal session** and hear it answer, in real time.

- **Voice engine (default): `realtime`.** Realtime transcription plus `gpt-realtime-2` reading Claude's reply word for word. (GPT-Live, `gpt-live-1`, is disabled for now.)
- **Other engines (Settings):**
  - `tts`: the same, but with `gpt-4o-mini-tts`.
  - `local` ("On this Mac"): Chatterbox Multilingual running on Apple Silicon, free. Clone any voice from a 10–20 s recording in Settings → Clone a voice.
- **Listening (Settings):** OpenAI Realtime transcription (shows words while you talk), or **On this Mac**: Whisper large-v3-turbo running locally, free and private (~1 s per phrase on an M1 Pro; hands-free mode cuts phrases with a simple voice detector). With both set to On this Mac, no OpenAI key is needed.
- **Local models:** `claude-voice local-voice` sets up both (needs `uv`; downloads ~4 GB); the install prompt runs it. Servers: `local-tts/server.py`, `local-stt/server.py`.
- Your words reach the thread as `← voice: …` through a Claude Code channel in terminal `claude-voice` sessions, or as Monitor events in desktop-app sessions. Claude replies with the `speak` tool.
- Tool-permission prompts are relayed to the app: say "yes" or "no", or click Allow / Deny.
- **Live activity:** under the orb (and at the bottom of the message history) the apps show what the thread is doing: "Thinking…", the tool it's running (e.g. `Bash  npm test`) with elapsed time, and agents working in the background. Your sent messages keep a "processing" shimmer until the thread goes idle. This comes from Claude Code hooks: run `claude-voice hooks` once (adds them to `~/.claude/settings.json`; `--remove` undoes it), then start a new session. Without them the indicator only lasts until Claude's first spoken reply.
- **Open from anywhere:** run `claude-voice shortcut` once and Ctrl+Option+Cmd+Space opens Claude Voice (or brings it to the front), even when the app isn't running. When the app opens without a thread to talk to, it starts one itself: a new Terminal window runs Claude Code with voice in the folder of your last thread (your home folder the first time) and attaches it. It compiles a tiny helper (needs the Xcode command line tools) and runs it at login as a LaunchAgent; `--remove` undoes it.
- **Sub-agents:** ask Claude to "start an agent to…" and it calls `spawn_agent`, which runs a separate headless `claude -p` thread in the project (permission mode `auto` by default). A panel docked beside the voice window streams each agent's tool calls and messages live: an orange pulsing circle while it runs, gray once it stops. When an agent finishes, the main thread gets its result and tells you by voice. Other tools: `list_agents`, `agent_output`, `message_agent` (follow-up in the same thread), `stop_agent`.
- **T3 Code:** type `/voice` (or `$voice`) in any T3 Code thread and the app attaches to it, whatever agent the thread runs: what you say is sent into the thread as if typed, and the replies are read aloud as they stream in. Connect once in Settings → T3 Code or with `claude-voice t3` (it uses the `t3 pair` command bundled in T3 Code; T3 must be running). See `src/t3.js`.
- **Threads:** ask Claude to "open a new thread in ~/other-project" and it calls `new_thread`, which opens a Terminal window on the Mac running Claude Code with the voice channel (optionally with a first message). `list_threads` and `end_thread` manage the running ones.

## Use
```bash
claude-voice      # = claude --dangerously-load-development-channels server:voice
```
Then type `/voice`. The app opens, attaches to that thread and starts listening. Just talk.

- `⌥ Space`: interrupt Claude while it's speaking, or toggle the mic.
- `Esc`: stop speaking.
- While Claude talks, the transcriber only gets silence, so it never hears (or answers) its own voice. With "Interrupt by talking" on (the default), talking clearly louder than the echo from the speakers cuts Claude off.

## iPhone
`ios/` is a native SwiftUI version of the app. It finds the Claude Code sessions running on your Mac over the local network and talks to OpenAI directly from the phone. Everything else matches the Mac app: all three engines (GPT-Live over WebRTC), barge-in, permission prompts, typed context and the orb. Its Threads / Sub-agents sheet works as an orchestrator: switch between threads, open a new one on a Mac (at least one thread must already be running there), end one, and start, follow up on or stop sub-agents of the connected thread.

1. Pair once on the Mac: click the QR button (right of the keyboard button) in the Mac app, or run `claude-voice pair`. It writes a shared token to `~/.claude-voice/remote.json` and shows a QR code. Scan the code with the app (Sessions → Scan pairing code) or with the Camera app.
2. Sessions started after pairing listen on the network (the token is required) and announce themselves over Bonjour (`_claudevoice._tcp`). Pick one in the app, add your OpenAI key in Settings, and talk.
3. In a desktop-app session, run `/voice phone` so Claude arms the Monitor; nothing opens on the Mac. Terminal `claude-voice` sessions need nothing extra.

- The phone and the Mac must be on the same Wi-Fi. Traffic is plain `ws://` on your LAN, protected by the token. `claude-voice pair --reset` rotates the token and `claude-voice pair --off` turns network access off.
- The mic keeps working with the screen locked (background audio), so you can pocket the phone.
- Build: `cd ios && xcodegen generate && open ClaudeVoice.xcodeproj` (or `xcodebuild … -allowProvisioningUpdates`). This needs XcodeGen and pulls WebRTC through SwiftPM.

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
