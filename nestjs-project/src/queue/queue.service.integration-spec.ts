import { randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import appConfig from '../config/app.config';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { QueueService } from './queue.service';

describe('QueueService (integration)', () => {
  let module: TestingModule;
  let queueService: QueueService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [appConfig, queueConfig],
        }),
        QueueModule,
      ],
    }).compile();

    queueService = module.get(QueueService);
    await module.init();
  });

  afterAll(async () => {
    await module.close();
  });

  it('delivers a published payload to a subscribed handler', async () => {
    const event = `test.event.${randomUUID()}`;
    const payload = { videoId: randomUUID() };

    let resolveReceived: (data: { videoId: string }) => void;
    const received = new Promise<{ videoId: string }>((resolve) => {
      resolveReceived = resolve;
    });

    await queueService.subscribe<{ videoId: string }>(event, (data) => {
      resolveReceived(data);
      return Promise.resolve();
    });
    await queueService.publish(event, payload);

    await expect(received).resolves.toEqual(payload);
  }, 15000);
});
