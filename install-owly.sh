#!/bin/bash
# Root: install the newest Owly release (checksum-verified against GitHub's digest) and let its
# service run as a normal third-party service under SELinux (it ships in /usr/lib with a library
# label, which runs it in systemd's own confined context where it can't query the Wi-Fi card).
set -e
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
curl -fsSL https://api.github.com/repos/t4t5/owly/releases/latest -o "$TMP/release.json"
read -r URL DIGEST < <(python3 -I - "$TMP/release.json" <<'PY'
import json, re, sys
rel = json.load(open(sys.argv[1]))
a = next(a for a in rel["assets"] if re.fullmatch(r"owly-[\d.]+-\d+\.x86_64\.rpm", a["name"]))
print(a["browser_download_url"], (a.get("digest") or "none").removeprefix("sha256:"))
PY
)
[ "$DIGEST" != none ] || { echo "No checksum published for Owly's RPM, not installing"; exit 1; }
curl -fsSL "$URL" -o "$TMP/owly.rpm"
echo "$DIGEST  $TMP/owly.rpm" | sha256sum -c --quiet
dnf install -y "$TMP/owly.rpm"
semanage fcontext -a -t bin_t /usr/lib/owly/owlyd 2>/dev/null || semanage fcontext -m -t bin_t /usr/lib/owly/owlyd
restorecon /usr/lib/owly/owlyd
systemctl try-restart owlyd.service || true
