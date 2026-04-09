import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/layout/Layout';
import { PageLoader } from './components/common/LoadingSpinner';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { ProtectedRoute } from './components/common/ProtectedRoute';
import { useWebSocket } from './hooks/useWebSocket';
import { useAuthStore } from './stores/auth';

// Lazy load page components for code splitting
const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const Agent = lazy(() => import('./pages/Agent').then(m => ({ default: m.Agent })));
const Agents = lazy(() => import('./pages/Agents').then(m => ({ default: m.Agents })));
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
const Memory = lazy(() => import('./pages/Memory').then(m => ({ default: m.Memory })));
const MemoryDetail = lazy(() => import('./pages/MemoryDetail').then(m => ({ default: m.MemoryDetail })));
const Skills = lazy(() => import('./pages/Skills').then(m => ({ default: m.Skills })));
const SkillDetail = lazy(() => import('./pages/SkillDetail').then(m => ({ default: m.SkillDetail })));
const Messages = lazy(() => import('./pages/Messages').then(m => ({ default: m.Messages })));
const Conversation = lazy(() => import('./pages/Conversation').then(m => ({ default: m.Conversation })));
const Learning = lazy(() => import('./pages/Learning').then(m => ({ default: m.Learning })));
const LearningPlaybookDetail = lazy(() => import('./pages/LearningPlaybookDetail').then(m => ({ default: m.LearningPlaybookDetail })));

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
              <Route path="a/:agentName" element={<Agent />} />
              <Route path="agents" element={<Agents />} />
              <Route path="search" element={<Search />} />
              <Route path="about" element={<About />} />
              <Route path="settings" element={<Settings />} />
              <Route path="swarms" element={<Swarms />} />
              <Route path="swarms/:id" element={<SwarmDetail />} />
              <Route path="sessions" element={<Sessions />} />
              <Route path="sessions/:id" element={<Sessions />} />
              <Route path="events" element={<Events />} />
              <Route path="terminal/:swarmId" element={<Terminal />} />
              <Route path="messages" element={<Messages />} />
              <Route path="messages/:id" element={<Conversation />} />
              <Route path="memory" element={<Memory />} />
              <Route path="memory/:resourceId" element={<MemoryDetail />} />
              <Route path="skills" element={<Skills />} />
              <Route path="skills/:resourceId" element={<SkillDetail />} />
              <Route path="learning" element={<Learning />} />
              <Route path="learning/playbooks/:id" element={<LearningPlaybookDetail />} />
              <Route path="tasks" element={<TaskGraph />} />
              <Route path="tasks/list" element={<TasksList />} />

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
