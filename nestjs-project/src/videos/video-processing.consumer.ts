import { Logger } from '@nestjs/common';
import { QueueService } from '../queue/queue.service';
import { VideoProcessingService } from './video-processing.service';
import { VIDEO_PROCESSING_REQUESTED_EVENT } from './videos.constants';

const logger = new Logger('VideoWorker');

/**
 * Wires the queue consumer to the processing service. Lives outside
 * worker.main.ts so tests can exercise the queue → worker → ready seam without
 * booting (and never shutting down) the standalone worker process.
 */
export function registerVideoProcessingConsumer(
  queueService: QueueService,
  videoProcessingService: VideoProcessingService,
): Promise<string> {
  return queueService.subscribe<{ videoId: string }>(
    VIDEO_PROCESSING_REQUESTED_EVENT,
    async (payload, lastAttempt) => {
      logger.log(
        `Received ${VIDEO_PROCESSING_REQUESTED_EVENT}: ${payload.videoId}`,
      );
      await videoProcessingService.process(payload.videoId, lastAttempt);
    },
  );
}
