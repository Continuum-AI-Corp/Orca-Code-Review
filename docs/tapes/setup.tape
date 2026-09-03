# Action setup demo: Claude Code with the orca-review-action skill wiring the
# GitHub Action into a throwaway private repo. Recorded at real time; the
# shipped cut is sped up (see README). Stops where a real user takes over: the
# API key is typed by the user into `gh secret set`, never by the agent.
Output docs/demo-setup-raw.mp4
Set Shell "bash"
Set FontSize 13
Set Width 1320
Set Height 1100
Set TypingSpeed 60ms
Hide
Type "cd /tmp/orcacode-demo && unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_PID CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_CODE_EXECPATH CLAUDE_CODE_TUI_JUST_SWITCHED && export PS1='$ ' && clear" Enter
Show
Type "claude --permission-mode bypassPermissions" Sleep 500ms Enter
Sleep 8s
# Trust dialog for a new folder: cursor rests on "No, exit".
Down
Sleep 500ms
Enter
Sleep 4s
Type "Set up OrcaCode Review in this repo" Sleep 800ms Enter
# The skill asks its decisions in one AskUserQuestion; Enter takes each default.
Sleep 45s
Enter
Sleep 3s
Enter
Sleep 3s
Enter
Sleep 3s
Enter
Sleep 3s
Enter
Sleep 3s
Enter
Sleep 200s
Screenshot docs/tapes/s2-done.png
Sleep 5s
