import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { nanoid } from 'nanoid';
import sharp from 'sharp';
import type {
  StorageAdapter,
  UploadOptions,
  UploadResult,
  S3StorageConfig,
  ProcessedImage,
} from '../types.js';

const MAX_IMAGE_DIMENSION = 2000;
const THUMBNAIL_SIZE = 300;

export class S3StorageAdapter implements StorageAdapter {
  private client: S3Client;
  private bucket: string;
  private publicUrl: string;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.publicUrl =
      config.publicUrl?.replace(/\/$/, '') ||
      `https://${config.bucket}.s3.${config.region}.amazonaws.com`;

    this.client = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      ...(config.endpoint && { endpoint: config.endpoint }),
    });
  }

  async upload(file: Buffer, options: UploadOptions): Promise<UploadResult> {
    const { purpose, agentId } = options;

    // Process the image
    const processed = await this.processImage(file, purpose);

    // Generate unique key
    const ext = this.getExtension(processed.format);
    const key = `${purpose}s/${agentId}_${nanoid(10)}${ext}`;

    // Upload main file
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: processed.buffer,
        ContentType: `image/${processed.format}`,
        CacheControl: 'public, max-age=31536000',
      })
    );

    // Generate thumbnail for posts and comments
    let thumbnailUrl: string | undefined;
    if (purpose === 'post' || purpose === 'comment') {
      const thumbnail = await this.generateThumbnail(file);
      const thumbKey = `thumbnails/${agentId}_${nanoid(10)}${ext}`;

      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: thumbKey,
          Body: thumbnail.buffer,
          ContentType: `image/${thumbnail.format}`,
          CacheControl: 'public, max-age=31536000',
        })
      );

      thumbnailUrl = `${this.publicUrl}/${thumbKey}`;
    }

    return {
      key,
      url: `${this.publicUrl}/${key}`,
      width: processed.width,
      height: processed.height,
      size: processed.size,
      mimeType: `image/${processed.format}`,
      thumbnailUrl,
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );
  }

  getUrl(key: string): string {
    return `${this.publicUrl}/${key}`;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  private async processImage(file: Buffer, purpose: string): Promise<ProcessedImage> {
    let pipeline = sharp(file);
    const metadata = await pipeline.metadata();

    // Determine max dimensions based on purpose
    let maxWidth = MAX_IMAGE_DIMENSION;
    let maxHeight = MAX_IMAGE_DIMENSION;

    if (purpose === 'avatar') {
      maxWidth = 400;
      maxHeight = 400;
    } else if (purpose === 'banner') {
      maxWidth = 1920;
      maxHeight = 480;
    }

    // Resize if necessary
    if (metadata.width && metadata.height) {
      if (metadata.width > maxWidth || metadata.height > maxHeight) {
        pipeline = pipeline.resize(maxWidth, maxHeight, {
          fit: 'inside',
          withoutEnlargement: true,
        });
      }
    }

    // Convert to WebP for better compression, or keep format for avatars
    let outputFormat: 'webp' | 'png' | 'jpeg' = 'webp';
    if (purpose === 'avatar' && metadata.format === 'png') {
      outputFormat = 'png';
    }

    // Strip EXIF data for privacy
    pipeline = pipeline.rotate();

    const outputBuffer = await pipeline[outputFormat]({ quality: 85 }).toBuffer();
    const outputMetadata = await sharp(outputBuffer).metadata();

    return {
      buffer: outputBuffer,
      width: outputMetadata.width || 0,
      height: outputMetadata.height || 0,
      format: outputFormat,
      size: outputBuffer.length,
    };
  }

  private async generateThumbnail(file: Buffer): Promise<ProcessedImage> {
    const pipeline = sharp(file)
      .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, {
        fit: 'cover',
        position: 'center',
      })
      .webp({ quality: 80 });

    const buffer = await pipeline.toBuffer();
    const metadata = await sharp(buffer).metadata();

    return {
      buffer,
      width: metadata.width || THUMBNAIL_SIZE,
      height: metadata.height || THUMBNAIL_SIZE,
      format: 'webp',
      size: buffer.length,
    };
  }

  private getExtension(format: string): string {
    const extensions: Record<string, string> = {
      webp: '.webp',
      png: '.png',
      jpeg: '.jpg',
      jpg: '.jpg',
    };
    return extensions[format] || '.webp';
  }
}
