import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { QueueService } from './queue/queue.service';
import { VideoProcessingService } from './videos/video-processing.service';
import { VIDEO_PROCESSING_REQUESTED_EVENT } from './videos/videos.constants';

const logger = new Logger('VideoWorker');

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const queueService = app.get(QueueService);
  const videoProcessingService = app.get(VideoProcessingService);

  await queueService.subscribe<{ videoId: string }>(
    VIDEO_PROCESSING_REQUESTED_EVENT,
    async (payload) => {
      logger.log(
        `Received ${VIDEO_PROCESSING_REQUESTED_EVENT}: ${payload.videoId}`,
      );
      await videoProcessingService.process(payload.videoId);
    },
  );

  logger.log('Video worker started, listening for processing jobs');
}
void bootstrap();
