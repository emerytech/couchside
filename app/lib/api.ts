/**
 * Typed client for the Couchside agent API (contract v1).
 * Base URL: http://<host>:<port>  (default port 8787)
 */
import { Buffer } from 'buffer';
import { isDeclaredTooLarge, isUsableBodySize } from './responseCap';
import { Settings } from './settings';

/** The subset of Settings the API client actually needs. */
export type ConnSettings = Pick<Settings, 'host' | 'port' | 'token' | 'lastIp'>;

/**
 * A remote image source (uri + optional request headers). Structurally a subset
 * of React Native's ImageURISource, so it drops straight into <Image source>.
 */
export type ImageSource = { uri: string; headers?: Record<string, string> };

// ---------- Contract types ----------

export type Ping = {
  ok: boolean;
  app: string;
  version: string;
  /** The LAN IP the agent was reached on (agent >= 2.3); cached as Box.lastIp. */
  ip?: string | null;
  /** The agent's short hostname (agent >= 2.3); used to verify fallback identity. */
  host?: string | null;
};

/** Agent families this app will talk to (current + prior product names). */
const AGENT_APPS = /^(couchside|couchpilot|rescue)-agent$/;

/**
 * Does this ping body identify OUR box? Requires the agent family, and (when
 * both sides know a hostname (box.host is an mDNS name and the agent reports
 * host, >= 2.3)) a hostname match. Guards the cached-IP fallback: a DHCP
 * lease that wandered to a different machine must never receive this box's
 * bearer token or count as "reachable".
 */
export function pingMatchesBox(body: unknown, expectedHost: string): boolean {
  if (!body || typeof body !== 'object') return false;
  const p = body as Record<string, unknown>;
  if (p.ok !== true || typeof p.app !== 'string' || !AGENT_APPS.test(p.app)) return false;
  const expected = expectedHost.toLowerCase().replace(/\.local\.?$/, '');
  if (expected !== expectedHost.toLowerCase() && typeof p.host === 'string' && p.host) {
    return p.host.toLowerCase() === expected;
  }
  return true;
}

export type DiskInfo = {
  mount: string;
  total_gb: number;
  used_gb: number;
  free_gb: number;
  pct: number;
};

/**
 * Primary-interface facts the agent reports (>= 2.6) for the app's power path:
 * the box's MAC (for a Wake-on-LAN magic packet), whether the link is wired
 * (WoL rarely works over WiFi), and whether magic-packet wake is armed. Any
 * field is null when the agent could not read it.
 */
export type NetInfo = {
  iface: string | null;
  mac: string | null;
  wired: boolean | null;
  wol_armed: boolean | null;
};

/**
 * Optional-feature summary a box reports on /api/status (agent >= 2.8.2). Lets
 * the app hide UI a box can't back — and skip the per-feature probe requests it
 * otherwise fires on connect (GET /api/tv, /api/media, /api/screen, ...) — from
 * the status poll it already makes, instead of N separate probe-and-appear
 * round-trips. A hint, not authority: a live op still confirms (e.g. gamepad
 * true but the controller node's perms broke). Absent on older agents — when
 * `caps` is undefined the app falls back to probing each feature individually.
 */
export type BoxCaps = {
  /** Virtual game controller (/dev/uinput on Linux, ViGEmBus on Windows). Gates the Pad tab. */
  gamepad: boolean;
  /** A Steam install is present. Gates the Launch tab: games, launch, downloads, cover art. */
  steam: boolean;
  /** Now-playing / transport (MPRIS on Linux, SMTC on Windows). Gates the media card. */
  media: boolean;
  /** A TV / volume backend (RS-232 panel, HDMI-CEC, or box soft-volume). Gates the TV strip. */
  tv: boolean;
  /** A screen-capture path for the live preview. Gates the preview card. */
  screen: boolean;
  /** Scheduled wake can be armed (RTC alarm on Linux, waitable timer on Windows). Gates the sleep/wake rows. */
  power_schedule: boolean;
  /**
   * Aerial screensaver (Steam-shortcut launched, Linux/gamescope boxes only).
   * Optional: absent on agents < 2.8.4, so undefined must read as "unknown,
   * probe" — only an explicit false skips the probe.
   */
  screensaver?: boolean;
  /**
   * Couch Mode: desktop->TV Game Mode handoff (SteamOS/Bazzite desktop with a
   * TV wired in, 2+ outputs). Optional: absent on agents < 2.9, so undefined
   * reads as "unknown, probe"; only an explicit false skips the probe.
   */
  couchmode?: boolean;
  /**
   * Couch Mode's DEGRADED tier (agent >= 2.9.70): this box has Steam but no
   * gamescope session, so the couch button opens Big Picture in the running
   * desktop instead of switching sessions. EXCLUSIVE with `couchmode` — the
   * agent never sets both, so the UI never has to choose.
   */
  bigpicture?: boolean;
  /**
   * Desktop nav: a SteamOS/Bazzite box currently in the Plasma DESKTOP session.
   * Gates the RemoteView desktop cluster (Start menu, pointer/trackpad, overview)
   * — session-aware, so it flips off once the box is in Game Mode. Optional:
   * absent on agents < 2.9, so undefined reads as "not a desktop box here".
   */
  desktop?: boolean;
  /**
   * Steam Remote Play (in-home streaming): the box has streamed from at least
   * one host, so there are games to offer. Gates the Launch tab's "Stream from
   * PC" section. Optional: absent on agents < 2.9.23, so undefined reads as
   * "unknown, probe" — only an explicit false skips the probe.
   */
  steamlink?: boolean;
  /**
   * Steam settings deep links (agent >= 2.9.31). Every slug the box offers was
   * confirmed on hardware — an unknown slug is NOT an error in Steam, it just
   * opens the default page, so the agent ships an allowlist rather than guesses.
   */
  steammenus?: boolean;
  /**
   * The BOX's own battery (agent >= 2.9.40) — a handheld or laptop, not a
   * controller. Linux-only: it reads /sys/class/power_supply.
   * Optional, so undefined reads as "unknown, probe" and only an explicit false
   * means "this machine runs on mains".
   */
  boxbattery?: boolean;
  /**
   * Gaming card: this box has Steam, so a "what's running now" card (GPU/game/
   * output/controllers/session) is worth showing. Gates the Console-tab card.
   * Optional: absent on agents < 2.9.25, so undefined reads as "unknown, probe"
   * — only an explicit false skips the probe.
   */
  gaming?: boolean;
  /**
   * Stream host (Steam Remote Play served BY this box). Gates the Console-tab
   * "Streaming to" card. Distinct from `steamlink`, which is the CLIENT
   * direction ("Stream from PC"). Optional: absent on agents < 2.9.26, so
   * undefined reads as "unknown, probe" — only an explicit false skips it.
   */
  streamhost?: boolean;
  /**
   * Any game launcher the box can drive — Steam, Epic, GOG Galaxy, or a custom
   * launcher (Windows agent >= 0.4.0-win). Gates the Launch tab in place of
   * `steam` alone, so an Epic/GOG/Game Pass box shows its games too. Optional:
   * absent on older agents and every Linux agent, so undefined falls back to
   * `steam` for the tab decision — never hides on a guess.
   */
  launchers?: boolean;
  /**
   * Phone->box file drop (POST /api/upload, agent >= 2.9.54). Gates the
   * Console-tab "Send a file to your box" card. Optional: absent on older
   * agents, so undefined reads as "unknown, probe" — only an explicit false
   * (drop dir not writable) hides the card.
   */
  file_upload?: boolean;
  /** Box can set which session it BOOTS into (agent >= 2.9.58). Four backends —
   *  steamosctl, or a conf-dir drop-in for sddm or plasmalogin, or greetd; see
   *  the `backend` union on SessionDefault below, which this comment used to
   *  contradict. Absent when none is usable, so the setting never appears on a
   *  box that cannot honour it. */
  session_default?: boolean;
  /**
   * Display + audio readout (agent >= 2.9.59): mode, panel identity, HDR/VRR,
   * default sink and source. Gates the Console-tab "DISPLAY & AUDIO" card.
   * Linux-only — every source behind it is DRM sysfs, a Wayland compositor, or
   * WirePlumber. Optional: absent on older agents and on Windows, so undefined
   * reads as "unknown, probe" and only an explicit false skips the request.
   */
  display_info?: boolean;
  /**
   * Couchside Player (agent >= 2.9.61): the streaming-service tile is deployed
   * AND the box has a Widevine-capable browser. Gates the Watch tab. False is a
   * real answer here, not a gap — a box with no Chrome reports false rather
   * than offering a control that would open a black window. Optional: absent on
   * older agents and on Windows, so undefined reads as "unknown, probe".
   */
  player?: boolean;
  /**
   * Install a game you OWN but have not downloaded (agent >= 2.9.73): the box can
   * enumerate the owned-but-uninstalled library from Steam's local art cache and
   * fire steam://install for one. Gates the Launch tab's "Not installed" section.
   * Linux-only — it reads appcache/librarycache off the Steam root. Optional:
   * absent on older agents and on Windows, so undefined reads as "unknown, probe"
   * and only an explicit false skips the request.
   */
  steaminstall?: boolean;
  /**
   * Setup → Utilities endpoint present (agent >= 2.9.74): one-click hardware/setup
   * helpers (flash an OpenPuck receiver, enable HDMI-CEC, …). Linux-only. The app
   * ALSO gates the section behind an opt-in pref, so a firmware-flashing surface is
   * never shown unless the user turns it on. Optional: undefined reads as "unknown,
   * probe"; only explicit false skips it.
   */
  utilities?: boolean;
  /**
   * Opt-in remote-desktop module present (agent + the couchside-portal helper on
   * its socket): the fullscreen desktop view uses the FLUID /ws/screen MJPEG
   * stream + tap-to-point (absolute pointer via xdg-desktop-portal) instead of the
   * still-frame poller + relative mouse. Linux/Wayland-desktop only, opt-in deps +
   * a per-session consent on the box. Optional: absent on agents without the module
   * and on Windows, so undefined reads as "unknown, probe"; only explicit false
   * skips the fluid path (the app then uses the P1 poller).
   */
  screenstream?: boolean;
  /**
   * P4b: the box has a VA H.264 encoder, so it can serve the /ws/h264 Annex-B
   * stream the app decodes with WebCodecs (VideoDecoder -> canvas in a WebView) —
   * 30–60fps hardware-decoded instead of MJPEG-over-<Image>. Linux/Wayland-desktop
   * only, opt-in. Optional + additive: absent on agents without it and on Windows,
   * so undefined reads as "unknown"; the app uses the H.264 tier when this is true
   * AND the WebView can decode, else it falls back to screenstream (MJPEG). (This
   * cap no longer implies libnice/webrtcbin — the WebCodecs path needs no WebRTC.)
   */
  screenstream_h264?: boolean;
  /**
   * Audio output switcher (agent >= 2.9.80): the box can enumerate its audio
   * sinks and set the default from the phone (TV/HDMI ↔ Bluetooth ↔ analog).
   * Linux-only — it drives pactl. Gates the Console-tab "AUDIO OUTPUT" card.
   * Optional: absent on older agents and on Windows, so undefined reads as
   * "unknown, probe" — only an explicit false (no pactl) hides the card.
   */
  audioswitch?: boolean;
  /**
   * Front light-bar / status-LED control (agent >= 2.9.81): the box can set an
   * RGB or mono LED's colour + brightness from the phone (via /sys/class/leds).
   * Linux-only. Gates the Console-tab "LIGHT" card. Optional: absent on older
   * agents and on Windows, so undefined reads as "unknown, probe" — and an
   * explicit false (no controllable/writable LED) hides the card. NOTE: on a
   * stock box the sysfs files are root-owned, so this is false until an
   * install-time udev grant makes an LED writable.
   */
  ledcontrol?: boolean;
  /**
   * Whole-system / addressable RGB via a local OpenRGB SDK server (agent >=
   * 2.9.84, cap `openrgb`). undefined = unknown/probe (older agent, Windows);
   * false = no OpenRGB server on the box. Gates the OpenRGB card + the real
   * multi-zone scanner.
   */
  openrgb?: boolean;
};

/** One Setup → Utilities helper + its live state, from GET /api/utilities.
 *  `state` is per-utility (openpuck: 'board_ready' | 'puck_present' | 'no_board';
 *  cec: 'enabled' | 'needs_enable' | 'no_adapter'). */
export type Utility = { id: string; state: string; label: string; description: string };

/** GET /api/utilities/openpuck/latest — the OpenPuck fork's newest release vs the
 *  build the box pins, for the opt-in "check for newer firmware" control. Read-only;
 *  `available: false` means the box couldn't reach GitHub (an `error` string says
 *  why). `is_newer` gates whether the app offers a newer flash. */
export type OpenpuckLatest = {
  available: boolean;
  pinned_tag: string;
  tag?: string | null;
  name?: string | null;
  size?: number | null;
  is_newer?: boolean;
  error?: string;
};

/** One owned-but-uninstalled entry from GET /api/steam/installable. name/type are
 *  present when the agent (>= 2.9.76) parsed them offline from appinfo.vdf; type
 *  is lowercased ('game' | 'dlc' | 'tool' | …) and drives the app's game filter. */
export type InstallableGame = { appid: number; name?: string; type?: string };

/**
 * Couchside Player state, from GET /api/player.
 *
 * `services` and `service_urls` both come from the TILE on the box, never from
 * a table in this app. That is deliberate: the tile is what enforces the
 * allowlist, so a copy here would be the copy furthest from enforcement and the
 * first to drift. `service_urls` exists so a pasted or shared link can be split
 * into (service, path) using the box's own hosts.
 */
