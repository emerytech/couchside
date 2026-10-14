/** File-transfer policy, independent of Expo so downgrade handling is testable. */
export type UploadConnection = {
  host: string; port: number; token: string;
  secure?: boolean; tlsPort?: number; pinModulus?: string;
};
export type UploadReply = { status: number; body: string };
export type UploadResult = { ok: boolean; name: string; bytes: number; path: string };
export type UploadProgress = (fraction: number) => void;
export type SecureUpload = {
  host: string; port: number; pinModulus: string; ticket: string;
  fileUri: string; name: string;
};
export type UploadDrivers = {
  mintTicket: () => Promise<string | null>;
  secure: (upload: SecureUpload, progress?: UploadProgress) => Promise<UploadReply>;
  legacy: (url: string, fileUri: string, token: string, progress?: UploadProgress) => Promise<UploadReply>;
};

/** A successful HTTP status alone is not proof that the box saved the file. */
export function parseUploadResult(body: string): UploadResult {
  let value: unknown;
  try { value = JSON.parse(body); } catch { /* report a safe, consistent message below */ }
  if (value && typeof value === 'object') {
    const result = value as Record<string, unknown>;
    if (result.ok === true && typeof result.name === 'string' && result.name.length > 0
        && typeof result.bytes === 'number' && Number.isSafeInteger(result.bytes) && result.bytes > 0
        && typeof result.path === 'string' && result.path.length > 0) {
      return { ok: true, name: result.name, bytes: result.bytes, path: result.path };
    }
  }
  throw new Error('The box did not confirm the upload. Check its download folder before retrying.');
}

/** A retained pin is also a security commitment, even if a flag was lost. */
export function needsSecureUpload(conn: UploadConnection): boolean {
  return !!(conn.secure || conn.pinModulus);
}

export async function sendFile(
  conn: UploadConnection, fileUri: string, name: string,
  drivers: UploadDrivers, progress?: UploadProgress,
): Promise<UploadReply> {
  if (!name || name === '.' || name === '..' || /[/\\\x00-\x1f\x7f]/.test(name)) {
    throw new Error('Choose a file with a valid filename.');
  }
  if (needsSecureUpload(conn)) {
    if (!conn.secure || !conn.pinModulus || !/^[0-9a-f]{512,2048}$/i.test(conn.pinModulus)
        || !Number.isInteger(conn.tlsPort) || conn.tlsPort! < 1 || conn.tlsPort! > 65535) {
      throw new Error('The box’s secure pairing is incomplete. Pair it again before sending files.');
    }
    const ticket = await drivers.mintTicket();
    if (!ticket || !/^[0-9a-f]{32}$/i.test(ticket)) {
      throw new Error('Could not secure the upload — try again.');
    }
    // Deliberately no catch/retry/downgrade. A failed transfer may have committed
    // on the box; only the user can choose to retry with a fresh one-use ticket.
    return drivers.secure({ host: conn.host, port: conn.tlsPort!, pinModulus: conn.pinModulus,
      ticket, fileUri, name }, progress);
  }
  const host = conn.host.includes(':') && !conn.host.startsWith('[') ? `[${conn.host}]` : conn.host;
  return drivers.legacy(`http://${host}:${conn.port}/api/upload?name=${encodeURIComponent(name)}`,
    fileUri, conn.token, progress);
}
