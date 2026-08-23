import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';

const PART_PRESIGN_EXPIRATION_SECONDS = 3600;
const GET_PRESIGN_EXPIRATION_SECONDS = 3600;

export interface UploadPart {
  partNumber: number;
  url: string;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = this.config.bucket;
    this.client = new S3Client({
      endpoint: this.config.endpoint,
      region: this.config.region,
      forcePathStyle: this.config.forcePathStyle,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
    });
  }

  async createMultipartUpload(
    key: string,
    partCount: number,
  ): Promise<{ uploadId: string; parts: UploadPart[] }> {
    const created = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key }),
    );
    const uploadId = created.UploadId as string;

    const parts: UploadPart[] = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const command = new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      });
      const url = await getSignedUrl(this.client, command, {
        expiresIn: PART_PRESIGN_EXPIRATION_SECONDS,
      });
      parts.push({ partNumber, url });
    }

    return { uploadId, parts };
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      }),
    );
  }

  async getObject(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const chunks: Buffer[] = [];
    for await (const chunk of response.Body as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async getPresignedGetUrl(
    key: string,
    options: { attachment?: boolean } = {},
  ): Promise<{ url: string; expiresAt: Date }> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(options.attachment
        ? { ResponseContentDisposition: 'attachment' }
        : {}),
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: GET_PRESIGN_EXPIRATION_SECONDS,
    });
    return {
      url,
      expiresAt: new Date(Date.now() + GET_PRESIGN_EXPIRATION_SECONDS * 1000),
    };
  }
}
