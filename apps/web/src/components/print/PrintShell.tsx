import { Button, Spinner } from '@legalops/ui';
import { Download, Printer } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Print-ready documents (browser "Save as PDF"). Server-side PDF generation and storage is a later
 * step; this keeps V1 honest and dependency-free.
 */
export function PrintShell({ title, children, ready, wide = false, bare = false, pdfHref }: { title: string; children: ReactNode; ready: boolean; wide?: boolean; /** Draw the children as they are (an already-styled sheet), without the padded article around them. */ bare?: boolean; /** The exact PDF of this document, offered next to Print. */ pdfHref?: string }) {
  if (!ready) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner className="size-6 text-brand-700" />
      </div>
    );
  }
  return (
    <div className="min-h-dvh bg-canvas py-6 print:bg-white print:py-0">
      <div className={`mx-auto mb-4 flex justify-end gap-2 px-4 print:hidden ${bare ? 'max-w-[210mm]' : wide ? 'max-w-6xl' : 'max-w-3xl'}`}>
        {pdfHref ? (
          <a href={pdfHref} download>
            <Button variant="secondary" icon={<Download className="size-4" />}>
              Download PDF
            </Button>
          </a>
        ) : null}
        <Button icon={<Printer className="size-4" />} onClick={() => window.print()}>
          {pdfHref ? 'Print' : 'Print / Save as PDF'}
        </Button>
      </div>
      {bare ? (
        <div aria-label={title} className="shadow-sm print:shadow-none">
          {children}
        </div>
      ) : (
      <article
        aria-label={title}
        className={`mx-auto bg-white px-6 py-8 text-sm text-black shadow-sm sm:px-10 print:max-w-none print:px-0 print:shadow-none ${wide ? 'max-w-6xl' : 'max-w-3xl'}`}
      >
        {children}
      </article>
      )}
    </div>
  );
}
