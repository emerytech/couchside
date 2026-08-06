/**
 * LG webOS SSAP protocol, app-direct. ZERO runtime imports.
 *
 * PORTED from the agent's webOS backend (agent/couchsided.py _WEBOS_* / _WebOSSession).
 * The box already pairs and controls the real LG this way; this is the box-less
 * JS port. lib/tvdirect/__tests__ pins the register manifest against the agent so a
 * byte-drift (which the TV answers with 401) fails CI.
 *
 * Transport: SSAP is JSON messages over a WebSocket (wss://<ip>:3001, self-signed).
 * Simpler than Android TV — no client cert, no protobuf. Pairing = an on-TV "Accept"
 * prompt returning a client-key we persist and resend to reconnect silently.
 *
 * THE REGISTER MANIFEST BELOW IS BYTE-VERBATIM from the agent. Its `signatures`
 * block is a precomputed RSA signature over the `signed` sub-object; ANY edit
 * invalidates it and the TV returns 401 insufficient permissions. Do not touch it.
 */

export const WEBOS_PORT = 3001;

/** Verbatim from agent _WEBOS_REGISTER_JSON. Parse, do not hand-edit. */
export const WEBOS_REGISTER_JSON = "{\"forcePairing\":false,\"manifest\":{\"appVersion\":\"1.1\",\"manifestVersion\":1,\"permissions\":[\"LAUNCH\",\"LAUNCH_WEBAPP\",\"APP_TO_APP\",\"CLOSE\",\"TEST_OPEN\",\"TEST_PROTECTED\",\"CONTROL_AUDIO\",\"CONTROL_DISPLAY\",\"CONTROL_INPUT_JOYSTICK\",\"CONTROL_INPUT_MEDIA_RECORDING\",\"CONTROL_INPUT_MEDIA_PLAYBACK\",\"CONTROL_INPUT_TV\",\"CONTROL_POWER\",\"READ_APP_STATUS\",\"READ_CURRENT_CHANNEL\",\"READ_INPUT_DEVICE_LIST\",\"READ_NETWORK_STATE\",\"READ_RUNNING_APPS\",\"READ_TV_CHANNEL_LIST\",\"WRITE_NOTIFICATION_TOAST\",\"READ_POWER_STATE\",\"READ_COUNTRY_INFO\",\"READ_SETTINGS\",\"CONTROL_TV_SCREEN\",\"CONTROL_TV_STANBY\",\"CONTROL_FAVORITE_GROUP\",\"CONTROL_USER_INFO\",\"CHECK_BLUETOOTH_DEVICE\",\"CONTROL_BLUETOOTH\",\"CONTROL_TIMER_INFO\",\"STB_INTERNAL_CONNECTION\",\"CONTROL_RECORDING\",\"READ_RECORDING_STATE\",\"WRITE_RECORDING_LIST\",\"READ_RECORDING_LIST\",\"READ_RECORDING_SCHEDULE\",\"WRITE_RECORDING_SCHEDULE\",\"READ_STORAGE_DEVICE_LIST\",\"READ_TV_PROGRAM_INFO\",\"CONTROL_BOX_CHANNEL\",\"READ_TV_ACR_AUTH_TOKEN\",\"READ_TV_CONTENT_STATE\",\"READ_TV_CURRENT_TIME\",\"ADD_LAUNCHER_CHANNEL\",\"SET_CHANNEL_SKIP\",\"RELEASE_CHANNEL_SKIP\",\"CONTROL_CHANNEL_BLOCK\",\"DELETE_SELECT_CHANNEL\",\"CONTROL_CHANNEL_GROUP\",\"SCAN_TV_CHANNELS\",\"CONTROL_TV_POWER\",\"CONTROL_WOL\"],\"signatures\":[{\"signature\":\"eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2Iiwia2V5SWQiOiJ0ZXN0LXNpZ25pbmctY2VydCIsInNpZ25hdHVyZVZlcnNpb24iOjF9.hrVRgjCwXVvE2OOSpDZ58hR+59aFNwYDyjQgKk3auukd7pcegmE2CzPCa0bJ0ZsRAcKkCTJrWo5iDzNhMBWRyaMOv5zWSrthlf7G128qvIlpMT0YNY+n/FaOHE73uLrS/g7swl3/qH/BGFG2Hu4RlL48eb3lLKqTt2xKHdCs6Cd4RMfJPYnzgvI4BNrFUKsjkcu+WD4OO2A27Pq1n50cMchmcaXadJhGrOqH5YmHdOCj5NSHzJYrsW0HPlpuAx/ECMeIZYDh6RMqaFM2DXzdKX9NmmyqzJ3o/0lkk/N97gfVRLW5hA29yeAwaCViZNCP8iC9aO0q9fQojoa7NQnAtw==\",\"signatureVersion\":1}],\"signed\":{\"appId\":\"com.lge.test\",\"created\":\"20140509\",\"localizedAppNames\":{\"\":\"LG Remote App\",\"ko-KR\":\"\\ub9ac\\ubaa8\\ucee8 \\uc571\",\"zxx-XX\":\"\\u041b\\u0413 R\\u044d\\u043cot\\u044d A\\u041f\\u041f\"},\"localizedVendorNames\":{\"\":\"LG Electronics\"},\"permissions\":[\"TEST_SECURE\",\"CONTROL_INPUT_TEXT\",\"CONTROL_MOUSE_AND_KEYBOARD\",\"READ_INSTALLED_APPS\",\"READ_LGE_SDX\",\"READ_NOTIFICATIONS\",\"SEARCH\",\"WRITE_SETTINGS\",\"WRITE_NOTIFICATION_ALERT\",\"CONTROL_POWER\",\"READ_CURRENT_CHANNEL\",\"READ_RUNNING_APPS\",\"READ_UPDATE_INFO\",\"UPDATE_FROM_REMOTE_APP\",\"READ_LGE_TV_INPUT_EVENTS\",\"READ_TV_CURRENT_TIME\"],\"serial\":\"2f930e2d2cfe083771f68e4fe7bb07\",\"vendorId\":\"com.lge\"}},\"pairingType\":\"PROMPT\"}";

