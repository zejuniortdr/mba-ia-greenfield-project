import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import PgBoss from 'pg-boss';
import queueConfig from '../config/queue.config';

/** at-least-once: a rethrown handler error is retried this many times. */
export const JOB_RETRY_LIMIT = 3;
const JOB_RETRY_DELAY_SECONDS = 10;

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly boss: PgBoss;

  constructor(
    @Inject(queueConfig.KEY)
    config: ConfigType<typeof queueConfig>,
  ) {
    this.boss = new PgBoss(config);
  }

  async onModuleInit(): Promise<void> {
    await this.boss.start();
  }

  async onModuleDestroy(): Promise<void> {
    // wait: true so the polling workers are actually gone before the process
    // (or a test module) tears down, instead of leaking open connections.
    await this.boss.stop({ wait: true });
  }

  /**
   * @param db optional connection (e.g. an open TypeORM transaction) so the job
   * insert commits atomically with the caller's own writes.
   */
  async publish(
    event: string,
    payload: object,
    db?: PgBoss.Db,
  ): Promise<string | null> {
    await this.boss.createQueue(event);
    return this.boss.send(event, payload, {
      retryLimit: JOB_RETRY_LIMIT,
      retryDelay: JOB_RETRY_DELAY_SECONDS,
      retryBackoff: true,
      ...(db ? { db } : {}),
    });
  }

  /**
   * The handler receives `lastAttempt = true` when pg-boss has no retry left,
   * so callers can tell a retryable failure from a terminal one.
   */
  async subscribe<ReqData extends object>(
    event: string,
    handler: (payload: ReqData, lastAttempt: boolean) => Promise<void>,
  ): Promise<string> {
    await this.boss.createQueue(event);
    return this.boss.work<ReqData>(
      event,
      { includeMetadata: true },
      async ([job]) => {
        await handler(job.data, job.retryCount >= job.retryLimit);
      },
    );
  }
}
