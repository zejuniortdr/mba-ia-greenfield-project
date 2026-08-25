import { mkdtemp, readFile, rm } from 'fs/promises';
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

/**
 * Transient = worth retrying (storage/network down, timeout, 5xx). Anything
 * else (missing object, ffprobe rejecting the file) is terminal.
 */
export function isTransientError(error: unknown): boolean {
  const candidate = error as {
    name?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const status = candidate?.$metadata?.httpStatusCode;
  if (status !== undefined && status >= 500) {
    return true;
  }
  if (candidate?.name === 'TimeoutError') {
    return true;
  }
  return [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'ENOTFOUND',
  ].includes(candidate?.code ?? '');
}

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

  async process(videoId: string, lastAttempt = true): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      this.logger.error(`Video ${videoId} not found, skipping processing`);
      return;
    }

    let workDir: string | undefined;
    try {
      if (!video.storage_key) {
        throw new Error(`Video ${videoId} has no storage_key`);
      }

      workDir = await mkdtemp(join(tmpdir(), 'video-processing-'));
      const inputPath = join(workDir, 'original');

      await this.storageService.downloadToFile(video.storage_key, inputPath);

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
      if (!lastAttempt && isTransientError(error)) {
        // Rethrow so pg-boss requeues it; the video stays in `processing`.
        // `finally` below still cleans the temp dir.
        throw error;
      }
      try {
        video.status = VideoStatus.FAILED;
        await this.videoRepository.save(video);
      } catch (saveError) {
        this.logger.error(
          `Failed to persist failed status for video ${videoId}`,
          saveError instanceof Error ? saveError.stack : String(saveError),
        );
      }
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
        const duration = metadata.format.duration;
        if (duration === undefined || duration === null) {
          reject(new Error(`ffprobe returned no duration for ${inputPath}`));
          return;
        }
        resolve(duration);
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
