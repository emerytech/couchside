# CEC TV input picker preview

The shared Power & volume menu and Pad Remote view can list the video sources
discovered by a box's kernel `cec-ctl` adapter. This is an additive preview:
existing CEC power, volume, and Switch to Box behavior is retained. RS-232 panel
inputs keep their existing IDs and commands. Unsupported adapters omit the list.

## Behavior and limits

- The initial scan runs in a background worker with an 18-second process limit.
  Status requests return immediately with cached results and a loading flag.
- Results are cached for five minutes. Refresh is throttled, and concurrent scans
  share a single worker for the current adapter.
- Only discovered video sources appear. CEC cannot enumerate empty HDMI ports or
  devices that do not participate in CEC. Audio-system nodes are excluded.
  An HDMI-connected PC that does not advertise CEC will not appear. Use the TV's
  own input controls, or a separately paired network TV remote, for those ports.
- Selecting this box uses its established One Touch Play path. Other sources use
  Set Stream Path, without announcing another device as this box's Active Source.
  The picker preserves the adapter's configured logical address, name, and vendor.
- Before selecting another CEC device, a discrete Power On key is sent only to
  that device's inventoried logical address. Standby Apple TV ignored the routing
  request until woken. Unsupported wake keys do not prevent the routing request.
- A transmitted command is a request, not confirmation that a TV switched inputs.
  Some TVs may ignore routing requests from a playback device. The TV's own remote
  remains the fallback.
- Routing requires authentication and a fresh server-generated inventory ID.
  Arbitrary addresses, stale lists, changed adapter addresses, and overlapping
  switches are rejected. No commands are queued for later execution.
- If the HDMI link loses its physical address, routing stops until the adapter
  reconnects. A cached address is never forced onto a disconnected adapter.
- Mock mode never scans or routes real CEC hardware.

## Verification

The inventory parser was checked against a live Steam Machine CEC scan containing
the box on HDMI 4 and an Apple TV on HDMI 2. Both appear with the correct names.
The shared menu was checked in a local browser fixture for discovery rows, request
feedback, and refresh. The initial routing-only request did not switch the TV.
With the targeted wake key, Apple TV reported Active Source `2.0.0.0`, and the
owner visually confirmed Apple TV appeared followed by the Steam Machine on
return. The return command also preserved the adapter's identity. This verifies
that hardware combination; other TVs can still ignore CEC routing requests.

`tests/test_cec_sources.py` covers parsing, address validation, caching, scan
failures, stale/hotplug/busy rejection, fixed subprocess arguments, mock isolation,
and authenticated HTTP routes. Existing TV source, TV identification, and Couch
Mode ceremony regression suites are also run. CI includes the new suite.

## Deployment

No version number or update manifest is changed by this preview. It is not a
released agent or app build. Existing apps that already render `Tv.sources` can
display the discovered list after an agent update; the scanning and refresh UI
needs a new app build. Older agents omit the added fields and retain their UI.

Before a device trial, compare against that device's installed agent and back it
up, including any independent Themes or Player work. Do not replace a newer test
agent wholesale with this branch. Roll back a trial by restoring that saved
binary/source and restarting only Couchside; no pairing or configuration reset is
needed.
