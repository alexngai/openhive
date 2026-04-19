import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate, useParams } from 'react-router-dom';
import { Layout } from './components/layout/Layout';
import { PageLoader } from './components/common/LoadingSpinner';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { ProtectedRoute } from './components/common/ProtectedRoute';
import { useWebSocket } from './hooks/useWebSocket';
import { useAuthStore } from './stores/auth';

function SessionIdRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/threads/${id ?? ''}`} replace />;
}

function MailIdRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/threads/mail/${id ?? ''}`} replace />;
}

// Lazy load page components for code splitting
const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const Search = lazy(() => import('./pages/Search').then(m => ({ default: m.Search })));
const About = lazy(() => import('./pages/About').then(m => ({ default: m.About })));
const Login = lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));
const AuthCallback = lazy(() => import('./pages/AuthCallback').then(m => ({ default: m.AuthCallback })));
const Settings = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })));
const Swarms = lazy(() => import('./pages/Swarms').then(m => ({ default: m.Swarms })));
const SwarmDetail = lazy(() => import('./pages/SwarmDetail').then(m => ({ default: m.SwarmDetail })));
const Terminal = lazy(() => import('./pages/Terminal').then(m => ({ default: m.Terminal })));
const Sessions = lazy(() => import('./pages/Sessions').then(m => ({ default: m.Sessions })));
const Events = lazy(() => import('./pages/Events').then(m => ({ default: m.Events })));
const TasksList = lazy(() => import('./pages/Tasks').then(m => ({ default: m.TaskGraphList })));
const TaskGraph = lazy(() => import('./pages/TaskGraph').then(m => ({ default: m.TaskGraph })));
const TaskDetail = lazy(() => import('./pages/TaskDetail').then(m => ({ default: m.TaskDetail })));
const Specs = lazy(() => import('./pages/Specs').then(m => ({ default: m.Specs })));
const SpecNew = lazy(() => import('./pages/SpecNew').then(m => ({ default: m.SpecNew })));
const SpecDetail = lazy(() => import('./pages/SpecDetail').then(m => ({ default: m.SpecDetail })));
const Dispatches = lazy(() => import('./pages/Dispatches').then(m => ({ default: m.Dispatches })));
const DispatchDetail = lazy(() => import('./pages/DispatchDetail').then(m => ({ default: m.DispatchDetail })));
const Memory = lazy(() => import('./pages/Memory').then(m => ({ default: m.Memory })));
const MemoryDetail = lazy(() => import('./pages/MemoryDetail').then(m => ({ default: m.MemoryDetail })));
const Skills = lazy(() => import('./pages/Skills').then(m => ({ default: m.Skills })));
const SkillDetail = lazy(() => import('./pages/SkillDetail').then(m => ({ default: m.SkillDetail })));
const Learning = lazy(() => import('./pages/Learning').then(m => ({ default: m.Learning })));
const LearningPlaybookDetail = lazy(() => import('./pages/LearningPlaybookDetail').then(m => ({ default: m.LearningPlaybookDetail })));
const Streams = lazy(() => import('./pages/Streams').then(m => ({ default: m.Streams })));

export default function App() {
  // Initialize WebSocket connection
  useWebSocket();

  // Check auth mode on startup (local mode auto-authenticates)
  const checkAuthMode = useAuthStore((s) => s.checkAuthMode);
  useEffect(() => {
    checkAuthMode();
  }, [checkAuthMode]);

  return (
    <ErrorBoundary>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/" element={<Layout />}>
            {/* Public routes */}
            <Route path="login" element={<Login />} />
            <Route path="auth/callback" element={<AuthCallback />} />

            {/* Protected routes */}
            <Route element={<ProtectedRoute />}>
              <Route index element={<Dashboard />} />
              <Route path="search" element={<Search />} />
              <Route path="about" element={<About />} />
              <Route path="settings" element={<Settings />} />
              <Route path="swarms" element={<Swarms />} />
              <Route path="swarms/:id" element={<SwarmDetail />} />
              <Route path="threads" element={<Sessions />} />
              <Route path="threads/:id" element={<Sessions />} />
              <Route path="threads/mail/:mailId" element={<Sessions />} />
              <Route path="events" element={<Events />} />
              <Route path="terminal/:swarmId" element={<Terminal />} />
              {/* Redirects from legacy routes */}
              <Route path="sessions" element={<Navigate to="/threads" replace />} />
              <Route path="sessions/:id" element={<SessionIdRedirect />} />
              <Route path="messages" element={<Navigate to="/threads" replace />} />
              <Route path="messages/:id" element={<MailIdRedirect />} />
              <Route path="memory" element={<Memory />} />
              <Route path="memory/:resourceId" element={<MemoryDetail />} />
              <Route path="skills" element={<Skills />} />
              <Route path="skills/:resourceId" element={<SkillDetail />} />
              <Route path="learning" element={<Learning />} />
              <Route path="learning/playbooks/:id" element={<LearningPlaybookDetail />} />
              <Route path="streams" element={<Streams />} />
              <Route path="tasks" element={<TaskGraph />} />
              <Route path="tasks/list" element={<TasksList />} />
              <Route path="tasks/:resourceId/:nodeId" element={<TaskDetail />} />
              <Route path="specs" element={<Specs />} />
              <Route path="specs/new" element={<SpecNew />} />
              <Route path="specs/:resourceId/:specId" element={<SpecDetail />} />
              <Route path="dispatches" element={<Dispatches />} />
              <Route path="dispatches/:id" element={<DispatchDetail />} />

              {/* Redirects for removed routes */}
              <Route path="resources" element={<Navigate to="/memory" replace />} />
              <Route path="swarmcraft" element={<Navigate to="/" replace />} />
            </Route>
          </Route>
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
