# Prompt de instalação do Claude Voice

Cole tudo abaixo da linha numa sessão do Claude Code (no Mac). Troque `<DMG>` pelo caminho do `Claude Voice-<versão>-arm64.dmg`.

---

Instale o Claude Voice nesta máquina (macOS, Apple Silicon) e deixe o `/voice` funcionando. O instalador é `<DMG>`. Faça os passos abaixo, confira cada um e me diga no fim o que falta (se faltar algo).

1. **App:** monte o DMG (`hdiutil attach -nobrowser`), feche o Claude Voice se estiver aberto, substitua `/Applications/Claude Voice.app` pelo do DMG, desmonte o DMG e rode `xattr -dr com.apple.quarantine "/Applications/Claude Voice.app"` (o app é assinado ad-hoc).

2. **Servidor MCP `voice` (escopo de usuário):** remova um `voice` antigo se existir (`claude mcp remove voice -s user`) e registre:
   ```
   claude mcp add voice -s user -e ELECTRON_RUN_AS_NODE=1 -- "/Applications/Claude Voice.app/Contents/MacOS/Claude Voice" "/Applications/Claude Voice.app/Contents/Resources/app.asar/channel/server.js"
   ```

3. **Skill `/voice`:** crie `~/.claude/skills/voice/SKILL.md` com exatamente este conteúdo:
   ````markdown
   ---
   name: voice
   description: Connect the Claude Voice desktop app to this live Claude Code thread so the user can talk to you and hear your replies.
   disable-model-invocation: true
   ---
   
   The user invoked /voice: they want to talk to you through the Claude Voice app. Speech they say into that app is their own input to this thread.
   
   1. Call the `attach` tool from the `voice` MCP server (`mcp__voice__attach`; load it with ToolSearch if it's deferred).
      - If the tool doesn't exist: tell the user the voice server isn't loaded in this session (restart the session, or start one with `claude-voice` in a terminal) and stop.
      - If it returns an error, show it and stop.
   
   2. Decide how speech will reach you:
      - **Claude desktop app session** (your system prompt says you're running inside the Claude desktop app): channels aren't delivered here, so start a `Monitor` with the `ws` URL from the attach result, description "voice messages", `timeout_ms` 1800000. Each event `[voice] The user said …` is the user speaking to you. Whenever that monitor expires (timeout), re-arm it with the same URL. If it closes with code 4000 ("voice app disconnected"), the user closed the app: don't re-arm; voice is off until they run /voice again.
      - **Terminal session started with `claude-voice`**: don't start a Monitor; speech arrives as `<channel source="voice">` messages.
   
   3. Reply in one short line: "🎙️ Voice attached — just talk."
   
   From now on, answer every voice message by calling `mcp__voice__speak` with a short, natural, spoken-style reply in the language the user spoke (no markdown, code, paths or URLs in spoken text). Do the work they ask for as usual; if it takes a while, speak a quick acknowledgement first and a short summary at the end. Put longer details as normal text in the thread.
   ````

4. **Permissões:** em `~/.claude/settings.json`, adicione em `permissions.allow` (sem apagar o que já existe): `mcp__voice__speak`, `mcp__voice__attach`, `mcp__voice__list_agents`, `mcp__voice__agent_output`. Deixe `spawn_agent`, `message_agent` e `stop_agent` pedindo confirmação.

5. **Launcher de terminal:** crie `~/.local/bin/claude-voice` (executável) com:
   ```sh
   #!/bin/sh
   # Start Claude Code with the Claude Voice channel enabled. Then type /voice to talk.
   exec claude --dangerously-load-development-channels server:voice "$@"
   ```
   Se `~/.local/bin` não estiver no PATH, me avise.

6. **Verificação:** `claude mcp get voice` deve mostrar o servidor conectado; abra o app uma vez (`open -a "Claude Voice"`) pra liberar o microfone.

No final, me diga em 3 linhas: reinicie o Claude Code (ou rode `claude-voice` no terminal), digite `/voice`, e na primeira vez coloque a chave da OpenAI nas Settings do app.
