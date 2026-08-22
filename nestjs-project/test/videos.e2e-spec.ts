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

describe('Videos (e2e)', () => {
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
    const email = `videos_e2e_${++counter}@example.com`;
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

  describe('POST /videos', () => {
    it('returns 201 with { id, uploadId, parts } on valid body', async () => {
      const token = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'My Video', sizeBytes: 1000 })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.uploadId).toBeDefined();
      expect(res.body.parts).toHaveLength(1);
      expect(res.body.parts[0].partNumber).toBe(1);
      expect(res.body.parts[0].url).toBeDefined();
    });

    it('returns 413 with VIDEO_TOO_LARGE when sizeBytes exceeds 10GB', async () => {
      const token = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Too Big', sizeBytes: 10_737_418_241 })
        .expect(413);

      expect(res.body.error).toBe('VIDEO_TOO_LARGE');
    });
  });

  describe('POST /videos/:id/complete', () => {
    async function initiateAndUploadPart(
      token: string,
    ): Promise<{ id: string; partNumber: number; etag: string }> {
      const initiateRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'My Video', sizeBytes: 1000 });

      const { id, parts } = initiateRes.body;
      const putResponse = await fetch(parts[0].url, {
        method: 'PUT',
        body: Buffer.from('video bytes'),
      });
      const etag = putResponse.headers.get('etag') as string;

      return { id, partNumber: parts[0].partNumber, etag };
    }

    it('returns 200, publishes video.processing.requested and updates status to processing', async () => {
      const token = await registerConfirmAndLogin();
      const { id, partNumber, etag } = await initiateAndUploadPart(token);

      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ partNumber, etag }] })
        .expect(200);

      expect(res.body).toEqual({ id, status: 'processing' });
    });

    it('returns 404 with VIDEO_NOT_FOUND when the video does not exist', async () => {
      const token = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/complete')
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ partNumber: 1, etag: 'etag' }] })
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 409 with VIDEO_UPLOAD_ALREADY_COMPLETED on the second call', async () => {
      const token = await registerConfirmAndLogin();
      const { id, partNumber, etag } = await initiateAndUploadPart(token);

      await request(app.getHttpServer())
        .post(`/videos/${id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ partNumber, etag }] })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ partNumber, etag }] })
        .expect(409);

      expect(res.body.error).toBe('VIDEO_UPLOAD_ALREADY_COMPLETED');
    });
  });
});
