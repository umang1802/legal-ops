import { lazy } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { AppShell } from './components/layout/AppShell.js';
import { RedirectIfAuthed, RequireAuth, RequirePermission } from './components/layout/guards.js';
import { AcceptInvitePage } from './features/auth/AcceptInvitePage.js';
import { ForgotPasswordPage } from './features/auth/ForgotPasswordPage.js';
import { LoginPage } from './features/auth/LoginPage.js';
import { ResetPasswordPage } from './features/auth/ResetPasswordPage.js';
import { VerifyEmailPage } from './features/auth/VerifyEmailPage.js';
import { NotFound } from './features/common/NotFound.js';
import { CaseDetailPage } from './features/cases/CaseDetailPage.js';
import { ClientDetailPage } from './features/clients/ClientDetailPage.js';
import { ClientsPage } from './features/clients/ClientsPage.js';
import { DashboardPage } from './features/dashboard/DashboardPage.js';
import { HearingDetailPage } from './features/hearings/HearingDetailPage.js';
import { MatterDetailPage } from './features/matters/MatterDetailPage.js';
import { MattersPage } from './features/matters/MattersPage.js';
import { NewMatterPage } from './features/matters/NewMatterPage.js';
import { SearchPage } from './features/search/SearchPage.js';
import { TaskDetailPage } from './features/tasks/TaskDetailPage.js';
import { TasksPage } from './features/tasks/TasksPage.js';
import { MorePage } from './features/more/MorePage.js';
import { FirmSettingsPage } from './features/settings/FirmSettingsPage.js';
import { MembersPage } from './features/settings/MembersPage.js';

// Route-level code splitting: billing, print views and the calendar load on first visit.
const BillingPage = lazy(() =>
  import('./features/billing/BillingPage.js').then((m) => ({ default: m.BillingPage })),
);
const CollectionsPage = lazy(() =>
  import('./features/billing/CollectionsPage.js').then((m) => ({ default: m.CollectionsPage })),
);
const InvoiceDetailPage = lazy(() =>
  import('./features/billing/InvoiceDetailPage.js').then((m) => ({ default: m.InvoiceDetailPage })),
);
const InvoiceEditorPage = lazy(() =>
  import('./features/billing/InvoiceEditorPage.js').then((m) => ({ default: m.InvoiceEditorPage })),
);
const InvoicesPage = lazy(() =>
  import('./features/billing/InvoicesPage.js').then((m) => ({ default: m.InvoicesPage })),
);
const PaymentDetailPage = lazy(() =>
  import('./features/billing/PaymentDetailPage.js').then((m) => ({ default: m.PaymentDetailPage })),
);
const PaymentsPage = lazy(() =>
  import('./features/billing/PaymentsPage.js').then((m) => ({ default: m.PaymentsPage })),
);
const CalendarPage = lazy(() =>
  import('./features/calendar/CalendarPage.js').then((m) => ({ default: m.CalendarPage })),
);
const CommunicationPage = lazy(() =>
  import('./features/communication/CommunicationPage.js').then((m) => ({ default: m.CommunicationPage })),
);
const AutomationsPage = lazy(() =>
  import('./features/automations/AutomationsPage.js').then((m) => ({ default: m.AutomationsPage })),
);
const InvoicePrintPage = lazy(() =>
  import('./features/billing/PrintPages.js').then((m) => ({ default: m.InvoicePrintPage })),
);
const ReceiptPrintPage = lazy(() =>
  import('./features/billing/PrintPages.js').then((m) => ({ default: m.ReceiptPrintPage })),
);

const router = createBrowserRouter([
  {
    element: <RedirectIfAuthed />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
    ],
  },
  // Token links work whether or not someone is signed in on this device.
  { path: '/reset-password', element: <ResetPasswordPage /> },
  { path: '/accept-invite', element: <AcceptInvitePage /> },
  { path: '/verify-email', element: <VerifyEmailPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        path: '/invoices/:invoiceId/print',
        element: (
          <RequirePermission permission="billing.view">
            <InvoicePrintPage />
          </RequirePermission>
        ),
      },
      {
        path: '/payments/:paymentId/receipt',
        element: (
          <RequirePermission permission="billing.view">
            <ReceiptPrintPage />
          </RequirePermission>
        ),
      },
      {
        element: <AppShell />,
        children: [
          { path: '/', element: <DashboardPage /> },
          { path: '/cases', element: <MattersPage /> },
          { path: '/cases/:caseId', element: <CaseDetailPage /> },
          {
            path: '/matters/new',
            element: (
              <RequirePermission permission="matters.create">
                <NewMatterPage />
              </RequirePermission>
            ),
          },
          { path: '/matters/:matterId', element: <MatterDetailPage /> },
          { path: '/search', element: <SearchPage /> },
          { path: '/calendar', element: <CalendarPage /> },
          { path: '/hearings/:hearingId', element: <HearingDetailPage /> },
          { path: '/tasks', element: <TasksPage /> },
          { path: '/tasks/:taskId', element: <TaskDetailPage /> },
          {
            path: '/clients',
            element: (
              <RequirePermission permission="clients.view">
                <ClientsPage />
              </RequirePermission>
            ),
          },
          {
            path: '/clients/:clientId',
            element: (
              <RequirePermission permission="clients.view">
                <ClientDetailPage />
              </RequirePermission>
            ),
          },
          ...(
            [
              ['/billing', <BillingPage />],
              ['/billing/invoices', <InvoicesPage />],
              ['/billing/payments', <PaymentsPage />],
              ['/billing/collections', <CollectionsPage />],
              ['/invoices/:invoiceId', <InvoiceDetailPage />],
              ['/payments/:paymentId', <PaymentDetailPage />],
            ] as const
          ).map(([path, el]) => ({
            path,
            element: <RequirePermission permission="billing.view">{el}</RequirePermission>,
          })),
          {
            path: '/invoices/new',
            element: (
              <RequirePermission permission="invoices.manage">
                <InvoiceEditorPage />
              </RequirePermission>
            ),
          },
          {
            path: '/invoices/:invoiceId/edit',
            element: (
              <RequirePermission permission="invoices.manage">
                <InvoiceEditorPage />
              </RequirePermission>
            ),
          },
          {
            path: '/settings/firm',
            element: (
              <RequirePermission permission="organization.manage">
                <FirmSettingsPage />
              </RequirePermission>
            ),
          },
          { path: '/settings/members', element: <MembersPage /> },
          {
            path: '/communication',
            element: (
              <RequirePermission permission="matters.view">
                <CommunicationPage />
              </RequirePermission>
            ),
          },
          {
            path: '/settings/automations',
            element: (
              <RequirePermission permission="workflows.manage">
                <AutomationsPage />
              </RequirePermission>
            ),
          },
          { path: '/more', element: <MorePage /> },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
