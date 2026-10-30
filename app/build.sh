#!/bin/sh
# Builds ../Agentdeck.app. No Xcode project: one Swift file, one HTML file, one plist, one icon.
set -e
cd "$(dirname "$0")"
APP=../Agentdeck.app
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp Info.plist "$APP/Contents/"
cp deck.html AppIcon.icns "$APP/Contents/Resources/"
swiftc -O -swift-version 5 main.swift -o "$APP/Contents/MacOS/Agentdeck"
# Signed with your Apple Development certificate when there is one: macOS only lets an app with a real signing
# identity post notifications. Without one it is signed ad hoc and the app shows its own banners instead.
IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | awk '/Apple Development/ {print $2; exit}')
codesign --force --sign "${IDENTITY:--}" "$APP"
echo "built $(cd .. && pwd)/Agentdeck.app"