export type PlayerState = {
  available: boolean;
  running: boolean;
  /** Service id the tile is pointed at ('' before anything has been opened). */
  service: string;
  /** Deep-link path, '' when the service was opened at its home page. */
  path: string;
  services: string[];
  /** {service id -> home URL}. Absent on the first agents that shipped `player`. */
  service_urls?: Record<string, string>;
  /**
   * Live <video> state, read over CDP. Null when nothing is playing or the
   * browser can't be reached — degrade closed, so the transport hides rather
   * than showing a dead scrubber. MPRIS is NOT the source here: measured, it
   * reports zero players while a streaming site is open but idle.
   */
  playback?: PlayerPlayback | null;
  /** Skip offsets this box allows. The app offers these, never its own. */
  seek_secs?: number[];
  /**
   * Services with a VERIFIED search URL — a subset of `services`. Searching
   * opens that service's own results page on the box, so nobody types a title
   * on a TV. Absent on agents before search shipped.
   */
  searchable?: string[];
  /** Query the tile is currently showing results for, '' otherwise. */
  query?: string;
  /**
   * {service -> extra hosts it is reachable on}, for LINK MATCHING only.
   * Measured: play.max.com redirects to play.hbomax.com and shared Max links
   * use the latter, so matching only the canonical host rejected the one
   * service whose deep-link pattern is verified. Never used to decide what may
   * be opened — the box still re-validates.
   */
  service_hosts?: Record<string, string[]>;
};

export type PlayerPlayback = {
  playing: boolean;
  /** Seconds. */
  position: number;
  /** Seconds; 0 for a live stream or before metadata loads. */
  duration: number;
  muted: boolean;
  title: string;
};

/** Transport ops the box accepts. Anything else is refused with a 404. */
export type PlayerOp =
  | 'open' | 'close' | 'hub'
  | 'play' | 'pause' | 'playpause' | 'mute' | 'seek';

/** One connected display, from GET /api/displays. */
export type Display = {
  name: string;
  /** True for a built-in panel (eDP/LVDS/DSI); false = an external monitor/TV. */
  internal: boolean;
};

/** GET /api/displays state (agent >= 2.9): the box's outputs for Couch Mode. */
export type Displays = {
  available: boolean;
  outputs: Display[];
  /** External output names to offer as the game display (default = first). */
  game_outputs: string[];
  /** Current session: 'gamescope' when already in Game Mode, else 'desktop'. */
  session: 'gamescope' | 'desktop';
  /** Whether the box's session honors the chosen output (Bazzite: yes; SteamOS
      hardcodes its preference: no). false hides the picker — a dead control is
      worse than none. undefined (older agent) keeps the picker visible. */
  output_forcing?: boolean;
};

/**
 * One display mode. `refresh_hz` is absent whenever the agent could read the
 * SIZE but not the rate — the two come from different sources on the box, so
 * they are independently optional rather than one object that is all-or-nothing.
 */
export type DisplayMode = {
  width: number;
  height: number;
  refresh_hz?: number;
};

/**
 * GET /api/display-info (agent >= 2.9.59): what the box is actually driving —
 * mode, panel identity, HDR/VRR, and the default audio devices.
 *
 * EVERY FIELD IS INDEPENDENTLY OPTIONAL, and that is the whole contract. There
 * is no single source on a Linux box that answers all of this: the current mode
 * comes from the compositor (Game Mode only), the panel name and preferred mode
 * come from EDID in sysfs (any session), and the audio devices come from
 * WirePlumber. The agent OMITS what it could not read rather than guessing, so
 * an absent key means "couldn't tell", never "no" — the UI must render it as a
 * dash, never as a value. Degrading closed is the point (CLAUDE.md §3.7).
 *
 * The distinction that matters most: `mode` is what is being scanned out RIGHT
 * NOW; `preferred_mode` is what the panel's EDID says it would LIKE, which is a
 * capability and identical whether the box is driving it or is blanked. They
 * are separate keys — never back-fill one from the other — because on most
 * boxes they happen to be equal, so conflating them looks correct everywhere
 * except the box where it is wrong.
 */
export type DisplayInfo = {
  /** False when nothing at all could be read; the card hides. */
  available: boolean;
  display?: {
    /** DRM connector, e.g. "DP-1" / "HDMI-A-1". */
    connector?: string;
    /** DRM status: true = a panel is plugged in and awake. */
    connected?: boolean;
    /** True for a built-in panel (eDP/LVDS/DSI); false = external monitor/TV. */
    internal?: boolean;
    /** EDID product name (0xFC descriptor), e.g. "TIO24Gen3T". */
    monitor?: string;
    /** EDID manufacturer, e.g. "Lenovo Group Limited". Shown only when there
        is no `monitor` — together they are far too long for one row. */
    make?: string;
    /** The mode being scanned out now. Compositor-sourced; absent on any box
        where the agent could not ask one (no session, desktop path unread). */
    mode?: DisplayMode;
    /** The panel's preferred mode from EDID. A CAPABILITY — the card labels it
        "preferred" and never prints it as the current mode. */
    preferred_mode?: DisplayMode;
    /** Rates the compositor reports as valid for this panel. A SUPPORTED list,
        not the current rate: a 60-only panel reports [60] whether it is lit or
        dark. Labelled "supported" wherever it is shown. */
    refresh_rates_hz?: number[];
    /** `supported` from EDID/compositor capability; `enabled` is the live
        state and is absent when the box exposes no honest read of it — which
        is the normal case in Game Mode. Absent `enabled` must render as
        "supported", never as "off". */
    hdr?: { supported?: boolean; enabled?: boolean };
    /** Same split as `hdr`: capability vs. live state, each optional. */
    vrr?: { supported?: boolean; active?: boolean };
  };
  audio?: {
    /** Default sink description ("Built-in Audio Analog Stereo"). */
    output?: string;
    /** Default source description. Frequently a DIFFERENT device from the
        sink, so the two are separate fields and both are shown. */
    input?: string;
  };
};

/** One audio output the box can play through, from GET /api/audio (agent >= 2.9.80,
    cap `audioswitch`). `name` is the pactl node id the switch POSTs back verbatim;
    `desc` is the human label shown in the row. */
export type AudioSink = {
  name: string;
  desc: string;
  hdmi: boolean;
  available: boolean;
  /** True for the sink pactl currently reports as the default. */
  default: boolean;
};

/** GET /api/audio: the box's audio outputs + which is the current default.
    `available: false` = no pactl on this box (the card hides). */
export type AudioState = {
  available: boolean;
  default: string | null;
  sinks: AudioSink[];
};

/** An 8-bit RGB colour, as the app and agent both speak it (0–255 per channel,
    device-independent — the agent scales to the LED's own range). */
export type Rgb = { r: number; g: number; b: number };

/** One controllable LED from GET /api/leds (agent >= 2.9.81, cap `ledcontrol`).
    `name` is the /sys/class/leds node id the setter POSTs back verbatim. */
export type LedInfo = {
  name: string;
  desc: string;
  /** True for a multicolour LED (has colour swatches); false = brightness only. */
  rgb: boolean;
  /** Presentation hint from the agent: a front/status/RGB light vs a keyboard
      indicator. The app renders only notable LEDs. */
  notable: boolean;
  /** The agent can write this LED as the desktop user (else it isn't returned). */
  writable: boolean;
  max_brightness: number;
  brightness: number;
  /** 0–100, so the app can light the matching level button. */
  brightness_pct: number;
  /** Current colour for an rgb LED, or null (mono, or the box couldn't tell). */
  color: Rgb | null;
};

/** The animated LED effects the agent supports (agent >= 2.9.84). `solid` and
    `off` are one-shot (no animation); the rest run on the box until changed.
    `scanner` is the KITT sweep — real across multiple LEDs (OpenRGB), a
    bounce-pulse on a single kernel LED. */
export type LedEffect =
  | 'solid' | 'off' | 'breathe' | 'pulse' | 'rainbow' | 'strobe' | 'scanner'
  // `manual` = a per-LED painted pattern on a strip (agent >= 2.9.85); the
  // colours stick because the agent puts each node in the driver's manual mode.
  | 'manual';

/** The effect currently running on an LED (from GET /api/leds `active`). Absent
    for an LED showing a plain solid colour (that's read from LedInfo instead). */
export type LedActive = {
  effect: LedEffect;
  color: Rgb | null;
  speed: number;
  brightness: number;
};

/** An addressable STRIP the agent groups from `prefix[N]` LED nodes (agent >=
    2.9.85), e.g. a Steam Machine's 17 `valve-leds`. `hw_effects` are the firmware
    effect names the driver runs on the box itself (patrol/breath/rainbow/…), so
    the animation survives the app closing. */
export type StripInfo = {
  prefix: string;
  count: number;
  rgb: boolean;
  hw_effects: string[];
};

/** GET /api/leds: the writable LEDs the box exposes + their state.
    `available: false` = nothing controllable here (the card hides). */
export type LedsState = {
  available: boolean;
  leds: LedInfo[];
  /** Supported effect ids (agent >= 2.9.84); absent on an older agent, in which
      case the app shows colour/brightness only and hides the effect controls. */
  effects?: LedEffect[];
  /** Per-LED (and per-strip, keyed `strip:<prefix>`) running effect (agent >= 2.9.84). */
  active?: Record<string, LedActive>;
  /** Addressable strips the agent can drive as a whole (agent >= 2.9.85). Absent
      on older agents → the app falls back to driving the sweep itself. */
  strips?: StripInfo[];
};

/** One OpenRGB controller from GET /api/openrgb (agent >= 2.9.84, cap `openrgb`).
    `index` is what the setter POSTs back; `led_count` is the sum of its zones. */
export type OpenRgbController = {
  index: number;
  name: string;
  led_count: number;
  zones: { name: string; leds: number }[];
};

/** GET /api/openrgb: the OpenRGB controllers the box exposes + their running
    effect. `available: false` = no OpenRGB server on the box (card hides). */
export type OpenRgbState = {
  available: boolean;
  /** "host:port" of the OpenRGB SDK server, or null when unavailable. */
  server: string | null;
  controllers: OpenRgbController[];
  effects?: LedEffect[];
  /** Per-device running animation, keyed by device index (as a string). */
  active?: Record<string, LedActive>;
};

/** One stage of the Couch Mode ceremony (GET /api/couch-mode/status, agent
    >= 2.9.19). */
export type CeremonyStage = {
  key: 'tv_power_on' | 'tv_input' | 'output' | 'session' | 'audio';
  label: string;
  state: 'pending' | 'running' | 'ok' | 'skipped' | 'failed';
  /** Why it was skipped/failed (SteamOS ignores the picker; the TV's HDMI sink
      never woke; no TV backend…). */
  reason?: string;
  /** Only the session switch is fatal. A non-fatal `failed` (e.g. audio) is a
      warning the UI renders amber, not red — Game Mode still came up. */
  fatal?: boolean;
};

/** The Couch Mode ceremony job. Full array every poll, so a phone joining
    mid-run catches up for free. */
export type CeremonyStatus = {
  id: number;
  state: 'idle' | 'running' | 'done' | 'failed';
  output?: string;
  hdr?: boolean;
  /** The VERIFIED session at a terminal state (not a fake-green assumption). */
  session?: 'gamescope' | 'desktop' | null;
  started_at?: number;
  stages: CeremonyStage[];
  // A new agent's POST response also carries legacy {ok, steps}; the new app
  // ignores them and drives the UI from `stages`.
};

/** POST /api/couch-mode returns the initial ceremony job (agent >= 2.9.19) OR
    the old synchronous {ok, ...} (older agent). The sheet feature-detects on
    the presence of a `stages` array. */
export type CouchModeStartResult = CeremonyStatus | { ok: boolean };

/** GET/POST /api/screensaver state (agent >= 2.8.4). */
export type Screensaver = {
  available: boolean;
  running: boolean;
  /** Current theme ("all" or comma list, e.g. "space,underwater"). */
  theme: string;
  tier: string;
  themes: string[];
  tiers: string[];
};

/**
 * Recent-vitals ring (agent >= 2.8.3): parallel arrays, oldest first, sampled
 * on the status poll itself (>=10s apart, ~30 samples ≈ 5 min). Entries may be
 * null when the box couldn't read a value — gap the sparkline, don't draw 0.
 */
export type StatusHistory = {
  t: number[];
  temp: (number | null)[];
  load: (number | null)[];
  mem_pct: (number | null)[];
};

