# Records .github/assets/quickstart.gif against the published image. Reads MODEL_API_KEY from ./.env
# in hidden setup; the key is never typed on screen.

Output .github/assets/quickstart.gif
Set Shell "bash"
Set FontSize 15
Set Width 1200
Set Height 440
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 18ms

Hide
Type "set -a; . ./.env; set +a; export KEY=$MODEL_API_KEY; unset MODEL_API_KEY OPENROUTER_API_KEY DISPACH_API_TOKEN; export TOKEN=$(openssl rand -hex 8); docker rm -f milo-demo >/dev/null 2>&1; docker volume rm milo-demo >/dev/null 2>&1; export PS1='$ '; clear" Enter
Sleep 1s
Show

Type "# 1. Start the server: no agents yet, nothing to configure but a token" Enter
Type "docker run -d -p 7420:7420 -v milo-demo:/home/dispach -e DISPACH_API_TOKEN=$TOKEN --name milo-demo ghcr.io/moeen-mahmud/dispach:0.2.1" Enter
Sleep 2s
Type "# 2. Create an agent over HTTP, live with no restart" Enter
Type `curl -s -H "Authorization: Bearer $TOKEN" localhost:7420/v1/agents -d '{"answers":{"user":"you","name":"milo","model":"deepseek-v4-flash","baseUrl":"https://api.deepseek.com/v1","apiKey":"'$KEY'"}}' | jq -c '{id, adopted}'` Enter
Sleep 3s
Type "# 3. Send a message, then follow the turn as it streams" Enter
Type `T=$(curl -s -H "Authorization: Bearer $TOKEN" localhost:7420/v1/agents/milo/messages -d '{"text":"What can you do for my product? One sentence.","chunks":true}' | jq -r .turnId); echo $T` Enter
Sleep 1s
Type `curl -sN -H "Authorization: Bearer $TOKEN" "localhost:7420/v1/agents/milo/turns/$T/stream?chunks=true" | sed -un 's/^data: //p' | jq -j --unbuffered 'select(.type=="model.chunk" and .data.kind!="reasoning") | .data.delta'; echo` Enter
Sleep 12s

Hide
Type "docker rm -f milo-demo >/dev/null; docker volume rm milo-demo >/dev/null; clear" Enter
