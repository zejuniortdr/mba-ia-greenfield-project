import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import appConfig from '../config/app.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { VideoTooLargeException } from '../common/exceptions/domain.exception';
import { Video } from './entities/video.entity';
import { VideoStatus } from './entities/video-status.enum';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let videosService: VideosService;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [appConfig, storageConfig, queueConfig],
        }),
        StorageModule,
        QueueModule,
      ],
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
      ],
    }).compile();

    videosService = module.get(VideosService);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_upload_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `chan_upload_${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('creates a draft video in the database and returns uploadId + parts for a valid size', async () => {
    const channel = await createChannel();

    const result = await videosService.initiateUpload(channel.id, {
      title: 'My Video',
      sizeBytes: 1000,
    });

    expect(result.uploadId).toBeTruthy();
    expect(result.parts).toHaveLength(1);

    const video = await videoRepository.findOneBy({ id: result.id });
    expect(video?.status).toBe(VideoStatus.DRAFT);
    expect(video?.channel_id).toBe(channel.id);
    expect(video?.upload_id).toBe(result.uploadId);
    expect(video?.storage_key).toBe(`videos/${result.id}/original`);
  });

  it('rejects sizeBytes above 10GB without creating a video record', async () => {
    const channel = await createChannel();

    await expect(
      videosService.initiateUpload(channel.id, {
        title: 'Too Big',
        sizeBytes: 10_737_418_241,
      }),
    ).rejects.toThrow(VideoTooLargeException);

    const videos = await videoRepository.findBy({ channel_id: channel.id });
    expect(videos).toHaveLength(0);
  });
});
