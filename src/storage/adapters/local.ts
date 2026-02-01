import * as fs from 'fs';
import * as path from 'path';
import { nanoid } from 'nanoid';
import sharp from 'sharp';
import type {
  StorageAdapter,
  UploadOptions,
  UploadResult,
  LocalStorageConfig,
  ProcessedImage,
} from '../types.js';

const MAX_IMAGE_DIMENSION = 2000;
const THUMBNAIL_SIZE = 300;

export class LocalStorageAdapter implements StorageAdapter {
  private basePath: string;
  private publicUrl: string;

  constructor(config: LocalStorageConfig) {
    this.basePath = path.resolve(config.path);
    this.publicUrl = config.publicUrl.replace(/\/$/, '');
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    const dirs = ['avatars', 'banners', 'posts', 'comments', 'thumbnails'];
    for (const dir of dirs) {
      const fullPath = path.join(this.basePath, dir);
      if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
      }
    }
  }

  async upload(file: Buffer, options: UploadOptions): Promise<UploadResult> {
    const { purpose, agentId } = options;

    // Process the image
    const processed = await this.processImage(file, purpose);

    // Generate unique key
    const ext = this.getExtension(processed.format);
    const key = `${purpose}s/${agentId}_${nanoid(10)}${ext}`;
    const filePath = path.join(this.basePath, key);

    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write main file
    fs.writeFileSync(filePath, processed.buffer);

    // Generate thumbnail for posts and comments
    let thumbnailUrl: string | undefined;
    if (purpose === 'post' || purpose === 'comment') {
      const thumbnail = await this.generateThumbnail(file);
      const thumbKey = `thumbnails/${agentId}_${nanoid(10)}${ext}`;
      const thumbPath = path.join(this.basePath, thumbKey);
      fs.writeFileSync(thumbPath, thumbnail.buffer);
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
    const filePath = path.join(this.basePath, key);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  getUrl(key: string): string {
    return `${this.publicUrl}/${key}`;
  }

  async exists(key: string): Promise<boolean> {
    const filePath = path.join(this.basePath, key);
    return fs.existsSync(filePath);
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
      outputFormat = 'png'; // Keep PNG for avatars with transparency
    }

    // Strip EXIF data for privacy
    pipeline = pipeline.rotate(); // Auto-rotate based on EXIF then strip

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
