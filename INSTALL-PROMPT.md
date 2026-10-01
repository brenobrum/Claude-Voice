# Prompt de instalação do Claude Voice

Cole tudo abaixo da linha numa sessão do Claude Code (no Mac).

---

Instale o Claude Voice nesta máquina (macOS, Apple Silicon) e deixe o `/voice` funcionando. Faça os passos abaixo, confira cada um e me diga no fim o que falta (se faltar algo).

1. **Repo:** clone (ou atualize, se já existir) `https://github.com/brenobrum/Claude-Voice` em `~/Workspace/claude-voice`. Guarde esse caminho como `REPO`.

2. **DMG:** baixe o DMG mais recente da release do GitHub pra `/tmp/claude-voice.dmg`:
   ```
   curl -fsSL -o /tmp/claude-voice.dmg "$(curl -fsSL https://api.github.com/repos/brenobrum/Claude-Voice/releases/latest | python3 -c 'import json,sys;print(next(a["browser_download_url"] for a in json.load(sys.stdin)["assets"] if a["name"].endswith("arm64.dmg")))')"
   ```

3. **App:** monte o DMG (`hdiutil attach -nobrowser /tmp/claude-voice.dmg`), feche o Claude Voice se estiver aberto, substitua `/Applications/Claude Voice.app` pelo do DMG, desmonte o DMG e rode `xattr -dr com.apple.quarantine "/Applications/Claude Voice.app"` (o app é assinado ad-hoc).

4. **Servidor MCP `voice` (escopo de usuário):** remova um `voice` antigo se existir (`claude mcp remove voice -s user`) e registre:
   ```
   claude mcp add voice -s user -e ELECTRON_RUN_AS_NODE=1 -- "/Applications/Claude Voice.app/Contents/MacOS/Claude Voice" "/Applications/Claude Voice.app/Contents/Resources/app.asar/channel/server.js"
   ```

5. **Skill `/voice`:** crie `~/.claude/skills/voice/SKILL.md` com exatamente este conteúdo:
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

6. **Permissões:** em `~/.claude/settings.json`, adicione em `permissions.allow` (sem apagar o que já existe): `mcp__voice__speak`, `mcp__voice__attach`, `mcp__voice__list_agents`, `mcp__voice__agent_output`, `mcp__voice__copy_install_prompt`. Deixe `spawn_agent`, `message_agent` e `stop_agent` pedindo confirmação.

7. **Launcher de terminal:** crie `~/.local/bin/claude-voice` (executável) com:
   ```sh
   #!/bin/sh
   # Start Claude Code with the Claude Voice channel enabled. Then type /voice to talk.
   exec claude --dangerously-load-development-channels server:voice "$@"
   ```
   Se `~/.local/bin` não estiver no PATH, me avise.

8. **Hooks de atividade:** rode `node $REPO/bin/hooks.js`. Isso adiciona hooks em `~/.claude/settings.json` que mostram no app o que o Claude está fazendo (pensando, rodando uma ferramenta, agentes em background).

9. **Atalho global:** rode `node $REPO/bin/shortcut.js`. Isso faz Ctrl+Option+Cmd+Space abrir o Claude Voice de qualquer lugar, mesmo com o app fechado.

10. **Voz local grátis:** rode `node $REPO/bin/local-voice.js` (precisa do `uv`; se faltar, `brew install uv`). Isso instala o Chatterbox, que roda a voz do Claude direto no Mac, de graça, baixa o modelo (~2,6 GB) e cria uma voz feminina inicial. No app ele aparece em Settings → "On this Mac", onde também dá pra clonar a própria voz.

11. **Verificação:** `claude mcp get voice` deve mostrar o servidor conectado; abra o app uma vez (`open -a "Claude Voice"`) pra liberar o microfone.

No final, me diga em 3 linhas: reinicie o Claude Code (ou rode `claude-voice` no terminal), digite `/voice`, e na primeira vez coloque a chave da OpenAI nas Settings do app (pra voz grátis, escolha "On this Mac" ali).
