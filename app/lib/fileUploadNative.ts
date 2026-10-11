import { requireOptionalNativeModule } from 'expo-modules-core';
import type { SecureUpload, UploadProgress, UploadReply } from './fileUpload';

type Progress = { id: string; sent: number; total: number };
type Uploader = {
  upload(options: Omit<SecureUpload, 'port'> & { id: string; port: string }): Promise<UploadReply>;
  addListener(event: 'progress', listener: (event: Progress) => void): { remove(): void };
};
let nextId = 0;

export async function uploadPinnedFile(options: SecureUpload, progress?: UploadProgress): Promise<UploadReply> {
  const uploader = requireOptionalNativeModule<Uploader>('CouchsideFileTransfer');
  if (!uploader) throw new Error('Update Couchside to send files securely from this device.');
  const id = `upload-${++nextId}`;
  const subscription = uploader.addListener('progress', (event) => {
    if (event.id === id && event.total > 0) progress?.(Math.min(1, Math.max(0, event.sent / event.total)));
  });
  try {
    return await uploader.upload({ ...options, port: String(options.port), id });
  } finally {
    subscription.remove();
  }
}

/** Compatibility adapter used only for an explicitly unencrypted pairing. */
export async function uploadLegacyFile(
  url: string, fileUri: string, token: string, progress?: UploadProgress,
): Promise<UploadReply> {
  const { File, UploadType } = await import('expo-file-system');
  const result = await new File(fileUri).createUploadTask(url, {
    httpMethod: 'POST',
    uploadType: UploadType.BINARY_CONTENT,
    headers: { Authorization: `Bearer ${token}` },
    onProgress: ({ bytesSent, totalBytes }: { bytesSent: number; totalBytes: number }) => {
      if (totalBytes > 0) progress?.(bytesSent / totalBytes);
    },
  }).uploadAsync();
  if (!result) throw new Error('Upload did not complete — try again.');
  return result;
}