export type Status = {
  hostname: string;
  time: number;
  uptime_s: number;
  load: [number, number, number];
  cpu_temp_c: number | null;
  mem: {
    total_mb: number;
    used_mb: number;
    available_mb: number;
    /** Swap in use (agent >= 2.9.43); absent when the box has no swap. */
    swap_total_mb?: number;
    swap_used_mb?: number;
    /** Linux PSI memory pressure (agent >= 2.9.43): the share of time work was
     *  STALLED waiting on memory, which is what you actually feel — a used
     *  percentage says how much is spoken for, not whether anything hurts.
     *  `some` = at least one task stalled, `full` = everything stalled.
     *  ABSENT (not zero) on kernels without CONFIG_PSI: "no pressure" and
     *  "cannot tell" must not render the same. */
    pressure?: { some10?: number; some60?: number; full10?: number; full60?: number };
  };
  disks: DiskInfo[];
  /** Network facts for the power/Wake-on-LAN path (agent >= 2.6). */
  net?: NetInfo;
  /** The LAN IP the phone reached the box on (agent >= 2.9.22). The app learns
      it into the box's lastIp every poll, so the cached-IP fallback stays fresh
      and works for boxes added by hostname. */
  ip?: string;
  agent_version: string;
  /** Which OS the box runs (agent >= 2.9.34). Absent on older agents and on any
   *  box whose /etc/os-release could not be read — omission, never a null.
   *  Shapes differ by distro: a rolling release (CachyOS) has no VERSION_ID and
   *  reports `version` from BUILD_ID with no separate `build`; a point release
   *  (Bazzite, SteamOS) sends both. */
  os?: {
    /** PRETTY_NAME, falling back to NAME. e.g. "Bazzite", "CachyOS". */
    name?: string;
    /** VERSION_ID, falling back to BUILD_ID. e.g. "43", "rolling", "3.8.21". */
    version?: string;
    /** BUILD_ID when it differs from `version`. e.g. "Stable (F43.20260420)". */
    build?: string;
    /** uname release — the single most useful line in a handheld bug report. */
    kernel?: string;
  };
  /** Optional-feature summary (agent >= 2.8.2); undefined on older agents. See BoxCaps. */
  caps?: BoxCaps;
  /** Recent-vitals ring for sparklines (agent >= 2.8.3); undefined on older agents. */
  history?: StatusHistory;
  /** The BOX's own battery (agent >= 2.9.40). ABSENT on a mains desktop and on
      older agents alike — the agent omits the key entirely rather than sending
      zeroes, so "no battery card" needs no separate flag. `minutes` is present
      only while discharging: on AC the same counter measures the CHARGE rate,
      and reporting it as time-remaining would be confidently wrong. */
  battery?: {
    pct: number;
    status: string;
    on_ac?: boolean;
    minutes?: number;
    /** Instantaneous power flow in watts (agent >= 2.9.43). The SIGN is
        `status`, not the number: while charging this is the CHARGE rate, so
        never label it "discharge" without checking. Absent when the gauge
        reports nothing — a box drawing 0 W does not exist. */
    watts?: number;
    /** Minutes until the battery is FULL, while charging (agent >= 2.9.43).
        Deliberately separate from `minutes`, which means "runtime left on
        battery" — folding them together would make an older app report
        "42m left" while the box is plugged in and filling up. */
    minutes_to_full?: number;
    /** ACPI platform profile, verbatim (agent >= 2.9.43). NOT guaranteed to be
        one of the usual low-power/balanced/performance values: a Legion Go S
        reported "custom" because Steam's TDP control set one. Render whatever
        arrives; do not switch on a fixed set. */
    profile?: string;
  };
};

export type UnitScope = 'system' | 'user';

export type Unit = {
  name: string;
  scope: UnitScope;
  active: string;
  sub: string;
  description: string;
  /**
   * A LOG SOURCE, not a real service (Windows agent >= 0.4.4). The agent's own
   * log is in the watchlist so it reaches the Logs picker; it has no Windows
   * service behind it, so showing it in the units card meant a permanent
   * "inactive/not-found" warning. Absent on every other agent — treat undefined
   * as "a real unit", which is what it has always been.
   */
  log_only?: boolean;
};

export type Danger = 'low' | 'medium' | 'high';

export type ActionInfo = {
  id: string;
  label: string;
  description: string;
  danger: Danger;
};

export type ActionResult = {
  ok: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  /** New mute state, returned by the mute op (agent >= 2.6.5). */
  muted?: boolean | null;
  /** Machine-readable hint the app maps to a specific message. Currently
      "roku_control_disabled" — a reachable Roku that 403s control because its
      "Control by mobile apps" network access isn't permissive. */
  hint?: string;
};

export type Journal = {
  unit: string;
  scope: string;
  lines: string[];
};

/**
 * A launcher tile. Steam games are auto-discovered by the agent (kind
 * "steam", carrying the numeric appid used for cover art); "custom" launchers
 * are user-defined argv commands the app can add/delete.
 */
export type Launcher = {
  id: string;
  label: string;
  /** "shortcut" = a non-Steam shortcut from Steam's shortcuts.vdf (agent
   *  >= 2.9.57). On SteamOS that is how Netflix/Hulu/Disney+/EmuDeck and the
   *  rest reach the TV. It is deliberately not "custom": custom launchers come
   *  from the agent's own config and offer a delete control, which would do
   *  nothing for a shortcut that lives in Steam's file. An older app build
   *  receiving this value degrades cleanly — it renders the generic rocket
   *  tile and offers no delete, which is exactly right. */
  kind: 'steam' | 'custom' | 'shortcut';
  /** Steam appid, present for kind "steam": used for library cover art. */
  appid?: number;
  /**
   * Install size in bytes, from Steam's own appmanifest (agent >= 2.9.72).
   *
   * ABSENT means Steam did not state a size — a game mid-download, or one it
   * has not measured. The agent never sends an invented zero, because "0 GB"
   * reads as free space that is not free.
   */
  size_bytes?: number;
  /**
   * Minutes played, from Steam's own localconfig.vdf on the box (agent
   * >= 2.9.71). LOCAL — no Steam Web API key, no public profile, no network.
   *
   * ABSENT means Steam has no record, which is exactly the "never played"
   * signal; the agent deliberately does not send a zero it had to invent. A
   * real 0 (installed, launched, quit immediately) IS sent as 0, so
   * `playtime_min === 0` and `playtime_min === undefined` mean different
   * things and the filter must not conflate them.
   */
  playtime_min?: number;
  /** Unix seconds Steam last saw this game launched (agent >= 2.9.71). Absent
   *  when never launched. */
  last_played?: number;
  /** Which SHAPE of cover art the box has locally (agent >= 2.9.41).
   *  "portrait" = a 600x900 capsule that fills a tile; "header" = a 460x215
   *  banner that does NOT and needs its own layout. Absent means no local art
   *  (or an older agent), which renders the text card either way — so an old
   *  agent behaves exactly as it does today. */
  art?: 'portrait' | 'header';
};

/** State of an in-progress Steam operation. Unknown values render as 'updating'. */
export type SteamDownloadState =
  | 'downloading'
  | 'paused'
  | 'queued'
  | 'validating'
  | 'finalizing'
  | 'updating';

/** One Steam app with a download/update/validation operation. */
export type SteamDownload = {
  appid: number;
  name: string;
  state: SteamDownloadState;
  /**
   * True when bytes/install work are ACTUALLY moving right now (agent >= 2.9.4),
   * vs a queued/pending update Steam hasn't started. Absent on older agents —
   * treat undefined as active so their behavior is unchanged.
   */
  active?: boolean;
  bytes_total: number;
  bytes_downloaded: number;
  percent: number;
};

/** True when this entry is genuinely transferring/installing (not just queued). */
export function isActiveDownload(d: SteamDownload): boolean {
  return d.active !== false && d.state !== 'queued';
}

export type Downloads = { downloads: SteamDownload[] };

/**
 * Steam Remote Play (in-home streaming), agent >= 2.9.23. A host is another
 * Steam machine on the LAN (your gaming PC / another Deck) the box has streamed
 * from; `games` are the titles it offers. Launch one with
 * `api.launch(settings, `stream:${appid}`)` — Steam streams it natively, no
 * Steam Link app to install. Probe-and-appear: 404 -> null hides the surface.
 */
export type StreamGame = { appid: number; label: string };
export type StreamHost = {
  host: string;
  /** Unix seconds the box last saw this host (newest first in the list). */
  last: number;
  games: StreamGame[];
  /**
   * Whether the host looks reachable right now (agent >= 2.9.32). Absent on
   * older agents — treat undefined as "unknown", NOT offline, so they render
   * exactly as before. Deliberately conservative: ambiguity resolves to false,
   * so a false here is advisory (dim + explain), never a reason to disable the
   * row. Streaming from an off host is what makes Steam fall back to "play
   * locally" and offer a multi-GB install, which reads as a Couchside bug.
   */
  online?: boolean;
  /** Short, already user-facing explanation of `online` ("no response in 66m"). */
  reason?: string;
  /** Unix seconds Steam itself last saw the host; 0 when it never has. */
  last_seen?: number;
};
export type SteamLink = { available: boolean; hosts: StreamHost[] };

/**
 * Live gaming card payload (agent >= 2.9.25). EVERY field is independently
 * optional — the agent omits what it cannot read, so a box with no discrete GPU
 * (Intel i915) has no `gpu` key at all. `session` is the only field always
 * present. Cover art for `game.appid` via steamCoverSource (box cache, LAN-only).
 */
/** One Steam settings panel the box can jump to (agent >= 2.9.31). */
export type SteamMenu = { id: string; label: string };
export type SteamMenus = { menus: SteamMenu[] };

/** One GPU as the box reports it (agent >= 2.9.43; `card` >= 2.9.67). */
export type GpuInfo = {
  name: string;
  /** DRM card the reading came from, e.g. "card1" (agent >= 2.9.67). The only
   *  stable way to tell two GPUs apart in the UI. */
  card?: string;
  temp_c?: number;
  vram_used_mb?: number;
  vram_total_mb?: number;
  /** System memory the GPU may use (agent >= 2.9.43). On an APU this is the
   *  number that matters: a Legion Go S carves out 512 MB of "VRAM" that sits
   *  at 89% while 15.3 GB of GTT is barely touched, so VRAM alone made a 32 GB
   *  handheld look like a full 0.5 GB graphics card. */
  gtt_used_mb?: number;
  gtt_total_mb?: number;
  /** How hard the GPU is actually working, 0-100 (agent >= 2.9.43). A memory
   *  bar says what is allocated, not whether anything is happening. */
  busy_pct?: number;
};

export type Gaming = {
  /** The primary GPU — the discrete card when a box has one. Unchanged field,
   *  still sent by every agent, so older app code keeps working. */
  gpu?: GpuInfo;
  /** EVERY GPU the box can read, in DRM card order (agent >= 2.9.67). A
   *  dual-GPU laptop reports its integrated and discrete cards separately;
   *  before this, only the first was sent and it was usually the iGPU. */
  gpus?: GpuInfo[];
  game?: {
    appid: number;
    label?: string;
    /** Seconds the game has been running (agent >= 2.9.43). From the process
        start time in /proc, compared against uptime rather than wall time, so a
        clock change cannot make it look like the game started tomorrow. */
    running_s?: number;
    pid?: number;
  };
  output?: { name: string; internal: boolean };
  controllers?: {
    uniq: string;
    name: string;
    battery_pct?: number;
    battery_status?: string;
  }[];
  session: string;
};

/**
 * Steam Remote Play served BY this box (agent >= 2.9.26, phase 4a detect-only).
 * `active` means a peer is streaming from the box right now; the card renders
 * only then. Probe-and-appear: 404 -> null. The OPPOSITE direction from
 * SteamLink ("Stream from PC").
 */
export type HostSession = {
  available: boolean;
  /** Steam is listening on the Remote Play port — the box can host. */
  listening: boolean;
  active: boolean;
  /** The client platform Steam reported (e.g. "macOS"), when the log named it. */
  client?: string;
  /** Unix seconds the session started (from the log's own timestamp). */
  since?: number;
};

/**
 * Box-side update check (agent >= 2.9.5), read over the LAN. The BOX contacts
 * GitHub (it already does that to update itself) and caches the result; the app
 * only ever talks to the box, so the app itself never leaves your network. See
 * the agent's /api/update/check for the privacy rationale. Absent on older
 * agents (404 -> null -> no banner).
 */
/** GET/POST /api/update/flatpak (agent >= 2.9.46). */
/** GET /api/update/os (agent >= 2.9.47). */
export type OsStatus = {
  /** "rpm-ostree" | "steamos" — which atomic updater the box has. */
  kind: string | null;
  /** Opted in via `couchside allow-system-updates on`. */
  elevated: boolean;
  /** Booted OS version. */
  current: string | null;
  /** An update is downloaded and applies on the NEXT reboot. */
  staged: boolean;
};

export type FlatpakStatus = {
  available: boolean;
  count: number;
  /** "app-id\tversion" lines from the box's remote-ls. */
  updates: string[];
  /**
   * Whether SYSTEM flatpaks can be updated — i.e. the box owner ran
   * `couchside allow-system-updates on`. False means only --user apps update,
   * and the card should point at the opt-in instead of pretending.
   */
  elevated: boolean;
  /**
   * Whether the box's flatpak-update process is still running (agent >= 2.9.59).
   * This is the completion signal to poll — NOT `count === 0`. An end-of-life
   * runtime that `flatpak update` cannot apply keeps `count` above zero forever
   * (KI-036), so waiting for zero hangs; waiting for `running` to go false does
   * not. Absent on older agents — callers must fall back to `count === 0` then.
   */
  running?: boolean;
};

export type UpdateCheck = {
  available: boolean;
  installed: string;
  latest: string | null;
  tag: string | null;
  notes: string | null;
  checked_at: number;
  /**
   * True only if the box was opted in (on the box: `couchside allow-updates on`)
   * to let the app trigger an update via applyUpdate(). Off by default, so the
   * app shows a working [Update] button only where the owner enabled it.
   */
  apply_enabled?: boolean;
  error?: string;
};

/** MPRIS transport op, POSTed as /api/media/<player>/<op>. */
export type MediaOp = 'play' | 'pause' | 'play_pause' | 'next' | 'previous' | 'stop' | 'seek';

/** One MPRIS media player's now-playing snapshot. */
export type MediaPlayer = {
  id: string;
  identity: string;
  status: 'Playing' | 'Paused' | 'Stopped';
  title: string;
  artist: string;
  album: string;
  position_ms: number;
  length_ms: number;
  rate: number;
  can_seek: boolean;
  can_go_next: boolean;
  can_go_previous: boolean;
  can_play: boolean;
  can_pause: boolean;
  /** True when the agent can serve the art bytes (a file:// the player advertised). */
  art: boolean;
  /** Cache-buster for the art fetch; changes when the track changes. */
  art_key: string;
};

export type Media = { available: boolean; players: MediaPlayer[] };

/** Screen-capture capability of the box (probe-and-appear). */
export type ScreenInfo = {
  available: boolean;
  session: 'gamescope' | 'desktop' | 'mock' | null;
  backends: string[];
  formats: string[];
};

/** Delayed suspend/poweroff timer (in-process on the box; cleared by a restart). */
export type PowerSleep = { action: 'suspend' | 'poweroff'; fire_at: number; remaining_s: number };
/** Scheduled RTC wake alarm. */
export type PowerWake = { fire_at: number; remaining_s: number };
/** Sleep timer + wake schedule state (GET /api/power/schedule). */
export type PowerSchedule = {
  sleep: PowerSleep | null;
  wake: PowerWake | null;
  wake_available: boolean;
  limits: { sleep_min_s: number; sleep_max_s: number; wake_min_s: number; wake_max_s: number };
};

