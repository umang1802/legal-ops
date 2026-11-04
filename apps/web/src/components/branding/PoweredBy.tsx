import { LogoMark } from './LogoMark.js';

/** "Powered by LexForgeX" line for the app and client-facing printouts. */
export function PoweredBy({ className = '' }: { className?: string }) {
  return (
    <p className={`flex items-center gap-1.5 text-xs text-muted ${className}`}>
      <LogoMark className="size-4" />
      Powered by LexForgeX
    </p>
  );
}
