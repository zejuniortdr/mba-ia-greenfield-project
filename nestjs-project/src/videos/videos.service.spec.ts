import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { Repository } from 'typeorm';
import { VideoTooLargeException } from '../common/exceptions/domain.exception';
import { QueueService } from '../queue/queue.service';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

describe('VideosService — initiateUpload', () => {
  let videosService: VideosService;
  let videoRepository: jest.Mocked<Repository<Video>>;
  let storageService: jest.Mocked<StorageService>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: {
            create: jest.fn((data: Partial<Video>) => data),
            save: jest.fn(),
          },
        },
        {
          provide: StorageService,
          useValue: {
            createMultipartUpload: jest.fn(),
          },
        },
        {
          provide: QueueService,
          useValue: {
            publish: jest.fn(),
          },
        },
      ],
    }).compile();

    videosService = module.get(VideosService);
    videoRepository = module.get(getRepositoryToken(Video));
    storageService = module.get(StorageService);
  });

  it('throws VideoTooLargeException when sizeBytes exceeds 10GB and does not create a video', async () => {
    await expect(
      videosService.initiateUpload('channel-1', {
        title: 'My Video',
        sizeBytes: 10_737_418_241,
      }),
    ).rejects.toThrow(VideoTooLargeException);

    expect(videoRepository.save).not.toHaveBeenCalled();
    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('creates a draft video and returns uploadId + parts for a valid size', async () => {
    videoRepository.save.mockResolvedValueOnce({
      id: 'video-1',
    } as Video);
    videoRepository.save.mockResolvedValueOnce({
      id: 'video-1',
    } as Video);
    storageService.createMultipartUpload.mockResolvedValueOnce({
      uploadId: 'upload-1',
      parts: [{ partNumber: 1, url: 'https://example.com/part1' }],
    });

    const result = await videosService.initiateUpload('channel-1', {
      title: 'My Video',
      sizeBytes: 1000,
    });

    expect(videoRepository.save).toHaveBeenCalledTimes(2);
    expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
      'videos/video-1/original',
      1,
    );
    expect(result).toEqual({
      id: 'video-1',
      uploadId: 'upload-1',
      parts: [{ partNumber: 1, url: 'https://example.com/part1' }],
    });
  });

  it('computes the correct number of parts for a size spanning multiple parts', async () => {
    videoRepository.save.mockResolvedValueOnce({ id: 'video-2' } as Video);
    videoRepository.save.mockResolvedValueOnce({ id: 'video-2' } as Video);
    storageService.createMultipartUpload.mockResolvedValueOnce({
      uploadId: 'upload-2',
      parts: [],
    });

    await videosService.initiateUpload('channel-1', {
      title: 'My Video',
      sizeBytes: 150 * 1024 * 1024, // 150MB, part size is 100MB
    });

    expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
      'videos/video-2/original',
      2,
    );
  });
});
