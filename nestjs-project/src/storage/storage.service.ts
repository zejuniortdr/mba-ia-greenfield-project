import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
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
  /** Server-side calls — internal Docker endpoint. */
  private readonly client: S3Client;
  /** Signing only — public endpoint, so the URL works outside the Compose network. */
  private readonly presignClient: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = this.config.bucket;
    const clientOptions = {
      region: this.config.region,
      forcePathStyle: this.config.forcePathStyle,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
    };
    this.client = new S3Client({
      ...clientOptions,
      endpoint: this.config.endpoint,
    });
    this.presignClient = new S3Client({
      ...clientOptions,
      endpoint: this.config.publicEndpoint,
    });
  }

  async createMultipartUpload(
    key: string,
    partCount: number,
    contentType?: string,
  ): Promise<{ uploadId: string; parts: UploadPart[] }> {
    const created = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
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
      const url = await getSignedUrl(this.presignClient, command, {
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

  async downloadToFile(key: string, destinationPath: string): Promise<void> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!response.Body) {
      throw new Error(`Object not found or has an empty body: ${key}`);
    }
    await pipeline(
      response.Body as Readable,
      createWriteStream(destinationPath),
    );
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
    options: { attachment?: boolean; contentType?: string } = {},
  ): Promise<{ url: string; expiresAt: Date }> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(options.attachment
        ? { ResponseContentDisposition: 'attachment' }
        : {}),
      ...(options.contentType
        ? { ResponseContentType: options.contentType }
        : {}),
    });
    const url = await getSignedUrl(this.presignClient, command, {
      expiresIn: GET_PRESIGN_EXPIRATION_SECONDS,
    });
    return {
      url,
      expiresAt: new Date(Date.now() + GET_PRESIGN_EXPIRATION_SECONDS * 1000),
    };
  }
}
