# Project: `ujust get-couchside` — the Bazzite portal channel

**Status:** 📋 Drafted 2026-08-01, NOT submitted. The recipe below is written
against `ublue-os/bazzite` main as of tonight (82-bazzite-apps.just, 1036
lines; yafti.yml, 884 lines — both re-fetched, not trusted from the 07-23
memory). Owner decides when to open the PR.

**The honest gate, recorded before anyone falls in love with this:** the
2026-07-23 research (see the bazzite-distribution-channels memory) found the
real bars are blast-radius scrutiny (an unattended LAN daemon that can reboot
the box) and ADOPTION — the portal is a deliberately small list and everything
in it is orders of magnitude bigger than us. A PR now may simply be declined
as too niche. That is not a reason not to try; it is the expectation to carry
in. The docs PR (#489) was the low-bar precedent-matching move and is done.

## The recipe (drop into 82-bazzite-apps.just)

Follows the `get-emudeck` shape exactly: `get-<name> ACTION=""`, an
`install-` alias, status|install|uninstall contract, interactive `ugum` menu
when no action given. Status detection = the systemd unit, which is what the
installer actually creates — not a grep for files.

```just
alias install-couchside := get-couchside

# Install Couchside (https://couchside.tv) - phone remote & dashboard for this box. Options: status | install | uninstall
[group("gaming")]
get-couchside ACTION="":
    #!/usr/bin/bash
    set -eo pipefail
    get_status_token() {
        if systemctl list-unit-files couchside.service &>/dev/null && \
           [[ -f "$HOME/.local/opt/couchside/couchsided.py" ]]; then
            echo "install"
        else
            echo "uninstall"
        fi
    }
    get_current_status() {
        if [[ "$(get_status_token)" == "install" ]]; then
            echo "Installed"
        else
            echo "Not Installed"
        fi
    }
    install_couchside() {
        curl --retry 3 -fsSL https://couchside.tv/install.sh | bash
    }
    uninstall_couchside() {
        curl --retry 3 -fsSL https://couchside.tv/install.sh | bash -s -- --uninstall
    }
    OPTION="{{ ACTION }}"
    if [[ "$OPTION" == "status" ]]; then
        get_status_token
        exit 0
    elif [[ "$OPTION" == "install" ]]; then
        install_couchside
        exit 0
    elif [[ "$OPTION" == "uninstall" ]]; then
        uninstall_couchside
        exit 0
    elif [[ -z "$OPTION" ]]; then
        current_status=$(get_current_status)
        echo "${bold}Couchside${normal}"
        echo "Current status: $current_status"
        OPTION=$(ugum choose "Install" "Uninstall" "Exit without changes")
        case "$OPTION" in
            "Install")
                install_couchside
                ;;
            "Uninstall")
                uninstall_couchside
                ;;
            *)
                echo "No changes made."
                ;;
        esac
        exit 0
    fi
```

## The yafti.yml entry (optional, separate ask)

The portal toggle is a SECOND, bigger ask than the recipe — the recipe alone
already gives every Bazzite user `ujust get-couchside` from any terminal and a
one-line install instruction for the site/docs. Recommend submitting the
recipe FIRST, alone; a toggle can be a follow-up once the recipe has sat
upstream for a while. If/when:

```yaml
      "Couchside (phone remote & dashboard)":
        description: "Control this machine from your phone: launch games, switch sessions, trackpad, power. LAN-only, no accounts."
        default: false
        status_script: "ujust get-couchside status"
        packages:
          - Install:
              script: 'ujust get-couchside install; status=$?; echo; echo "Press Enter to close..."; read -r _; exit $status'
          - Uninstall:
              script: 'ujust get-couchside uninstall; status=$?; echo; echo "Press Enter to close..."; read -r _; exit $status'
```

## MUST-FIX BEFORE SUBMITTING: `--uninstall` completeness

`install.sh --uninstall` exists (the flag is real — the removal block around
`:428` disables the service). **Verify it removes EVERYTHING the installer now
creates, on a real box, before the PR** — the reviewers will read that path
first, and tonight's helper work added new root-owned artifacts:

- [ ] `/etc/systemd/system/couchside-helper.socket` + `.service` (disable
      --now, then remove)
- [ ] `/usr/local/libexec/couchside-helper.py`
- [ ] `/run/couchside/` (socket dir)
- [ ] the sudoers file, udev rule, `/etc/couchside`, both autologin drop-ins,
      greetd backup if present — audit the whole (e0)-(h) trail

If any of those survive an uninstall, that is a real gap for OUR users today,
not just a PR blocker — fix it in install.sh regardless of whether the ujust
PR ever opens.

## Submission mechanics

1. Fork `ublue-os/bazzite`, one commit touching ONLY
   `system_files/desktop/shared/usr/share/ublue-os/just/82-bazzite-apps.just`.
2. PR body: what Couchside is (one paragraph), LAN-only/no-cloud/token-auth,
   MIT agent, installer is signed + verified (Ed25519, the PR can link the
   sign/verify code), precedent: Decky-style curl|sh of a systemd service,
   uninstall is complete and testable via `ujust get-couchside uninstall`.
   Volunteer to maintain the recipe.
3. Expect blast-radius questions (uinput, reboot, session switching). The
   honest answers exist: allowlist architecture, bearer token, LAN-only, the
   privileged helper (root surface = eight audited verbs). Link the security
   audit summary.
4. If declined on niche/adoption grounds: keep the recipe in OUR docs as a
   copy-paste `ujust`-style snippet, revisit at real adoption numbers.
