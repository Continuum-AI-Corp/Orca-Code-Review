# Usage demo: a real review of a real pull request, driven by Claude Code with
# the orca-review skill. Recorded at real time; docs/demo-review.mp4 is the
# ffmpeg-trimmed cut (see docs/tapes/README).
Output docs/demo-review-raw.mp4
Set Shell "bash"
Set FontSize 13
Set Width 1320
Set Height 1320
Set TypingSpeed 60ms
Hide
Type "cd /tmp/orcacode-demo && unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_PID CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_CODE_EXECPATH CLAUDE_CODE_TUI_JUST_SWITCHED && export PS1='$ ' && clear" Enter
Show
Type "claude --permission-mode bypassPermissions" Sleep 500ms Enter
Sleep 8s
# First launch in this folder: the trust dialog. Its cursor rests on "No, exit",
# so trusting the folder is one Down then Enter.
# Recorded in the throwaway demo repo (/tmp/orcacode-demo), which has its own,
# empty, Claude memory — the recording account's memory for its real projects
# says "reply in Chinese".
# bypassPermissions: a review reads code and writes .orcacode-review/ only; a
# recording cannot answer the per-command prompts a real reviewer would.
Down
Sleep 500ms
Enter
Sleep 4s
Screenshot docs/tapes/r1-ready.png
Type "Review PR 1 for me" Sleep 800ms Enter
Sleep 300s
Screenshot docs/tapes/r2-done.png
Sleep 8s
