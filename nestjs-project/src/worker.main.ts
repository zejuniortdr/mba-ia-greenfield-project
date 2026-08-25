import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { QueueService } from './queue/queue.service';
import { VideoProcessingService } from './videos/video-processing.service';
import { registerVideoProcessingConsumer } from './videos/video-processing.consumer';

const logger = new Logger('VideoWorker');

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);

  await registerVideoProcessingConsumer(
    app.get(QueueService),
    app.get(VideoProcessingService),
  );

  logger.log('Video worker started, listening for processing jobs');
}
void bootstrap();
