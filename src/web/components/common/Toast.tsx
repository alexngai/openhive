import { useEffect, useState } from 'react';
import { X, CheckCircle, XCircle, Info, AlertTriangle } from 'lucide-react';
import { useToastStore, Toast as ToastType, ToastType as ToastVariant } from '../../stores/toast';
import clsx from 'clsx';

const icons: Record<ToastVariant, React.ElementType> = {
  success: CheckCircle,
  error: XCircle,
  info: Info,
  warning: AlertTriangle,
};

const styles: Record<ToastVariant, string> = {
  success: 'bg-green-500/10 border-green-500/30 text-green-400',
  error: 'bg-red-500/10 border-red-500/30 text-red-400',
  info: 'bg-blue-500/10 border-blue-500/30 text-blue-400',
  warning: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400',
};

function ToastItem({ toast }: { toast: ToastType }) {
  const [isExiting, setIsExiting] = useState(false);
  const { removeToast } = useToastStore();
  const Icon = icons[toast.type];

  const handleClose = () => {
    setIsExiting(true);
    setTimeout(() => removeToast(toast.id), 200);
  };

  return (
    <div
      className={clsx(
        'flex items-start gap-3 p-4 rounded-lg border shadow-lg backdrop-blur-sm',
        'transform transition-all duration-200',
        isExiting ? 'opacity-0 translate-x-4' : 'opacity-100 translate-x-0',
        styles[toast.type]
      )}
      role="alert"
    >
      <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="font-medium">{toast.title}</p>
        {toast.message && (
          <p className="text-sm mt-1 opacity-90">{toast.message}</p>
        )}
      </div>
      <button
        onClick={handleClose}
        className="flex-shrink-0 p-1 rounded hover:bg-white/10 transition-colors"
        aria-label="Dismiss"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const { toasts } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
