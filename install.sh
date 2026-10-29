#!/bin/sh
# Sets Agentdeck up on this Mac, or updates it after a `git pull`: the `ag` command, then the app.
set -e
cd "$(dirname "$0")"
[ -x /opt/homebrew/bin/python3 ] || { echo "Needs Homebrew Python: brew install python"; exit 1; }
command -v swiftc >/dev/null || { echo "Needs the Xcode command line tools: xcode-select --install"; exit 1; }
mkdir -p ~/.local/bin ~/.cache
ln -sf "$PWD/ag" ~/.local/bin/ag
if [ -d ~/.pi/agent ]; then  # pi lists itself to Agentdeck through this extension; running pi pick it up on /reload
  mkdir -p ~/.pi/agent/extensions
  ln -sf "$PWD/pi/agentdeck.ts" ~/.pi/agent/extensions/agentdeck.ts
fi
./ag check
./app/build.sh
pkill -x Agentdeck 2>/dev/null || true
open Agentdeck.app
echo "Agentdeck is running. Option+Space opens the deck; README.md has the WezTerm keys."
