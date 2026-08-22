import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USERNAME || 'streamtube',
  password: process.env.DB_PASSWORD || 'streamtube',
  database: process.env.DB_NAME || 'streamtube',
}));
