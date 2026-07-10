import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, Minus, Settings2, Copy } from 'lucide-react';
import { api } from '../lib/api';
import { DoctorPanel } from '../components/doctor/DoctorPanel';
import { PageLoader } from '../components/common/LoadingSpinner';

interface SetupFieldChoice {
  value: string;
  label: string;
}

interface SetupField {
  key: string;
  label: string;
  description?: string;
  type: 'string' | 'boolean' | 'choice' | 'number' | 'secret';
  choices?: SetupFieldChoice[];
  default?: unknown;
  current?: unknown;
  optional?: boolean;
}

interface SectionReport {
  id: string;
  title: string;
  description: string;
  status: { state: 'complete' | 'incomplete' | 'optional'; summary: string; issues: string[] };
  fields: SetupField[];
}

interface ApplyResponse {
  ok: boolean;
  message: string;
  restartRequired?: boolean;
  outputs?: Record<string, unknown>;
  status?: SectionReport['status'];
}

function StateIcon({ state }: { state: SectionReport['status']['state'] }) {
  if (state === 'complete') return <CheckCircle2 className="w-4 h-4 text-green-500" />;
  if (state === 'incomplete') return <Circle className="w-4 h-4 text-amber-500" />;
  return <Minus className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />;
}

function seedValue(field: SetupField): unknown {
  return field.current ?? field.default;
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: SetupField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const inputClass =
    'w-full text-xs px-2 py-1.5 rounded border bg-transparent focus:outline-none';
  const inputStyle = { borderColor: 'var(--color-border)', color: 'var(--color-text)' };

  if (field.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-xs cursor-pointer">
        <input
          type="checkbox"
          checked={value === true || value === 'true'}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span style={{ color: 'var(--color-text-secondary)' }}>
          {field.description ?? field.label}
        </span>
      </label>
    );
  }
  if (field.type === 'choice') {
    return (
      <select
        className={inputClass}
        style={inputStyle}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      >
        {(field.choices ?? []).map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      type={field.type === 'number' ? 'number' : field.type === 'secret' ? 'password' : 'text'}
      className={inputClass}
      style={inputStyle}
      value={value === undefined || value === null ? '' : String(value)}
      placeholder={field.optional ? 'optional' : undefined}
      onChange={(e) =>
        onChange(field.type === 'number' ? Number(e.target.value) : e.target.value)
      }
    />
  );
}

function OutputsBlock({ outputs }: { outputs: Record<string, unknown> }) {
  const token = typeof outputs.token === 'string' ? outputs.token : null;
  const adminKey = typeof outputs.adminKey === 'string' ? outputs.adminKey : null;
  const snippets = Array.isArray(outputs.snippets) ? (outputs.snippets as string[]) : [];

  const copyable = (label: string, value: string) => (
    <div className="mt-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-2xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
          {label}
        </span>
        <button
          onClick={() => navigator.clipboard.writeText(value)}
          className="text-2xs flex items-center gap-1"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <Copy className="w-3 h-3" /> copy
        </button>
      </div>
      <code
        className="block text-2xs p-2 rounded whitespace-pre-wrap break-all"
        style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
      >
        {value}
      </code>
    </div>
  );

  return (
    <div>
      {adminKey && copyable('Admin key — save it somewhere safe', adminKey)}
      {token && copyable('Onboard token', token)}
      {snippets.map((s, i) => copyable(i === 0 ? 'Connect an agent' : 'Or', s))}
    </div>
  );
}

function SectionCard({ section }: { section: SectionReport }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(section.status.state === 'incomplete');
  const [answers, setAnswers] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      section.fields
        .map((f) => [f.key, seedValue(f)] as const)
        .filter(([, v]) => v !== undefined),
    ),
  );
  const [result, setResult] = useState<ApplyResponse | null>(null);

  const apply = useMutation({
    mutationFn: () =>
      api.post<ApplyResponse>(`/admin/setup/${section.id}`, { answers }),
    onSuccess: (res) => {
      setResult(res);
      queryClient.invalidateQueries({ queryKey: ['admin-setup'] });
    },
    onError: (err) =>
      setResult({ ok: false, message: (err as Error).message }),
  });

  return (
    <div className="card p-4">
      <button className="flex items-start gap-2.5 w-full text-left" onClick={() => setOpen(!open)}>
        <div className="mt-0.5">
          <StateIcon state={section.status.state} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
            {section.title}
          </div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            {section.status.summary}
          </div>
          {section.status.issues.map((issue) => (
            <div key={issue} className="text-2xs mt-0.5 text-amber-500">
              ! {issue}
            </div>
          ))}
        </div>
      </button>

      {open && (
        <div className="mt-3 pl-6 space-y-3">
          {section.fields.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {section.description}
            </p>
          ) : (
            <>
              {section.fields.map((field) => (
                <div key={field.key}>
                  {field.type !== 'boolean' && (
                    <label
                      className="block text-2xs font-medium mb-1"
                      style={{ color: 'var(--color-text-secondary)' }}
                    >
                      {field.label}
                      {field.description && (
                        <span style={{ color: 'var(--color-text-muted)' }}>
                          {' '}
                          — {field.description}
                        </span>
                      )}
                    </label>
                  )}
                  <FieldInput
                    field={field}
                    value={answers[field.key]}
                    onChange={(v) => setAnswers((a) => ({ ...a, [field.key]: v }))}
                  />
                </div>
              ))}
              <button
                onClick={() => apply.mutate()}
                disabled={apply.isPending}
                className="text-xs px-3 py-1.5 rounded bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50"
              >
                {apply.isPending ? 'Applying...' : 'Apply'}
              </button>
            </>
          )}

          {result && (
            <div className="text-xs">
              <span className={result.ok ? 'text-green-500' : 'text-red-500'}>
                {result.ok ? '✓' : '✗'} {result.message}
              </span>
              {result.restartRequired && (
                <span className="ml-2 text-amber-500">restart required</span>
              )}
              {result.outputs && <OutputsBlock outputs={result.outputs} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Onboarding() {
  const { data, isLoading, error } = useQuery<{ sections: SectionReport[] }>({
    queryKey: ['admin-setup'],
    queryFn: () => api.get('/admin/setup'),
  });

  if (isLoading) return <PageLoader />;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Settings2 className="w-5 h-5 text-honey-500" />
        <h1 className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
          Hub setup
        </h1>
      </div>
      <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
        Configure this hub section by section. Everything here is re-runnable — the same
        sections back <code>openhive setup</code> on the CLI.
      </p>

      {error ? (
        <div className="card p-4 text-xs text-red-500">
          Could not load setup state: {(error as Error).message}. Setup requires admin
          authority — in token-auth mode use the CLI (<code>openhive setup</code>).
        </div>
      ) : (
        <div className="space-y-3">
          {(data?.sections ?? []).map((section) => (
            <SectionCard key={section.id} section={section} />
          ))}
        </div>
      )}

      <DoctorPanel
        endpoint="/admin/doctor"
        queryKey={['admin-doctor']}
        title="Hub health"
        allowDeep
      />
    </div>
  );
}
