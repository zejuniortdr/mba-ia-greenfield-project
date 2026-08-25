import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video } from './video.entity';
import { VideoStatus } from './video-status.enum';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
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
        email: `video_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('should default status to draft', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'My Video',
        size_bytes: '1000',
      }),
    );

    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('should allow null description, storage_key, thumbnail_key, upload_id and duration_seconds', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'My Video',
        size_bytes: '1000',
      }),
    );

    expect(video.description).toBeNull();
    expect(video.storage_key).toBeNull();
    expect(video.thumbnail_key).toBeNull();
    expect(video.upload_id).toBeNull();
    expect(video.duration_seconds).toBeNull();
  });

  it('should enforce title max length of 100 characters', async () => {
    const channel = await createChannel();
    const longTitle = 'a'.repeat(101);

    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: channel.id,
          title: longTitle,
          size_bytes: '1000',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should reject an invalid status value', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: channel.id,
          title: 'My Video',
          size_bytes: '1000',
          status: 'invalid' as VideoStatus,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should reject a missing channel_id (FK constraint)', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: '00000000-0000-0000-0000-000000000000',
          title: 'My Video',
          size_bytes: '1000',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'My Video',
        size_bytes: '1000',
      }),
    );

    const found = await videoRepository.findOne({
      where: { channel_id: channel.id },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });
});
