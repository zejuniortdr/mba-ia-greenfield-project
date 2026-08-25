import { execFile } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import appConfig from '../config/app.config';
import storageConfig from '../config/storage.config';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './entities/video-status.enum';
import { VideoProcessingService } from './video-processing.service';

const execFileAsync = promisify(execFile);
const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

async function generateTestVideo(
  workDir: string,
  durationSeconds: number,
): Promise<Buffer> {
  const outputPath = join(workDir, `${durationSeconds}s.mp4`);
  await execFileAsync('ffmpeg', [
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${durationSeconds}:size=64x64:rate=5`,
    '-pix_fmt',
    'yuv420p',
    '-y',
    outputPath,
  ]);
  return readFile(outputPath);
}

describe('VideoProcessingService (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let videoProcessingService: VideoProcessingService;
  let workDir: string;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    workDir = await mkdtemp(join(tmpdir(), 'video-processing-fixtures-'));

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [appConfig, storageConfig],
        }),
        StorageModule,
      ],
      providers: [
        VideoProcessingService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
      ],
    }).compile();

    storageService = module.get(StorageService);
    videoProcessingService = module.get(VideoProcessingService);
  });

  afterAll(async () => {
    await dataSource.destroy();
    await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createDraftVideo(storageKey: string): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_processing_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `chan_processing_${counter}`,
        user_id: user.id,
      }),
    );
    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Test Video',
        size_bytes: '1000',
        status: VideoStatus.PROCESSING,
        storage_key: storageKey,
      }),
    );
  }

  it('processes a valid video: extracts duration, generates thumbnail at 10% and marks ready', async () => {
    const storageKey = `test/original-${counter}.mp4`;
    const buffer = await generateTestVideo(workDir, 5);
    await storageService.putObject(storageKey, buffer, 'video/mp4');
    const video = await createDraftVideo(storageKey);

    await videoProcessingService.process(video.id);

    const updated = await videoRepository.findOneBy({ id: video.id });
    expect(updated?.status).toBe(VideoStatus.READY);
    expect(updated?.duration_seconds).toBeGreaterThanOrEqual(4);
    expect(updated?.duration_seconds).toBeLessThanOrEqual(6);
    expect(updated?.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);

    const thumbnailPath = join(workDir, `thumbnail-${counter}.jpg`);
    await storageService.downloadToFile(
      updated?.thumbnail_key as string,
      thumbnailPath,
    );
    expect((await readFile(thumbnailPath)).length).toBeGreaterThan(0);
  }, 30000);

  it('uses frame 0 as thumbnail for a video shorter than 2s', async () => {
    const storageKey = `test/original-short-${counter}.mp4`;
    const buffer = await generateTestVideo(workDir, 1);
    await storageService.putObject(storageKey, buffer, 'video/mp4');
    const video = await createDraftVideo(storageKey);

    await videoProcessingService.process(video.id);

    const updated = await videoRepository.findOneBy({ id: video.id });
    expect(updated?.status).toBe(VideoStatus.READY);
    expect(updated?.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
  }, 30000);

  it('marks the video as failed when the storage object does not exist, without throwing', async () => {
    const video = await createDraftVideo(`test/missing-${counter}.mp4`);

    await expect(
      videoProcessingService.process(video.id),
    ).resolves.toBeUndefined();

    const updated = await videoRepository.findOneBy({ id: video.id });
    expect(updated?.status).toBe(VideoStatus.FAILED);
  }, 30000);
});
