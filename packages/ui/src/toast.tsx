import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

const TOAST_MS = 6000;

export type Toast = {
  message: string;
  tone?: "info" | "danger";
  action?: { label: string; run: () => void };
};

const ToastContext = createContext<(toast: Toast) => void>(() => {});

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<(Toast & { id: number }) | null>(null);
  const show = useCallback((toast: Toast) => {
    setCurrent((previous) => ({ ...toast, id: (previous?.id ?? 0) + 1 }));
  }, []);
  const id = current?.id;
  useEffect(() => {
    if (id === undefined) return;
    const timer = setTimeout(() => setCurrent(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [id]);
  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role={current?.tone === "danger" ? "alert" : "status"}
        className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-4"
      >
        {current && (
          <div className="pointer-events-auto flex items-center gap-4 rounded bg-text px-4 py-2.5 text-sm text-page shadow-lg">
            <span>{current.message}</span>
            {current.action && (
              <button
                type="button"
                className="cursor-pointer font-semibold underline outline-page focus-visible:outline-2"
                onClick={() => {
                  current.action?.run();
                  setCurrent(null);
                }}
              >
                {current.action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}
