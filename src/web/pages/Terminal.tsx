import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import { PageLoader } from '../components/common/LoadingSpinner';
import { TerminalPanel } from '../components/terminal/TerminalPanel';
import type { HostedSwarm } from '../lib/api';

export function Terminal() {
  const { swarmId } = useParams<{ swarmId: string }>();
  const navigate = useNavigate();
  const [swarm, setSwarm] = useState<HostedSwarm | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!swarmId) {
      setError('No swarm ID provided');
      setLoading(false);
      return;
    }

    api.get<HostedSwarm>(`/map/hosted/${swarmId}`)
      .then((data) => {
        if (data.state !== 'running') {
          setError(`Swarm is ${data.state} — terminal requires a running swarm.`);
        }
        setSwarm(data);
      })
      .catch((err) => {
        setError((err as Error).message || 'Swarm not found');
      })
      .finally(() => setLoading(false));
  }, [swarmId]);

  if (loading) return <PageLoader />;

  if (error || !swarm) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="card p-6 max-w-md text-center">
          <AlertTriangle className="w-8 h-8 mx-auto mb-3 text-amber-400" />
          <p className="text-sm mb-3" style={{ color: 'var(--color-text-secondary)' }}>
            {error || 'Swarm not found'}
          </p>
          <button
            onClick={() => navigate('/swarms')}
            className="btn btn-secondary text-xs"
          >
            Back to Swarms
          </button>
        </div>
      </div>
    );
  }

  return (
    <TerminalPanel
      mode="embedded"
      swarm={{
        swarmId: swarm.id,
        swarmName: swarm.name,
        endpoint: swarm.endpoint || `ws://127.0.0.1:${swarm.assigned_port}`,
      }}
      isOpen
      onClose={() => navigate('/swarms')}
    />
  );
}
