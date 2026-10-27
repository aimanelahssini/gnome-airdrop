#!/bin/bash
# Tests the "Send with AirDrop" device search in a throwaway headless GNOME Shell.
# owly and nmcli are fakes (tests/shell/fake-bin): the real radio and Wi-Fi are never touched,
# and settings go to a temp folder, never to the real ones.
#   tests/shell/run.sh [OUT_DIR]        results.txt and shell.log land in OUT_DIR
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
T="$(mktemp -d)"
OUT="${1:-$T/out}"
mkdir -p "$T"/{home,config/glib-2.0/settings,data/gnome-shell/extensions,state,cache,rt,fake} "$OUT"
rm -f "$OUT/results.txt" "$OUT/owly.log"
chmod 700 "$T/rt"
cp -r "$REPO/extension/airdrop@aimanelahssini" "$HERE/airdrop-test@tests" "$T/data/gnome-shell/extensions/"
cat > "$T/config/glib-2.0/settings/keyfile" <<KEY
[org/gnome/shell]
enabled-extensions=['airdrop@aimanelahssini', 'airdrop-test@tests']
disable-user-extensions=false
welcome-dialog-last-shown-version='999'
KEY
dconf dump / > "$T/dconf-before.txt"
env -u WAYLAND_DISPLAY -u DISPLAY -u DBUS_SESSION_BUS_ADDRESS \
    HOME="$T/home" XDG_CONFIG_HOME="$T/config" XDG_DATA_HOME="$T/data" XDG_STATE_HOME="$T/state" \
    XDG_CACHE_HOME="$T/cache" XDG_RUNTIME_DIR="$T/rt" GSETTINGS_BACKEND=keyfile \
    PATH="$HERE/fake-bin:$PATH" AIRDROP_FAKE="$T/fake" AIRDROP_OUT="$OUT" \
    dbus-run-session -- timeout "${TIMEOUT:-180}" gnome-shell --headless --wayland --virtual-monitor 1280x800 \
    > "$OUT/shell.log" 2>&1 || true
dconf dump / > "$T/dconf-after.txt"
if diff "$T/dconf-before.txt" "$T/dconf-after.txt" | grep -qiE 'airdrop|enabled-extensions'; then
    echo "REAL DCONF CHANGED"
else
    echo "real dconf: no AirDrop changes"
fi
cp "$T/fake/owly.log" "$OUT/owly.log" 2>/dev/null || true
# Owly's stderr from the search should be in the shell log.
if grep -q 'airdrop: browse: phone9: /Discover failed' "$OUT/shell.log"; then
    echo "PASS search messages logged" >> "$OUT/results.txt"
else
    echo "FAIL search messages logged" >> "$OUT/results.txt"
fi
if grep -q 'has been already disposed' "$OUT/shell.log"; then
    echo "FAIL no disposed-notification warnings" >> "$OUT/results.txt"
else
    echo "PASS no disposed-notification warnings" >> "$OUT/results.txt"
fi
grep -E 'JS ERROR|TypeError|ReferenceError' "$OUT/shell.log" | head -5 || true
cat "$OUT/results.txt" 2>/dev/null
rm -rf "$T"
