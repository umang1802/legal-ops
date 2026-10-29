import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../../config/env.js';
import { AppError } from '../../http/errors.js';
import { contentDisposition, type DocumentStorage } from './document-storage.js';

/** Amazon S3 (credentials from the EC2 instance role), or a local S3-compatible store (SeaweedFS) in development via S3_ENDPOINT. */
export class S3DocumentStorage implements DocumentStorage {
  readonly name = 's3';
  private readonly s3: S3Client;

  constructor(
    private readonly bucket: string,
    opts: {
      region: string;
      endpoint?: string | undefined;
      forcePathStyle?: boolean;
      credentials?: { accessKeyId: string; secretAccessKey: string } | undefined;
    },
  ) {
    this.s3 = new S3Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      ...(opts.credentials ? { credentials: opts.credentials } : {}),
      forcePathStyle: opts.forcePathStyle ?? false,
      // Signed part URLs must not carry checksum headers the browser won't send.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async startUpload(key: string, contentType: string) {
    // No ServerSideEncryption header: AWS encrypts every new object with SSE-S3 by default, and S3-compatible dev
    // stores (SeaweedFS) reject the header.
    const r = await this.s3.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }));
    if (!r.UploadId) throw new Error('S3 returned no upload id');
    return { uploadId: r.UploadId };
  }

  signPartUrls(key: string, uploadId: string, partCount: number, expiresInSeconds: number) {
    return Promise.all(
      Array.from({ length: partCount }, (_, i) =>
        getSignedUrl(this.s3, new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: i + 1 }), {
          expiresIn: expiresInSeconds,
        }),
      ),
    );
  }

  async completeUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]) {
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
  }

  async abortUpload(key: string, uploadId: string) {
    await this.s3.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId })).catch(() => undefined);
  }

  async objectSize(key: string) {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return r.ContentLength ?? null;
    } catch (err) {
      if (err instanceof NotFound || (err as { name?: string }).name === 'NotFound') return null;
      throw err;
    }
  }

  async remove(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  signDownloadUrl(key: string, o: { fileName: string; contentType: string; inline: boolean; expiresInSeconds: number }) {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: contentDisposition(o.fileName, o.inline),
        ResponseContentType: o.contentType,
      }),
      { expiresIn: o.expiresInSeconds },
    );
  }
}

/** Used when DOCUMENTS_BUCKET isn't set: every operation explains that document storage isn't set up. */
export class DisabledDocumentStorage implements DocumentStorage {
  readonly name = 'disabled';
  private fail(): never {
    throw new AppError(503, 'NOT_CONFIGURED', 'Document storage isn’t set up on this server yet. Contact LexForgeX.');
  }
  startUpload(): never {
    return this.fail();
  }
  signPartUrls(): never {
    return this.fail();
  }
  completeUpload(): never {
    return this.fail();
  }
  abortUpload(): never {
    return this.fail();
  }
  objectSize(): never {
    return this.fail();
  }
  remove(): never {
    return this.fail();
  }
  signDownloadUrl(): never {
    return this.fail();
  }
}

export function createDocumentStorage(env: Env): DocumentStorage {
  if (!env.S3_BUCKET) return new DisabledDocumentStorage();
  return new S3DocumentStorage(env.S3_BUCKET, {
    region: env.S3_REGION ?? env.AWS_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials:
      env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } : undefined,
  });
}
