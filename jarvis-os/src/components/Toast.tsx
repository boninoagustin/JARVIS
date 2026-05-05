import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextType {
  toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextType>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, type: ToastType = 'info') => {
    const id = nextId++;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 3500);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const iconMap: Record<ToastType, ReactNode> = {
    success: <CheckCircle size={16} color="#00ff00" />,
    error:   <XCircle size={16} color="#ff3333" />,
    warning: <AlertTriangle size={16} color="#ffaa00" />,
    info:    <Info size={16} color="#0088ff" />,
  };

  const bgMap: Record<ToastType, string> = {
    success: 'rgba(0,255,0,0.08)',
    error:   'rgba(255,51,51,0.08)',
    warning: 'rgba(255,170,0,0.08)',
    info:    'rgba(0,136,255,0.08)',
  };

  const borderMap: Record<ToastType, string> = {
    success: 'rgba(0,255,0,0.3)',
    error:   'rgba(255,51,51,0.3)',
    warning: 'rgba(255,170,0,0.3)',
    info:    'rgba(0,136,255,0.3)',
  };

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}
      <div className="toast-container">
        {toasts.map(t => (
          <div
            key={t.id}
            className="toast-item"
            style={{
              backgroundColor: bgMap[t.type],
              borderColor: borderMap[t.type],
            }}
          >
            <span className="toast-icon">{iconMap[t.type]}</span>
            <span className="toast-message">{t.message}</span>
            <button className="toast-close" onClick={() => removeToast(t.id)}>
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
