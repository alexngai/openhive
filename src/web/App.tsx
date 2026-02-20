import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Layout } from './components/layout/Layout';
import { PageLoader } from './components/common/LoadingSpinner';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { useWebSocket } from './hooks/useWebSocket';
import { useAuthStore } from './stores/auth';

// Lazy load page components for code splitting
const Home = lazy(() => import('./pages/Home').then(m => ({ default: m.Home })));
const Hive = lazy(() => import('./pages/Hive').then(m => ({ default: m.Hive })));
const Post = lazy(() => import('./pages/Post').then(m => ({ default: m.Post })));
const Agent = lazy(() => import('./pages/Agent').then(m => ({ default: m.Agent })));
const Hives = lazy(() => import('./pages/Hives').then(m => ({ default: m.Hives })));
const Agents = lazy(() => import('./pages/Agents').then(m => ({ default: m.Agents })));
const Search = lazy(() => import('./pages/Search').then(m => ({ default: m.Search })));
const About = lazy(() => import('./pages/About').then(m => ({ default: m.About })));
const Login = lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));
const Register = lazy(() => import('./pages/Register').then(m => ({ default: m.Register })));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword').then(m => ({ default: m.ForgotPassword })));
const ResetPassword = lazy(() => import('./pages/ResetPassword').then(m => ({ default: m.ResetPassword })));
const Settings = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })));
const Swarms = lazy(() => import('./pages/Swarms').then(m => ({ default: m.Swarms })));
const SwarmCraft = lazy(() => import('./pages/SwarmCraft').then(m => ({ default: m.SwarmCraft })));

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
            <Route index element={<Home />} />
            <Route path="h/:hiveName" element={<Hive />} />
            <Route path="h/:hiveName/post/:postId" element={<Post />} />
            <Route path="a/:agentName" element={<Agent />} />
            <Route path="hives" element={<Hives />} />
            <Route path="agents" element={<Agents />} />
            <Route path="search" element={<Search />} />
            <Route path="about" element={<About />} />
            <Route path="login" element={<Login />} />
            <Route path="register" element={<Register />} />
            <Route path="forgot-password" element={<ForgotPassword />} />
            <Route path="reset-password/:token" element={<ResetPassword />} />
            <Route path="settings" element={<Settings />} />
            <Route path="swarms" element={<Swarms />} />
            <Route path="swarmcraft" element={<SwarmCraft />} />
          </Route>
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
