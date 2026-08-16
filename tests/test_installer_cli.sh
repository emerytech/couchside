#!/usr/bin/env bash
# Pins for the installer's security-page-facing surface (2026-08-15):
#
#   1. KI-022 — the closing banner does NOT print the bearer token (or the
#      pairing URL that embeds it) unless --show-token; the QR is the default
#      carrier. The one exception: when no QR renderer exists at all, the URL
#      prints anyway, because pairing must never be blocked.
#   2. couchside new-token — the revocation path. Must confirm before acting,
#      must restart the service (the auth gate compares the token loaded at
#      startup), and must never echo the minted secret.
#   3. couchside tls on|off|status — status reads the LIVE /api/ping advert
#      (not the config's opinion), and `off` warns that a pinned phone fails
#      closed rather than downgrading.
#   4. Firewall — the TLS listener port is opened alongside the plaintext port
#      in BOTH backends, and skipped when the owner set tls.enabled false.
#      Without this a ufw box advertises a port the firewall blocks, and a
#      pinned app fails closed into "box offline".
#
# Textual, like tests/test_installer_distro.sh: what lands on the box is this
# text. Plus one functional check: the CLI heredoc extracts and parses as bash.
set -u
SRC="${1:?usage: test_installer_cli.sh /path/to/install.sh}"
fails=0
check() { # name, condition-result (0/1)
    if [ "$2" -eq 0 ]; then echo "  PASS  $1"; else echo "  FAIL  $1"; fails=$((fails+1)); fi
}

echo "banner token redaction (KI-022)"
# The TOKEN echo must live inside the SHOW_TOKEN gate — assert the literal
# line exists AND that a gate on SHOW_TOKEN appears above it in the same block.
awk '/^if \[ "\$SHOW_TOKEN" = "1" \]; then$/,/^fi$/' "$SRC" | grep -q 'echo " TOKEN: ${TOKEN}"'
check "TOKEN literal prints only under --show-token" $?
awk '/^if \[ "\$SHOW_TOKEN" = "1" \]; then$/,/^fi$/' "$SRC" | grep -q 'echo " ${PAIR_URL}"'
check "pairing URL (embeds the token) is behind --show-token too" $?
grep -q -- '--show-token)     SHOW_TOKEN=1' "$SRC"
check "--show-token flag is parsed" $?
# The no-QR-renderer fallback still prints the URL: pairing must not be blocked.
grep -q 'pair by copying this link' "$SRC"
check "last-resort (no QR renderer) still prints the pairing link" $?

echo "CLI heredoc"
tmp="$(mktemp)"
awk '/^cat > "\$CLI" <<'"'"'CLIEOF'"'"'$/{f=1;next} /^CLIEOF$/{f=0} f' "$SRC" > "$tmp"
[ -s "$tmp" ]; check "CLI heredoc extracts non-empty" $?
bash -n "$tmp" 2>/dev/null; check "CLI parses as bash" $?

echo "couchside new-token"
# Block ranges end at the case entry's own 4-space `;;` closer — the nested
# case inside `tls` closes its entries at 8 spaces, so this never ends early.
# A range that silently ran to EOF would let pins match ANY later block, so
# each block's line count is asserted bounded first.
nt() { awk '/^  new-token\)$/,/^    ;;$/' "$tmp"; }
lines=$(nt | wc -l | tr -d ' ')
[ "$lines" -gt 5 ] && [ "$lines" -lt 60 ]; check "new-token block is bounded ($lines lines)" $?
grep -q '^  new-token)$' "$tmp"; check "new-token subcommand exists" $?
nt | grep -q "Continue? \[y/N\]"
check "confirms before rotating" $?
# Via the shared helper since 2026-08-16 — the hand-rolled `sudo systemctl
# restart couchside` this used to look for did not match the sudoers grant and
# failed silently, which for new-token means the OLD token keeps authorizing.
nt | grep -q '_restart_agent'
check "restarts the agent (old token must stop authorizing)" $?
nt | grep -q 'chmod 600'
check "token file mode stays 600" $?
# The minted secret must never be echoed — its only sink is the tee into the
# token file. Any echo/printf that references $new besides that tee is a leak.
leaks=$(nt | grep -E '(echo|printf).*\$new' | grep -cv 'tee')
check "the new token is never printed (found $leaks leaks)" "$leaks"

echo "couchside tls"
tl() { awk '/^  tls\)$/,/^    ;;$/' "$tmp"; }
lines=$(tl | wc -l | tr -d ' ')
[ "$lines" -gt 5 ] && [ "$lines" -lt 120 ]; check "tls block is bounded ($lines lines)" $?
grep -q '^  tls)$' "$tmp"; check "tls subcommand exists" $?
# The actual curl, not a comment mentioning the route (a comment kept a
# mutation of this pin green — measured 2026-08-15).
tl | grep -q 'curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/api/ping"'
check "status reads the LIVE advert, not just config" $?
tl | grep -q 'FAILS'
check "off warns that pinned phones fail closed" $?
rm -f "$tmp"

echo "CLI restarts the agent with the argv sudoers actually grants"
# The grant install.sh writes is EXACT-argument. A verb that restarts with any
# other argv needs a password, and with 2>/dev/null attached it fails SILENTLY —
# measured on a real box 2026-08-16: the config was written, success reported,
# and the agent kept serving the old value. These two pins tie the CLI to the
# rule; if either side is edited alone, this goes red.
GRANT='systemctl restart --no-block couchside.service'
grep -q "NOPASSWD: /usr/bin/$GRANT" "$SRC"
check "install.sh still grants exactly '$GRANT'" $?
tmp2="$(mktemp)"
awk '/^cat > "\$CLI" <<'"'"'CLIEOF'"'"'$/{f=1;next} /^CLIEOF$/{f=0} f' "$SRC" > "$tmp2"
# Every restart must go through the one helper...
grep -q '^_restart_agent()' "$tmp2"
check "CLI defines a single _restart_agent helper" $?
# ...which uses -n (never hangs on a prompt) and the granted argv verbatim.
grep -q "sudo -n $GRANT" "$tmp2"
check "the helper uses -n and the granted argv verbatim" $?
# No verb may hand-roll its own restart. Exclude comment/echo lines: the helper
# deliberately NAMES the old broken form to explain it, and prints it as a hint.
handrolled=$(grep -n 'sudo systemctl restart' "$tmp2" | grep -vE '^\s*[0-9]+:\s*#' | grep -vc 'echo')
check "no verb hand-rolls a restart (found $handrolled)" "$handrolled"
# Silence is what hid this: a failed restart must SAY so.
grep -q 'NOT live yet' "$tmp2"
check "a failed restart warns instead of '|| true'" $?
rm -f "$tmp2"

echo "firewall opens the TLS port"
grep -q 'firewall-cmd --add-port="${TLS_PORT}/tcp" --permanent' "$SRC"
check "firewalld branch opens the TLS port" $?
grep -q 'ufw allow "${TLS_PORT}/tcp"' "$SRC"
check "ufw branch opens the TLS port" $?
grep -q 'if \[ -n "$TLS_PORT" \]' "$SRC"
check "TLS port open is gated (opt-out leaves no hole)" $?
grep -q 'tls.get("enabled", True)' "$SRC"
check "opt-out (tls.enabled false) yields an empty TLS_PORT" $?

echo
if [ "$fails" -gt 0 ]; then echo "FAILED: $fails"; exit 1; fi
echo "all installer-cli pins passed"
