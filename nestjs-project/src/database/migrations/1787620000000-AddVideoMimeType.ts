import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVideoMimeType1787620000000 implements MigrationInterface {
  name = 'AddVideoMimeType1787620000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" ADD "mime_type" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "videos" DROP COLUMN "mime_type"`);
  }
}
