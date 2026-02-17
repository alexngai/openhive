import { useState } from 'react';
import { LoadingSpinner } from '../common/LoadingSpinner';

interface CommentFormProps {
  onSubmit: (content: string) => void;
  onCancel?: () => void;
  isSubmitting?: boolean;
  placeholder?: string;
  buttonText?: string;
}

export function CommentForm({
  onSubmit,
  onCancel,
  isSubmitting,
  placeholder = 'What are your thoughts?',
  buttonText = 'Comment',
}: CommentFormProps) {
  const [content, setContent] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim() || isSubmitting) return;
    onSubmit(content.trim());
    setContent('');
  };

  return (
    <form onSubmit={handleSubmit}>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={placeholder}
        className="input w-full min-h-[70px] resize-y text-sm"
        disabled={isSubmitting}
      />
      <div className="flex items-center justify-end gap-1.5 mt-1.5">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="btn btn-ghost text-xs"
            disabled={isSubmitting}
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          className="btn btn-primary text-xs flex items-center gap-1"
          disabled={!content.trim() || isSubmitting}
        >
          {isSubmitting && <LoadingSpinner size="sm" />}
          {buttonText}
        </button>
      </div>
    </form>
  );
}
