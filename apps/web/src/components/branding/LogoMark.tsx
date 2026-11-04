/** The LexForgeX hallmark: a gold V over a bone Λ on deep teal. Same artwork as public/icon.svg. */
export function LogoMark({ className = 'size-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" className={className} aria-hidden>
      <rect width="1024" height="1024" rx="225" fill="#0e2a3d" />
      <path fill="#e0a15a" d="M278 230h122l112 182 112-182h122L585 493H439z" />
      <path fill="#efe9dc" d="M439 530h146l161 263H624L512 610 400 793H278z" />
    </svg>
  );
}

/** Mark plus wordmark. `size` is the mark's Tailwind size class; the name is set in wide-tracked capitals. */
export function Logo({
  markClassName = 'size-8',
  textClassName = 'text-base',
}: {
  markClassName?: string;
  textClassName?: string;
}) {
  return (
    <span className="inline-flex items-center gap-3">
      <LogoMark className={markClassName} />
      <span className={`font-medium tracking-[0.22em] uppercase ${textClassName}`}>LexForgeX</span>
    </span>
  );
}
