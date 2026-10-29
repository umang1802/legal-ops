/**
 * Development only: creates the local document bucket (S3_BUCKET on S3_ENDPOINT) and the CORS rule browsers need to
 * upload parts directly (PUT from APP_URL, exposing ETag). Production buckets are set up in the AWS console (runbook).
 */
import { CreateBucketCommand, HeadBucketCommand, PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';
import { loadEnv } from '../config/env.js';

const env = loadEnv();
if (env.NODE_ENV === 'production') throw new Error('dev-storage is for local development only');
if (!env.S3_BUCKET || !env.S3_ENDPOINT) throw new Error('Set S3_BUCKET and S3_ENDPOINT in .env first');

const s3 = new S3Client({
  region: env.S3_REGION ?? env.AWS_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: env.S3_ACCESS_KEY_ID ?? 'dev', secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? 'dev' },
});
const Bucket = env.S3_BUCKET;
try {
  await s3.send(new HeadBucketCommand({ Bucket }));
  console.log(`bucket ${Bucket} exists`);
} catch {
  await s3.send(new CreateBucketCommand({ Bucket }));
  console.log(`created bucket ${Bucket}`);
}
await s3.send(
  new PutBucketCorsCommand({
    Bucket,
    CORSConfiguration: {
      CORSRules: [{ AllowedOrigins: [env.APP_URL], AllowedMethods: ['PUT', 'GET'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 }],
    },
  }),
);
console.log(`CORS set for ${env.APP_URL}`);
