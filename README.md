# Agentdeck

A floating deck over WezTerm for every Claude Code, Codex and pi agent on this Mac: who needs you, who is working,
and a way to reply or jump to one without hunting for its tab. The full guide is `.lavish/ag-guide.html`.

## Set up on a Mac

Needs an Apple Silicon Mac, WezTerm, Homebrew Python (`brew install python`) and the Xcode command line tools
(`xcode-select --install`).

    git clone https://github.com/aj8uppal/agentdeck.git ~/personal/agentdeck
    ~/personal/agentdeck/install.sh

That links `ag` into `~/.local/bin`, links the pi extensions into `~/.pi/agent/extensions`, builds `Agentdeck.app` and starts it.
`pi/agentdeck.ts` puts pi in the deck (state, cost, replies) and changes how pi puts decisions to you. It explains a decision in its reply, then asks it with `ask_user` and ends its turn. You answer in the editor (a bare number picks that option) or with the deck's buttons, or ask why or push back first. A brief above the editor shows the goal, what you decided, what it assumes and what is still open (`/brief` for all of it). `pi/autoname.ts` names each pi session and its tab from what it is about (`/autoname` to redo it; a `/name` of yours is kept).
Pi sessions already open show up after `/reload` or a restart. Run it again after a `git pull` to update.

- Option+Space opens the deck, Option+Shift+Space jumps to whoever needs you.
- To start it with the Mac: menu-bar icon, then "Open at login".
- `ag` in a terminal prints the same list; it needs `~/.local/bin` on your `PATH`.
- Projects are grouped by their folder under `~/personal`; anywhere else, an agent is labelled with its folder name.
- Notifications: with an Apple Development certificate in the keychain the app is signed with it and can use macOS
  notifications once you allow them. Without one it shows its own banner, which works the same.

## WezTerm keys (optional)

Add to `~/.wezterm.lua`. Without the last block everything still works, except that jumping to an agent in a
*different* WezTerm window switches its tab without bringing that window to the front.

```lua
local AG = wezterm.home_dir .. '/.local/bin/ag'

-- in config.keys:
{ mods = 'LEADER', key = 'n', action = wezterm.action_callback(function() wezterm.background_child_process { AG, 'next' } end) },
{ mods = 'LEADER', key = ' ', action = wezterm.action_callback(function() wezterm.background_child_process { '/usr/bin/open', '-g', 'agentdeck://toggle' } end) },
{ mods = 'LEADER', key = 'a', action = act.SpawnCommandInNewTab { args = { AG, 'watch' } } },

-- at the top of wezterm.on('update-right-status', function(window, pane) ... end):
local want = io.open(wezterm.home_dir .. '/.cache/agentdeck-focus')
if want then
  local id = tonumber(want:read('*a'))
  want:close()
  if id and pane:pane_id() == id then
    os.remove(wezterm.home_dir .. '/.cache/agentdeck-focus')
    window:focus()
  end
end
```

## Working on it

`ag check` runs the feed's self-test. `node app/test.cjs` runs the interface tests (it borrows Playwright from
`~/personal/3d-tetris`). `app/build.sh` rebuilds the app; after editing `app/icon.svg`, `node app/icon.cjs` re-renders `app/AppIcon.icns`.