export type LaunchResult = {
  ok: boolean;
  /** Present when ok is false. */
  error?: string;
};

/**
 * Which TV-control backend the agent is using (agent >= 2.5). "panel" (RS-232)
 * and "cec" (HDMI-CEC) drive the TV; "soft" (agent >= 2.6) drives the box's own
 * audio sink and does volume/mute only, with no power.
 */
export type TvBackend =
  | 'panel'
  | 'cec'
  | 'soft'
  | 'webos'
  | 'samsung'
  | 'roku'
  | 'androidtv'
  | 'vidaa'
  // LG's signage line over plain TCP 9761 (no pairing, no TLS). Distinct from
  // "webos": these panels do not speak consumer webOS at all.
  | 'lgcom';

/**
 * A TV the box found on the LAN (GET /api/tv/discover, agent >= 2.9.12). `brand`
 * is one of the pairable network backends; `host` feeds the existing pair flow.
 */
export type DiscoveredTv = {
  brand: 'webos' | 'samsung' | 'roku' | 'androidtv';
  name: string;
  host: string;
};

/**
 * What the box found at one address (POST /api/tv/identify, agent >= 2.9.32).
 * `brand` widens past the pairable backends because the point is to name the
 * devices we do NOT support: an LG commercial/signage panel opens the same
 * port 3001 as a consumer webOS TV and then never completes TLS, which is how
 * "pair" on one produced a raw `_ssl.c: handshake operation timed out`.
 * `reason` is already user-facing prose — render it verbatim.
 */
export type TvIdentifyResult = {
  brand: 'webos' | 'samsung' | 'roku' | 'androidtv' | 'vidaa' | 'lg_commercial' | null;
  label: string;
  supported: boolean;
  reason: string;
};

/**
 * One physical controller the box can see. Emulated pads (the box's own virtual
 * gamepad, Steam Input's) are filtered out agent-side and never appear here.
 * `uniq` is the pad's own MAC and is stable across Bluetooth reconnects, so it
 * is the identity used to pin the trigger to one controller; `readable` is false
 * when the agent can see the pad but lacks permission to read its events.
 */
export type GuideController = {
  uniq: string;
  phys: string;
  name: string;
  readable: boolean;
  /** Why the pad is unreadable (agent >= 2.9.41); absent when readable, and
   *  absent on older agents.
   *  - "masked": the node's mode is 000 — Steam / InputPlumber hid it on
   *    purpose and presents its own composite device. Re-running install.sh
   *    CANNOT fix this, so the app must not suggest it.
   *  - "permission": an ordinary mode this user lacks; that one is
   *    install-fixable. */
  reason?: 'masked' | 'permission';
};

/**
 * Guide-hold trigger state (GET /api/guide-hold, agent >= 2.9.14). The route
 * 404s when the box can't do the Couch Mode handoff or can't read evdev.
 */
export type GuideHold = {
  available: boolean;
  enabled: boolean;
  hold_ms: number;
  /** Empty = any real controller; otherwise the pinned pad's MAC. */
  uniq: string;
  /** True when a pinned pad is set AND currently connected. */
  uniq_present: boolean;
  session: 'gamescope' | 'desktop';
  controllers: GuideController[];
};

/** TV-control probe result. The route 404s when no backend is available. */
export type Tv = {
  available: boolean;
  /** The active backend: "panel" (RS-232), "cec" (HDMI-CEC), or "soft" (box audio). */
  backend: TvBackend;
  /** Human description, e.g. "Newline RS-232 (/dev/ttyUSB0 @ 19200)". */
  adapter: string;
  /**
   * The ops this backend supports (agent >= 2.6). The "soft" backend omits the
   * power ops, so the app hides the power button. Absent on older agents, which
   * the app treats as the full op set.
   */
  ops?: TvOp[];
  /** Box's own OS volume (media keys) is available (agent >= 2.6.2). */
  box_volume?: boolean;
  /** An external TV backend (panel/CEC) can drive volume (agent >= 2.6.2). */
  tv_volume?: boolean;
  /** An external TV backend (panel/CEC) can drive power (agent >= 2.6.2). */
  tv_power?: boolean;
  /** Current box mute state at probe time (agent >= 2.6.5), or null if unknown. */
  muted?: boolean | null;
  /**
   * The panel can jump its input to the box's OPS slot (agent >= 2.6.7). Only
   * the RS-232 panel backend reports this, so the "Switch to box" button is
   * hidden on CEC/soft boxes — it is an opt-in RS-232 feature.
   */
  source_box?: boolean;
  /**
   * The panel can blank/unblank the screen without cutting power (agent >=
   * 2.6.8), so the box keeps running when an OPS display would otherwise power
   * it off in standby. RS-232 panel only — CEC/soft boxes never report it.
   */
  screen_toggle?: boolean;
  /**
   * Display inputs the panel can switch to (agent >= 2.6.9): the app renders a
   * source picker and POSTs /api/tv/source/<id>. Panel (RS-232) only — empty or
   * absent on CEC/soft boxes, which can't route a display's input.
   */
  sources?: { id: string; label: string }[];
  /**
   * Factory-remote / nav key emulation via POST /api/tv/key/<k> (agent >=
   * 2.7.0 for the RS-232 panel; agent >= 2.9.7 also for the network smart-TV
   * backends webOS/Samsung/Roku): arrows / ok / menu / home / back.
   */
  keys?: boolean;
  /**
   * A `source` key (POST /api/tv/key/source) opens the TV's input picker (agent
   * >= 2.9.12). Set by Android/Google TV (KEYCODE_TV_INPUT) and Samsung
   * (KEY_SOURCE); the RS-232 panel uses its explicit `sources` list instead.
   */
  source_key?: boolean;
  /**
   * Text entry into a focused on-TV field via POST /api/tv/text (agent >=
   * 2.9.7). Set by the network smart-TV backends (webOS IME, Samsung
   * SendInputString, Roku Lit_ keys); never by panel/CEC.
   */
  text?: boolean;
  /**
   * Backend PUSHES a focus signal (agent >= 2.9.12) when an on-TV text field
   * opens/closes, delivered as a {t:'input_focus'} frame on /ws/gamepad. Only
   * webOS reports it today (registerRemoteKeyboard); when set, the app auto-
   * raises its text sheet on focus and dismisses it on blur. Absent on every
   * other backend, which keep the manual text button unchanged.
   */
  text_focus_push?: boolean;
  /**
   * Every backend this box can actually drive (agent >= 2.9.13), which the app
   * lists as a TV picker. Older agents resolved exactly one backend by a fixed
   * priority chain and sent no roster — that chain is why pairing a second TV
   * reported success and then drove nothing. Kept as plain strings so a backend
   * added agent-side later renders (by id) instead of being mistyped.
   */
  backends?: string[];
  /**
   * The user's stored choice, or null meaning "fall back to the priority
   * chain" (agent >= 2.9.13). NOT the same as `backend`: the agent re-validates
   * the choice against live availability every call, so a chosen TV whose
   * config vanished falls back. `backend` is the one actually driving — show
   * that one as the truth.
   */
  tv_active?: string | null;
  /** Current box OS volume 0-100 (agent >= 2.7.0), or null when unreadable. */
  box_volume_level?: number | null;
  /**
   * Current panel speaker volume 0-100 (agent >= 2.7.0), or null. NOTE: on
   * some panels this register stops tracking after source switches — treat as
   * advisory; the box level is the reliable one.
   */
  tv_volume_level?: number | null;
};

/** Factory-remote keys the agent accepts at POST /api/tv/key/<k>. */
export type TvKey =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'ok'
  | 'menu'
  | 'home'
  | 'back'
  | 'settings'
  | 'source'
  | 'bright_up'
  | 'bright_down';

/** Where volume goes: the box's own OS volume, or the TV/panel over CEC/RS-232. */
export type VolumeTarget = 'box' | 'tv';

/** The unified TV ops the agent accepts at POST /api/tv/<op>. */
export type TvOp = 'power_on' | 'power_off' | 'volume_up' | 'volume_down' | 'mute';

/**
 * Result of a smart-TV pair/add call (webOS/Samsung pair, Roku add). `ok` is
 * false with a human `error` when the TV rejected or was unreachable.
 */
export type TvPairResult = {
  ok: boolean;
  paired?: boolean;
  added?: boolean;
  backend?: TvBackend;
  host?: string;
  name?: string;
  error?: string;
};

// ---------- Errors ----------

export type ApiErrorKind = 'unreachable' | 'unauthorized' | 'http' | 'timeout';

export class ApiError extends Error {
  kind: ApiErrorKind;
  /**
   * HTTP status code, set only when kind === 'http'. Lets probe methods map an
   * exact 404 (route/feature absent on this agent) to "feature not present"
   * without also swallowing transient 5xx. See probeOrNull().
   */
  status?: number;

  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * House pattern for probe-and-appear methods added from v2.8 on (downloads,
 * screenInfo, media, power, powerSchedule): a 404 means the agent is too old
 * or the feature is absent, so resolve `null` and let the UI stay hidden while
 * usePoll keeps its slow cadence. EXACTLY 404 — a transient 500 still throws,
 * so a momentarily unhealthy agent does NOT read as "feature vanished".
 * Deliberately NOT retrofitted onto api.tv() (its throw-on-404 is shipped).
 */
async function probeOrNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e: unknown) {
    if (e instanceof ApiError && e.kind === 'http' && e.status === 404) return null;
    throw e;
  }
}

/**
 * Gate an optional-feature probe on the box's advertised caps (Status.caps).
 * When `cap` is explicitly false the feature is absent, so resolve null WITHOUT
 * a request — the round-trip the caps summary exists to save. When `cap` is
 * undefined (older agent that doesn't report caps) we still run the probe, so
 * behaviour is unchanged against agents < 2.8.2. A 404 from the probe itself is
 * handled by probeOrNull, so this stays correct even if caps disagrees.
 */
function probeGated<T>(
  cap: boolean | undefined,
  probe: () => Promise<T | null>,
): Promise<T | null> {
  if (cap === false) return Promise.resolve(null);
  return probe();
}

// ---------- Client ----------

const TIMEOUT_MS = 4000;

function baseUrl(settings: Pick<Settings, 'host' | 'port'>): string {
  return `http://${settings.host}:${settings.port}`;
}

// §3b resolved-host: the host that last served each box (keyed host:port).
// Binary fetches (album art, later screen frames) must hit the SAME host the
// JSON API proved reachable, not a blind settings.host that mDNS may have
// stopped resolving under SteamOS Game Mode WiFi power-save.
const lastGoodHost = new Map<string, string>();
/** Stable identity of a poll/connection target ("host:port"). Exported as the
 *  canonical `resetKey` for usePoll: every active-box poll passes it so a box
 *  switch clears stale data instead of briefly showing the previous box's. */
export function hostKey(s: Pick<Settings, 'host' | 'port'>): string {
  return `${s.host}:${s.port}`;
}
export function resolveEffectiveHost(settings: ConnSettings): string {
  return lastGoodHost.get(hostKey(settings)) ?? settings.host;
}

// Latest capability summary each box reported on /api/status (keyed host:port),
// so the optional-feature probes can skip a request the box has said it can't
// answer without every caller threading caps down. Populated by api.status();
// empty until the first status poll of a box returns (and always empty for
// agents < 2.8.2 that don't report caps), in which case the probes fall back to
// probing — never a false skip. Mirrors the lastGoodHost cache above.
const lastCaps = new Map<string, BoxCaps>();
function cachedCaps(settings: Pick<Settings, 'host' | 'port'>): BoxCaps | undefined {
  return lastCaps.get(hostKey(settings));
}

/** Value-equality for BoxCaps (either may be undefined). Lets callers persist
 *  caps onto a box only when it actually changed, avoiding write churn. */
export function capsEqual(a?: BoxCaps, b?: BoxCaps): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.gamepad === b.gamepad &&
    a.steam === b.steam &&
    a.media === b.media &&
    a.tv === b.tv &&
    a.screen === b.screen &&
    a.power_schedule === b.power_schedule &&
    a.screensaver === b.screensaver &&
    a.couchmode === b.couchmode &&
    a.bigpicture === b.bigpicture &&
    a.desktop === b.desktop &&
    a.steamlink === b.steamlink &&
    a.gaming === b.gaming &&
    a.streamhost === b.streamhost &&
    a.steammenus === b.steammenus &&
    a.boxbattery === b.boxbattery &&
    a.launchers === b.launchers &&
    a.file_upload === b.file_upload &&
    a.session_default === b.session_default &&
    a.display_info === b.display_info &&
    a.player === b.player &&
    a.steaminstall === b.steaminstall &&
    a.utilities === b.utilities &&
    a.screenstream === b.screenstream &&
    a.screenstream_h264 === b.screenstream_h264 &&
    a.audioswitch === b.audioswitch &&
    a.ledcontrol === b.ledcontrol &&
    a.openrgb === b.openrgb
  );
}

/** Which session the box boots into. "last" is a Couchside mode, not an OS one:
 *  SDDM records the last session but the autologin override defeats it, so the
 *  agent points the override at whatever is running. */
export type SessionDefaultMode = 'game' | 'desktop' | 'last';
export type SessionDefault = {
  available: boolean;
  /** What the agent detected: 'greetd' since 2.9.58 (custom Steam machines),
   *  'plasmalogin' since 2.9.66 (KDE's SDDM successor — CachyOS deckify today,
   *  Bazzite eventually). The card never branches on this, so an unknown
   *  string from a NEWER agent must stay representable — hence the open
   *  fallback arm. */
  backend: 'steamosctl' | 'sddm' | 'plasmalogin' | 'greetd' | (string & {}) | null;
  mode: 'game' | 'desktop' | 'unknown';
};

