import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VideoTooLargeException } from '../common/exceptions/domain.exception';
import { StorageService, UploadPart } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import {
  MAX_VIDEO_SIZE_BYTES,
  UPLOAD_PART_SIZE_BYTES,
} from './videos.constants';

export interface InitiateUploadResult {
  id: string;
  uploadId: string;
  parts: UploadPart[];
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
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
}
