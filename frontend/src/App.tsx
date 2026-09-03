import { Navigate, Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from './routes/ProtectedRoute';
import { AdminLayout } from './components/Layout';
import { DistributionDraftProvider } from './admin/DistributionDraftContext';
import { AdminLoginPage } from './admin/AdminLoginPage';
import { EventsPage } from './admin/EventsPage';
import { EditEventPage } from './admin/EditEventPage';
import { TicketTypesPage } from './admin/TicketTypesPage';
import { EditTicketTypePage } from './admin/EditTicketTypePage';
import { MergeTicketTypesPage } from './admin/MergeTicketTypesPage';
import { ImportEmailListPage } from './admin/ImportEmailListPage';
import { SelectEventStep } from './admin/SelectEventStep';
import { SelectTicketTypeStep } from './admin/SelectTicketTypeStep';
import { ConfirmDistributionStep } from './admin/ConfirmDistributionStep';
import { DistributionsListPage } from './admin/DistributionsListPage';
import { DistributionDetailPage } from './admin/DistributionDetailPage';
import { AnalyticsDashboardPage } from './admin/AnalyticsDashboardPage';
import { AttendanceStatsPage } from './admin/AttendanceStatsPage';
import { CheckInPage } from './admin/CheckInPage';
import { AppDownloadPage } from './claim/AppDownloadPage';
import { MyTicketsPage } from './portal/MyTicketsPage';
import { TicketDetailPage } from './portal/TicketDetailPage';
import { UserLoginPage } from './portal/UserLoginPage';
import { UserSignupPage } from './portal/UserSignupPage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/admin/login" replace />} />

      <Route path="/admin/login" element={<AdminLoginPage />} />

      {/* Portal end-user — đăng nhập / tạo tài khoản */}
      <Route path="/portal/login" element={<UserLoginPage />} />
      <Route path="/portal/signup" element={<UserSignupPage />} />

      {/* Universal link nhận vé — app đã cài tự mở & claim; chưa cài về trang tải app. */}
      <Route path="/c/:token" element={<AppDownloadPage />} />
      <Route path="/claim/:token" element={<AppDownloadPage />} />

      {/* Portal: xem vé của tôi (yêu cầu đăng nhập user) */}
      <Route element={<ProtectedRoute loginPath="/portal/login" />}>
        <Route path="/portal/tickets" element={<MyTicketsPage />} />
        <Route path="/portal/tickets/:id" element={<TicketDetailPage />} />
      </Route>

      <Route element={<ProtectedRoute admin />}>
        <Route
          element={
            <DistributionDraftProvider>
              <AdminLayout />
            </DistributionDraftProvider>
          }
        >
          <Route path="/admin/distribute/event" element={<SelectEventStep />} />
          <Route path="/admin/distribute/emails" element={<ImportEmailListPage />} />
          <Route path="/admin/distribute/type" element={<SelectTicketTypeStep />} />
          <Route path="/admin/distribute/confirm" element={<ConfirmDistributionStep />} />
          <Route path="/admin/events" element={<EventsPage />} />
          {/* EVENT-EDIT: sửa sự kiện (name/venue/thời gian/maxParticipants). */}
          <Route path="/admin/events/:id/edit" element={<EditEventPage />} />
          <Route path="/admin/ticket-types" element={<TicketTypesPage />} />
          <Route path="/admin/ticket-types/:id/edit" element={<EditTicketTypePage />} />
          {/* TICKET-MERGE: "Gộp loại vé" — dry-run + apply MERGE + rollback ROLLBACK. */}
          <Route path="/admin/merge-ticket-types" element={<MergeTicketTypesPage />} />
          <Route path="/admin/distributions" element={<DistributionsListPage />} />
          <Route path="/admin/distributions/:jobId" element={<DistributionDetailPage />} />
          <Route path="/admin/stats" element={<AnalyticsDashboardPage />} />
          <Route path="/admin/attendance" element={<AttendanceStatsPage />} />
          <Route path="/admin/check-in" element={<CheckInPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/admin/login" replace />} />
    </Routes>
  );
}
