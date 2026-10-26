# Records .github/assets/tui.gif. Needs `dispach` on PATH and an agent named milo in DISPACH_HOME
# (`dispach init --name milo …` with its key in the agent's .env); the setup line is hidden.
Output .github/assets/tui.gif
Set Shell "bash"
Set FontSize 15
Set Width 1200
Set Height 720
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms

Hide
Type "export DISPACH_HOME=/tmp/dispach-demo DISPACH_NO_BOOTSTRAP=1 PS1='$ '; clear" Enter
Sleep 1s
Show

Type "dispach run milo" Enter
Sleep 4s
Type `Call config_set with path tools.providers.system.writeRoots and value ["~"]. Then tell me in one line what happened.`
Sleep 500ms
Enter
Sleep 12s
Sleep 2s
Hide
Ctrl+C
Sleep 300ms
Ctrl+C
Sleep 1s
