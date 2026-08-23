import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import ffmpeg from 'fluent-ffmpeg';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './entities/video-status.enum';

const SHORT_VIDEO_THRESHOLD_SECONDS = 2;
const THUMBNAIL_TIMESTAMP_RATIO = 0.1;
const THUMBNAIL_FILENAME = 'thumbnail.jpg';

export function calculateThumbnailTimestamp(durationSeconds: number): number {
  return durationSeconds < SHORT_VIDEO_THRESHOLD_SECONDS
    ? 0
    : durationSeconds * THUMBNAIL_TIMESTAMP_RATIO;
}

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {}

  async process(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      this.logger.error(`Video ${videoId} not found, skipping processing`);
      return;
    }

    let workDir: string | undefined;
    try {
      workDir = await mkdtemp(join(tmpdir(), 'video-processing-'));
      const inputPath = join(workDir, 'original');

      const originalBuffer = await this.storageService.getObject(
        video.storage_key as string,
      );
      await writeFile(inputPath, originalBuffer);

      const duration = await this.probeDuration(inputPath);
      const timestamp = calculateThumbnailTimestamp(duration);
      await this.extractThumbnail(inputPath, timestamp, workDir);

      const thumbnailBuffer = await readFile(join(workDir, THUMBNAIL_FILENAME));
      const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
      await this.storageService.putObject(
        thumbnailKey,
        thumbnailBuffer,
        'image/jpeg',
      );

      video.duration_seconds = Math.round(duration);
      video.thumbnail_key = thumbnailKey;
      video.status = VideoStatus.READY;
      await this.videoRepository.save(video);
    } catch (error) {
      this.logger.error(
        `Failed to process video ${videoId}`,
        error instanceof Error ? error.stack : String(error),
      );
      video.status = VideoStatus.FAILED;
      await this.videoRepository.save(video);
    } finally {
      if (workDir) {
        await rm(workDir, { recursive: true, force: true });
      }
    }
  }

  private probeDuration(inputPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(metadata.format.duration ?? 0);
      });
    });
  }

  private extractThumbnail(
    inputPath: string,
    timestampSeconds: number,
    folder: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .screenshots({
          timestamps: [timestampSeconds],
          filename: THUMBNAIL_FILENAME,
          folder,
        });
    });
  }
}
