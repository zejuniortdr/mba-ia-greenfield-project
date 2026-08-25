import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1787428122392 } from './migrations/1787428122392-CreateVideos';
import { AddVideoMimeType1787620000000 } from './migrations/1787620000000-AddVideoMimeType';
import { createTestDataSource } from '../test/create-test-data-source';

// Must list every table the registered migrations create. This spec drops the
// "migrations" bookkeeping table, so any migration missing from MIGRATIONS below
// loses its record while its table survives — leaving the shared DB in a state
// where migration:run can never succeed again.
const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

const MANAGED_ENUMS = ['verification_tokens_type_enum', 'videos_status_enum'];

const MIGRATIONS = [
  CreateUsersAndChannels1775687773260,
  CreateAuthTokens1777579850478,
  CreateVideos1787428122392,
  AddVideoMimeType1787620000000,
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: MIGRATIONS,
      },
    );

    await dataSource.initialize();

    // Sequentially: concurrent CASCADE drops on FK-related tables deadlock
    // against each other, which used to leave the shared DB half-migrated.
    for (const table of [...MANAGED_TABLES, 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    // DROP TABLE ... CASCADE does not drop enum types the dropped columns
    // used — they are independent objects and survive the table drop,
    // so a stale one collides with CREATE TYPE on the next runMigrations().
    for (const enumType of MANAGED_ENUMS) {
      await dataSource.query(`DROP TYPE IF EXISTS "${enumType}"`);
    }
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving token tables missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should register every migration file that exists on disk', () => {
    // Guards the failure mode described above: a migration added to
    // src/database/migrations/ but not to MIGRATIONS would silently lose its
    // bookkeeping row here and break migration:run for everyone afterwards.
    const files = readdirSync(join(__dirname, 'migrations')).filter((f) =>
      f.endsWith('.ts'),
    );
    expect(MIGRATIONS).toHaveLength(files.length);
  });

  it('should apply all migrations and create every managed table', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(MIGRATIONS.length);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should revert the last migration and drop its bookkeeping row', async () => {
    // Asserts the revert generically instead of naming the last migration's
    // table, so adding a migration does not silently invalidate this test.
    const before = await dataSource.query<{ name: string }[]>(
      `SELECT name FROM "migrations" ORDER BY timestamp`,
    );

    await dataSource.undoLastMigration();

    const after = await dataSource.query<{ name: string }[]>(
      `SELECT name FROM "migrations" ORDER BY timestamp`,
    );
    expect(after.map((r) => r.name)).toEqual(
      before.slice(0, -1).map((r) => r.name),
    );
  });
});
