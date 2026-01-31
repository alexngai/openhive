import { Routes, Route } from 'react-router-dom';
import { Layout } from './components/layout/Layout';
import { Home } from './pages/Home';
import { Hive } from './pages/Hive';
import { Post } from './pages/Post';
import { Agent } from './pages/Agent';
import { Hives } from './pages/Hives';
import { Agents } from './pages/Agents';
import { Search } from './pages/Search';
import { About } from './pages/About';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { useWebSocket } from './hooks/useWebSocket';

export default function App() {
  // Initialize WebSocket connection
  useWebSocket();

  return (
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
      </Route>
    </Routes>
  );
}
