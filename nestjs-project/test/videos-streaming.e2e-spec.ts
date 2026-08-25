import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { MailService } from '../src/mail/mail.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { StorageService } from '../src/storage/storage.service';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/entities/video-status.enum';

interface PresignedUrlBody {
  url: string;
  expiresAt: string;
}

interface ErrorBody {
  error: string;
}

describe('Videos streaming/download (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let storageService: StorageService;

  beforeAll(async () => {
    // This suite runs inside the Compose network, so the presigned URLs it
    // fetches must point at the internal endpoint, not the browser-facing one.
    process.env.STORAGE_PUBLIC_ENDPOINT =
      process.env.STORAGE_ENDPOINT ?? 'http://minio:9000';

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    storageService = moduleFixture.get(StorageService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  let counter = 0;
  async function registerConfirmAndLogin(): Promise<string> {
    const email = `videos_streaming_e2e_${++counter}@example.com`;
    const password = 'password123';

    const mailService = app.get(MailService);
    let capturedToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return (res.body as { access_token: string }).access_token;
  }

  async function createDraftVideo(token: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'My Video', sizeBytes: 1000 });
    return (res.body as { id: string }).id;
  }

  // Uploads real objects to MinIO before flipping the row to ready, so the
  // presigned URLs the endpoints hand back are actually resolvable.
  async function markVideoReady(id: string): Promise<Buffer> {
    const content = Buffer.alloc(4096, 'a');
    await storageService.putObject(
      `videos/${id}/original`,
      content,
      'video/mp4',
    );
    await storageService.putObject(
      `videos/${id}/thumbnail.jpg`,
      Buffer.from('thumbnail'),
      'image/jpeg',
    );
    await dataSource.getRepository(Video).update(id, {
      status: VideoStatus.READY,
      storage_key: `videos/${id}/original`,
      thumbnail_key: `videos/${id}/thumbnail.jpg`,
      duration_seconds: 42,
      mime_type: 'video/mp4',
    });
    return content;
  }

  describe('GET /videos/:id/stream-url', () => {
    it('returns 200 with { url, expiresAt } without an Authorization header once ready', async () => {
      const token = await registerConfirmAndLogin();
      const id = await createDraftVideo(token);
      await markVideoReady(id);

      const res = await request(app.getHttpServer())
        .get(`/videos/${id}/stream-url`)
        .expect(200);

      const body = res.body as PresignedUrlBody;
      expect(body.url).toEqual(expect.any(String));
      expect(body.expiresAt).toEqual(expect.any(String));
    });

    it('serves a byte range from the returned url with 206 Partial Content', async () => {
      const token = await registerConfirmAndLogin();
      const id = await createDraftVideo(token);
      const content = await markVideoReady(id);

      const res = await request(app.getHttpServer())
        .get(`/videos/${id}/stream-url`)
        .expect(200);

      const { url } = res.body as PresignedUrlBody;
      const ranged = await fetch(url, { headers: { Range: 'bytes=0-1023' } });

      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('content-range')).toBe(
        `bytes 0-1023/${content.length}`,
      );
      expect(ranged.headers.get('accept-ranges')).toBe('bytes');
      expect((await ranged.arrayBuffer()).byteLength).toBe(1024);
    }, 30000);

    it('returns 409 with VIDEO_UPLOAD_NOT_COMPLETE while the video is still draft', async () => {
      const token = await registerConfirmAndLogin();
      const id = await createDraftVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${id}/stream-url`)
        .expect(409);

      expect((res.body as ErrorBody).error).toBe('VIDEO_UPLOAD_NOT_COMPLETE');
    });

    it('returns 404 with VIDEO_NOT_FOUND for a non-existent id', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000/stream-url')
        .expect(404);

      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:id/download-url', () => {
    it('returns 200 with { url, expiresAt } once ready', async () => {
      const token = await registerConfirmAndLogin();
      const id = await createDraftVideo(token);
      await markVideoReady(id);

      const res = await request(app.getHttpServer())
        .get(`/videos/${id}/download-url`)
        .expect(200);

      const body = res.body as PresignedUrlBody;
      expect(body.url).toEqual(expect.any(String));
      expect(body.expiresAt).toEqual(expect.any(String));
    });

    it('serves the file as an attachment from the returned url', async () => {
      const token = await registerConfirmAndLogin();
      const id = await createDraftVideo(token);
      await markVideoReady(id);

      const res = await request(app.getHttpServer())
        .get(`/videos/${id}/download-url`)
        .expect(200);

      const { url } = res.body as PresignedUrlBody;
      const downloaded = await fetch(url);

      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get('content-disposition')).toContain(
        'attachment',
      );
    }, 30000);

    it('returns 409 with VIDEO_UPLOAD_NOT_COMPLETE while the video is still draft', async () => {
      const token = await registerConfirmAndLogin();
      const id = await createDraftVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${id}/download-url`)
        .expect(409);

      expect((res.body as ErrorBody).error).toBe('VIDEO_UPLOAD_NOT_COMPLETE');
    });

    it('returns 404 with VIDEO_NOT_FOUND for a non-existent id', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000/download-url')
        .expect(404);

      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });
  });
});
