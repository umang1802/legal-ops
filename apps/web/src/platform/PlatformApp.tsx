import { Spinner } from '@legalops/ui';
import { Suspense } from 'react';
import { Route, Routes, Navigate } from 'react-router';
import { AuditLogPage } from './AuditLogPage.js';
import { FirmDetailPage } from './FirmDetailPage.js';
import { FirmsPage } from './FirmsPage.js';
import { PlatformLoginPage } from './PlatformLoginPage.js';
import { PlatformShell } from './PlatformShell.js';

/** The whole console in one lazy chunk, mounted at /platform/*. */
export function PlatformApp() {
  return (
    <Suspense fallback={<Spinner className="size-8" />}>
      <Routes>
        <Route path="login" element={<PlatformLoginPage />} />
        <Route element={<PlatformShell />}>
          <Route index element={<Navigate to="firms" replace />} />
          <Route path="firms" element={<FirmsPage />} />
          <Route path="firms/:firmId" element={<FirmDetailPage />} />
          <Route path="audit" element={<AuditLogPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
