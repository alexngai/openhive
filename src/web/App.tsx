import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate, useParams } from 'react-router-dom';
import { Layout } from './components/layout/Layout';
import { PageLoader } from './components/common/LoadingSpinner';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { ProtectedRoute } from './components/common/ProtectedRoute';
import { useWebSocket } from './hooks/useWebSocket';
import { useElectronDeepLinks } from './hooks/useElectronDeepLinks';
import { useAuthStore } from './stores/auth';
import { useHubsStore } from './stores/hubs';

function SessionIdRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/threads/${id ?? ''}`} replace />;
}

function MailIdRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/threads/mail/${id ?? ''}`} replace />;
}

function DispatchIdRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/dispatch/${id ?? ''}`} replace />;
}

// Lazy load page components for code splitting
const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })));
const About = lazy(() => import('./pages/About').then(m => ({ default: m.About })));
const Login = lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));
const AuthCallback = lazy(() => import('./pages/AuthCallback').then(m => ({ default: m.AuthCallback })));
const Settings = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })));
const Onboarding = lazy(() => import('./pages/Onboarding'));
const Swarms = lazy(() => import('./pages/Swarms').then(m => ({ default: m.Swarms })));
const SwarmDetail = lazy(() => import('./pages/SwarmDetail').then(m => ({ default: m.SwarmDetail })));
const Terminal = lazy(() => import('./pages/Terminal').then(m => ({ default: m.Terminal })));
const Sessions = lazy(() => import('./pages/Sessions').then(m => ({ default: m.Sessions })));
const Events = lazy(() => import('./pages/Events').then(m => ({ default: m.Events })));
const TeamEditor = lazy(() => import('./pages/TeamEditor'));
const Teams = lazy(() => import('./pages/Teams'));
const TeamDetail = lazy(() => import('./pages/TeamDetail'));
const LoadoutEditor = lazy(() => import('./pages/LoadoutEditor'));
const TasksList = lazy(() => import('./pages/Tasks').then(m => ({ default: m.TaskGraphList })));
const TaskGraph = lazy(() => import('./pages/TaskGraph').then(m => ({ default: m.TaskGraph })));
const TaskDetail = lazy(() => import('./pages/TaskDetail').then(m => ({ default: m.TaskDetail })));
const Specs = lazy(() => import('./pages/Specs').then(m => ({ default: m.Specs })));
const SpecNew = lazy(() => import('./pages/SpecNew').then(m => ({ default: m.SpecNew })));
const SpecDetail = lazy(() => import('./pages/SpecDetail').then(m => ({ default: m.SpecDetail })));
const Dispatch = lazy(() => import('./pages/Dispatch').then(m => ({ default: m.Dispatch })));
const DispatchDetail = lazy(() => import('./pages/DispatchDetail').then(m => ({ default: m.DispatchDetail })));
const Schedules = lazy(() => import('./pages/Schedules').then(m => ({ default: m.Schedules })));
const ScheduleDetail = lazy(() => import('./pages/ScheduleDetail').then(m => ({ default: m.ScheduleDetail })));
const Experiments = lazy(() => import('./pages/Experiments').then(m => ({ default: m.Experiments })));
const ExperimentDetail = lazy(() => import('./pages/ExperimentDetail').then(m => ({ default: m.ExperimentDetail })));
const ExperimentRunDetail = lazy(() => import('./pages/ExperimentRunDetail').then(m => ({ default: m.ExperimentRunDetail })));
const Memory = lazy(() => import('./pages/Memory').then(m => ({ default: m.Memory })));
const MemoryDetail = lazy(() => import('./pages/MemoryDetail').then(m => ({ default: m.MemoryDetail })));
const Skills = lazy(() => import('./pages/Skills').then(m => ({ default: m.Skills })));
const SkillDetail = lazy(() => import('./pages/SkillDetail').then(m => ({ default: m.SkillDetail })));
const Repos = lazy(() => import('./pages/Repos').then(m => ({ default: m.Repos })));
const RepoDetail = lazy(() => import('./pages/RepoDetail').then(m => ({ default: m.RepoDetail })));
const Learning = lazy(() => import('./pages/Learning').then(m => ({ default: m.Learning })));
const LearningPlaybookDetail = lazy(() => import('./pages/LearningPlaybookDetail').then(m => ({ default: m.LearningPlaybookDetail })));
const Changes = lazy(() => import('./pages/Changes').then(m => ({ default: m.Changes })));

export default function App() {
  // Initialize WebSocket connection
  useWebSocket();

  // Electron deep links (`openhive://…`) → react-router. No-op in browsers.
  useElectronDeepLinks();

  // Check auth mode on startup (local mode auto-authenticates)
  const checkAuthMode = useAuthStore((s) => s.checkAuthMode);
  useEffect(() => {
    checkAuthMode();
  }, [checkAuthMode]);

  // Multi-hub (A2): once auth is ready, ensure a same-origin "this hub"
  // connection exists and keep the active connection's cached credential in
  // sync with the live session. On boot this reconciles the switcher to
  // whatever lib/hub.ts (persisted origin) is actually pointed at.
  useEffect(() => {
    const apply = (s = useAuthStore.getState()) => {
      if (!s.isReady) return;
      const hubs = useHubsStore.getState();
      hubs.ensureSeed({ token: s.token, agent: s.agent, authMode: s.authMode });
      hubs.syncActiveFromAuth({ token: s.token, agent: s.agent, authMode: s.authMode });
    };
    apply();
    return useAuthStore.subscribe(apply);
  }, []);

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
              <Route path="about" element={<About />} />
              <Route path="settings" element={<Settings />} />
              <Route path="onboarding" element={<Onboarding />} />
              <Route path="swarms" element={<Swarms />} />
              <Route path="swarms/:id" element={<SwarmDetail />} />
              <Route path="threads" element={<Sessions />} />
              <Route path="threads/:id" element={<Sessions />} />
              <Route path="threads/mail/:mailId" element={<Sessions />} />
              {/* Programmatic-mode hosted swarms (codex-rpc today) live on
                  the Threads page like sessions/mail. Sessions reads
                  `hostedId` from params and renders <HostedChat /> in the
                  detail pane — same chrome as SessionDetail/MailThreadView. */}
              <Route path="threads/hosted-chat/:hostedId" element={<Sessions />} />
              {/* TUI-kind hosted swarms (claude-code, codex-tui) — the detail
                  pane renders an embedded terminal attached to the live PTY. */}
              <Route path="threads/hosted-tui/:hostedId" element={<Sessions />} />
              <Route path="events" element={<Events />} />
              <Route path="terminal/:swarmId" element={<Terminal />} />
              <Route path="teams" element={<Teams />} />
              <Route path="teams/:id" element={<TeamDetail />} />
              <Route path="teams/:id/editor" element={<TeamEditor />} />
              {/* Loadouts list lives under the consolidated Teams page tabs. */}
              <Route path="loadouts" element={<Navigate to="/teams?tab=loadouts" replace />} />
              <Route path="loadouts/:id/editor" element={<LoadoutEditor />} />
              {/* Redirects from legacy routes */}
              <Route path="sessions" element={<Navigate to="/threads" replace />} />
              <Route path="sessions/:id" element={<SessionIdRedirect />} />
              <Route path="messages" element={<Navigate to="/threads" replace />} />
              <Route path="messages/:id" element={<MailIdRedirect />} />
              <Route path="memory" element={<Memory />} />
              <Route path="memory/:resourceId" element={<MemoryDetail />} />
              <Route path="skills" element={<Skills />} />
              <Route path="skills/:resourceId" element={<SkillDetail />} />
              <Route path="repos" element={<Repos />} />
              <Route path="repos/:id" element={<RepoDetail />} />
              <Route path="learning" element={<Learning />} />
              <Route path="learning/playbooks/:id" element={<LearningPlaybookDetail />} />
              <Route path="changes" element={<Changes />} />
              <Route path="streams" element={<Navigate to="/changes" replace />} />
              <Route path="tasks" element={<TaskGraph />} />
              <Route path="tasks/list" element={<TasksList />} />
              <Route path="tasks/:resourceId/:nodeId" element={<TaskDetail />} />
              <Route path="specs" element={<Specs />} />
              <Route path="specs/new" element={<SpecNew />} />
              <Route path="specs/:resourceId/:specId" element={<SpecDetail />} />
              <Route path="dispatch" element={<Dispatch />} />
              <Route path="dispatch/:id" element={<DispatchDetail />} />
              <Route path="schedules" element={<Schedules />} />
              <Route path="schedules/:id" element={<ScheduleDetail />} />
              <Route path="experiments" element={<Experiments />} />
              <Route path="experiments/:id" element={<ExperimentDetail />} />
              <Route path="experiments/:id/runs/:runId" element={<ExperimentRunDetail />} />
              {/* Redirect legacy /dispatches URLs */}
              <Route path="dispatches" element={<Navigate to="/dispatch" replace />} />
              <Route path="dispatches/:id" element={<DispatchIdRedirect />} />

              {/* Redirects for removed routes */}
              <Route path="resources" element={<Navigate to="/memory" replace />} />
              <Route path="swarmcraft" element={<Navigate to="/" replace />} />
              {/* Agents concept was removed — operational agent context
                  lives on SwarmDetail's Registered Agents section. */}
              <Route path="agents" element={<Navigate to="/swarms" replace />} />
              <Route path="a/:agentName" element={<Navigate to="/swarms" replace />} />
              {/* Catch-all: anything else falls back to the dashboard so users
                  never land on an empty frame. */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Route>
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
