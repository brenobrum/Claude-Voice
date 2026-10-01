#!/bin/sh
# Claude Code hook (every event): forwards the hook's JSON to this session's voice channel, so the
# voice apps can show what Claude is doing (thinking, running a tool, agents in the background).
# The channel writes ~/.claude-voice/run/<claude pid> ("port token"); outside voice sessions this is a no-op.
# Installed by `claude-voice hooks`; the channel server refreshes this copy each time it starts.
RUN="$HOME/.claude-voice/run"
[ -n "$(ls -A "$RUN" 2>/dev/null)" ] || exit 0
pid=$PPID
while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
  if [ -f "$RUN/$pid" ]; then
    read -r port token < "$RUN/$pid"
    curl -s -m 1 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary @- \
      "http://127.0.0.1:$port/hook?token=$token"
    exit 0
  fi
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
done
exit 0
