import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  VideoNotFoundException,
  VideoTooLargeException,
  VideoUploadAlreadyCompletedException,
  VideoUploadNotCompleteException,
} from '../common/exceptions/domain.exception';
import { QueueService } from '../queue/queue.service';
import {
  CompletedPart,
  StorageService,
  UploadPart,
} from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import { VideoStatus } from './entities/video-status.enum';
import {
  MAX_VIDEO_SIZE_BYTES,
  UPLOAD_PART_SIZE_BYTES,
  VIDEO_PROCESSING_REQUESTED_EVENT,
} from './videos.constants';

export interface InitiateUploadResult {
  id: string;
  uploadId: string;
  parts: UploadPart[];
}

export interface CompleteUploadResult {
  id: string;
  status: VideoStatus;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly queueService: QueueService,
  ) {}

  async initiateUpload(
    channelId: string,
    dto: CreateVideoDto,
  ): Promise<InitiateUploadResult> {
    if (dto.sizeBytes > MAX_VIDEO_SIZE_BYTES) {
      throw new VideoTooLargeException();
    }

    const video = await this.videoRepository.save(
      this.videoRepository.create({
        channel_id: channelId,
        title: dto.title,
        description: dto.description ?? null,
        size_bytes: String(dto.sizeBytes),
      }),
    );

    const storageKey = `videos/${video.id}/original`;
    const partCount = Math.ceil(dto.sizeBytes / UPLOAD_PART_SIZE_BYTES);
    const { uploadId, parts } = await this.storageService.createMultipartUpload(
      storageKey,
      partCount,
    );

    video.storage_key = storageKey;
    video.upload_id = uploadId;
    await this.videoRepository.save(video);

    return { id: video.id, uploadId, parts };
  }

  async completeUpload(
    id: string,
    channelId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.videoRepository.findOne({
      where: { id, channel_id: channelId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoUploadAlreadyCompletedException();
    }

    const parts: CompletedPart[] = dto.parts.map((part) => ({
      partNumber: part.partNumber,
      etag: part.etag,
    }));
    await this.storageService.completeMultipartUpload(
      video.storage_key as string,
      video.upload_id as string,
      parts,
    );

    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    await this.videoRepository.save(video);

    await this.queueService.publish(VIDEO_PROCESSING_REQUESTED_EVENT, {
      videoId: video.id,
    });

    return { id: video.id, status: video.status };
  }

  private async findReadyVideoOrThrow(id: string): Promise<Video> {
    const video = await this.videoRepository.findOne({ where: { id } });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.READY) {
      throw new VideoUploadNotCompleteException();
    }
    return video;
  }

  async getStreamUrl(id: string): Promise<{ url: string; expiresAt: Date }> {
    const video = await this.findReadyVideoOrThrow(id);
    return this.storageService.getPresignedGetUrl(video.storage_key as string);
  }

  async getDownloadUrl(id: string): Promise<{ url: string; expiresAt: Date }> {
    const video = await this.findReadyVideoOrThrow(id);
    return this.storageService.getPresignedGetUrl(video.storage_key as string, {
      attachment: true,
    });
  }
}
