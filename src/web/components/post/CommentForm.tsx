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
        className="input w-full min-h-[100px] resize-y"
        disabled={isSubmitting}
      />
      <div className="flex items-center justify-end gap-2 mt-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="btn btn-ghost text-sm"
            disabled={isSubmitting}
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          className="btn btn-primary text-sm flex items-center gap-2"
          disabled={!content.trim() || isSubmitting}
        >
          {isSubmitting && <LoadingSpinner size="sm" />}
          {buttonText}
        </button>
      </div>
    </form>
  );
}