/** Unified TV ops -> SSAP request URIs. From _WEBOS_OP_URI (couchsided.py:8086). */
export const WEBOS_OP_URI: Record<string, string> = {
  power_off: 'ssap://system/turnOff',
  volume_up: 'ssap://audio/volumeUp',
  volume_down: 'ssap://audio/volumeDown',
};

/** Factory-remote key -> webOS pointer button name. From _WEBOS_KEYS (couchsided.py:8334). */
export const WEBOS_KEYS: Record<string, string> = {
  up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', ok: 'ENTER',
  menu: 'MENU', home: 'HOME', back: 'BACK', exit: 'EXIT', info: 'INFO',
  play: 'PLAY', pause: 'PAUSE', stop: 'STOP', rewind: 'REWIND', fast_forward: 'FASTFORWARD',
};

/** ssap:// URI for the second (pointer) socket that carries button presses. */
export const WEBOS_POINTER_URI = 'ssap://com.webos.service.networkinput/getPointerInputSocket';

/** SSAP mute + IME text URIs. */
export const WEBOS_MUTE_URI = 'ssap://audio/setMute';
export const WEBOS_IME_INSERT_URI = 'ssap://com.webos.service.ime/insertText';

/** App launcher: list installed apps (with icon URLs) + launch one by id. */
export const WEBOS_LIST_APPS_URI = 'ssap://com.webos.applicationManager/listLaunchPoints';
export const WEBOS_LAUNCH_URI = 'ssap://system.launcher/launch';

/**
 * The register envelope. `id` is assigned by the session (SSAP correlates
 * responses by id). A stored clientKey makes it silent; without one the TV
 * shows the Accept prompt and returns a fresh key to persist.
 */
export function registerMessage(id: string, clientKey?: string): string {
  const payload = JSON.parse(WEBOS_REGISTER_JSON);
  if (clientKey) payload['client-key'] = clientKey;
  return JSON.stringify({ id, type: 'register', payload });
}

/** A generic SSAP request. */
export function requestMessage(id: string, uri: string, payload?: unknown): string {
  const obj: Record<string, unknown> = { id, type: 'request', uri };
  if (payload !== undefined) obj.payload = payload;
  return JSON.stringify(obj);
}

/** The pointer-socket frame for a button press (its own text protocol, not JSON). */
export function pointerButtonFrame(name: string): string {
  return `type:button\nname:${name}\n\n`;
}

/** Classify a parsed SSAP message. */
export type WebosMsg = { id?: string; type?: string; payload?: Record<string, unknown>; error?: string };
export const isPrompt = (m: WebosMsg): boolean => m.payload?.pairingType === 'PROMPT';
export const isRegistered = (m: WebosMsg): boolean => m.type === 'registered';
export const clientKeyOf = (m: WebosMsg): string | undefined =>
  typeof m.payload?.['client-key'] === 'string' ? (m.payload['client-key'] as string) : undefined;
