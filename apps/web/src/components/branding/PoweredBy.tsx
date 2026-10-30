import { Scale } from 'lucide-react';

/** "Powered by LexForgeX" line for the app and client-facing printouts. */
export function PoweredBy({ className = '' }: { className?: string }) {
  return (
    <p className={`flex items-center gap-1.5 text-xs text-muted ${className}`}>
      <Scale className="size-3.5" aria-hidden />
      Powered by LexForgeX
    </p>
  );
}