/** Result of a successful POST /api/upload (agent >= 2.9.54). */
export type UploadResult = { ok: boolean; name: string; bytes: number; path: string };

/** Result of POST /api/upload/reveal (agent >= 2.9.55). `opened` is false with a
 *  human-readable `reason` when the box can't raise a file manager (Game Mode). */
export type RevealResult = { opened: boolean; path?: string; reason?: string };

/**
 * Upload a local file to the box's drop dir (POST /api/upload, agent >= 2.9.54).
 *
 * Streams the file straight from disk via expo-file-system's upload task — the
 * bytes never pass through JS memory, so a multi-GB game is fine — and reports
 * progress as a 0..1 fraction. `name` is sent as a query param; the agent
 * REJECTS anything that isn't a bare, contained filename, so pass a basename.
 *
 * expo-file-system is imported lazily so this native-only module never has to
 * load in the web dev harness that drives the rest of the app.
 */
export async function uploadFile(
  settings: ConnSettings,
  fileUri: string,
  name: string,
  onProgress?: (fraction: number) => void,
): Promise<UploadResult> {
  const { File, UploadType } = await import('expo-file-system');
  const host = resolveEffectiveHost(settings);
  const url = `${baseUrl({ host, port: settings.port })}/api/upload?name=${encodeURIComponent(name)}`;
  const task = new File(fileUri).createUploadTask(url, {
    httpMethod: 'POST',
    uploadType: UploadType.BINARY_CONTENT,
    headers: { Authorization: `Bearer ${settings.token}` },
    onProgress: ({ bytesSent, totalBytes }: { bytesSent: number; totalBytes: number }) => {
      if (onProgress && totalBytes > 0) onProgress(bytesSent / totalBytes);
    },
  });
  const res = await task.uploadAsync();
  if (!res || res.status < 200 || res.status >= 300) {
    throw new ApiError('http', `Upload failed (HTTP ${res?.status ?? '?'})`, res?.status);
  }
  try {
    return JSON.parse(res.body) as UploadResult;
  } catch {
    return { ok: true, name, bytes: 0, path: '' };
  }
}

/** base64-encode raw bytes for the /ws/screen stream client, which turns each
 *  binary WS JPEG frame into a data: URI for <Image>. Uses the `buffer` lib
 *  (base64-js under the hood): chunked typed-array work, no per-char string
 *  concat — meaningfully faster than a hand loop on the per-frame MJPEG path,
 *  which trims app-side video latency. */
export function base64FromArrayBuffer(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString('base64');
}

/**
 * Album art for a player's current track, as a base64 `data:` URI for <Image>.
 * Fetches from the resolved host (§3b) with the bearer token (an <Image> URL
 * can't carry Authorization) and inlines the bytes, so nothing sensitive lands
 * in Fresco's disk cache. Resolves null on any failure / 404 (no art).
 */
export async function mediaArtSource(
  settings: ConnSettings,
  player: string,
  artKey: string,
): Promise<string | null> {
  const host = resolveEffectiveHost(settings);
  const url = `http://${host}:${settings.port}/api/media/art?player=${encodeURIComponent(
    player,
  )}&k=${encodeURIComponent(artKey)}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${settings.token}` } });
    if (!res.ok) return null;
    // Refuse an oversized body BEFORE reading it — the only point where refusing
    // actually avoids buffering the bytes (KI-035).
    if (isDeclaredTooLarge(res.headers.get('Content-Length'))) return null;
    const type = res.headers.get('Content-Type') || 'image/jpeg';
    const buf = await res.arrayBuffer();
    // Backstop for a missing or dishonest Content-Length: stop here rather than
    // base64-amplifying it ~1.33x and handing a giant string to <Image>.
    if (!isUsableBodySize(buf.byteLength)) return null;
    return `data:${type};base64,${base64FromArrayBuffer(buf)}`;
  } catch {
    return null;
  }
}

/**
 * Fetch one live screen-preview frame from the resolved host (§3b) with bearer
 * auth, as a base64 data: URI for <Image>. Inlined (never a raw <Image> URL)
 * because the URL can't carry the token and frames are no-store — a frame may
 * show a password prompt, so nothing is written to Fresco's disk cache. null on
 * failure or 503 (capture failed). `t` cache-busts each frame.
 */
export async function screenFrameSource(
  settings: ConnSettings, signal?: AbortSignal,
): Promise<string | null> {
  const host = resolveEffectiveHost(settings);
  const url = `http://${host}:${settings.port}/api/screen/frame?t=${Date.now()}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${settings.token}` }, signal });
    if (!res.ok) return null;
    // Same cap as album art, and it matters more here: the preview POLLS, so an
    // oversized frame gets a fresh chance at the phone's memory every tick.
    if (isDeclaredTooLarge(res.headers.get('Content-Length'))) return null;
    const type = res.headers.get('Content-Type') || 'image/jpeg';
    const buf = await res.arrayBuffer();
    if (!isUsableBodySize(buf.byteLength)) return null;
    return `data:${type};base64,${base64FromArrayBuffer(buf)}`;
  } catch {
    return null;
  }
}

/** One fetch attempt against a specific host. Throws ApiError on transport failure. */
async function attempt(
  host: string,
  settings: ConnSettings,
  path: string,
  opts: {
    method?: 'GET' | 'POST' | 'DELETE';
    auth?: boolean;
    timeoutMs?: number;
    body?: unknown;
  },
): Promise<Response> {
  const { method = 'GET', auth = true, timeoutMs = TIMEOUT_MS, body } = opts;
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  // Hard deadline INDEPENDENT of fetch + AbortController. On Android, a fetch
  // whose DNS is stuck resolving a `.local` mDNS name can ignore
  // controller.abort() and never settle its promise — which froze callers (the
  // Fleet tab stuck forever at "probing…", and raceGet's Promise.any waiting on
  // a hostname path that never rejects). This timer guarantees the JS promise
  // always settles, so a stuck lookup degrades to a clean timeout + retry.
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const hardDeadline = new Promise<never>((_, reject) => {
    hardTimer = setTimeout(
      () => reject(new ApiError('timeout', `Timed out after ${timeoutMs / 1000}s`)),
      timeoutMs + 1000,
    );
  });
  try {
    const headers: Record<string, string> = {};
    if (auth) headers.Authorization = `Bearer ${settings.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const fetchPromise = fetch(`${baseUrl({ host, port: settings.port })}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    return await Promise.race([fetchPromise, hardDeadline]);
  } catch (e: unknown) {
    if (e instanceof ApiError) throw e; // hard-deadline timeout, already shaped
    if (e instanceof Error && e.name === 'AbortError') {
      throw new ApiError('timeout', `Timed out after ${timeoutMs / 1000}s`);
    }
    throw new ApiError('unreachable', 'Box unreachable: network error');
  } finally {
    clearTimeout(abortTimer);
    if (hardTimer) clearTimeout(hardTimer);
  }
}

const PROBE_TIMEOUT_MS = 2500;

/**
 * Head start given to the cached-IP path before the hostname attempt joins the
 * race (see raceGet). Android mDNS resolution was measured at ~1.6s, the
 * probe + request on a live cached IP at ~40ms — so when the IP is good the
 * hostname fetch never even starts.
 */
const GET_RACE_STAGGER_MS = 250;

/**
 * Happy-Eyeballs for idempotent GETs: race the cached IP (identity-probed
 * first, so the bearer token still never goes to an unproven address) against
 * the configured hostname, staggered so the fast path usually wins alone.
 * Safe only for GETs — a double-send of a POST could run an action twice.
 * Returns the first success; if both fail, throws the hostname path's error
 * (it matches what the single-attempt flow would have reported).
 */
async function raceGet(
  settings: ConnSettings,
  path: string,
  opts: { method?: 'GET' | 'POST' | 'DELETE'; auth?: boolean; timeoutMs?: number; body?: unknown },
  fallbackIp: string,
): Promise<{ res: Response; usedHost: string }> {
  let settled = false;
  const ipPath = (async () => {
    if (!(await probeTarget(fallbackIp, settings))) {
      throw new ApiError('unreachable', 'cached IP did not answer as this box');
    }
    const res = await attempt(fallbackIp, settings, path, opts);
    return { res, usedHost: fallbackIp };
  })();
  const hostPath = (async () => {
    await new Promise((r) => setTimeout(r, GET_RACE_STAGGER_MS));
    if (settled) {
      // The IP already won; don't fire a redundant fetch.
      throw new ApiError('unreachable', 'cached IP path won');
    }
    const res = await attempt(settings.host, settings, path, opts);
    return { res, usedHost: settings.host };
  })();
  // Swallow the loser's eventual rejection so it can't surface as unhandled.
  ipPath.catch(() => {});
  hostPath.catch(() => {});
  try {
    const winner = await Promise.any([ipPath, hostPath]);
    settled = true;
    return winner;
  } catch {
    settled = true;
    // Both paths failed. Re-throw the hostname error for a familiar message.
    return await hostPath;
  }
}

/**
 * Unauthenticated identity probe: does `host` answer /api/ping AS this box
 * (see pingMatchesBox)? Never sends the bearer token. False on any failure.
 */
async function probeTarget(host: string, settings: ConnSettings): Promise<boolean> {
  try {
    const res = await attempt(host, settings, '/api/ping', {
      auth: false,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (!res.ok) return false;
    return pingMatchesBox(await res.json(), settings.host);
  } catch {
    return false;
  }
}

async function request<T>(
  settings: ConnSettings,
  path: string,
  opts: {
    method?: 'GET' | 'POST' | 'DELETE';
    auth?: boolean;
    timeoutMs?: number;
    body?: unknown;
    // Skip the probe-first dance and send ONE attempt straight to the
    // poll-proven host. For rapid, recoverable POSTs (TV nav keys) only —
    // see the branch below.
    fastPath?: boolean;
  } = {},
): Promise<T> {
  // Cached-IP fallback: keeps the app working when mDNS breaks (SteamOS Game
  // Mode) but the box is still up. The fallback target must first prove via
  // an unauthenticated ping that it IS this box (pingMatchesBox). A DHCP
  // lease that wandered to another machine gets neither the bearer token nor
  // a misleading 401.
  const method = opts.method ?? 'GET';
  const fallback =
    settings.lastIp && settings.lastIp !== settings.host ? settings.lastIp : undefined;

  let res: Response;
  let usedHost = settings.host;
  if (opts.fastPath) {
    // TV nav keys: the normal POST path pings the box to pick a target BEFORE
    // sending, because a POST can't be safely retried. That doubles the
    // round-trips on every D-pad press, which is why TV control felt sluggish
    // next to box control (a single WebSocket frame). A nav key is different
    // from a reboot: it is a single send to the host the poll already proved
    // reachable, and if that host went stale in the gap since the last poll the
    // worst case is one dropped press, recovered by the next one. So skip the
    // probe and send straight there.
    usedHost = resolveEffectiveHost(settings);
    res = await attempt(usedHost, settings, path, opts);
  } else if (method === 'GET' && fallback) {
    // Idempotent + a cached IP known: race both addresses (IP-first, see
    // raceGet). Double-delivery is harmless for a GET, and this removes the
    // ~1.6s mDNS resolution from every status poll / list fetch.
    ({ res, usedHost } = await raceGet(settings, path, opts, fallback));
  } else if (method === 'GET' || !fallback) {
    // Single known address (or non-GET without a fallback): one plain attempt.
    // No retry here: React Native's fetch reports "connection lost after the
    // request was delivered" identically to "never connected", so a re-sent
    // POST could run an action (reboot!) twice.
    res = await attempt(settings.host, settings, path, opts);
  } else {
    // Non-idempotent (POST/DELETE): pick the working target FIRST with cheap
    // ping probes, then send the request EXACTLY ONCE, never retried.
    let target = settings.host;
    if (!(await probeTarget(settings.host, settings))) {
      if (await probeTarget(fallback, settings)) target = fallback;
      // else: send to the configured host anyway and surface its real error.
    }
    usedHost = target;
    res = await attempt(target, settings, path, opts);
  }

  // Remember which host actually answered (any HTTP status proves it IS this
  // box and is reachable), so binary fetches — Steam cover art, album art, later
  // screen frames — can target the SAME host instead of a blind settings.host
  // that mDNS may have stopped resolving. (§3b resolved-host.)
  lastGoodHost.set(hostKey(settings), usedHost);

  if (res.status === 401) {
    throw new ApiError('unauthorized', 'Unauthorized: check token');
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body && typeof body.error === 'string') detail = `${detail}: ${body.error}`;
    } catch {
      // non-JSON body; keep the status line
    }
    throw new ApiError('http', detail, res.status);
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError('http', 'Invalid JSON in response');
  }
}

// ---------- PIN pairing (unauthenticated box enrollment) ----------

export type PairStartResult = { ok: boolean; ttl?: number; error?: string };
export type PairFinishResult = { ok: boolean; token?: string; port?: number; error?: string };

/**
 * Hit a box directly by ip:port with NO bearer token — the PIN-pairing routes
 * are the box's only unauthenticated POSTs (the phone has no token yet). Reads
 * the JSON body for both 200 and the 4xx error cases.
 */
