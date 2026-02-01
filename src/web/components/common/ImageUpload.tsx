import { useState, useRef, useCallback } from 'react';
import { Upload, X, Image as ImageIcon, Loader2 } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toast';
import clsx from 'clsx';

interface UploadedImage {
  url: string;
  key: string;
  width?: number;
  height?: number;
}

interface ImageUploadProps {
  onUpload: (image: UploadedImage) => void;
  onRemove?: () => void;
  currentImage?: string | null;
  purpose?: 'avatar' | 'banner' | 'post' | 'comment';
  className?: string;
  compact?: boolean;
}

export function ImageUpload({
  onUpload,
  onRemove,
  currentImage,
  purpose = 'post',
  className,
  compact = false,
}: ImageUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(currentImage || null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    // Validate file type
    if (!file.type.startsWith('image/')) {
      toast.error('Invalid file', 'Please select an image file');
      return;
    }

    // Validate file size (5MB max)
    if (file.size > 5 * 1024 * 1024) {
      toast.error('File too large', 'Maximum file size is 5MB');
      return;
    }

    // Create preview
    const reader = new FileReader();
    reader.onloadend = () => {
      setPreview(reader.result as string);
    };
    reader.readAsDataURL(file);

    // Upload
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('purpose', purpose);

      const response = await api.upload<{ data: UploadedImage }>('/uploads', formData);
      onUpload(response.data);
      toast.success('Image uploaded');
    } catch (err) {
      setPreview(currentImage || null);
      toast.error('Upload failed', 'Could not upload the image');
    } finally {
      setIsUploading(false);
    }
  }, [currentImage, onUpload, purpose]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files[0];
    if (file) {
      handleFile(file);
    }
  }, [handleFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFile(file);
    }
  }, [handleFile]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          handleFile(file);
          break;
        }
      }
    }
  }, [handleFile]);

  const handleRemove = useCallback(() => {
    setPreview(null);
    if (inputRef.current) {
      inputRef.current.value = '';
    }
    onRemove?.();
  }, [onRemove]);

  if (preview) {
    return (
      <div className={clsx('relative group', className)}>
        <img
          src={preview}
          alt="Upload preview"
          className={clsx(
            'rounded-lg object-cover',
            compact ? 'w-20 h-20' : 'max-h-64 w-auto'
          )}
        />
        {isUploading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-lg">
            <Loader2 className="w-6 h-6 animate-spin text-white" />
          </div>
        )}
        {!isUploading && (
          <button
            onClick={handleRemove}
            className="absolute top-2 right-2 p-1.5 rounded-full bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/70"
            type="button"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onPaste={handlePaste}
      className={clsx(
        'border-2 border-dashed rounded-lg transition-colors cursor-pointer',
        isDragging
          ? 'border-honey-500 bg-honey-500/10'
          : 'border-[var(--color-border)] hover:border-honey-500/50',
        compact ? 'p-4' : 'p-8',
        className
      )}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          inputRef.current?.click();
        }
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={handleChange}
        className="hidden"
      />
      <div className="flex flex-col items-center gap-2 text-center">
        {isUploading ? (
          <Loader2 className="w-8 h-8 animate-spin text-honey-500" />
        ) : (
          <div className="w-12 h-12 rounded-full bg-[var(--color-elevated)] flex items-center justify-center">
            {compact ? (
              <ImageIcon className="w-5 h-5" style={{ color: 'var(--color-text-secondary)' }} />
            ) : (
              <Upload className="w-6 h-6" style={{ color: 'var(--color-text-secondary)' }} />
            )}
          </div>
        )}
        {!compact && (
          <>
            <p className="font-medium">
              {isDragging ? 'Drop image here' : 'Upload an image'}
            </p>
            <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              Drag and drop, paste, or click to select
            </p>
            <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              PNG, JPG, GIF up to 5MB
            </p>
          </>
        )}
      </div>
    </div>
  );
}
