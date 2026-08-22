import { randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import appConfig from '../config/app.config';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let storageService: StorageService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [appConfig, storageConfig],
        }),
        StorageModule,
      ],
    }).compile();

    storageService = module.get(StorageService);
  });

  it('creates a multipart upload and returns a presigned PUT URL that accepts bytes on MinIO', async () => {
    const key = `test/${randomUUID()}.txt`;
    const content = Buffer.from('hello streamtube storage integration test');

    const { uploadId, parts } = await storageService.createMultipartUpload(
      key,
      1,
    );

    expect(uploadId).toBeTruthy();
    expect(parts).toHaveLength(1);

    const putResponse = await fetch(parts[0].url, {
      method: 'PUT',
      body: content,
    });
    expect(putResponse.status).toBe(200);
    const etag = putResponse.headers.get('etag') as string;
    expect(etag).toBeTruthy();

    await storageService.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag },
    ]);

    const { url } = await storageService.getPresignedGetUrl(key);
    const getResponse = await fetch(url);
    expect(getResponse.status).toBe(200);
    const body = Buffer.from(await getResponse.arrayBuffer());
    expect(body.equals(content)).toBe(true);
  });

  it('getPresignedGetUrl serves the object with Range request support', async () => {
    const key = `test/${randomUUID()}.txt`;
    const content = Buffer.from('0123456789');

    const { uploadId, parts } = await storageService.createMultipartUpload(
      key,
      1,
    );
    const putResponse = await fetch(parts[0].url, {
      method: 'PUT',
      body: content,
    });
    const etag = putResponse.headers.get('etag') as string;
    await storageService.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag },
    ]);

    const { url } = await storageService.getPresignedGetUrl(key);
    const rangeResponse = await fetch(url, {
      headers: { Range: 'bytes=0-4' },
    });

    expect(rangeResponse.status).toBe(206);
    const body = Buffer.from(await rangeResponse.arrayBuffer());
    expect(body.toString()).toBe('01234');
  });

  it('getPresignedGetUrl with attachment option sets Content-Disposition', async () => {
    const key = `test/${randomUUID()}.txt`;
    const content = Buffer.from('download me');

    const { uploadId, parts } = await storageService.createMultipartUpload(
      key,
      1,
    );
    const putResponse = await fetch(parts[0].url, {
      method: 'PUT',
      body: content,
    });
    const etag = putResponse.headers.get('etag') as string;
    await storageService.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag },
    ]);

    const { url } = await storageService.getPresignedGetUrl(key, {
      attachment: true,
    });
    const getResponse = await fetch(url);

    expect(getResponse.headers.get('content-disposition')).toContain(
      'attachment',
    );
  });
});