async function unauthPost<T>(
  ip: string,
  port: number,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${ip}:${port}${path}`, {
      method: 'POST',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    return (await res.json()) as T;
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new ApiError('timeout', `Timed out after ${timeoutMs / 1000}s`);
    }
    throw new ApiError('unreachable', 'Box unreachable: network error');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start PIN pairing: the box mints a PIN and displays it on ITS OWN screen.
 * Returns the TTL; the PIN is never sent over the network. Agent >= 2.9.12.
 */
export function pairStart(ip: string, port: number): Promise<PairStartResult> {
  return unauthPost<PairStartResult>(ip, port, '/api/pair/start', undefined, 8000);
}

/**
 * Finish PIN pairing: submit the PIN shown on the box. On success returns the
 * box token (to store) and its port; on a wrong/expired/locked PIN, `ok:false`
 * with a reason.
 */
export function pairFinish(ip: string, port: number, pin: string): Promise<PairFinishResult> {
  return unauthPost<PairFinishResult>(ip, port, '/api/pair/finish', { pin }, 8000);
}

export const api = {
  /** Stream a local file to the box's drop dir (POST /api/upload, agent >= 2.9.54). */
  uploadFile,
  /** Unauthenticated reachability probe. */
  ping(settings: ConnSettings): Promise<Ping> {
    return request<Ping>(settings, '/api/ping', { auth: false });
  },

  async status(settings: ConnSettings): Promise<Status> {
    const s = await request<Status>(settings, '/api/status');
    // Cache caps so the optional-feature probes can skip dead requests (see
    // lastCaps). Only overwrite when present, so a momentary old-agent reply
    // never clears a good entry.
    if (s.caps) lastCaps.set(hostKey(settings), s.caps);
    return s;
  },

  units(settings: ConnSettings): Promise<{ units: Unit[] }> {
    return request<{ units: Unit[] }>(settings, '/api/units');
  },

  journal(settings: ConnSettings, unit: string, scope: UnitScope, lines = 100): Promise<Journal> {
    const q = new URLSearchParams({
      unit,
      lines: String(lines),
      scope,
    });
    return request<Journal>(settings, `/api/journal?${q.toString()}`);
  },

  actions(settings: ConnSettings): Promise<{ actions: ActionInfo[] }> {
    return request<{ actions: ActionInfo[] }>(settings, '/api/actions');
  },

  runAction(settings: ConnSettings, id: string): Promise<ActionResult> {
    // Actions block server-side for up to 15s (e.g. `systemctl restart sddm`);
    // outlive that so a slow-but-successful action isn't reported as a timeout.
    return request<ActionResult>(settings, `/api/actions/${encodeURIComponent(id)}`, {
      method: 'POST',
      timeoutMs: 20000,
    });
  },

  // ---------- launchers ----------

  /** List discovered Steam games + user-defined custom launchers. */
  launchers(settings: ConnSettings): Promise<{ launchers: Launcher[] }> {
    return request<{ launchers: Launcher[] }>(settings, '/api/launchers');
  },

  /**
   * Owned-but-uninstalled Steam games (agent >= 2.9.73, gated by caps.steaminstall).
   * Since agent 2.9.76 each entry may carry name + type, parsed OFFLINE from
   * Steam's own appinfo.vdf on the box (measured 100% coverage of a real 1101-app
   * library) — the app seeds its details index from these so the whole library
   * renders instantly instead of trickling through the rate-limited store API
   * (~200/5min; an 1101-app library showed 88 games after days). The store lookup
   * remains as enrichment for what appinfo lacks (genres, release year). Older
   * agents send appids only; the store path still covers those. Art comes from
   * coverArt(appid). Probe-and-appear: null on 404 hides the section. To INSTALL
   * one, call launch(settings, `install:${appid}`) — the agent gates it against
   * this same set and hands steam://install to the client.
   */
  installable(
    settings: ConnSettings,
  ): Promise<{ games: InstallableGame[]; count: number } | null> {
    return probeOrNull(
      request<{ games: InstallableGame[]; count: number }>(
        settings, '/api/steam/installable'));
  },

  /**
   * Setup → Utilities: the box's one-click hardware/setup helpers + their live
   * state (agent >= 2.9.74, cap `utilities`). Read-only probe-and-appear: null on a
   * 404 hides the section. The app ALSO gates the section behind the opt-in
   * `utilitiesEnabled` pref, so a firmware-flashing surface never shows unasked.
   */
  utilities(settings: ConnSettings): Promise<{ utilities: Utility[] } | null> {
    return probeOrNull(request<{ utilities: Utility[] }>(settings, '/api/utilities'));
  },

  /**
   * Run a Utilities tenant's state-changing action (agent >= 2.9.75), e.g.
   * runUtility(settings, 'openpuck') to flash a plugged-in board. The id is
   * looked up in the agent's frozen run-allowlist; a non-runnable id (e.g. 'cec',
   * whose enable is an install-time step) 404s. Returns the standard ActionResult.
   *
   * LONG timeout on purpose: the OpenPuck flash blocks the response for the whole
   * UF2 write (the bootloader burns ~376KB to nRF flash, several seconds). The
   * default 4s timeout aborted the request mid-flash and reported "could not
   * reach the box" for a flash that SUCCEEDED (observed on hardware 2026-08-08)
   * — the worst kind of wrong.
   */
  runUtility(
    settings: ConnSettings,
    id: string,
    variant?: 'pinned' | 'latest',
  ): Promise<ActionResult> {
    // `variant` is an allowlisted enum the agent validates (pinned | latest); it is
    // sent only for openpuck's opt-in "flash newer" and defaults to pinned server-
    // side when omitted, so old agents (which ignore the query) keep working.
    const q = variant ? `?variant=${encodeURIComponent(variant)}` : '';
    return request<ActionResult>(
      settings, `/api/utilities/${encodeURIComponent(id)}/run${q}`,
      { method: 'POST', timeoutMs: 60000 });
  },

  /**
   * OPT-IN "check for newer OpenPuck firmware" (agent >= 2.9.77): the fork's newest
   * release vs the build the box pins. Read-only, cached box-side; resolves null on
   * a 404 so older agents simply don't show the control. Calling this NEVER flashes
   * anything — flashing a newer build is a separate, explicit
   * runUtility(settings, 'openpuck', 'latest').
   */
  openpuckLatest(settings: ConnSettings): Promise<OpenpuckLatest | null> {
    return probeOrNull(
      request<OpenpuckLatest>(settings, '/api/utilities/openpuck/latest'));
  },

  /**
   * In-progress Steam downloads/updates. Probe-and-appear: resolves null on a
   * 404 (agent < 2.8 or no route) so the Launch tab hides the section; a 200
   * with an empty list also means "nothing pending".
   */
  downloads(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<Downloads | null> {
    return probeGated(caps?.steam, () =>
      probeOrNull(request<Downloads>(settings, '/api/downloads')));
  },

  /**
   * Steam Remote Play host + game list (agent >= 2.9.23). Probe-and-appear:
   * null on a 404 (older agent, or the box has never streamed from a host) so
   * the Launch tab hides the "Stream from PC" section. Launch a game with
   * launch(settings, `stream:${appid}`).
   */
  /**
   * Steam's settings panels, as deep links (agent >= 2.9.31). Probe-and-appear:
   * null on a 404 (older agent, or a box with no Steam) so the section hides.
   */
  steamMenus(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<SteamMenus | null> {
    return probeGated(caps?.steammenus, () =>
      probeOrNull(request<SteamMenus>(settings, '/api/steam/menus')));
  },

  /** Open one Steam settings panel on the box's own screen. */
  openSteamMenu(settings: ConnSettings, id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(settings, '/api/steam/menus', {
      method: 'POST',
      // request() stringifies this itself — passing a string here double-
      // encodes it and the agent rejects the body as 'not a JSON object'.
      body: { id },
    });
  },

  /**
   * Navigate the Steam UI to a known destination (agent >= 2.9.42).
   *
   * Exists so the search button has a KNOWN starting screen before it walks a
   * fixed key path. MEASURED on a Legion Go S: the same key path fired from the
   * wrong screen opens Steam's sidebar menu instead of search, so anchoring is
   * not optional polish — it is what makes the feature work twice in a row.
   *
   * Resolves false on an older agent (404) rather than throwing, so the caller
   * can skip the key walk instead of blindly sending arrows.
   */
  /**
   * Tail of the box-side installer transcript (agent >= 2.9.43).
   *
   * The installer has always written this file; nothing read it, so the app sat
   * on a canned "this can take a minute" while the box knew exactly which step
   * it was on. Resolves [] on an older agent (404) or while the box is
   * restarting mid-update — both are expected, not errors.
   */
  updateLog(settings: ConnSettings): Promise<string[]> {
    return request<{ lines: string[] }>(settings, '/api/update/log')
      .then((r) => (Array.isArray(r?.lines) ? r.lines : []))
      .catch(() => []);
  },

  /**
   * Ask the running game to close (agent >= 2.9.43).
   *
   * Sends NO body on purpose: the agent resolves what is running itself. The
   * app cannot name a process, which is what stops this from being a remote
   * kill-anything primitive. Do not "helpfully" start passing the appid.
   *
   * Resolves false on 409 (nothing running) or on an older agent, so the caller
   * can just refresh rather than treat it as an error.
   */
  stopGame(settings: ConnSettings): Promise<boolean> {
    return request<{ stopped: boolean }>(settings, '/api/game/stop', { method: 'POST' })
      .then((r) => !!r?.stopped)
      .catch(() => false);
  },

  steamGoto(settings: ConnSettings, id: 'home'): Promise<boolean> {
    return request<{ ok: boolean }>(settings, '/api/steam/goto', {
      method: 'POST',
      body: { id },
    })
      .then((r) => !!r?.ok)
      .catch(() => false);
  },

  steamlink(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<SteamLink | null> {
    return probeGated(caps?.steamlink, () =>
      probeOrNull(request<SteamLink>(settings, '/api/steamlink')));
  },

  /**
   * Live "what's running now" gaming card (agent >= 2.9.25). Probe-and-appear:
   * null on a 404 (older agent, or a box with no Steam) so the card hides. Every
   * payload field is independently optional — a box with no discrete GPU (Intel)
   * omits `gpu` entirely; render only what resolved. Cover art for `game.appid`
   * comes from the box's own cache via steamCoverSource (LAN-only).
   */
  gaming(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<Gaming | null> {
    return probeGated(caps?.gaming, () =>
      probeOrNull(request<Gaming>(settings, '/api/gaming')));
  },

  /**
   * Is a Steam Remote Play session being served BY this box (agent >= 2.9.26)?
   * Detect-only — nothing here changes the box's session or display.
   * Probe-and-appear: null on a 404 (older agent / no Steam) so the card hides.
   */
  streamHost(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<HostSession | null> {
    return probeGated(caps?.streamhost, () =>
      probeOrNull(request<HostSession>(settings, '/api/stream-host')));
  },

  /**
   * Box-side agent update check (agent >= 2.9.5). The box does the GitHub read
   * (cached); the app just reads the result over the LAN, so the app never
   * touches the internet. 404 -> null on older agents (no banner shown).
   */
  updateCheck(
    settings: ConnSettings,
    opts: { force?: boolean } = {},
  ): Promise<UpdateCheck | null> {
    // force=1 bypasses the box's ~6h cache for a manual "Check for updates" tap.
    const q = opts.force ? '?force=1' : '';
    return probeOrNull(request<UpdateCheck>(settings, `/api/update/check${q}`));
  },

  /**
   * Trigger a box-side agent update (agent >= 2.9.5, only when the box opted in
   * — 403 otherwise). The box runs the SIGNATURE-VERIFIED installer detached and
   * restarts, so the connection drops; poll ping/status for the new version.
   */
  applyUpdate(settings: ConnSettings): Promise<{ started: boolean; log?: string }> {
    return request<{ started: boolean; log?: string }>(settings, '/api/update/apply', {
      method: 'POST',
    });
  },

  /**
   * Pending flatpak updates on the box (agent >= 2.9.46). Null on older agents
   * or boxes without flatpak (404) — probe-and-appear, the card just hides.
   */
  flatpakStatus(settings: ConnSettings): Promise<FlatpakStatus | null> {
    return probeOrNull(request<FlatpakStatus>(settings, '/api/update/flatpak'));
  },

  /**
   * Fire the box-side flatpak update (agent >= 2.9.46). Detached on the box; the
   * response says only that it STARTED (plus whether it ran elevated). Progress
   * comes from flatpakLog(); completion from flatpakStatus() count going to 0.
   * Sends NO body: the agent runs one frozen command — the app cannot name a
   * package or a scope, which is what keeps the token from being a root shell.
   */
  flatpakUpdate(
    settings: ConnSettings,
  ): Promise<{ started: boolean; elevated?: boolean; error?: string }> {
    return request<{ started: boolean; elevated?: boolean; error?: string }>(
      settings, '/api/update/flatpak', { method: 'POST' });
  },

  /** Tail of the flatpak update transcript. [] on older agents / no run yet. */
  flatpakLog(settings: ConnSettings): Promise<string[]> {
    return request<{ lines: string[] }>(settings, '/api/update/flatpak/log')
      .then((r) => (Array.isArray(r?.lines) ? r.lines : []))
      .catch(() => []);
  },

  /**
   * Atomic OS state (agent >= 2.9.47). Null on a non-atomic box or older agent
   * (404). An atomic update STAGES for the next boot; `staged` tells the app to
   * prompt a reboot rather than offer another update.
   */
  osStatus(settings: ConnSettings): Promise<OsStatus | null> {
    return probeOrNull(request<OsStatus>(settings, '/api/update/os'));
  },

  /**
   * Stage an OS update (agent >= 2.9.47). Requires the opt-in — there is no
   * unprivileged fallback for an OS image, so the box returns needs_optin when
   * ungranted. Detached on the box; poll osStatus() for staged:true. No body.
   */
  osUpdate(
    settings: ConnSettings,
  ): Promise<{ started: boolean; needs_optin?: boolean; error?: string }> {
    return request<{ started: boolean; needs_optin?: boolean; error?: string }>(
      settings, '/api/update/os', { method: 'POST' });
  },

  /** Tail of the OS update transcript. [] on older agents / no run yet. */
  osLog(settings: ConnSettings): Promise<string[]> {
    return request<{ lines: string[] }>(settings, '/api/update/os/log')
      .then((r) => (Array.isArray(r?.lines) ? r.lines : []))
      .catch(() => []);
  },

  /**
   * Ask THIS (awake) box to broadcast a Wake-on-LAN magic packet for `mac`,
   * waking a different, sleeping box on the same LAN (agent >= 2.9.13).
   *
   * Needed because iOS blocks UDP for apps outright — broadcast AND unicast —
   * so the phone's own magic packet never leaves the device. An awake box does
   * it instead. 404s on older agents; callers fall back to the phone's own
   * broadcast (which does work on Android).
   */
  wolRelay(settings: ConnSettings, mac: string): Promise<ActionResult> {
    return request<ActionResult>(settings, '/api/wol', {
      method: 'POST',
      body: { mac },
    });
  },

  /**
   * Image source for a Steam game's library cover art (agent >= 2.7.1). The
   * agent serves the art from the box's OWN local Steam cache, so the phone
   * never contacts Steam or any CDN — the app stays LAN-only (see PRIVACY.md).
   *
   * Auth rides as a Bearer header, which React Native's Image sends on native;
   * web <img> can't carry it, so covers fall back to the text card there. Reuses
   * the address request() last reached this box on (§3b resolved-host) so covers
   * follow the cached-IP fallback in SteamOS Game Mode instead of a dead .local
   * name; if that target is unreachable, the agent is older, or the art isn't
   * cached yet, the request fails and the tile's onError shows the text card.
   */
  steamCoverSource(settings: ConnSettings, appid: number): ImageSource {
    const host = resolveEffectiveHost(settings);
    // The token goes in BOTH the header and the query, on purpose.
    //
    // MEASURED, not assumed: React Native's <Image> accepts source.headers, and
    // on Android they are DROPPED before the request leaves the phone.
    // Instrumenting the agent showed every cover request arriving as
    // `auth_header='' len=0  ua='okhttp/4.9.2'`, so cover art was blank on every
    // Android device while iOS was fine.
    //
    // The header stays because it is the better mechanism where it works. The
    // query is the fallback the image loader cannot strip. The agent's access
    // log already replaces any query string with "?<redacted>", so the token
    // does not reach the journal. Needs agent >= 2.9.43 for the query form;
    // older agents still honour the header, so iOS is unaffected either way.
    const qs = `?token=${encodeURIComponent(settings.token)}`;
    return {
      uri: `${baseUrl({ host, port: settings.port })}/api/steam/${appid}/cover${qs}`,
      headers: { Authorization: `Bearer ${settings.token}` },
    };
  },

  /** Launch a game/app by launcher id. */
  launch(settings: ConnSettings, id: string): Promise<LaunchResult> {
    return request<LaunchResult>(settings, `/api/launchers/${encodeURIComponent(id)}`, {
      method: 'POST',
      timeoutMs: 15000,
    });
  },

  /** Add a custom launcher (a label + argv command). Returns the created row. */
  addLauncher(
    settings: ConnSettings,
    input: { label: string; cmd: string[] },
  ): Promise<Launcher> {
    return request<Launcher>(settings, '/api/launchers', {
      method: 'POST',
      body: input,
    });
  },

  /** Delete a custom launcher by id. */
  deleteLauncher(settings: ConnSettings, id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(settings, `/api/launchers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  // ---------- TV control (probe-and-appear) ----------

  /**
   * Probe for TV control. Resolves to the active backend + adapter when the
   * agent has one (RS-232 panel or HDMI-CEC); the route 404s (ApiError kind
   * "http") on boxes without any, which the caller treats as "no TV strip".
   */
  tv(settings: ConnSettings): Promise<Tv> {
    return request<Tv>(settings, '/api/tv');
  },

  /**
   * Choose WHICH paired TV drives the remote (agent >= 2.9.13); `null` clears
   * the choice and restores the priority chain. The agent rejects a backend the
   * box cannot drive with a 400 ("backend not available on this box") rather
   * than storing an unusable choice, so the ApiError message is worth showing.
   * The reply's `backend` is the RESOLVED one and can differ from the requested
   * `tv_active` — a chosen TV whose config vanished falls back.
   */
  tvSetActive(
    settings: ConnSettings,
    backend: string | null,
  ): Promise<{ ok: boolean; tv_active?: string | null; backend?: TvBackend; backends?: string[] }> {
    return request<{ ok: boolean; tv_active?: string | null; backend?: TvBackend; backends?: string[] }>(
      settings, '/api/tv/active', {
        method: 'POST',
        timeoutMs: 12000,
        body: { backend },
      });
  },

  /**
   * Send a one-shot TV command. Volume ops take an optional target: "box" (the
   * box's own OS volume, the default) or "tv" (the panel/CEC backend). Power
   * ops ignore it.
   */
  tvSend(settings: ConnSettings, op: TvOp, target?: VolumeTarget): Promise<ActionResult> {
    const q = target ? `?target=${target}` : '';
    return request<ActionResult>(settings, `/api/tv/${op}${q}`, {
      method: 'POST',
      timeoutMs: 12000,
    });
  },

  /**
   * Switch the panel's input to the box's OPS slot (RS-232 panel backend only;
   * gated behind Tv.source_box). Pulls the display back to the box from any
   * other source in one tap.
   */
  tvSource(settings: ConnSettings): Promise<ActionResult> {
    return request<ActionResult>(settings, '/api/tv/source_box', {
      method: 'POST',
      timeoutMs: 12000,
    });
  },

  /**
   * Toggle the panel backlight (screen dark / lit) without touching power, so
   * the box stays running (RS-232 panel backend only; gated behind
   * Tv.screen_toggle). Toggle-only — the panel reports no readable state.
   */
  tvScreenToggle(settings: ConnSettings): Promise<ActionResult> {
    return request<ActionResult>(settings, '/api/tv/screen_toggle', {
      method: 'POST',
      timeoutMs: 12000,
    });
  },

  /**
   * Switch the display to input `id` (one of Tv.sources; RS-232 panel only).
   */
  tvSelectSource(settings: ConnSettings, id: string): Promise<ActionResult> {
    return request<ActionResult>(settings, `/api/tv/source/${encodeURIComponent(id)}`, {
      method: 'POST',
      timeoutMs: 12000,
    });
  },

  /**
   * Set the absolute volume level (0-100). Box target converges via media-key
   * steps (Game Mode OSD shows); TV target uses the RS-232 closed loop. The
   * result carries the final `level` the agent landed on.
   */
  tvSetVolume(
    settings: ConnSettings,
    level: number,
    target: VolumeTarget,
  ): Promise<ActionResult & { level?: number | null }> {
    return request<ActionResult & { level?: number | null }>(settings, '/api/tv/volume', {
      method: 'POST',
      timeoutMs: 20000,
      body: { level, target },
    });
  },

  /** Send one factory-remote / nav key to the active backend (see Tv.keys). */
  tvKey(settings: ConnSettings, key: TvKey): Promise<ActionResult> {
    return request<ActionResult>(settings, `/api/tv/key/${key}`, {
      method: 'POST',
      timeoutMs: 12000,
      // Nav keys are rapid and recoverable, so skip the probe round-trip that
      // the normal POST path does before every send (that overhead is what made
      // TV control feel sluggish next to box control). See request().
      fastPath: true,
    });
  },

  /**
   * Type text into a focused on-TV field (network smart-TV backends only; gated
   * behind Tv.text). Routed to the active backend's text channel (webOS IME /
   * Samsung SendInputString / Roku Lit_ keys).
   */
  tvText(settings: ConnSettings, text: string): Promise<ActionResult> {
    return request<ActionResult>(settings, '/api/tv/text', {
      method: 'POST',
      timeoutMs: 12000,
      body: { text },
    });
  },

  /**
   * Pair with an LG webOS TV. The TV shows an Accept prompt; the agent blocks
   * until the user accepts (or ~60 s), then persists the granted key so later
   * connects are silent. `mac` (optional) enables Wake-on-LAN power-on. The
   * long timeout matches the on-TV accept wait.
   */
  tvPairWebos(
    settings: ConnSettings,
    host: string,
    mac?: string,
  ): Promise<TvPairResult> {
    return request<TvPairResult>(settings, '/api/tv/webos/pair', {
      method: 'POST',
      timeoutMs: 70000,
      body: mac ? { host, mac } : { host },
    });
  },

  /**
   * Pair with a Samsung Tizen TV. The TV shows an Allow prompt; on accept the
   * agent persists the granted token. `mac` (optional) enables Wake-on-LAN.
   */
  tvPairSamsung(
    settings: ConnSettings,
    host: string,
    mac?: string,
  ): Promise<TvPairResult> {
    return request<TvPairResult>(settings, '/api/tv/samsung/pair', {
      method: 'POST',
      timeoutMs: 70000,
      body: mac ? { host, mac } : { host },
    });
  },

  /**
   * Register a Roku by host. Roku needs no pairing — the agent just verifies it
   * answers ECP, captures its friendly name, and persists it.
   */
  tvAddRoku(settings: ConnSettings, host: string): Promise<TvPairResult> {
    return request<TvPairResult>(settings, '/api/tv/roku/add', {
      method: 'POST',
      timeoutMs: 12000,
      body: { host },
    });
  },

  /**
   * Register a Hisense VIDAA TV by host. No pairing — the agent verifies its
   * MQTT broker answers, then persists. `mac` (optional) enables Wake-on-LAN.
   */
  tvAddVidaa(settings: ConnSettings, host: string, mac?: string): Promise<TvPairResult> {
    return request<TvPairResult>(settings, '/api/tv/vidaa/add', {
      method: 'POST',
      timeoutMs: 12000,
      body: mac ? { host, mac } : { host },
    });
  },

  /**
   * Android TV / Google TV pairing, step 1: ask the agent to open the pairing
   * socket. On success a 6-digit code appears on the TV, and the agent holds
   * the socket open for the finish call. `code_shown: true` on success.
   */
  tvAndroidtvPairStart(
    settings: ConnSettings,
    host: string,
  ): Promise<TvPairResult & { code_shown?: boolean }> {
    return request<TvPairResult & { code_shown?: boolean }>(
      settings, '/api/tv/androidtv/pair/start', {
        method: 'POST',
        timeoutMs: 20000,
        body: { host },
      });
  },

  /**
   * Scan the LAN (from the box) for pairable TVs (agent >= 2.9.12). The box runs
   * a ~3s mDNS + SSDP sweep, so give it a generous budget. Always resolves (an
   * empty list means none found); a 404 means the agent predates discovery.
   */
  tvDiscover(settings: ConnSettings): Promise<{ tvs: DiscoveredTv[] }> {
    return request<{ tvs: DiscoveredTv[] }>(settings, '/api/tv/discover', {
      timeoutMs: 8000,
    });
  },

  /**
   * Ask the box what kind of device is at `host` (agent >= 2.9.32), so the app
   * can pick the pairing flow instead of making the user guess — and so a wrong
   * target lands as a sentence rather than a raw socket error. The box makes
   * several sequential TCP connects to that one address, each with its own
   * timeout, so this needs far more than the 4 s default. A 404 means the agent
   * predates identify: callers MUST fall back to pairing with the selected
   * brand, since most boxes in the field are older.
   */
  tvIdentify(settings: ConnSettings, host: string): Promise<TvIdentifyResult> {
    return request<TvIdentifyResult>(settings, '/api/tv/identify', {
      method: 'POST',
      timeoutMs: 15000,
      body: { host },
    });
  },

  /**
   * Register an LG commercial/signage panel by host (agent >= 2.9.32). Its 9761
   * control port is unauthenticated, so there is no pairing and no on-TV accept
   * prompt — the agent just confirms something answers there before persisting.
   */
  tvAddLgCommercial(
    settings: ConnSettings,
    host: string,
    name?: string,
  ): Promise<TvPairResult> {
    return request<TvPairResult>(settings, '/api/tv/lgcommercial/add', {
      method: 'POST',
      timeoutMs: 12000,
      body: name ? { host, name } : { host },
    });
  },

  /**
   * Android TV / Google TV pairing, step 2: send the 6-digit code from the TV.
   * The agent computes the secret on the held socket and persists the cert.
   * `mac` (optional) enables Wake-on-LAN power-on.
   */
  tvAndroidtvPairFinish(
    settings: ConnSettings,
    code: string,
    mac?: string,
  ): Promise<TvPairResult> {
    return request<TvPairResult>(settings, '/api/tv/androidtv/pair/finish', {
      method: 'POST',
      timeoutMs: 20000,
      body: mac ? { code, mac } : { code },
    });
  },

  /**
   * Now-playing / transport across MPRIS players. Probe-and-appear: resolves
   * null on 404 (agent < 2.8 or no session bus) so the card hides; 200 with an
   * empty list means "nothing playing". 8 s budget matches the agent's ceiling.
   */
  media(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<Media | null> {
    return probeGated(caps?.media, () =>
      probeOrNull(request<Media>(settings, '/api/media', { timeoutMs: 8000 })));
  },

  /**
   * Which session the box boots into (agent >= 2.9.58).
   *
   * null on 404 (older agent) so the card hides; a 200 can still carry
   * available:false when the box has no usable backend — no SteamOS D-Bus
   * interface AND no sudoers grant — which the card also treats as "hide".
   */
  sessionDefault(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<SessionDefault | null> {
    return probeGated(caps?.session_default, () =>
      probeOrNull(request<SessionDefault>(settings, '/api/session/default')));
  },

  /** Set the boot session. The mode is one of a closed set the agent re-checks. */
  setSessionDefault(
    settings: ConnSettings,
    mode: SessionDefaultMode,
  ): Promise<ActionResult> {
    return request<ActionResult>(settings, '/api/session/default', {
      method: 'POST',
      body: { mode },
    });
  },

  /** One transport op on a player; `seek` carries { position_ms }. */
  mediaOp(
    settings: ConnSettings,
    player: string,
    op: MediaOp,
    body?: { position_ms: number },
  ): Promise<ActionResult> {
    return request<ActionResult>(settings, `/api/media/${encodeURIComponent(player)}/${op}`, {
      method: 'POST',
      timeoutMs: 8000,
      body,
    });
  },

  /**
   * Screen-capture capability. Probe-and-appear: resolves null on 404 (agent
   * < 2.8 or no capture path) so the preview card hides. Frames come from
   * screenFrameSource(), not this method.
   */
  screenInfo(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<ScreenInfo | null> {
    return probeGated(caps?.screen, () =>
      probeOrNull(request<ScreenInfo>(settings, '/api/screen', { timeoutMs: 8000 })));
  },

  /**
   * Sleep timer + wake schedule. Probe-and-appear: resolves null ONLY on 404
   * (agent < 2.8.1) so the rows hide; a transient 500 still throws, never
   * reading as "timer vanished".
   */
  powerSchedule(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<PowerSchedule | null> {
    return probeGated(caps?.power_schedule, () =>
      probeOrNull(request<PowerSchedule>(settings, '/api/power/schedule')));
  },

  /**
   * Aerial screensaver state. Probe-and-appear: null on 404 (agent < 2.8.4 or
   * script not installed) so the row hides. caps.screensaver === false skips
   * the request outright; undefined (older agent) still probes.
   */
  screensaver(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<Screensaver | null> {
    return probeGated(caps?.screensaver, () =>
      probeOrNull(request<Screensaver>(settings, '/api/screensaver')));
  },

  /**
   * Couchside Player state (agent >= 2.9.61). Probe-and-appear: null on 404
   * (older agent, tile not installed, or no Widevine-capable browser) so the
   * Watch tab hides rather than offering a control that opens a black window.
   * caps.player === false skips the request; undefined still probes.
   *
   * `running` is OBSERVED state, not "what we last asked for": Steam relaunches
   * the registered tile by itself after a return to Game Mode (measured
   * 2026-07-27), so it can be true with no request behind it. Always re-read;
   * never assume the last op is still the truth.
   */
  player(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<PlayerState | null> {
    return probeGated(caps?.player, () =>
      probeOrNull(request<PlayerState>(settings, '/api/player')));
  },

  /**
   * Open an allowlisted service (optionally at a deep-link path) or stop the
   * tile. The box is the authority on what is allowed: an unknown service or a
   * path that fails that service's pattern comes back 404 having written
   * nothing and launched nothing. The app does not pre-judge — it surfaces the
   * refusal.
   */
  playerOp(
    settings: ConnSettings,
    op: PlayerOp,
    opts: {
      service?: string;
      path?: string;
      /** Must be one of PlayerState.seek_secs — the box refuses anything else. */
      secs?: number;
      /** Free text. The box rejects it on structure and percent-encodes the
       *  rest; only services in PlayerState.searchable accept it. */
      query?: string;
    } = {},
  ): Promise<{ ok: boolean; running?: boolean; starting?: boolean; service?: string }> {
    return request(settings, '/api/player', {
      method: 'POST',
      body: { op, ...opts },
    });
  },

  /** Start the screensaver (optionally switching theme/tier) or stop it. */
  screensaverOp(
    settings: ConnSettings,
    op: 'start' | 'stop',
    opts: { theme?: string; tier?: string } = {},
  ): Promise<{ ok: boolean; running?: boolean; starting?: boolean }> {
    return request(settings, '/api/screensaver', {
      method: 'POST',
      body: { op, ...opts },
    });
  },

  /**
   * Couch Mode displays. Probe-and-appear: null on 404 (agent < 2.9 or box
   * can't do the handoff) so the control hides. caps.couchmode === false skips
   * the request outright; undefined (older agent) still probes.
   */
  displays(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<Displays | null> {
    return probeGated(caps?.couchmode, () =>
      probeOrNull(request<Displays>(settings, '/api/displays')));
  },

  /**
   * Display + audio readout for the Console card (agent >= 2.9.59). Distinct
   * from `displays()` above, which is the Couch Mode output PICKER: this one is
   * a read-only description of the panel currently attached, and it answers on
   * boxes that can't do the handoff at all.
   *
   * Probe-and-appear: null on a 404 (older agent) so the card hides, and every
   * field inside the payload is independently optional — see DisplayInfo.
   */
  displayInfo(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<DisplayInfo | null> {
    return probeGated(caps?.display_info, () =>
      probeOrNull(request<DisplayInfo>(settings, '/api/display-info')));
  },

  /**
   * The box's audio outputs + the current default (agent >= 2.9.80, cap
   * `audioswitch`). Probe-and-appear: null on a 404 (older agent) so the AUDIO
   * OUTPUT card hides; an `available: false` payload (no pactl) hides it too.
   */
  audio(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<AudioState | null> {
    return probeGated(caps?.audioswitch, () =>
      probeOrNull(request<AudioState>(settings, '/api/audio')));
  },

  /**
   * Make `sink` the box's default output. `sink` is a `name` the box itself sent
   * in audio()'s sink list — the agent looks it up in its live set and 404s an
   * unknown one, so this can never point audio at something the box didn't offer.
   * Resolves false on any failure; the caller re-reads /api/audio to show the REAL
   * default rather than trusting this return (CLAUDE.md §11: observe the state).
   */
  setAudioDefault(settings: ConnSettings, sink: string): Promise<boolean> {
    return request<{ ok: boolean }>(settings, '/api/audio/default', {
      method: 'POST',
      body: { sink },
    })
      .then((r) => !!r?.ok)
      .catch(() => false);
  },

  /**
   * The box's controllable LEDs + their state (agent >= 2.9.81, cap
   * `ledcontrol`). Probe-and-appear: null on a 404 (older agent) so the LIGHT
   * card hides; an `available: false` payload (no writable LED) hides it too.
   */
  leds(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<LedsState | null> {
    return probeGated(caps?.ledcontrol, () =>
      probeOrNull(request<LedsState>(settings, '/api/leds')));
  },

  /**
   * Set an LED's colour and/or brightness. `led` is a `name` the box itself sent
   * in leds()'s list — the agent looks it up in its live /sys/class/leds set and
   * 404s an unknown one, so this can never aim a write anywhere the box didn't
   * offer. `brightness` is 0–100; `color` is 0–255 per channel. Resolves false on
   * any failure; the caller re-reads /api/leds to show the REAL state rather than
   * trusting this return (CLAUDE.md §11: observe the state).
   */
  setLed(
    settings: ConnSettings,
    led: string,
    patch: { brightness?: number; color?: Rgb },
  ): Promise<boolean> {
    return request<{ ok: boolean }>(settings, '/api/leds/set', {
      method: 'POST',
      body: { led, ...patch },
    })
      .then((r) => !!r?.ok)
      .catch(() => false);
  },

  /**
   * Start (or replace) an animated effect on an LED — or a `solid`/`off`
   * (agent >= 2.9.84). Same allowlist as setLed: `led` is a name the box sent,
   * looked up in its live /sys/class/leds set (404 otherwise). `effect` must be
   * one of the ids the box advertised in leds()'s `effects`; the agent
   * range-checks `speed` (1–100) and `brightness` (0–100) and rejects anything
   * else. The agent persists the choice so a reboot restores it. Resolves false
   * on any failure; the caller re-reads /api/leds for the real state (§11).
   */
  setLedEffect(
    settings: ConnSettings,
    led: string,
    patch: { effect: LedEffect; color?: Rgb; speed?: number; brightness?: number },
  ): Promise<boolean> {
    return request<{ ok: boolean }>(settings, '/api/leds/effect', {
      method: 'POST',
      body: { led, ...patch },
    })
      .then((r) => !!r?.ok)
      .catch(() => false);
  },

  /**
   * Drive a whole addressable STRIP (agent >= 2.9.85) — the box runs the effect
   * in firmware (a real night-rider `scanner`, `rainbow`, `breathe`) so it keeps
   * going with the app closed. `strip` is a prefix the box sent in leds()'s
   * `strips`; the agent looks it up and 404s otherwise. Resolves false on failure.
   */
  setStripEffect(
    settings: ConnSettings,
    strip: string,
    patch: { effect: LedEffect; color?: Rgb; speed?: number; brightness?: number },
  ): Promise<boolean> {
    return request<{ ok: boolean }>(settings, '/api/leds/effect', {
      method: 'POST',
      body: { strip, ...patch },
    })
      .then((r) => !!r?.ok)
      .catch(() => false);
  },

  /**
   * OpenRGB controllers (whole-system / addressable RGB) + their state (agent >=
   * 2.9.84, cap `openrgb`). Probe-and-appear: null on a 404 (older agent) so the
   * OpenRGB card hides; an `available: false` payload (no OpenRGB server on the
   * box) hides it too.
   */
  openrgb(
    settings: ConnSettings,
    caps: BoxCaps | undefined = cachedCaps(settings),
  ): Promise<OpenRgbState | null> {
    return probeGated(caps?.openrgb, () =>
      probeOrNull(request<OpenRgbState>(settings, '/api/openrgb')));
  },

  /**
   * Set an OpenRGB device to a solid colour or an animated effect (the real
   * multi-zone scanner). `device` is an int index the box itself sent in
   * openrgb()'s list — the agent looks it up in its live controller list and
   * 404s an unknown one, so this can never aim at a device the box didn't offer.
   * Resolves false on any failure; the caller re-reads /api/openrgb (§11).
   */
  openrgbSet(
    settings: ConnSettings,
    device: number,
    patch: { effect: LedEffect; color?: Rgb; speed?: number; brightness?: number },
  ): Promise<boolean> {
    return request<{ ok: boolean }>(settings, '/api/openrgb/set', {
      method: 'POST',
      body: { device, ...patch },
    })
      .then((r) => !!r?.ok)
      .catch(() => false);
  },

  /** Enter Couch Mode: fling Game Mode onto `output` (HDR optional). */
  couchModeStart(
    settings: ConnSettings,
    output: string,
    hdr = false,
  ): Promise<CouchModeStartResult> {
    return request(settings, '/api/couch-mode', {
      method: 'POST',
      body: { output, hdr },
    });
  },

  /** Couch Mode ceremony status. Probe-and-appear: null on 404 (older agent, or
      the box can't do the handoff) so the sheet degrades to the synchronous
      path and never polls a route that isn't there. */
  /**
   * Big Picture — Couch Mode's degraded tier (agent >= 2.9.70), for a box with
   * Steam but no gamescope session. Its own endpoint rather than a couch-mode
   * option because that one returns a staged JOB and this is one synchronous
   * action; folding them would make one shape mean two things.
   *
   * NOTE there is deliberately no "is Big Picture showing" read: the agent
   * measured that unprobeable (steamwebhelper carries the -gamepadui flag
   * whether BPM is up or closed), so the UI offers both actions rather than
   * rendering a toggle that would lie about the box's state.
   */
  bigPicture(settings: ConnSettings, op: 'open' | 'close'): Promise<ActionResult> {
    // `body` is the RAW object: request() stringifies it. Passing a string
    // here double-encodes it ("{\"op\":\"open\"}") and the agent correctly
    // answers 400 — which is exactly what the box logged the first time this
    // button was pressed in the harness.
    return request(settings, '/api/big-picture', {
      method: 'POST',
      body: { op },
    });
  },

  couchModeStatus(settings: ConnSettings): Promise<CeremonyStatus | null> {
    return probeOrNull(
      request<CeremonyStatus>(settings, '/api/couch-mode/status'));
  },

  /** Exit Couch Mode: return the box to its desktop session. */
  desktopMode(settings: ConnSettings): Promise<{ ok: boolean }> {
    return request(settings, '/api/desktop-mode', { method: 'POST' });
  },

  /**
   * Open the box's drop dir in its file manager after a file drop
   * (agent >= 2.9.55). Desktop-only on the box side: in Game Mode it answers
   * 200 with {opened:false, reason} rather than pretending, so the caller can
   * show the reason instead of a lie. Takes no arguments — the agent opens its
   * OWN drop dir, nothing client-supplied.
   */
  revealDrop(settings: ConnSettings): Promise<RevealResult> {
    return request(settings, '/api/upload/reveal', { method: 'POST' });
  },

  /**
   * Guide-hold trigger settings, or null when the box can't do it (older agent,
   * no Couch Mode handoff, or an agent that can't read /dev/input). null means
   * "hide the row" — the same probe-and-appear shape as the screensaver.
   */
  guideHold(settings: ConnSettings): Promise<GuideHold | null> {
    return probeOrNull(request<GuideHold>(settings, '/api/guide-hold'));
  },

  /** Patch the guide-hold settings. Omitted fields keep their current value. */
  guideHoldSet(
    settings: ConnSettings,
    patch: { enabled?: boolean; hold_ms?: number; uniq?: string },
  ): Promise<GuideHold & { ok: boolean }> {
    return request(settings, '/api/guide-hold', { method: 'POST', body: patch });
  },

  /** Arm a delayed suspend/poweroff. */
  powerSleep(
    settings: ConnSettings,
    delay_s: number,
    action: 'suspend' | 'poweroff',
  ): Promise<{ sleep: PowerSleep | null }> {
    return request(settings, '/api/power/sleep', { method: 'POST', body: { delay_s, action } });
  },
  /** Cancel the armed sleep timer (idempotent). */
  powerSleepCancel(settings: ConnSettings): Promise<{ sleep: null }> {
    return request(settings, '/api/power/sleep', { method: 'DELETE' });
  },

  /** Set the RTC wake alarm to an absolute epoch. */
  powerWake(settings: ConnSettings, at: number): Promise<{ wake: PowerWake | null }> {
    return request(settings, '/api/power/wake', { method: 'POST', body: { at } });
  },
  /** Clear the RTC wake alarm (idempotent). */
  powerWakeCancel(settings: ConnSettings): Promise<{ wake: null }> {
    return request(settings, '/api/power/wake', { method: 'DELETE' });
  },
};

// ---------- Formatting helpers ----------

export function humanizeUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
