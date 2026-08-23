import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/entities/video-status.enum';

describe('Videos streaming/download (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
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

    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
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
    return res.body.access_token;
  }

  async function createDraftVideo(token: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'My Video', sizeBytes: 1000 });
    return res.body.id;
  }

  async function markVideoReady(id: string): Promise<void> {
    await dataSource.getRepository(Video).update(id, {
      status: VideoStatus.READY,
      storage_key: `videos/${id}/original`,
      thumbnail_key: `videos/${id}/thumbnail.jpg`,
      duration_seconds: 42,
    });
  }

  describe('GET /videos/:id/stream-url', () => {
    it('returns 200 with { url, expiresAt } without an Authorization header once ready', async () => {
      const token = await registerConfirmAndLogin();
      const id = await createDraftVideo(token);
      await markVideoReady(id);

      const res = await request(app.getHttpServer())
        .get(`/videos/${id}/stream-url`)
        .expect(200);

      expect(res.body.url).toEqual(expect.any(String));
      expect(res.body.expiresAt).toEqual(expect.any(String));
    });

    it('returns 409 with VIDEO_UPLOAD_NOT_COMPLETE while the video is still draft', async () => {
      const token = await registerConfirmAndLogin();
      const id = await createDraftVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${id}/stream-url`)
        .expect(409);

      expect(res.body.error).toBe('VIDEO_UPLOAD_NOT_COMPLETE');
    });

    it('returns 404 with VIDEO_NOT_FOUND for a non-existent id', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000/stream-url')
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
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

      expect(res.body.url).toEqual(expect.any(String));
      expect(res.body.expiresAt).toEqual(expect.any(String));
    });

    it('returns 409 with VIDEO_UPLOAD_NOT_COMPLETE while the video is still draft', async () => {
      const token = await registerConfirmAndLogin();
      const id = await createDraftVideo(token);

      const res = await request(app.getHttpServer())
        .get(`/videos/${id}/download-url`)
        .expect(409);

      expect(res.body.error).toBe('VIDEO_UPLOAD_NOT_COMPLETE');
    });

    it('returns 404 with VIDEO_NOT_FOUND for a non-existent id', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000/download-url')
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });
});
