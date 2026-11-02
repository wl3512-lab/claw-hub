#!/bin/bash
# Builds ~/Applications/Claw Hub.app and the login service. Re-run any time.
set -e
HUB="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Applications/Claw Hub.app"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/com.lucy.claw-hub.plist"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$HUB/data"
[ -f "$HUB/tools/ClawHub.icns" ] && cp "$HUB/tools/ClawHub.icns" "$APP/Contents/Resources/ClawHub.icns"
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Claw Hub</string>
  <key>CFBundleIdentifier</key><string>com.lucy.claw-hub</string>
  <key>CFBundleExecutable</key><string>claw-hub</string>
  <key>CFBundleIconFile</key><string>ClawHub</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
</dict></plist>
PL
cat > "$APP/Contents/MacOS/claw-hub" <<SH
#!/bin/bash
URL="http://127.0.0.1:4777"
# make sure the service is up
curl -s -o /dev/null --max-time 1 "\$URL" || { launchctl kickstart -k "gui/\$(id -u)/com.lucy.claw-hub" 2>/dev/null; sleep 1.2; }
if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="\$URL" --window-size=1400,900
else
  open "\$URL"
fi
SH
chmod +x "$APP/Contents/MacOS/claw-hub"

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.lucy.claw-hub</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$HUB/server.js</string></array>
  <key>WorkingDirectory</key><string>$HUB</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HUB/data/server.log</string>
  <key>StandardErrorPath</key><string>$HUB/data/server.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/com.lucy.claw-hub" 2>/dev/null || true
sleep 1
for i in 1 2 3 4 5; do launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && break; sleep 1; done
touch "$APP"
echo "Built $APP"

# ---------- menubar icon ----------
MB="$HOME/Applications/Claw Hub Menubar.app"
MBPLIST="$HOME/Library/LaunchAgents/com.lucy.claw-hub-menubar.plist"
mkdir -p "$MB/Contents/MacOS"
node "$HUB/tools/export-icons.js" >/dev/null
swiftc -O -o "$MB/Contents/MacOS/claw-menu" "$HUB/menubar/main.swift" "$HUB/menubar/Frames.swift"
cat > "$MB/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Claw Hub Menubar</string>
  <key>CFBundleIdentifier</key><string>com.lucy.claw-hub-menubar</string>
  <key>CFBundleExecutable</key><string>claw-menu</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PL
codesign -s - --force "$MB" >/dev/null 2>&1 || true
cat > "$MBPLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.lucy.claw-hub-menubar</string>
  <key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-W</string><string>$MB</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/com.lucy.claw-hub-menubar" 2>/dev/null || true
pkill -f "Claw Hub Menubar.app" 2>/dev/null || true
sleep 1
for i in 1 2 3 4 5; do launchctl bootstrap "gui/$(id -u)" "$MBPLIST" 2>/dev/null && break; sleep 1; done
echo "Built $MB"
