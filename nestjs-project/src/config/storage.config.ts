import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  // Endpoint reachable from outside the Compose network — used only to sign
  // URLs handed to clients (browser/curl), never for server-side calls.
  publicEndpoint:
    process.env.STORAGE_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  bucket: process.env.STORAGE_BUCKET || 'streamtube-videos',
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID || 'streamtube',
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY || 'streamtube123',
  forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE !== 'false',
}));
