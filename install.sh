#!/bin/bash
# AirDrop for GNOME: the Quick Settings button, Files' "Send with AirDrop…", the app entry and the
# `airdrop` command. Installs Owly first if it's missing (asks for your password once).
#   git clone https://github.com/aimanelahssini/gnome-airdrop && cd gnome-airdrop && ./install.sh
set -e
cd "$(dirname "$0")"
UUID=airdrop@aimanelahssini

if ! command -v owly >/dev/null; then
    echo "Installing Owly (needs your password)..."
    pkexec bash "$PWD/install-owly.sh"
fi
for pkg in zenity nautilus-python; do
    rpm -q "$pkg" >/dev/null 2>&1 || MISSING="$MISSING $pkg"
done
[ -z "${MISSING:-}" ] || pkexec dnf install -y $MISSING

mkdir -p ~/.local/share/gnome-shell/extensions
rm -rf ~/.local/share/gnome-shell/extensions/$UUID
cp -r extension/$UUID ~/.local/share/gnome-shell/extensions/
# Only add to GNOME's enabled list (gnome-extensions enable can drop other extensions).
python3 - "$UUID" <<'PY'
import ast, subprocess, sys
cur = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'], text=True)
l = ast.literal_eval(cur.replace('@as ', ''))
if sys.argv[1] not in l:
    l.append(sys.argv[1])
subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', str(l)], check=True)
PY

install -Dm755 airdrop ~/.local/bin/airdrop
install -Dm644 logo.svg ~/.local/share/icons/hicolor/scalable/apps/airdrop.svg
install -Dm644 airdrop.desktop ~/.local/share/applications/airdrop.desktop
install -Dm644 airdrop-nautilus.py ~/.local/share/nautilus-python/extensions/airdrop.py
rm -f ~/.local/share/nautilus/scripts/"Send with AirDrop"
gtk-update-icon-cache -q ~/.local/share/icons/hicolor 2>/dev/null || true
update-desktop-database ~/.local/share/applications 2>/dev/null || true
nautilus -q 2>/dev/null || true
echo "AirDrop installed. Log out and back in once so GNOME loads it."
