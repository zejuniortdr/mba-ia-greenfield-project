import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import PgBoss from 'pg-boss';
import queueConfig from '../config/queue.config';

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
    await this.boss.stop();
  }

  async publish(event: string, payload: object): Promise<string | null> {
    await this.boss.createQueue(event);
    return this.boss.send(event, payload);
  }

  async subscribe<ReqData extends object>(
    event: string,
    handler: (payload: ReqData) => Promise<void>,
  ): Promise<string> {
    await this.boss.createQueue(event);
    return this.boss.work<ReqData>(event, async ([job]) => {
      await handler(job.data);
    });
  }
}
