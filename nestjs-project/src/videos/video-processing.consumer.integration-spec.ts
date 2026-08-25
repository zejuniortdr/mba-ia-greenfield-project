import { execFile } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import appConfig from '../config/app.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { QueueModule } from '../queue/queue.module';
import { QueueService } from '../queue/queue.service';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoStatus } from './entities/video-status.enum';
import { registerVideoProcessingConsumer } from './video-processing.consumer';
import { VideoProcessingService } from './video-processing.service';
import { VIDEO_PROCESSING_REQUESTED_EVENT } from './videos.constants';

const execFileAsync = promisify(execFile);
const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

async function waitForStatus(
  repository: Repository<Video>,
  id: string,
  status: VideoStatus,
  timeoutMs = 40000,
): Promise<Video> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const video = await repository.findOneBy({ id });
    if (video?.status === status) {
      return video;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Video ${id} never reached "${status}" (last: "${video?.status ?? 'missing'}")`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('Video processing consumer (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let queueService: QueueService;
  let workDir: string;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    workDir = await mkdtemp(join(tmpdir(), 'video-consumer-fixtures-'));

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [appConfig, queueConfig, storageConfig],
        }),
        QueueModule,
        StorageModule,
      ],
      providers: [
        VideoProcessingService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
      ],
    }).compile();
    await module.init();

    storageService = module.get(StorageService);
    queueService = module.get(QueueService);

    // Same wiring worker.main.ts uses in the video-worker container.
    await registerVideoProcessingConsumer(
      queueService,
      module.get(VideoProcessingService),
    );
  }, 60000);

  afterAll(async () => {
    await module.close();
    await dataSource.destroy();
    await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createProcessingVideo(storageKey: string): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_consumer_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `chan_consumer_${counter}`,
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

  it('takes a published job through the worker and lands the video in ready', async () => {
    const storageKey = `test/consumer-original-${counter}.mp4`;
    const outputPath = join(workDir, 'source.mp4');
    await execFileAsync('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=5:size=64x64:rate=5',
      '-pix_fmt',
      'yuv420p',
      '-y',
      outputPath,
    ]);
    await storageService.putObject(
      storageKey,
      await readFile(outputPath),
      'video/mp4',
    );
    const video = await createProcessingVideo(storageKey);

    await queueService.publish(VIDEO_PROCESSING_REQUESTED_EVENT, {
      videoId: video.id,
    });

    const processed = await waitForStatus(
      videoRepository,
      video.id,
      VideoStatus.READY,
    );
    expect(processed.duration_seconds).toBeGreaterThanOrEqual(4);
    expect(processed.duration_seconds).toBeLessThanOrEqual(6);
    expect(processed.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
  }, 60000);
});
